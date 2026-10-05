<script setup lang="ts">
// CodeMirror 6 wrapper. Dynamic import — CM does not get into the board bundle,
// only onto the admin page (accepted ceiling). Highlighting by language;
// v-model string. Language change → recreate the state (no reconfigure ceremony).
import type { EditorView } from '@codemirror/view'

// fill: fill the parent (h/w-full) — for cases where the container itself
// resizes (e.g. the resizable SFTP modal). Without fill — own resize handle (admin).
const props = defineProps<{ modelValue: string, language?: string, readonly?: boolean, fill?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const el = ref<HTMLElement>()
let view: EditorView | null = null

async function languageExt(lang?: string) {
  switch (lang) {
    case 'python': return (await import('@codemirror/lang-python')).python()
    case 'node': return (await import('@codemirror/lang-javascript')).javascript()
    default: {
      // raw/bash → shell mode (RouterOS/sh are close enough for highlighting)
      const { StreamLanguage } = await import('@codemirror/language')
      const { shell } = await import('@codemirror/legacy-modes/mode/shell')
      return StreamLanguage.define(shell)
    }
  }
}

// VSCode Dark+ look without a new dependency (theme-one-dark is not installed):
// own theme + highlight on the existing @codemirror/@lezer packages.
async function themeExts() {
  const { EditorView } = await import('@codemirror/view')
  const { HighlightStyle, syntaxHighlighting } = await import('@codemirror/language')
  const { tags: t } = await import('@lezer/highlight')

  const theme = EditorView.theme({
    '&': { color: '#d4d4d4', backgroundColor: '#1e1e1e' },
    '.cm-content': { caretColor: '#aeafad' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#aeafad' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#264f78' },
    '.cm-activeLine': { backgroundColor: '#ffffff0d' },
    '.cm-gutters': { backgroundColor: '#1e1e1e', color: '#858585', border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: '#ffffff0d' },
    // Autocomplete is moved to body (not clamped by the container) — theme styles
    // still apply to the tooltip; z-index above the modal.
    '.cm-tooltip': { backgroundColor: '#252526', border: '1px solid #454545', color: '#d4d4d4', zIndex: '9999' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#04395e', color: '#fff' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { color: '#d4d4d4' },
  }, { dark: true })

  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#569cd6' },
    { tag: [t.bool, t.null, t.atom], color: '#569cd6' },
    { tag: [t.string, t.special(t.string), t.character], color: '#ce9178' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: '#6a9955', fontStyle: 'italic' },
    { tag: [t.number, t.integer, t.float], color: '#b5cea8' },
    { tag: t.function(t.variableName), color: '#dcdcaa' },
    { tag: [t.variableName, t.propertyName, t.definition(t.variableName)], color: '#9cdcfe' },
    { tag: [t.typeName, t.className, t.namespace], color: '#4ec9b0' },
    { tag: t.regexp, color: '#d16969' },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: '#d4d4d4' },
    { tag: [t.meta, t.processingInstruction], color: '#569cd6' },
  ])
  return [theme, syntaxHighlighting(highlight)]
}

/**
 * Keys that `basicSetup` does NOT provide (developer complaint 2026-08-13).
 * CM6 upstream deliberately does not bind `Tab`: otherwise a keyboard user
 * cannot leave the editor for the next form field. But an editor without
 * Tab indentation is not a code editor, so we bind it ourselves, with Escape as the exit:
 *  - completion popup open → Tab accepts it (VS Code habit; before this
 *    Tab threw focus to the next field of the task form and the completion was lost);
 *  - otherwise Tab inserts indentation at the cursor (like VS Code), Shift-Tab removes it;
 *  - Escape leaves the editor (so Tab navigation through the form stays reachable).
 *    When the popup is open, Escape closes it first (the basicSetup default has
 *    higher priority and returns true), and only the next Escape drops focus.
 */
async function editorKeys() {
  const { keymap } = await import('@codemirror/view')
  const { acceptCompletion } = await import('@codemirror/autocomplete')
  const { indentLess, insertTab } = await import('@codemirror/commands')
  return keymap.of([
    // `acceptCompletion` returns false if there is no popup → fall through to the next.
    { key: 'Tab', run: acceptCompletion },
    // `insertTab`, NOT `indentWithTab`/`indentMore`: those shift the whole
    // line even when the cursor is mid-word (developer complaint
    // 2026-08-13). `insertTab` behaves like VS Code: empty selection →
    // indentation at the cursor; multi-line selection → lines shifted.
    { key: 'Tab', run: insertTab, shift: indentLess },
    { key: 'Escape', run: (v) => { v.contentDOM.blur(); return true } },
  ])
}

async function build(doc: string) {
  const { EditorView, basicSetup } = await import('codemirror')
  const { EditorState } = await import('@codemirror/state')
  const { tooltips } = await import('@codemirror/view')
  view?.destroy()
  view = new EditorView({
    parent: el.value!,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        EditorState.readOnly.of(!!props.readonly),
        EditorView.editable.of(!props.readonly),
        ...(await themeExts()),
        await editorKeys(),
        tooltips({ parent: document.body }), // move the autocomplete popup out of the overflow-hidden container
        await languageExt(props.language),
        EditorView.updateListener.of((v) => {
          if (v.docChanged)
            emit('update:modelValue', v.state.doc.toString())
        }),
      ],
    }),
  })
}

onMounted(() => build(props.modelValue))
watch(() => props.language, () => build(view?.state.doc.toString() ?? props.modelValue))
// View→edit transition (readonly toggle) → recreate the editable state.
watch(() => props.readonly, () => build(view?.state.doc.toString() ?? props.modelValue))
// External change (opening edit/new) → sync if it diverged.
watch(() => props.modelValue, (v) => {
  if (view && v !== view.state.doc.toString())
    build(v)
})
onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <!-- fill → fills the parent (the parent controls size, e.g. a resizable modal).
       Without fill → own vertical handle. Horizontal is deliberately NOT resizable here:
       the container sets the editor width, so that is what to stretch
       (`:ui.content` of a modal with `resize`, like inline-edit in FileManager) — a handle on
       the child itself would only conflict with the modal's `max-w`. -->
  <div
    ref="el"
    class="overflow-hidden rounded border border-default text-sm [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
    :class="fill ? 'h-full w-full' : 'h-80 min-h-48 max-h-[75vh] w-full resize-y'"
  />
</template>
