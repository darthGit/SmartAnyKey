# Architecture decisions

Code comments cite decisions as `ADR-NNN`. This is the register those numbers
resolve to: what was decided, in one line. A decision is never edited away — a
new one supersedes it and the old row says so.

| ADR | Decision | Status |
| :-- | :-- | :-- |
| 001 | Nuxt SPA + Nitro as the single server runtime | ACCEPTED |
| 002 | Supabase as the backend (Postgres + Auth + Realtime) | ACCEPTED |
| 003 | Apache Guacamole as the remote-access engine | ACCEPTED |
| 004 | UI layer: Nuxt UI (Tailwind + component library) | ACCEPTED |
| 005 | Device monitoring strategy | ACCEPTED |
| 006 | i18n strategy | ACCEPTED |
| 007 | Interactive SSH terminal (xterm.js), amends 003 | ACCEPTED |
| 008 | Session tiling: own recursive tree + flat-positioned rendering | ACCEPTED |
| 009 | Credential manager: named sets + 4-level resolve + AES-256-GCM at rest | ACCEPTED |
| 010 | Graphical access = guacamole-common-js + ws bridge to guacd (no iframe), amends 003/007 | ACCEPTED |
| 011 | `task_run` as a generic execution substrate | ACCEPTED |
| 012 | Auto-discovery: domain-agnostic recon + client-taught rule engine | ACCEPTED |
| 013 | RBAC: coarse global roles (admin / operator / viewer) | ACCEPTED |
| 014 | Tier-B internal probe: reuse the SSH substrate, fingerprint on the device | ACCEPTED |
| 015 | Rescan scheduler = Nitro scheduled tasks (in-process cron in the BFF) | ACCEPTED |
| 016 | Local tasks = an isolated executor service (separate container) | ACCEPTED |
| 017 | Point contacts: flat table, free-form `kind`, country-free normalisation | ACCEPTED |
| 018 | Task runtimes = registry data + cached environments in one harness | ACCEPTED |
| 019 | Session cookie: fixed prefix + `secure` as an installation setting | ACCEPTED |
| 020 | Delivery = image + compose, two paths, ops through the image | ACCEPTED |
| 021 | First-run initialisation: unauthenticated `/setup` + address from the host | ACCEPTED |
| 022 | The public repository is an incremental export of a private monorepo | SUPERSEDED by 025 |
| 023 | Infrastructure composition: only the services the product uses | ACCEPTED |
| 024 | Demo mode is a separate compose overlay, enabled by `install.sh --demo` | ACCEPTED |
| 025 | Code is developed in this public repository directly; the export of 022 ends at the switch-over | ACCEPTED |
| 026 | Sign-in: TOTP second factor enforced by the server; automation gets its own narrow tokens | ACCEPTED |
