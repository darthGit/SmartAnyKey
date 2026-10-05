// Pluralization. Ukrainian has 3 forms (one/few/many); vue-i18n does not handle
// them by default, hence a custom rule. Single source: imported by i18n.config.ts
// (runtime) and tests/i18n/plural.spec.ts (test) — no drift.
export const pluralRules = {
  // choice → form index: 0=точка, 1=точки, 2=точок
  uk: (choice: number): number => {
    const n = Math.abs(choice)
    if (n % 10 === 1 && n % 100 !== 11)
      return 0
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14))
      return 1
    return 2
  },
}
