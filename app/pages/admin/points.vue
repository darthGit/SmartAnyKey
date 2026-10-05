<script setup lang="ts">
// Admin UI for managing points (tier Full).
// Before this, a point could be created ONLY by CSV import, `number` was not editable
// anywhere, and deletion did not exist at all.
//
// CSR, Nuxt UI, i18n (ADR-006). Server-side point search (ilike + limit ~30) —
// 300+ points, the client does not fetch them all.
// Mutations — BFF under requireRole(admin) with Bearer (without the header, a guaranteed 403).
const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

interface PointRow {
  id: string
  number: number
  address: string
  subnet: string
  note: string | null
  scan_cadence_minutes: number | null
}
interface BlastRadius {
  devices: number
  runbooks: number
  contacts: number
  discoveredHosts: number
  driftEvents: number
  bindings: number
}

const NOTE_MAX = 2000 // mirrors server/services/notes.ts + DB CHECK (0014)

// --- server-side point search -------------------------------------------
const results = ref<PointRow[]>([])
const searchTerm = ref('')
const searchLoading = ref(false)
const loadErr = ref('')
const selectedId = ref<string | null>(null)
// The chosen point is kept separately and forced into `items`: after a pick USelectMenu
// re-filters the list and the row can drop out of `results` → the trigger would show a raw
// UUID.
const chosenPoint = ref<PointRow | null>(null)
const rowLabel = (p: PointRow) => `#${p.number} · ${p.address}`
const items = computed(() => {
  const list = results.value.map(p => ({ label: rowLabel(p), value: p.id }))
  const c = chosenPoint.value
  if (c && !list.some(i => i.value === c.id))
    list.unshift({ label: rowLabel(c), value: c.id })
  return list
})

const COLS = 'id,number,address,subnet,note,scan_cadence_minutes'

async function search(term: string) {
  // A comma/parenthesis breaks PostgREST `.or()` — sanitize.
  const clean = term.replace(/[(),]/g, '').trim()
  searchLoading.value = true
  loadErr.value = ''
  try {
    const isNum = /^\d+$/.test(clean)
    let q = supabase.from('points').select(COLS).order('number').limit(30)
    if (clean)
      q = isNum ? q.eq('number', Number(clean)) : q.ilike('address', `%${clean}%`)
    const { data, error } = await q
    if (error)
      throw error
    results.value = (data ?? []) as PointRow[]
  }
  catch (e) {
    loadErr.value = t('points.loadError', { message: (e as { message?: string }).message ?? String(e) })
  }
  finally {
    searchLoading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(searchTerm, (v) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => search(v), 250)
})
onMounted(() => search(''))
// SPA: the first fetch can outrun session restore (auth-state timing).
watch(session, (s, prev) => { if (s && !prev) search(searchTerm.value) })

// --- edit form -----------------------------------------------------------
const form = ref({ number: 0, address: '', subnet: '', note: '', cadence: null as number | null })
const showAdvanced = ref(false)
const saveErr = ref('')
const savedMsg = ref('')

const selected = computed(() => chosenPoint.value ?? results.value.find(p => p.id === selectedId.value) ?? null)

watch(selectedId, async (id) => {
  saveErr.value = ''
  savedMsg.value = ''
  showAdvanced.value = false
  delConfirm.value = false
  blast.value = null
  if (!id) {
    chosenPoint.value = null
    return
  }
  const { data } = await supabase.from('points').select(COLS).eq('id', id).maybeSingle()
  const row = (data ?? null) as PointRow | null
  chosenPoint.value = row
  if (row) {
    form.value = {
      number: row.number,
      address: row.address,
      subnet: row.subnet,
      note: row.note ?? '',
      // null in the DB = "no schedule"; USelect does not resolve null to an option →
      // the trigger stayed empty and did not show the current state.
      cadence: row.scan_cadence_minutes ?? 0,
    }
  }
})

const CADENCE = [15, 30, 60, 180, 360, 720, 1440]
const cadenceItems = computed(() => [
  { label: t('points.cadenceOff'), value: 0 },
  ...CADENCE.map(m => ({ label: `${m} min`, value: m })),
])

const msg = (e: unknown) => {
  const m = (e as { statusMessage?: string })?.statusMessage ?? String(e)
  if (m.includes('already exists')) return t('points.numberTaken')
  if (m.includes('subnet must be')) return t('points.subnetInvalid')
  return m
}

const canSave = computed(() =>
  !!selected.value && form.value.number > 0 && !!form.value.address.trim() && !!form.value.subnet.trim())

async function save() {
  if (!selected.value || !canSave.value)
    return
  saveErr.value = ''
  savedMsg.value = ''
  try {
    await $fetch(`/api/admin/points/${selected.value.id}`, {
      method: 'PATCH',
      headers: authHeaders.value,
      body: {
        number: form.value.number,
        address: form.value.address.trim(),
        subnet: form.value.subnet.trim(),
        note: form.value.note,
      },
    })
    // The rescan schedule lives behind the existing discovery route — no second path.
    await $fetch(`/api/discovery/${selected.value.id}/schedule`, {
      method: 'POST', headers: authHeaders.value,
      body: { cadenceMinutes: form.value.cadence || null },
    })
    savedMsg.value = t('points.saved')
    await afterMutation()
  }
  catch (e) {
    saveErr.value = t('points.saveError', { message: msg(e) })
  }
}

// The board is cached by useAsyncData('board') in index.vue — without invalidation
// returning to "/" would show the old name/address.
async function afterMutation() {
  await Promise.all([search(searchTerm.value), refreshNuxtData('board')])
}

// --- delete --------------------------------------------------------------
const delConfirm = ref(false)
const blast = ref<BlastRadius | null>(null)

async function askDelete() {
  if (!selected.value)
    return
  saveErr.value = ''
  try {
    // Irreversible action → show exactly what will disappear before asking.
    blast.value = await $fetch<BlastRadius>(
      `/api/admin/points/${selected.value.id}/blast-radius`, { headers: authHeaders.value })
    delConfirm.value = true
  }
  catch (e) {
    saveErr.value = t('points.deleteError', { message: msg(e) })
  }
}

const blastText = computed(() => {
  const b = blast.value
  if (!b)
    return ''
  const total = b.devices + b.runbooks + b.contacts + b.bindings
  return total === 0
    ? t('points.deleteBlastEmpty')
    : t('points.deleteBlast', {
        devices: b.devices, runbooks: b.runbooks, contacts: b.contacts, bindings: b.bindings,
      })
})

async function del() {
  if (!selected.value)
    return
  try {
    await $fetch(`/api/admin/points/${selected.value.id}`, {
      method: 'DELETE', headers: authHeaders.value,
    })
    delConfirm.value = false
    blast.value = null
    selectedId.value = null
    chosenPoint.value = null
    await afterMutation()
  }
  catch (e) {
    saveErr.value = t('points.deleteError', { message: msg(e) })
  }
}

// --- create --------------------------------------------------------------
const addOpen = ref(false)
const addForm = ref({ number: null as number | null, address: '', subnet: '' })
const addErr = ref('')
const addMsg = ref('')

const canAdd = computed(() =>
  !!addForm.value.number && addForm.value.number > 0
  && !!addForm.value.address.trim() && !!addForm.value.subnet.trim())

async function add() {
  if (!canAdd.value)
    return
  addErr.value = ''
  addMsg.value = ''
  try {
    const row = await $fetch<PointRow>('/api/admin/points', {
      method: 'POST',
      headers: authHeaders.value,
      body: {
        number: addForm.value.number,
        address: addForm.value.address.trim(),
        subnet: addForm.value.subnet.trim(),
      },
    })
    addMsg.value = t('points.addSuccess')
    addForm.value = { number: null, address: '', subnet: '' }
    await afterMutation()
    selectedId.value = row.id
  }
  catch (e) {
    addErr.value = t('points.saveError', { message: msg(e) })
  }
}

// Prefill the add form from the chosen point (number left empty — it is unique).
function duplicate() {
  if (!selected.value)
    return
  addOpen.value = true
  addForm.value = { number: null, address: selected.value.address, subnet: selected.value.subnet }
  addMsg.value = ''
  addErr.value = ''
}
</script>

<template>
  <AdminPage :title="t('points.title')" :subtitle="t('points.subtitle')">
    <div class="flex flex-col gap-6">
      <UFormField :label="t('points.search')">
        <USelectMenu
          v-model="selectedId"
          v-model:search-term="searchTerm"
          :items="items"
          value-key="value"
          :ignore-filter="true"
          :loading="searchLoading"
          :placeholder="t('points.searchPlaceholder')"
          class="w-full"
        />
      </UFormField>
      <UAlert v-if="loadErr" color="error" :description="loadErr" />

      <p v-if="!selected" class="text-sm text-muted">
        {{ t('points.empty') }}
      </p>

      <section v-else class="flex flex-col gap-4">
        <UFormField :label="t('points.address')" required>
          <UInput v-model="form.address" class="w-full" />
        </UFormField>

        <UFormField :label="t('points.subnet')" required>
          <UInput v-model="form.subnet" class="w-full font-mono" placeholder="192.0.2.0/24" />
        </UFormField>

        <UFormField :label="t('points.note')">
          <UTextarea v-model="form.note" :maxlength="NOTE_MAX" :rows="2" autoresize class="w-full" />
        </UFormField>

        <UFormField :label="t('points.cadence')">
          <USelect v-model="form.cadence" :items="cadenceItems" value-key="value" class="w-48" />
        </UFormField>

        <!-- `number` sits under a disclosure: editing is allowed (otherwise a wrong
             number is unfixable), but the effect on CSV import must be seen. -->
        <details class="rounded border border-default px-3 py-2">
          <summary class="cursor-pointer select-none text-sm text-muted marker:text-muted">
            {{ t('points.advanced') }}
          </summary>
          <div class="mt-3 flex flex-col gap-2">
            <UFormField :label="t('points.number')">
              <UInput v-model.number="form.number" type="number" class="w-40" data-action="point-number" />
            </UFormField>
            <p class="text-xs text-warning">
              ⚠ {{ t('points.numberHint') }}
            </p>
          </div>
        </details>

        <div class="border-t border-default pt-4">
          <PointContactsEditor :key="selected.id" :point-id="selected.id" :can-edit="true" />
        </div>

        <UAlert v-if="saveErr" color="error" :description="saveErr" />
        <!-- Blast radius above the confirmation row: otherwise "Delete" is visible
             before the list of what will disappear. -->
        <UAlert
          v-if="delConfirm && blast"
          color="warning"
          icon="i-lucide-alert-triangle"
          :description="blastText"
          data-testid="blast-radius"
        />
        <div class="flex items-center gap-3 flex-wrap">
          <UButton :disabled="!canSave" data-action="point-save" @click="save">
            {{ t('points.save') }}
          </UButton>
          <UButton variant="soft" icon="i-lucide-copy" data-action="point-duplicate" @click="duplicate">
            {{ t('points.duplicate') }}
          </UButton>
          <span v-if="savedMsg" class="text-sm text-muted">{{ savedMsg }}</span>
          <div class="flex-1" />
          <template v-if="delConfirm">
            <span class="text-sm">{{ t('points.deleteConfirm', { n: selected.number }) }}</span>
            <UButton color="error" icon="i-lucide-trash-2" data-action="point-delete-yes" @click="del">
              {{ t('points.deleteYes') }}
            </UButton>
            <UButton variant="ghost" @click="delConfirm = false; blast = null">
              {{ t('points.deleteCancel') }}
            </UButton>
          </template>
          <UButton
            v-else
            color="error"
            variant="soft"
            icon="i-lucide-trash-2"
            data-action="point-delete"
            @click="askDelete"
          >
            {{ t('points.deletePoint') }}
          </UButton>
        </div>
      </section>

      <section class="flex flex-col gap-4">
        <UButton
          :icon="addOpen ? 'i-lucide-chevron-down' : 'i-lucide-plus'"
          variant="soft"
          class="self-start"
          data-action="point-add-toggle"
          @click="addOpen = !addOpen"
        >
          {{ t('points.addToggle') }}
        </UButton>

        <div v-if="addOpen" class="flex flex-col gap-4 p-4 rounded-lg border border-default bg-muted">
          <UFormField :label="t('points.number')" required>
            <UInput v-model.number="addForm.number" type="number" class="w-40" />
          </UFormField>
          <UFormField :label="t('points.address')" required>
            <UInput v-model="addForm.address" class="w-full" />
          </UFormField>
          <UFormField :label="t('points.subnet')" required>
            <UInput v-model="addForm.subnet" class="w-full font-mono" placeholder="192.0.2.0/24" />
          </UFormField>
          <UAlert v-if="addErr" color="error" :description="addErr" />
          <div class="flex items-center gap-3">
            <UButton :disabled="!canAdd" data-action="point-add-submit" @click="add">
              {{ t('points.addSubmit') }}
            </UButton>
            <span v-if="addMsg" class="text-sm text-muted">{{ addMsg }}</span>
          </div>
        </div>
      </section>
    </div>
  </AdminPage>
</template>
