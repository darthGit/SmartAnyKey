# Localization

The UI is fully localized — no hardcoded strings (ADR-006). English
(`locales/en.json`) is the canonical base and fallback; every other locale
mirrors its keys.

## Add a language

1. Copy `locales/en.json` → `locales/<code>.json` (e.g. `de.json`).
2. Translate the **values**, keep the **keys** unchanged.
3. Register it in `nuxt.config.ts` → `i18n.locales`:
   ```ts
   { code: 'de', name: 'Deutsch', file: 'de.json' }
   ```
4. If the language has non-trivial plural rules (Slavic, Arabic, …), add a
   rule for it in `pluralRules.ts` (see `uk`). English/German need none.
5. Run `pnpm check:i18n` — it fails, listing any key present in `en.json`
   but missing in your file (also runs in pre-commit / CI).

That's it — the language appears in the in-app switcher automatically.

## Notes

- `pointsCount` uses the plural pipe syntax: `en` has 2 forms, `uk` has 3
  (via `pluralRules.uk`). Match your language's form count.
- User data (device type names, addresses) is **not** localized — it comes
  from the database, not these files.
