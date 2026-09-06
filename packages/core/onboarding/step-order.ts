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
 * Questions that are intentionally NOT steps:
 *
 *   - "source" (How did you hear about Multica?) is pure attribution
 *     data with zero user-facing payoff, so it no longer taxes the
 *     critical path. It is collected post-onboarding by the workspace
 *     source-backfill prompt, and only after agents have completed
 *     work for the user — see `needs-backfill.ts`.
 *   - "about_you" (the role / use_case questionnaire) was removed: it
 *     is marketing-style persona capture with no product payoff. The
 *     `role` / `use_case` slots in `QuestionnaireAnswers` stay — they
 *     share one JSONB column and PATCH endpoint with `source`, and
 *     simply remain unset.
 *
 * Runtime is the final form step. A connected path provisions Mika and opens
 * the interactive onboarding chat as part of the runtime step's submit action;
 * that chat is the product experience itself, not another progress-screen step.
 */
export const ONBOARDING_STEP_ORDER: readonly OnboardingStep[] = [
  "workspace",
  "runtime",
] as const;
