<script setup lang="ts">
// Admin UI for editing device protocols.
// CSR, Nuxt UI, i18n (ADR-006). The protocol set = per-device `actions[]`
// (direction B). Server-side device search (ilike + limit) — 2000+ devices, the client
// does not fetch them all (the PGRST_DB_MAX_ROWS trap). Mutation — BFF
// PATCH under requireRole(admin); the client only reads (RLS authenticated).
const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
// BFF write routes gate the role on the Bearer token (the cookie session yields JWT claims
// without a normalized user.id → requireRole 403). Same pattern as
// users.vue/commands.vue/signatures.vue.
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

const ALL_ACTIONS = ['vnc', 'rdp', 'ssh', 'web'] as const
type Action = typeof ALL_ACTIONS[number]

interface DeviceRow {
  id: string
  type_id: string
  point_id: string
  label: string
  host: string
  actions: Action[]
  default_action: Action | null
  meta: Record<string, unknown> | null
  // Observed name: a read-only fact — the form does NOT
  // edit it, only shows it and lets you copy it into `label` in one click.
  hostname: string | null
  hostname_source: string | null
  hostname_at: string | null
  points: { number: number, address: string } | null
}

// --- server-side device search ------------------------------------------
const DEVICE_COLS = 'id,type_id,point_id,label,host,actions,default_action,meta,hostname,hostname_source,hostname_at,points(number,address)'
const results = ref<DeviceRow[]>([])
const searchTerm = ref('')
const searchLoading = ref(false)
const loadErr = ref('')
const selectedId = ref<string | null>(null)
// The chosen device is kept separately: after a pick USelectMenu re-filters the list and
// the device can drop out of `results` → the label does not resolve (the trigger showed a UUID) and
// `selected` became null (duplicate did an early return). Same pattern as
// chosenPoint for points.
const selectedDevice = ref<DeviceRow | null>(null)
const rowLabel = (d: DeviceRow) => `#${d.points?.number ?? '?'} · ${d.label} · ${d.host}`
const items = computed(() => {
  const list = results.value.map(d => ({ label: rowLabel(d), value: d.id }))
  const c = selectedDevice.value
  if (c && !list.some(i => i.value === c.id))
    list.unshift({ label: rowLabel(c), value: c.id })
  return list
})

async function search(term: string) {
  const clean = term.replace(/[(),]/g, '').trim()
  const like = `%${clean}%`
  const isNum = /^\d+$/.test(clean)
  const cols = DEVICE_COLS
  searchLoading.value = true
  loadErr.value = ''
  try {
    const byOwn = supabase.from('devices').select(cols).or(`label.ilike.${like},host.ilike.${like}`).order('label').limit(30)
    const byPoint = isNum
      ? supabase.from('devices').select('id,type_id,point_id,label,host,actions,default_action,meta,hostname,hostname_source,hostname_at,points!inner(number,address)').eq('points.number', Number(clean)).limit(30)
      : Promise.resolve({ data: [] as unknown[] })
    const [r1, r2] = await Promise.all([byOwn, byPoint])
    const merged = new Map<string, DeviceRow>()
    for (const r of [...(r1.data ?? []), ...(r2.data ?? [])] as DeviceRow[]) merged.set(r.id, r)
    results.value = [...merged.values()].slice(0, 30)
  }
  catch (e) {
    loadErr.value = t('devices.loadError', { message: (e as Error).message })
  }
  finally {
    searchLoading.value = false
  }
}
// ponytail: manual debounce (250ms) — same pattern as credentials.vue.
let timer: ReturnType<typeof setTimeout>
watch(searchTerm, (term) => {
  clearTimeout(timer)
  timer = setTimeout(() => search(term), 250)
})

// --- edit form -----------------------------------------------------------
// meta = free-form non-secret pairs → edited as a {k,v} list, assembled into an object on save.
interface MetaPair { k: string, v: string }
const form = reactive<{ typeId: string, actions: Action[], label: string, host: string, defaultAction: string, metaPairs: MetaPair[] }>({
  typeId: '', actions: [], label: '', host: '', defaultAction: 'auto', metaPairs: [],
})
const saveErr = ref('')
const savedMsg = ref('')
const delConfirm = ref(false)

const selected = computed(() => results.value.find(d => d.id === selectedId.value)
  ?? pointDevices.value.find(d => d.id === selectedId.value) ?? null)
watch(selectedId, () => {
  const d = selected.value
  if (!d)
    return
  selectedDevice.value = d // keep the chosen row (survives the results re-filter)
  // a device found by search moves the page to its point
  if (d.points && d.point_id !== pagePoint.value?.id)
    setPagePoint({ id: d.point_id, number: d.points.number, address: d.points.address })
  loadTypes() // the "Type" dropdown for edit (small table → all rows)
  form.typeId = d.type_id
  form.actions = [...d.actions]
  form.label = d.label
  form.host = d.host
  form.defaultAction = d.default_action ?? 'auto'
  form.metaPairs = Object.entries(d.meta ?? {}).map(([k, v]) => ({ k, v: v == null ? '' : String(v) }))
  saveErr.value = ''
  savedMsg.value = ''
  delConfirm.value = false
  fetchCredStatus(d.id)
})
// Observed name. This is admin, so both actions are available:
// re-read it from the machine (SSH) and copy the fact into the label. The form does not
// edit `hostname` — it is a fact, not an input field.
const hostnameBusy = ref(false)
const hostnameMsg = ref('')
async function checkHostname(): Promise<void> {
  if (!selectedId.value)
    return
  hostnameBusy.value = true
  hostnameMsg.value = ''
  try {
    const res = await $fetch<{ status: string, hostname?: string }>(`/api/devices/${selectedId.value}/hostname`, {
      method: 'POST', headers: authHeaders.value,
    })
    hostnameMsg.value = res.status === 'skipped' ? t('board.hostname.noSsh') : (res.hostname ?? '')
    await search(searchTerm.value)
  }
  catch {
    hostnameMsg.value = t('board.hostname.checkFailed')
  }
  finally {
    hostnameBusy.value = false
  }
}

async function acceptHostname(): Promise<void> {
  const hn = selectedDevice.value?.hostname
  if (!selectedId.value || !hn)
    return
  form.label = hn          // the form is the source of what goes into the PATCH
  await save()
}

function addMeta() { form.metaPairs.push({ k: '', v: '' }) }
// An empty key is ignored; the last duplicate key wins.
function metaObject(): Record<string, string> {
  const o: Record<string, string> = {}
  for (const { k, v } of form.metaPairs) if (k.trim()) o[k.trim()] = v
  return o
}

function toggle(a: Action) {
  const i = form.actions.indexOf(a)
  if (i === -1)
    form.actions.push(a)
  else
    form.actions.splice(i, 1)
  // The default_action override must stay in the set (otherwise the backend returns 400).
  if (form.defaultAction !== 'auto' && !form.actions.includes(form.defaultAction as Action))
    form.defaultAction = 'auto'
}

// Default-action options = "by type" + only the chosen protocols.
const defaultActionItems = computed(() => [
  { label: t('devices.defaultActionAuto'), value: 'auto' },
  ...form.actions.map(a => ({ label: t(`action.${a}`), value: a })),
])
const canSave = computed(() => !!selectedId.value && !!form.typeId && form.actions.length > 0 && form.label.trim().length > 0 && form.host.trim().length > 0)

async function save() {
  if (!selectedId.value)
    return
  saveErr.value = ''
  savedMsg.value = ''
  try {
    await $fetch(`/api/admin/devices/${selectedId.value}`, {
      method: 'PATCH',
      headers: authHeaders.value,
      body: {
        type_id: form.typeId,
        actions: form.actions,
        label: form.label.trim(),
        host: form.host.trim(),
        default_action: form.defaultAction === 'auto' ? null : form.defaultAction,
        meta: metaObject(),
      },
    })
    savedMsg.value = t('devices.saved')
    const id = selectedId.value
    loadPointDevices()
    await search(searchTerm.value) // re-read the current state
    if (id)
      fetchCredStatus(id) // type/protocols may have changed → refresh the status
  }
  catch (e) {
    saveErr.value = t('devices.saveError', { message: (e as Error).message })
  }
}

// --- per-protocol cred status --------------------------------------------
// BFF read under Bearer (credential_bindings RLS deny-all); no secret leaks — only
// {action, resolved, level}. Map action → status for the form badges.
type CredStat = { resolved: boolean, level: string | null }
const credStatus = ref<Record<string, CredStat>>({})
async function fetchCredStatus(deviceId: string) {
  credStatus.value = {}
  try {
    const rows = await $fetch<{ action: string, resolved: boolean, level: string | null }[]>(
      `/api/admin/devices/${deviceId}/cred-status`,
      { headers: authHeaders.value },
    )
    credStatus.value = Object.fromEntries(rows.map(r => [r.action, { resolved: r.resolved, level: r.level }]))
  }
  catch {
    // cred status is informational; a failure does not block editing.
  }
}

// --- delete device -------------------------------------------------------
async function del() {
  if (!selectedId.value)
    return
  saveErr.value = ''
  try {
    await $fetch(`/api/admin/devices/${selectedId.value}`, { method: 'DELETE', headers: authHeaders.value })
    delConfirm.value = false
    selectedId.value = null
    selectedDevice.value = null
    loadPointDevices()
    await search(searchTerm.value)
  }
  catch (e) {
    saveErr.value = t('devices.deleteError', { message: (e as Error).message })
  }
}

// --- duplicate device ----------------------------------------------------
// Prefill the add form from the chosen one (same point/type/protocols), submit — the existing POST.
function duplicate() {
  const d = selectedDevice.value
  if (!d)
    return
  loadTypes()
  if (d.points)
    chosenPoint.value = { id: d.point_id, number: d.points.number, address: d.points.address }
  Object.assign(addForm, {
    pointId: d.point_id,
    typeId: d.type_id,
    actions: [...d.actions],
    label: t('devices.copyLabel', { label: d.label }),
    host: d.host,
    defaultAction: d.default_action ?? 'auto',
  })
  addOpen.value = true
  addMsg.value = ''
  addErr.value = ''
}

// --- manual device add ---------------------------------------------------
// Point = server-side search (points 300+). Type = a dropdown of our
// device_types (few rows → all). Mutation — POST with Bearer.
const addOpen = ref(false)
const types = ref<{ label: string, value: string }[]>([])
type PointRow = { id: string, number: number, address: string }
const pointResults = ref<PointRow[]>([])
const pointSearchTerm = ref('')
const pointLoading = ref(false)
// Closing USelectMenu re-searches with an empty term (first 30 by number) → the chosen
// point can drop out of the list and its label does not resolve (would show a UUID). Keep
// the chosen point in items always.
const chosenPoint = ref<PointRow | null>(null)
const asItem = (p: PointRow) => ({ label: `#${p.number} — ${p.address}`, value: p.id })
const pointItems = computed(() => {
  const list = pointResults.value.map(asItem)
  for (const c of [chosenPoint.value, pagePoint.value])
    if (c && !list.some(i => i.value === c.id))
      list.unshift(asItem(c))
  return list
})

async function loadTypes() {
  if (types.value.length)
    return
  const { data } = await supabase.from('device_types').select('id,name').order('sort')
  types.value = (data ?? []).map((r: { id: string, name: string }) => ({ label: r.name, value: r.id }))
}
watch(addOpen, (open) => {
  if (!open)
    return
  loadTypes()
  if (!addForm.pointId && pagePoint.value)
    addForm.pointId = pagePoint.value.id // the page's point; the field still lets you change it
})

async function searchPoints(term: string) {
  const clean = term.replace(/[(),]/g, '').trim()
  const like = `%${clean}%`
  const isNum = /^\d+$/.test(clean)
  const or = isNum ? `number.eq.${clean},address.ilike.${like}` : `address.ilike.${like}`
  pointLoading.value = true
  try {
    const { data } = await supabase.from('points').select('id,number,address').or(or).order('number').limit(30)
    pointResults.value = (data ?? []) as typeof pointResults.value
  }
  finally {
    pointLoading.value = false
  }
}
let pointTimer: ReturnType<typeof setTimeout>
watch(pointSearchTerm, (term) => {
  clearTimeout(pointTimer)
  pointTimer = setTimeout(() => searchPoints(term), 250)
})

const addForm = reactive<{ pointId: string | null, typeId: string | null, actions: Action[], label: string, host: string, defaultAction: string }>({
  pointId: null, typeId: null, actions: [], label: '', host: '', defaultAction: 'auto',
})
const addErr = ref('')
const addMsg = ref('')

watch(() => addForm.pointId, (id) => {
  const p = pointResults.value.find(x => x.id === id)
  if (p)
    chosenPoint.value = p
})

function toggleAdd(a: Action) {
  const i = addForm.actions.indexOf(a)
  if (i === -1)
    addForm.actions.push(a)
  else
    addForm.actions.splice(i, 1)
  if (addForm.defaultAction !== 'auto' && !addForm.actions.includes(addForm.defaultAction as Action))
    addForm.defaultAction = 'auto'
}
const addDefaultActionItems = computed(() => [
  { label: t('devices.defaultActionAuto'), value: 'auto' },
  ...addForm.actions.map(a => ({ label: t(`action.${a}`), value: a })),
])
const canAdd = computed(() => !!addForm.pointId && !!addForm.typeId && addForm.actions.length > 0
  && addForm.label.trim().length > 0 && addForm.host.trim().length > 0)

async function create() {
  if (!canAdd.value)
    return
  addErr.value = ''
  addMsg.value = ''
  try {
    await $fetch('/api/admin/devices', {
      method: 'POST',
      headers: authHeaders.value,
      body: {
        point_id: addForm.pointId,
        type_id: addForm.typeId,
        label: addForm.label.trim(),
        host: addForm.host.trim(),
        actions: addForm.actions,
        default_action: addForm.defaultAction === 'auto' ? null : addForm.defaultAction,
      },
    })
    addMsg.value = t('devices.addSuccess') // hint "next, bind a cred"
    Object.assign(addForm, { pointId: pagePoint.value?.id ?? null, typeId: null, actions: [], label: '', host: '', defaultAction: 'auto' })
    loadPointDevices()
    chosenPoint.value = null
    pointSearchTerm.value = ''
  }
  catch (e) {
    addErr.value = t('devices.addError', { message: (e as Error).message })
  }
}

// --- the page's point -----------------------------------------------------
// The point is the context of the page: picked once, it lists its devices and feeds Add.
// It lives in `?point=<number>` (a number a person reads and shares, not a uuid), so reload
// and Back keep it.
const route = useRoute()
const router = useRouter()
const pagePoint = ref<PointRow | null>(null)
const pagePointTerm = ref('')
const pointNotFound = ref<number | null>(null)
const pagePointId = computed({
  get: () => pagePoint.value?.id ?? null,
  set: (id: string | null) => {
    const p = pointResults.value.find(x => x.id === id)
    if (p)
      setPagePoint(p)
  },
})
let pagePointTimer: ReturnType<typeof setTimeout>
watch(pagePointTerm, (term) => {
  clearTimeout(pagePointTimer)
  pagePointTimer = setTimeout(() => searchPoints(term), 250)
})

const pointDevices = ref<DeviceRow[]>([])
const rowCreds = ref<Record<string, Record<string, boolean>>>({})
const typeName = (id: string) => types.value.find(ty => ty.value === id)?.label ?? ''

function setPagePoint(p: PointRow) {
  pagePoint.value = p
  pointNotFound.value = null
  if (route.query.point !== String(p.number))
    router.replace({ query: { ...route.query, point: String(p.number) } })
  loadPointDevices()
}

async function loadPointDevices() {
  const p = pagePoint.value
  if (!p)
    return
  loadTypes()
  const { data } = await supabase.from('devices').select(DEVICE_COLS).eq('point_id', p.id).order('sort')
  pointDevices.value = (data ?? []) as DeviceRow[]
  // ponytail: one cred-status call per device (≈7 on a point); a batch route once points hold dozens.
  const entries = await Promise.all(pointDevices.value.map(async (d) => {
    const rows = await $fetch<{ action: string, resolved: boolean }[]>(`/api/admin/devices/${d.id}/cred-status`, { headers: authHeaders.value })
      .catch(() => [])
    return [d.id, Object.fromEntries(rows.map(r => [r.action, r.resolved]))] as const
  }))
  rowCreds.value = Object.fromEntries(entries)
}

onMounted(async () => {
  const n = Number(route.query.point)
  if (!route.query.point || !Number.isInteger(n))
    return
  const { data } = await supabase.from('points').select('id,number,address').eq('number', n).maybeSingle()
  if (data)
    setPagePoint(data as PointRow)
  else
    pointNotFound.value = n
})
</script>

<template>
  <AdminPage :title="t('devices.title')" :subtitle="t('devices.subtitle')">
    <div class="flex flex-col gap-6">

    <UAlert v-if="loadErr" color="error" :description="loadErr" />

    <UFormField :label="t('devices.pagePoint')">
      <USelectMenu
        v-model="pagePointId"
        v-model:search-term="pagePointTerm"
        :items="pointItems"
        value-key="value"
        :ignore-filter="true"
        :loading="pointLoading"
        :placeholder="t('devices.pagePointPlaceholder')"
        class="w-full"
        data-testid="page-point"
      />
    </UFormField>
    <UAlert v-if="pointNotFound" color="warning" :description="t('devices.pointNotFound', { number: pointNotFound })" />

    <section v-if="pagePoint" class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-highlighted">{{ t('devices.pointDevices', { number: pagePoint.number, address: pagePoint.address }) }}</h2>
        <UButton size="xs" variant="soft" icon="i-lucide-plus" class="ml-auto" data-action="add-device" @click="addOpen = true">
          {{ t('devices.addToggle') }}
        </UButton>
      </div>
      <p v-if="!pointDevices.length" class="text-sm text-muted">{{ t('devices.pointEmpty') }}</p>
      <ul v-else class="divide-y divide-default rounded-lg ring ring-default">
        <li v-for="d in pointDevices" :key="d.id">
          <button
            type="button"
            class="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-elevated"
            :class="d.id === selectedId ? 'bg-elevated' : ''"
            data-testid="point-device-row"
            @click="selectedId = d.id"
          >
            <span class="font-medium text-highlighted" data-testid="row-label">{{ d.label }}</span>
            <span class="font-mono text-xs text-muted">{{ d.host }}</span>
            <span class="text-xs text-muted">{{ typeName(d.type_id) }}</span>
            <span class="ml-auto flex flex-wrap gap-1">
              <template v-for="a in d.actions" :key="a">
                <UBadge v-if="a === 'web'" size="xs" variant="subtle" color="neutral">{{ t(`action.${a}`) }}</UBadge>
                <UBadge
                  v-else
                  size="xs"
                  variant="subtle"
                  :color="rowCreds[d.id]?.[a] ? 'success' : 'warning'"
                  :title="rowCreds[d.id]?.[a] ? t('devices.credSet') : t('devices.credMissing')"
                  :data-testid="`cred-${a}`"
                >
                  <UIcon :name="rowCreds[d.id]?.[a] ? 'i-lucide-key-round' : 'i-lucide-key-square'" />
                  {{ t(`action.${a}`) }}
                </UBadge>
              </template>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <UFormField :label="t('devices.search')" :description="t('devices.searchAnyHint')">
      <USelectMenu
        v-model="selectedId"
        v-model:search-term="searchTerm"
        :items="items"
        value-key="value"
        :ignore-filter="true"
        :loading="searchLoading"
        :placeholder="t('devices.searchPlaceholder')"
        class="w-full"
      />
    </UFormField>

    <p v-if="!selectedId" class="text-sm text-muted">
      {{ pagePoint ? t('devices.emptyWithPoint') : t('devices.empty') }}
    </p>

    <section v-else class="flex flex-col gap-4 p-4 rounded-lg border border-default bg-muted" data-testid="edit-form">
      <UFormField :label="t('devices.addType')" required>
        <USelect v-model="form.typeId" :items="types" value-key="value" class="w-full" />
      </UFormField>

      <UFormField :label="t('devices.label')" required>
        <UInput v-model="form.label" class="w-full" />
      </UFormField>

      <UFormField :label="t('devices.host')" required>
        <UInput v-model="form.host" class="w-full font-mono" />
      </UFormField>

      <!-- Observed name — a read-only fact next to the label.
           Nothing to edit: the scan/SSH check writes it.
           Mismatch with the label → a marker + one click "Accept as name". -->
      <UFormField :label="t('board.hostname.label')">
        <div class="flex items-center gap-2">
          <span class="font-mono text-sm" :class="hostnameMismatch(selectedDevice?.label, selectedDevice?.hostname) ? 'text-warning' : 'text-muted'" data-testid="admin-hostname">
            {{ selectedDevice?.hostname || t('board.hostname.none') }}
          </span>
          <span v-if="selectedDevice?.hostname" class="text-xs text-muted">
            {{ t(`board.hostname.source.${selectedDevice.hostname_source ?? 'ptr'}`) }}
            <template v-if="selectedDevice.hostname_at">· {{ new Date(selectedDevice.hostname_at).toLocaleString() }}</template>
          </span>
          <UIcon
            v-if="hostnameMismatch(selectedDevice?.label, selectedDevice?.hostname)"
            name="i-lucide-triangle-alert"
            class="text-warning"
            :title="t('board.hostname.mismatch')"
          />
          <div class="ml-auto flex items-center gap-2">
            <UButton
              v-if="selectedDevice?.actions.includes('ssh')"
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-scan-line"
              :loading="hostnameBusy"
              :title="t('board.hostname.check')"
              data-action="hostname-check"
              @click="checkHostname"
            >
              {{ t('board.hostname.check') }}
            </UButton>
            <UButton
              v-if="hostnameMismatch(selectedDevice?.label, selectedDevice?.hostname)"
              size="xs"
              variant="subtle"
              color="neutral"
              :loading="hostnameBusy"
              data-action="hostname-accept"
              @click="acceptHostname"
            >
              {{ t('board.hostname.accept') }}
            </UButton>
          </div>
        </div>
        <span v-if="hostnameMsg" class="text-xs text-muted">{{ hostnameMsg }}</span>
      </UFormField>

      <UFormField :label="t('devices.protocols')" required>
        <div class="flex flex-col gap-2">
          <div v-for="a in ALL_ACTIONS" :key="a" class="flex items-center gap-3">
            <UCheckbox
              :id="`proto-${a}`"
              :model-value="form.actions.includes(a)"
              :label="t(`action.${a}`)"
              @update:model-value="toggle(a)"
            />
            <UBadge
              v-if="a !== 'web' && form.actions.includes(a)"
              size="xs"
              variant="subtle"
              :color="credStatus[a]?.resolved ? 'success' : 'warning'"
            >
              {{ credStatus[a]?.resolved ? t('devices.credOk', { level: credStatus[a]!.level }) : t('devices.credMissing') }}
            </UBadge>
          </div>
        </div>
      </UFormField>

      <UFormField :label="t('devices.defaultAction')">
        <USelect v-model="form.defaultAction" :items="defaultActionItems" value-key="value" class="w-full" />
      </UFormField>

      <UFormField :label="t('devices.meta')" :description="t('devices.metaHint')">
        <div class="flex flex-col gap-2">
          <div v-for="(p, i) in form.metaPairs" :key="i" class="flex gap-2">
            <UInput v-model="p.k" :placeholder="t('devices.metaKey')" class="w-48 font-mono" />
            <UInput v-model="p.v" :placeholder="t('devices.metaValue')" class="flex-1 font-mono" />
            <UButton icon="i-lucide-x" variant="ghost" color="error" :aria-label="t('devices.metaRemove')" @click="form.metaPairs.splice(i, 1)" />
          </div>
          <UButton size="xs" variant="soft" icon="i-lucide-plus" class="self-start" @click="addMeta">{{ t('devices.metaAdd') }}</UButton>
        </div>
      </UFormField>

      <UAlert v-if="saveErr" color="error" :description="saveErr" />
      <div class="flex items-center gap-3 flex-wrap">
        <UButton :disabled="!canSave" @click="save">
          {{ t('devices.save') }}
        </UButton>
        <UButton variant="soft" icon="i-lucide-copy" @click="duplicate">
          {{ t('devices.duplicate') }}
        </UButton>
        <span v-if="savedMsg" class="text-sm text-muted">{{ savedMsg }}</span>
        <div class="flex-1" />
        <template v-if="delConfirm">
          <span class="text-sm">{{ t('devices.deleteConfirm') }}</span>
          <UButton color="error" icon="i-lucide-trash-2" @click="del">{{ t('devices.deleteYes') }}</UButton>
          <UButton variant="ghost" @click="delConfirm = false">{{ t('devices.deleteCancel') }}</UButton>
        </template>
        <UButton v-else color="error" variant="soft" icon="i-lucide-trash-2" @click="delConfirm = true">
          {{ t('devices.deleteDevice') }}
        </UButton>
      </div>
    </section>

    <section class="flex flex-col gap-4">
      <UButton
        v-if="!pagePoint || addOpen"
        :icon="addOpen ? 'i-lucide-chevron-down' : 'i-lucide-plus'"
        variant="soft"
        class="self-start"
        @click="addOpen = !addOpen"
      >
        {{ t('devices.addToggle') }}
      </UButton>

      <div v-if="addOpen" class="flex flex-col gap-4 p-4 rounded-lg border border-default bg-muted" data-testid="add-form">
        <UFormField :label="t('devices.addPoint')" required>
          <USelectMenu
            v-model="addForm.pointId"
            v-model:search-term="pointSearchTerm"
            :items="pointItems"
            value-key="value"
            :ignore-filter="true"
            :loading="pointLoading"
            :placeholder="t('devices.addPointPlaceholder')"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('devices.addType')" required>
          <USelect
            v-model="addForm.typeId"
            :items="types"
            value-key="value"
            :placeholder="t('devices.addTypePlaceholder')"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('devices.label')" required>
          <UInput v-model="addForm.label" class="w-full" />
        </UFormField>

        <UFormField :label="t('devices.host')" required>
          <UInput v-model="addForm.host" class="w-full font-mono" />
        </UFormField>

        <UFormField :label="t('devices.protocols')" required>
          <div class="flex flex-col gap-2">
            <UCheckbox
              v-for="a in ALL_ACTIONS"
              :id="`add-proto-${a}`"
              :key="a"
              :model-value="addForm.actions.includes(a)"
              :label="t(`action.${a}`)"
              @update:model-value="toggleAdd(a)"
            />
          </div>
        </UFormField>

        <UFormField :label="t('devices.defaultAction')">
          <USelect v-model="addForm.defaultAction" :items="addDefaultActionItems" value-key="value" class="w-full" />
        </UFormField>

        <UAlert v-if="addErr" color="error" :description="addErr" />
        <div class="flex items-center gap-3">
          <UButton :disabled="!canAdd" @click="create">
            {{ t('devices.addSubmit') }}
          </UButton>
          <span v-if="addMsg" class="text-sm text-muted">{{ addMsg }}</span>
        </div>
      </div>
    </section>
    </div>
  </AdminPage>
</template>
