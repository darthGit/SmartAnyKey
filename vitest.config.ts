import { defineVitestConfig } from '@nuxt/test-utils/config'
import { configDefaults } from 'vitest/config'

// Wrapped with @nuxt/test-utils so specs can opt into the Nuxt runtime env
// via `// @vitest-environment nuxt` (component tests need auto-imports and,
// post-migration, Nuxt UI components). Node/server specs keep the default env.
//
// `SAK_TEST_CI=1` (= `pnpm test:ci`) excludes tests/integration/**, which
// need a live Supabase — otherwise CI without the stack is always red.
// ⚠ The exclusion must live here, in the config: the CLI flag `vitest run --exclude
// 'tests/integration/**'` filters NOTHING (measured with `vitest list --filesOnly`
// 2026-09-04: 87 files and 14 integration specs both with it and without). That
// flag looks working and silently does not — do not bring it back.
export const CI_EXCLUDE = 'tests/integration/**'

export default defineVitestConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: process.env.SAK_TEST_CI
      ? [...configDefaults.exclude, CI_EXCLUDE]
      : configDefaults.exclude,
    setupFiles: ['tests/helpers/load-env.ts', 'tests/helpers/setup-i18n.ts'],
  },
})
