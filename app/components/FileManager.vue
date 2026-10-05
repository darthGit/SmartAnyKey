<script setup lang="ts">
// Device SFTP file manager: pane
// kind 'sftp' in the split grid. Self-sufficient panel — fetches by deviceId via BFF
// /api/sftp/* (ssh2 SFTP, requireRole operator). Download/upload — blob via
// fetch, to carry the Bearer (a plain <a href> will not add the token).
// Strings via t() (ADR-006), Nuxt UI + Tailwind (ADR-004), no scoped CSS.
const props = defineProps<{ deviceId: string }>()
const { t, te } = useI18n()
// Error code → localised text; H3 passthrough (Unauthorized etc.) without
// its own key falls back to the generic sftp-error.
function errText(code: string, message: string): string {
  const key = `sftp.err.${code}`
  return te(key) ? t(key, message ? { message } : {}) : t('sftp.err.sftp-error')
}
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

interface Entry { name: string, type: 'dir' | 'file', size: number, mtime: number, mode: number }

const cwd = ref('/')
const entries = ref<Entry[]>([])
const loading = ref(false)
const error = ref<{ code: string, message: string } | null>(null)
const selected = ref<Set<string>>(new Set())
const busy = ref(false) // upload/CRUD in flight — block repeated actions

const base = computed(() => `/api/sftp/${props.deviceId}`)

// Directories first, then by name (readdir returns raw order).
const sorted = computed(() =>
  [...entries.value].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1),
)

// Breadcrumbs from cwd: [{name,path}], first = root.
const crumbs = computed(() => {
  const parts = cwd.value.split('/').filter(Boolean)
  const acc: { name: string, path: string }[] = [{ name: '/', path: '/' }]
  let p = ''
  for (const seg of parts) {
    p += `/${seg}`
    acc.push({ name: seg, path: p })
  }
  return acc
})

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

// Parent directory for the "up" button (null at root → button disabled).
const parent = computed(() => {
  if (cwd.value === '/')
    return null
  const i = cwd.value.lastIndexOf('/')
  return i <= 0 ? '/' : cwd.value.slice(0, i)
})

async function load() {
  loading.value = true
  error.value = null
  selected.value = new Set()
  try {
    entries.value = await $fetch<Entry[]>(`${base.value}/list`, {
      query: { path: cwd.value },
      headers: authHeaders.value,
    })
  }
  catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    error.value = { code: err.data?.statusMessage ?? 'sftp-error', message: err.message ?? '' }
    entries.value = []
  }
  finally {
    loading.value = false
  }
}

function enter(entry: Entry) {
  if (entry.type === 'dir')
    cwd.value = joinPath(cwd.value, entry.name)
}

watch(cwd, load)
onMounted(load)

// --- select --------------------------------------------------------------
function toggle(name: string) {
  const s = new Set(selected.value)
  if (s.has(name))
    s.delete(name)
  else
    s.add(name)
  selected.value = s
}
const allSelected = computed(() => entries.value.length > 0 && selected.value.size === entries.value.length)
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(entries.value.map(e => e.name))
}

// --- download (blob, to carry the Bearer) --------------------------------
async function downloadBlob(url: string, filename: string) {
  const blob = await $fetch<Blob>(url, { headers: authHeaders.value, responseType: 'blob' })
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  a.click()
  URL.revokeObjectURL(objectUrl)
}
function downloadFile(entry: Entry) {
  return downloadBlob(`${base.value}/download?path=${encodeURIComponent(joinPath(cwd.value, entry.name))}`, entry.name)
}
function downloadDir(entry: Entry) {
  return downloadBlob(`${base.value}/download-dir?path=${encodeURIComponent(joinPath(cwd.value, entry.name))}`, `${entry.name}.tar.gz`)
}

// --- upload (drag-drop, streamed body) -----------------------------------
const dragOver = ref(false)
async function uploadFiles(files: FileList | File[]) {
  busy.value = true
  try {
    for (const file of Array.from(files)) {
      await $fetch(`${base.value}/upload`, {
        method: 'POST',
        query: { path: joinPath(cwd.value, file.name) },
        headers: authHeaders.value,
        body: file,
      })
    }
    await load()
  }
  catch (e: unknown) {
    alert(t('sftp.uploadError', { message: (e as { message?: string }).message ?? '' }))
  }
  finally {
    busy.value = false
  }
}
function onDrop(e: DragEvent) {
  dragOver.value = false
  if (e.dataTransfer?.files.length)
    uploadFiles(e.dataTransfer.files)
}
const fileInput = ref<HTMLInputElement>()
function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.length)
    uploadFiles(input.files)
  input.value = ''
}

// --- name modal (mkdir / rename — one input) -----------------------------
const nameModal = ref<{ mode: 'mkdir' | 'rename', value: string, orig?: string } | null>(null)
async function submitName() {
  const m = nameModal.value
  if (!m || !m.value.trim())
    return
  busy.value = true
  try {
    if (m.mode === 'mkdir') {
      await $fetch(`${base.value}/mkdir`, { method: 'POST', headers: authHeaders.value, body: { path: joinPath(cwd.value, m.value.trim()) } })
    }
    else {
      await $fetch(`${base.value}/rename`, {
        method: 'POST',
        headers: authHeaders.value,
        body: { from: joinPath(cwd.value, m.orig!), to: joinPath(cwd.value, m.value.trim()) },
      })
    }
    nameModal.value = null
    await load()
  }
  catch (e: unknown) {
    alert(t('sftp.opError', { message: (e as { message?: string }).message ?? '' }))
  }
  finally {
    busy.value = false
  }
}

// --- delete (confirm modal; a directory is always recursive on the server)
const deleteModal = ref<{ names: string[] } | null>(null)
function askDelete(names: string[]) {
  if (names.length)
    deleteModal.value = { names }
}
async function confirmDelete() {
  const names = deleteModal.value?.names ?? []
  busy.value = true
  try {
    for (const name of names)
      await $fetch(`${base.value}/rm`, { method: 'DELETE', headers: authHeaders.value, body: { path: joinPath(cwd.value, name) } })
    deleteModal.value = null
    await load()
  }
  catch (e: unknown) {
    alert(t('sftp.opError', { message: (e as { message?: string }).message ?? '' }))
  }
  finally {
    busy.value = false
  }
}

// --- inline-edit (CodeEditor; size cap 413 → offer download) -------------
function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}
function editorLang(name: string): string {
  const e = ext(name)
  if (e === 'py')
    return 'python'
  if (['js', 'ts', 'json'].includes(e))
    return 'node'
  return 'shell'
}
const editModal = ref<{ name: string, content: string, readonly: boolean, saving: boolean } | null>(null)
// Open a file in the modal: row click → view (readonly), pencil →
// edit. A binary (415) or too large (413) is not loaded into the editor →
// offer download.
async function openInModal(entry: Entry, readonly: boolean) {
  busy.value = true
  try {
    const { content } = await $fetch<{ content: string }>(`${base.value}/read`, {
      query: { path: joinPath(cwd.value, entry.name) },
      headers: authHeaders.value,
    })
    editModal.value = { name: entry.name, content, readonly, saving: false }
  }
  catch (e: unknown) {
    const code = (e as { data?: { statusMessage?: string } }).data?.statusMessage
    if (code === 'binary-file' || code === 'file-too-large') {
      if (confirm(t(code === 'binary-file' ? 'sftp.binaryDownload' : 'sftp.tooLargeDownload')))
        await downloadFile(entry)
    }
    else {
      alert(t('sftp.opError', { message: (e as { message?: string }).message ?? '' }))
    }
  }
  finally {
    busy.value = false
  }
}
const openFile = (entry: Entry) => openInModal(entry, true) // view
const openEditor = (entry: Entry) => openInModal(entry, false) // edit
async function saveEdit() {
  const m = editModal.value
  if (!m)
    return
  m.saving = true
  try {
    await $fetch(`${base.value}/write`, {
      method: 'PUT',
      headers: authHeaders.value,
      body: { path: joinPath(cwd.value, m.name), content: m.content },
    })
    editModal.value = null
  }
  catch (e: unknown) {
    alert(t('sftp.opError', { message: (e as { message?: string }).message ?? '' }))
  }
  finally {
    if (editModal.value)
      editModal.value.saving = false
  }
}

// --- chmod (Base: permissions only; chown/chgrp out of scope) ------------
// rwx matrix (u/g/o × rwx) synced with the octal field — FileZilla/WinSCP convention.
const chmodModal = ref<{ name: string, mode: number, saving: boolean } | null>(null)
const chmodGroups = [
  { label: 'sftp.permOwner', shift: 6 },
  { label: 'sftp.permGroup', shift: 3 },
  { label: 'sftp.permOther', shift: 0 },
]
const chmodPerms = [{ key: 'r', bit: 4 }, { key: 'w', bit: 2 }, { key: 'x', bit: 1 }]
function openChmod(entry: Entry) {
  chmodModal.value = { name: entry.name, mode: entry.mode & 0o777, saving: false }
}
const chmodOctal = computed<string>({
  get: () => (chmodModal.value?.mode ?? 0).toString(8).padStart(3, '0'),
  set: (v: string) => {
    if (chmodModal.value && /^[0-7]{1,3}$/.test(v))
      chmodModal.value.mode = Number.parseInt(v, 8)
  },
})
function chmodHas(shift: number, bit: number): boolean {
  return !!chmodModal.value && ((chmodModal.value.mode >> shift) & bit) !== 0
}
function chmodToggle(shift: number, bit: number) {
  if (chmodModal.value)
    chmodModal.value.mode ^= (bit << shift)
}
async function saveChmod() {
  const m = chmodModal.value
  if (!m)
    return
  m.saving = true
  try {
    await $fetch(`${base.value}/chmod`, {
      method: 'PUT',
      headers: authHeaders.value,
      body: { path: joinPath(cwd.value, m.name), mode: m.mode },
    })
    chmodModal.value = null
    await load()
  }
  catch (e: unknown) {
    alert(t('sftp.opError', { message: (e as { message?: string }).message ?? '' }))
  }
  finally {
    if (chmodModal.value)
      chmodModal.value.saving = false
  }
}

// --- format --------------------------------------------------------------
function humanSize(n: number): string {
  if (n < 1024)
    return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
function fmtDate(mtime: number): string {
  return new Date(mtime * 1000).toLocaleString()
}
function fmtMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0')
}
</script>

<template>
  <div
    class="flex flex-col h-full min-h-0 bg-default"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
    <!-- toolbar: back(up) + breadcrumb + actions -->
    <div class="flex items-center gap-1 flex-wrap px-2 py-1 border-b border-default text-xs">
      <UButton icon="i-lucide-arrow-left" size="xs" variant="ghost" color="neutral" :disabled="!parent || busy || loading" :title="t('sftp.back')" :aria-label="t('sftp.back')" @click="parent && (cwd = parent)" />
      <nav class="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto font-mono">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i > 0" class="text-muted">/</span>
          <button class="px-1 rounded hover:bg-elevated text-highlighted shrink-0" @click="cwd = c.path">{{ c.name }}</button>
        </template>
      </nav>
      <UButton icon="i-lucide-folder-plus" size="xs" variant="ghost" color="neutral" :disabled="busy" :title="t('sftp.newFolder')" :aria-label="t('sftp.newFolder')" @click="nameModal = { mode: 'mkdir', value: '' }" />
      <UButton icon="i-lucide-upload" size="xs" variant="ghost" color="neutral" :disabled="busy" :title="t('sftp.upload')" :aria-label="t('sftp.upload')" @click="fileInput?.click()" />
      <UButton icon="i-lucide-refresh-cw" size="xs" variant="ghost" color="neutral" :disabled="busy || loading" :title="t('sftp.refresh')" :aria-label="t('sftp.refresh')" @click="load" />
      <input ref="fileInput" type="file" multiple class="hidden" @change="onPick">
    </div>

    <!-- bulk actions on selection -->
    <div v-if="selected.size" class="flex items-center gap-2 px-2 py-1 border-b border-default bg-elevated text-xs">
      <span class="text-muted">{{ t('sftp.selectedCount', { n: selected.size }) }}</span>
      <UButton icon="i-lucide-trash-2" size="xs" variant="ghost" color="error" :disabled="busy" @click="askDelete([...selected])">
        {{ t('sftp.deleteSelected') }}
      </UButton>
    </div>

    <!-- list -->
    <div class="flex-1 min-h-0 overflow-auto relative" :class="{ 'ring-2 ring-primary ring-inset': dragOver }">
      <div v-if="loading" class="p-4 text-center text-sm text-muted">{{ t('sftp.loading') }}</div>

      <div v-else-if="error" class="p-4 text-sm space-y-2">
        <p class="text-error">{{ errText(error.code, error.message) }}</p>
        <p class="text-muted text-xs">{{ t('sftp.errHint') }}</p>
        <UButton size="xs" variant="soft" color="neutral" @click="load">{{ t('sftp.retry') }}</UButton>
      </div>

      <div v-else-if="!entries.length" class="p-6 text-center text-sm text-muted space-y-2">
        <UIcon name="i-lucide-folder-open" class="size-8 opacity-40" />
        <p>{{ t('sftp.empty') }}</p>
        <p class="text-xs">{{ t('sftp.emptyHint') }}</p>
      </div>

      <table v-else class="w-full text-sm">
        <!-- sticky header: the background must be on the th cells (not only on thead) —
             with border-collapse:separate transparent cells let through rows that
             scroll under the header; z-10 so it paints above the body. -->
        <thead class="sticky top-0 z-10 text-xs text-muted border-b border-default [&_th]:bg-default">
          <tr>
            <th class="w-8 px-2 py-1"><UCheckbox :model-value="allSelected" :aria-label="t('sftp.selectAll')" @update:model-value="toggleAll" /></th>
            <th class="text-left px-2 py-1 font-medium">{{ t('sftp.colName') }}</th>
            <th class="text-right px-2 py-1 font-medium hidden sm:table-cell">{{ t('sftp.colSize') }}</th>
            <th class="text-left px-2 py-1 font-medium hidden md:table-cell">{{ t('sftp.colModified') }}</th>
            <th class="text-right px-2 py-1 font-mono font-medium hidden md:table-cell">{{ t('sftp.colMode') }}</th>
            <th class="w-px px-2 py-1" />
          </tr>
        </thead>
        <tbody>
          <!-- The whole row is clickable (list convention): dir → navigate, file →
               open. Checkbox and actions — @click.stop, so the file does not open. -->
          <tr
            v-for="entry in sorted"
            :key="entry.name"
            class="border-b border-muted hover:bg-elevated group cursor-pointer"
            :title="entry.type === 'dir' ? t('sftp.openFolder') : t('sftp.openFile')"
            @click="entry.type === 'dir' ? enter(entry) : openFile(entry)"
          >
            <td class="px-2 py-1" @click.stop><UCheckbox :model-value="selected.has(entry.name)" :aria-label="entry.name" @update:model-value="toggle(entry.name)" /></td>
            <td class="px-2 py-1 min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <UIcon :name="entry.type === 'dir' ? 'i-lucide-folder' : 'i-lucide-file'" class="shrink-0" :class="entry.type === 'dir' ? 'text-primary' : 'text-muted'" />
                <span class="min-w-0 truncate" :title="entry.name">{{ entry.name }}</span>
              </div>
            </td>
            <td class="px-2 py-1 text-right font-mono text-xs text-muted hidden sm:table-cell">{{ entry.type === 'dir' ? '—' : humanSize(entry.size) }}</td>
            <td class="px-2 py-1 text-xs text-muted hidden md:table-cell whitespace-nowrap">{{ fmtDate(entry.mtime) }}</td>
            <td class="px-2 py-1 text-right font-mono text-xs text-muted hidden md:table-cell">{{ fmtMode(entry.mode) }}</td>
            <td class="px-2 py-1" @click.stop>
              <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <UButton v-if="entry.type === 'file'" icon="i-lucide-pencil" size="xs" variant="ghost" color="neutral" :disabled="busy" :title="t('sftp.edit')" :aria-label="t('sftp.edit')" @click="openEditor(entry)" />
                <UButton icon="i-lucide-download" size="xs" variant="ghost" color="neutral" :disabled="busy" :title="t('sftp.download')" :aria-label="t('sftp.download')" @click="entry.type === 'dir' ? downloadDir(entry) : downloadFile(entry)" />
                <UButton icon="i-lucide-shield" size="xs" variant="ghost" color="neutral" :disabled="busy" :title="t('sftp.chmod')" :aria-label="t('sftp.chmod')" @click="openChmod(entry)" />
                <UButton icon="i-lucide-pen-line" size="xs" variant="ghost" color="neutral" :disabled="busy" :title="t('sftp.rename')" :aria-label="t('sftp.rename')" @click="nameModal = { mode: 'rename', value: entry.name, orig: entry.name }" />
                <UButton icon="i-lucide-trash-2" size="xs" variant="ghost" color="error" :disabled="busy" :title="t('sftp.delete')" :aria-label="t('sftp.delete')" @click="askDelete([entry.name])" />
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="dragOver" class="absolute inset-0 flex items-center justify-center bg-default/70 pointer-events-none text-sm text-primary font-medium">
        {{ t('sftp.dropHere') }}
      </div>
    </div>

    <!-- name modal (mkdir / rename) -->
    <UModal v-if="nameModal" :open="true" :title="nameModal.mode === 'mkdir' ? t('sftp.newFolder') : t('sftp.rename')" @update:open="nameModal = null">
      <template #body>
        <UInput v-model="nameModal.value" autofocus class="w-full" :placeholder="t('sftp.namePlaceholder')" @keydown.enter="submitName" />
      </template>
      <template #footer>
        <UButton variant="ghost" color="neutral" @click="nameModal = null">{{ t('sftp.cancel') }}</UButton>
        <UButton color="primary" :loading="busy" @click="submitName">{{ t('sftp.confirm') }}</UButton>
      </template>
    </UModal>

    <!-- delete confirm -->
    <UModal v-if="deleteModal" :open="true" :title="t('sftp.deleteTitle')" @update:open="deleteModal = null">
      <template #body>
        <p class="text-sm">{{ t('sftp.deleteConfirm', { n: deleteModal.names.length }) }}</p>
        <p class="mt-1 text-xs text-muted font-mono truncate">{{ deleteModal.names.join(', ') }}</p>
        <p class="mt-2 text-xs text-warning">{{ t('sftp.deleteWarning') }}</p>
      </template>
      <template #footer>
        <UButton variant="ghost" color="neutral" @click="deleteModal = null">{{ t('sftp.cancel') }}</UButton>
        <UButton color="error" :loading="busy" @click="confirmDelete">{{ t('sftp.delete') }}</UButton>
      </template>
    </UModal>

    <!-- view / edit a file. The modal is resizable (both axes) — handle
         bottom-right; the fill editor fills the body. Large by default, min/max
         bounds in vh/vw so it does not go off-screen. -->
    <UModal
      v-if="editModal"
      :open="true"
      :title="editModal.name"
      :ui="{ content: 'w-[60rem] max-w-[94vw] h-[34rem] min-w-80 min-h-64 max-h-[92vh] resize overflow-hidden', body: 'flex-1 min-h-0 overflow-hidden' }"
      @update:open="editModal = null"
    >
      <template #body>
        <CodeEditor v-model="editModal.content" :language="editorLang(editModal.name)" :readonly="editModal.readonly" fill />
      </template>
      <template #footer>
        <UButton variant="ghost" color="neutral" @click="editModal = null">{{ t('sftp.close') }}</UButton>
        <UButton v-if="editModal.readonly" color="primary" icon="i-lucide-pencil" @click="editModal.readonly = false">{{ t('sftp.edit') }}</UButton>
        <UButton v-else color="primary" :loading="editModal.saving" @click="saveEdit">{{ t('sftp.save') }}</UButton>
      </template>
    </UModal>

    <!-- chmod (permissions; chown/chgrp out of scope) -->
    <UModal v-if="chmodModal" :open="true" :title="`${t('sftp.chmod')} — ${chmodModal.name}`" @update:open="chmodModal = null">
      <template #body>
        <table class="text-sm">
          <thead>
            <tr class="text-xs text-muted">
              <th class="text-left px-2 py-1" />
              <th v-for="p in chmodPerms" :key="p.key" class="px-3 py-1 font-mono">{{ p.key }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="grp in chmodGroups" :key="grp.shift">
              <td class="px-2 py-1">{{ t(grp.label) }}</td>
              <td v-for="p in chmodPerms" :key="p.key" class="px-3 py-1 text-center">
                <UCheckbox
                  :model-value="chmodHas(grp.shift, p.bit)"
                  :aria-label="`${t(grp.label)} ${p.key}`"
                  @update:model-value="chmodToggle(grp.shift, p.bit)"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <div class="mt-3 flex items-center gap-2">
          <span class="text-xs text-muted">{{ t('sftp.chmodOctal') }}</span>
          <UInput v-model="chmodOctal" class="w-24 font-mono" maxlength="3" />
        </div>
      </template>
      <template #footer>
        <UButton variant="ghost" color="neutral" @click="chmodModal = null">{{ t('sftp.cancel') }}</UButton>
        <UButton color="primary" :loading="chmodModal.saving" @click="saveChmod">{{ t('sftp.save') }}</UButton>
      </template>
    </UModal>
  </div>
</template>
