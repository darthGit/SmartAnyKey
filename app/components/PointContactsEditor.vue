<script setup lang="ts">
// Point contacts. One row = one
// contact: phone / email / anything. There is no "person with channels" entity.
//
// Self-sufficient: reads `point_contacts` under RLS (as PointHealthCard fetches
// inventory), writes via operator-gated BFF routes with Bearer (without the
// header a 403 is guaranteed).
//
// Used twice: in the point card (operator during a call) and on
// /admin/points. One component — so the two forms do not drift apart.
import type { PointContact } from '~/types/board'
import { LINKED_KINDS, contactHref, sortContacts } from '~/utils/contact-link'

const props = defineProps<{ pointId: string, canEdit: boolean }>()
const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

const rows = ref<PointContact[]>([])
const err = ref('')
const busyId = ref<string | null>(null)

// Kinds for which the platform has a link scheme. NOT a list of allowed kinds —
// "Other" allows free input, because the vocabulary of kinds belongs to the client (no domain defaults).
const KNOWN = LINKED_KINDS
const sorted = computed(() => sortContacts(rows.value))
const kindItems = computed(() => [
  { label: t('contacts.kindPhone'), value: 'phone' },
  { label: t('contacts.kindEmail'), value: 'email' },
  { label: t('contacts.kindOther'), value: '__other__' },
])

interface Draft { kind: string, customKind: string, value: string, label: string }
const draft = ref<Draft | null>(null)
const editingId = ref<string | null>(null)

const blank = (): Draft => ({ kind: 'phone', customKind: '', value: '', label: '' })
const resolvedKind = (d: Draft) => (d.kind === '__other__' ? d.customKind.trim() : d.kind)

async function load() {
  err.value = ''
  const { data, error } = await supabase.from('point_contacts')
    .select('id,point_id,kind,value,value_norm,label,sort')
    .eq('point_id', props.pointId).order('sort').order('id')
  if (error) {
    err.value = t('contacts.loadError', { message: error.message })
    return
  }
  rows.value = (data ?? []) as PointContact[]
}

onMounted(load)
watch(() => props.pointId, load)
// SPA: the first fetch can outrun session restore (RLS → empty).
// guidelines §Client-side auth-state timing.
watch(session, (s, prev) => { if (s && !prev) load() })

function startAdd() {
  editingId.value = null
  draft.value = blank()
}

function startEdit(c: PointContact) {
  editingId.value = c.id
  draft.value = {
    kind: KNOWN.includes(c.kind) ? c.kind : '__other__',
    customKind: KNOWN.includes(c.kind) ? '' : c.kind,
    value: c.value,
    label: c.label ?? '',
  }
}

function cancel() {
  draft.value = null
  editingId.value = null
}

const msg = (e: unknown) => {
  const m = (e as { statusMessage?: string })?.statusMessage ?? String(e)
  // A duplicate (409) must read as "already exists", not as a raw DB phrase.
  return m.includes('already exists') ? t('contacts.duplicateValue') : m
}

const canSubmit = computed(() =>
  !!draft.value && !!resolvedKind(draft.value) && !!draft.value.value.trim())

async function submit() {
  if (!draft.value || !canSubmit.value)
    return
  const body = {
    kind: resolvedKind(draft.value),
    value: draft.value.value.trim(),
    label: draft.value.label.trim() || undefined,
  }
  busyId.value = editingId.value ?? '__new__'
  err.value = ''
  try {
    if (editingId.value) {
      await $fetch(`/api/points/${props.pointId}/contacts/${editingId.value}`, {
        method: 'PATCH', headers: authHeaders.value, body: { ...body, label: body.label ?? null },
      })
    }
    else {
      await $fetch(`/api/points/${props.pointId}/contacts`, {
        method: 'POST', headers: authHeaders.value, body,
      })
    }
    cancel()
    await load()
  }
  catch (e) {
    err.value = t('contacts.saveError', { message: msg(e) })
  }
  finally {
    busyId.value = null
  }
}

const confirmId = ref<string | null>(null)

async function remove(id: string) {
  busyId.value = id
  err.value = ''
  try {
    await $fetch(`/api/points/${props.pointId}/contacts/${id}`, {
      method: 'DELETE', headers: authHeaders.value,
    })
    confirmId.value = null
    await load()
  }
  catch (e) {
    err.value = t('contacts.saveError', { message: msg(e) })
  }
  finally {
    busyId.value = null
  }
}
</script>

<template>
  <div class="flex flex-col gap-1.5" data-testid="point-contacts">
    <div class="flex items-center gap-2">
      <span class="text-xs font-medium text-muted">{{ t('contacts.title') }}</span>
      <UButton
        v-if="canEdit && !draft"
        class="ml-auto"
        size="xs"
        variant="ghost"
        icon="i-lucide-plus"
        data-action="contact-add"
        @click="startAdd"
      >
        {{ t('contacts.add') }}
      </UButton>
    </div>

    <p v-if="!rows.length && !draft" class="text-xs text-muted">
      {{ t('contacts.empty') }}<template v-if="canEdit"> — {{ t('contacts.hint') }}</template>
    </p>

    <div
      v-for="c in sorted"
      :key="c.id"
      class="flex items-center gap-2 rounded border border-default px-2 py-1.5 text-sm"
      data-testid="contact-row"
    >
      <!-- Row typography: exactly one size for the whole
           row (`text-sm` from the container) and one font-family rule —
           a technical value in monospace, human text proportional.
           Was: 10px mono / 14px sans / 12px sans in one row.
           Fixed width of the kind column — otherwise PHONE/EMAIL/TELEGRAM of different
           lengths shift the value horizontally. -->
      <span class="w-20 shrink-0 truncate uppercase tracking-wide text-muted font-mono">{{ c.kind }}</span>
      <!-- A link and a non-link must have the same typography: only the
           affordance (colour+underline) tells them apart, not size or font. -->
      <a
        v-if="contactHref(c.kind, c.value)"
        :href="contactHref(c.kind, c.value)!"
        class="min-w-0 truncate font-mono text-primary underline"
        data-testid="contact-link"
      >{{ c.value }}</a>
      <span v-else class="min-w-0 truncate font-mono">{{ c.value }}</span>
      <span v-if="c.label" class="shrink-0 truncate text-muted">· {{ c.label }}</span>

      <span v-if="canEdit" class="ml-auto shrink-0 flex items-center gap-1">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-pencil"
          :aria-label="t('contacts.save')"
          data-action="contact-edit"
          @click="startEdit(c)"
        />
        <UButton
          size="xs"
          variant="ghost"
          :color="confirmId === c.id ? 'error' : 'neutral'"
          :icon="confirmId === c.id ? 'i-lucide-check' : 'i-lucide-trash-2'"
          :loading="busyId === c.id"
          :aria-label="confirmId === c.id ? t('contacts.deleteConfirm') : t('contacts.delete')"
          :title="confirmId === c.id ? t('contacts.deleteConfirm') : t('contacts.delete')"
          data-action="contact-delete"
          @click="confirmId === c.id ? remove(c.id) : (confirmId = c.id)"
        />
      </span>
    </div>

    <!-- Add/edit form: the same one, so the fields do not drift apart. -->
    <div v-if="draft" class="flex flex-col gap-2 rounded border border-accented p-2" data-testid="contact-form">
      <div class="flex flex-wrap items-center gap-2">
        <USelect v-model="draft.kind" :items="kindItems" size="xs" class="w-32" />
        <UInput
          v-if="draft.kind === '__other__'"
          v-model="draft.customKind"
          size="xs"
          class="w-32"
          :placeholder="t('contacts.kindOtherPlaceholder')"
        />
        <UInput v-model="draft.value" size="xs" class="flex-1 min-w-40" :placeholder="t('contacts.value')" />
      </div>
      <UInput v-model="draft.label" size="xs" :placeholder="t('contacts.labelPlaceholder')" />
      <div class="flex items-center justify-end gap-2">
        <UButton size="xs" variant="ghost" color="neutral" @click="cancel">
          {{ t('contacts.cancel') }}
        </UButton>
        <UButton
          size="xs"
          :disabled="!canSubmit"
          :loading="busyId === (editingId ?? '__new__')"
          data-action="contact-submit"
          @click="submit"
        >
          {{ t('contacts.save') }}
        </UButton>
      </div>
    </div>

    <span v-if="err" class="text-xs text-error">{{ err }}</span>
  </div>
</template>
