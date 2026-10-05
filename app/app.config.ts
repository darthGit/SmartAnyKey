// Colors + their mapping onto Nuxt UI. Token values live here / in main.css
// @theme, not in components.
export default defineAppConfig({
  ui: {
    colors: {
      // the reference's neon-violet accent (~#b76dff). violet is the closest
      // built-in Tailwind scale; an exact neon ramp is a tuning follow-up.
      primary: 'violet',
      // magenta accent (#fbabff)
      secondary: 'fuchsia',
      neutral: 'neutral',
    },
    // The Nuxt UI default pins the menu width to the trigger width
    // (`w-(--reka-*-trigger-width)`) → long options get truncated. Let the menu
    // grow to its content (w-fit), no narrower than the trigger, with a ceiling.
    // Globally — the theme in app.config, not per-instance. tailwind-merge
    // keeps the last width class; the rest of the theme (ring/animation/max-h) is untouched.
    select: { slots: { content: 'w-fit min-w-(--reka-select-trigger-width) max-w-[min(90vw,28rem)]' } },
    selectMenu: { slots: { content: 'w-fit min-w-(--reka-combobox-trigger-width) max-w-[min(90vw,28rem)]' } },
    // Dialog footer canon — actions on the right (dismiss → primary). The Nuxt
    // UI 4.9 slot default has no `justify` → buttons huddled left, and FileManager
    // wrapped them in its own `justify-end` → inconsistency between modals
    // (2026-07-24). One theme override instead of per-instance.
    modal: { slots: { footer: 'justify-end gap-2' } },
  },
})
