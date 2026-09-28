import type { OnboardingStep } from "./types";

/**
 * Canonical order of the persisted onboarding steps.
 *
 * Single source of truth for "what step comes after what" — consumed
 * by the UI progress indicator to compute `index of current_step` and
 * `total step count`. Inserting, reordering, or removing a step only
 * requires changing this array; every call site that reads it updates
 * automatically.
 *
 * Intentionally excludes "welcome": welcome is a first-entry product
 * intro, not a persisted step. It doesn't show a progress indicator
 * for the same reason — users shouldn't think of reading the intro
 * as progress toward completing setup.
 *
 * The fork excludes source, role and use-case questionnaires (OL-14).
 * Keep this product constraint when adopting upstream onboarding changes.
 * Historical answers remain server data; setup never rewrites them.
 *
 * Runtime is the final form step. A connected path provisions Mika and opens
 * the interactive onboarding chat as part of the runtime step's submit action;
 * that chat is the product experience itself, not another progress-screen step.
 */
export const ONBOARDING_STEP_ORDER: readonly OnboardingStep[] = [
  "workspace",
  "runtime",
] as const;
