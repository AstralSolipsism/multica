import {
  type LocaleResources,
  type SupportedLocale,
} from "@multica/core/i18n";
import en from "./en";
import zhHans from "./zh-Hans";
import zhHant from "./zh-Hant";
import ko from "./ko";
import ja from "./ja";
import ru from "./ru";
import fr from "./fr";
import es from "./es";
import effectiveEn from "./effective/en";
import effectiveZhHans from "./effective/zh-Hans";
import effectiveZhHant from "./effective/zh-Hant";
import effectiveKo from "./effective/ko";
import effectiveJa from "./effective/ja";
import effectiveRu from "./effective/ru";
import effectiveFr from "./effective/fr";
import effectiveEs from "./effective/es";

// Shared <locale>.ts entries are the source of truth for namespace registrations.
// Add namespaces to every language entry. When adding a language, update its
// entry module, packages/views/package.json exports, and the web LocaleBundle's
// BUNDLES registration.
export const UPSTREAM_RESOURCES: Record<SupportedLocale, LocaleResources> = {
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  ko,
  ja,
  ru,
  fr,
  es,
};

// The effective bundles live in ./effective/<locale> — raw namespaces under
// the Labrastro brand overlay, with zh-Hant falling back to zh-Hans and the
// Spanish locale to English for fork copy that has not been translated yet —
// so web SSR, hydration, desktop, hot resource reloads and the per-locale web
// chunks all hand consumers the identical objects.
export const RESOURCES: Record<SupportedLocale, LocaleResources> = {
  en: effectiveEn,
  "zh-Hans": effectiveZhHans,
  "zh-Hant": effectiveZhHant,
  ko: effectiveKo,
  ja: effectiveJa,
  ru: effectiveRu,
  fr: effectiveFr,
  es: effectiveEs,
};
