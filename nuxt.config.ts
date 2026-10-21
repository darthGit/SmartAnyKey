export default defineNuxtConfig({
  // ADR 001: internal tool behind auth — SPA, no SSR
  ssr: false,
  compatibilityDate: '2026-07-07',
  // ADR-007: interactive SSH = xterm ↔ Nitro-ws ↔ ssh2 (server/routes/api/terminal)
  nitro: {
    // ADR-007 ws (SSH/guac) + ADR-015 scheduled tasks (drift rescan):
    // per-point cadence picked up every minute.
    experimental: { websocket: true, tasks: true },
    scheduledTasks: { '* * * * *': ['discovery:rescan', 'tasks:tick'], '17 4 * * *': ['update:check'] },
  },
  // ADR-010: pre-bundle guacamole-common-js so Vite does not discover it
  // on the fly mid dev session (re-optimize + reload crashed dev with an unhandled
  // ECONNRESET). The client-side (browser) guac client.
  vite: {
    optimizeDeps: { include: ['guacamole-common-js'] },
  },
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxtjs/i18n',
    '@nuxtjs/supabase',
  ],
  css: ['~/assets/css/main.css'],
  // Internal/LAN tool → offline: bundle lucide icons locally (the BFF serves
  // /api/_nuxt_icon/*), NOT a runtime fetch from api.iconify.design (unreachable in
  // offline prod → every icon, incl. the checkbox tick, broke = a "foreign
  // glyph"). Needs @iconify-json/lucide (devDep). The kit's whole lucide palette.
  // `provider: 'server'` is required: with `ssr: false` the module defaults to `iconify`
  // and then silently disables `serverBundle` (@nuxt/icon 2.3.1 module.mjs:385, :507);
  // the CSP `connect-src` blocks that API anyway.
  icon: {
    provider: 'server',
    serverBundle: 'local',
    fallbackToApi: false,
  },
  // ADR-006: base en (fallback), no_prefix (internal tool, no SEO).
  // A fresh visit gets the browser language with fallback to en; a manual choice persists
  // in a cookie. Plural/fallback — i18n/i18n.config.ts.
  i18n: {
    vueI18n: 'i18n.config.ts',
    strategy: 'no_prefix',
    defaultLocale: 'en',
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'uk', name: 'Українська', file: 'uk.json' },
    ],
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'i18n_locale',
      fallbackLocale: 'en',
      redirectOn: 'root',
    },
  },
  // Internal tool → dark-first (control-room aesthetic)
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
  },
  supabase: {
    redirectOptions: {
      login: '/login',
      callback: '/login',
      // `/setup` is the only route without auth (ADR-021), and without this line
      // it is unreachable in principle: the module sends any unauthenticated
      // path to /login, and `first-run.global.ts` sends it back to /setup while
      // there are zero admins → an endless redirect loop (measured in a clean
      // room 2026-09-18: the page never reached a stable state at all).
      exclude: ['/setup'],
    },
    // Do not derive from the Supabase URL — ADR-019.
    cookiePrefix: 'sak-auth-token',
    cookieOptions: {
      // http install: a Secure cookie does not stick. TLS → env override. ADR-019.
      secure: false,
    },
  },
  runtimeConfig: {
    // NUXT_CRED_ENCRYPTION_KEY — AES-256-GCM credentials key (ADR-009), 64 hex
    credEncryptionKey: '',
    // guacd for the ws bridge (ADR-010): the BFF bridges browser↔guacd directly.
    // NUXT_GUACD_HOST / NUXT_GUACD_PORT — the locally published guacd (docker).
    guacdHost: '127.0.0.1',
    guacdPort: '4822',
    // ADR-016: local tasks go to an isolated executor service (internal HTTP
    // + shared secret). NUXT_EXECUTOR_URL / NUXT_EXECUTOR_SECRET.
    executorUrl: 'http://127.0.0.1:8090/run',
    executorSecret: '',
    // Registry of task runners — JSON `{"<runtime>":"<url>"}`. Empty = no runner
    // configured (like empty rule tables, no domain defaults): which runtimes an
    // installation has is its property, not our knowledge. Adding `python313`/`ansible`
    // = a line here, no code or migration change. NUXT_TASK_RUNNERS
    taskRunners: '',
    // The running version: the image bakes the release tag in (Dockerfile SAK_VERSION →
    // NUXT_APP_VERSION); a host-side `pnpm dev` stays `dev`, which never counts as outdated.
    appVersion: 'dev',
    // owner/repo whose latest GitHub release is checked daily. Empty = no outbound request at
    // all (closed networks). The default lives in compose, not here. NUXT_UPDATE_REPO
    updateRepo: '',
    public: {
      // How many trailing phone digits count as a match
      // (so +380671234567 and 0671234567 find the same point).
      // Public, because the client-side board search does the same match.
      // Empty = exact match only; there is deliberately no default in code — the length
      // of the national part is a property of the deployment's country.
      // NUXT_PUBLIC_PHONE_MATCH_TAIL
      phoneMatchTail: '',
      // External app address — needed where we build a link for a reader
      // outside the browser (a link to the run in the sink notification body).
      // Empty = the link is simply not added; there is deliberately no default in code —
      // the deployment address is deployment-specific, belongs in config. NUXT_PUBLIC_APP_URL
      appUrl: '',
    },
  },
})
