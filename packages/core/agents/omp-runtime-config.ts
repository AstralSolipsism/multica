// OMP (Oh My Pi)-specific `runtime_config` schema (OL-1261).
//
// Stored under `agent.runtime_config` as freeform JSONB; only meaningful for
// agents whose runtime provider is omp. The daemon decodes the same schema in
// `server/pkg/agent/omp_runtime.go` and maps it onto OMP launch flags — keep
// both sides in lockstep when changing field names.

export type OmpAdvisorReviewMode = "turn" | "agent-end";
export type OmpExecutionMode = "standard" | "plan_yolo" | "prewalk";

export interface OmpRuntimeConfig {
  /** Cheap model for lightweight internal work (`--smol`). */
  smolModel?: string;
  /** Slow/reasoning model, also the advisor reviewer (`--slow`). */
  slowModel?: string;
  /** Plan-mode model (`--plan`). */
  planModel?: string;
  advisorEnabled?: boolean;
  /** Advisor review cadence; OMP's own default is "turn". */
  advisorReviewMode?: OmpAdvisorReviewMode;
  /** "standard" is the default and normalized away on parse. */
  executionMode?: OmpExecutionMode;
  /** Handoff target for plan_yolo / prewalk (`--plan-yolo-into` / `--prewalk-into`). */
  handoffModel?: string;
}

const ompWireKeys = [
  "smol_model",
  "slow_model",
  "plan_model",
  "handoff_model",
  "advisor_enabled",
  "advisor_review_mode",
  "execution_mode",
] as const;

const advisorReviewModes: readonly OmpAdvisorReviewMode[] = ["turn", "agent-end"];
const executionModes: readonly OmpExecutionMode[] = ["standard", "plan_yolo", "prewalk"];

function parseModelField(root: Record<string, unknown>, key: string): string | undefined {
  const value = root[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// Parse an arbitrary runtime_config payload into the typed schema. Unknown
// keys are dropped and malformed payloads collapse to an empty object, so a
// broken save renders as defaults instead of blocking the UI.
export function parseOmpRuntimeConfig(raw: unknown): OmpRuntimeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const root = raw as Record<string, unknown>;
  const out: OmpRuntimeConfig = {};
  out.smolModel = parseModelField(root, "smol_model");
  out.slowModel = parseModelField(root, "slow_model");
  out.planModel = parseModelField(root, "plan_model");
  out.handoffModel = parseModelField(root, "handoff_model");
  if (root.advisor_enabled === true) out.advisorEnabled = true;
  if (
    typeof root.advisor_review_mode === "string" &&
    advisorReviewModes.includes(root.advisor_review_mode as OmpAdvisorReviewMode)
  ) {
    out.advisorReviewMode = root.advisor_review_mode as OmpAdvisorReviewMode;
  }
  if (
    typeof root.execution_mode === "string" &&
    executionModes.includes(root.execution_mode as OmpExecutionMode) &&
    root.execution_mode !== "standard"
  ) {
    out.executionMode = root.execution_mode as OmpExecutionMode;
  }
  return out;
}

// Render the typed form state back into the wire shape. Only carries fields
// the user actually populated; "standard" execution mode is the default and
// never serialized.
export function serializeOmpRuntimeConfig(
  cfg: OmpRuntimeConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (cfg.smolModel) out.smol_model = cfg.smolModel;
  if (cfg.slowModel) out.slow_model = cfg.slowModel;
  if (cfg.planModel) out.plan_model = cfg.planModel;
  if (cfg.handoffModel) out.handoff_model = cfg.handoffModel;
  if (cfg.advisorEnabled) out.advisor_enabled = true;
  if (cfg.advisorReviewMode) out.advisor_review_mode = cfg.advisorReviewMode;
  if (cfg.executionMode && cfg.executionMode !== "standard") {
    out.execution_mode = cfg.executionMode;
  }
  return out;
}

// Stable shallow equality across two parsed configs, used by the form's dirty
// detector. Absent and default-normalized values compare equal.
export function ompRuntimeConfigEquals(
  a: OmpRuntimeConfig,
  b: OmpRuntimeConfig,
): boolean {
  return (
    (a.smolModel ?? "") === (b.smolModel ?? "") &&
    (a.slowModel ?? "") === (b.slowModel ?? "") &&
    (a.planModel ?? "") === (b.planModel ?? "") &&
    (a.handoffModel ?? "") === (b.handoffModel ?? "") &&
    Boolean(a.advisorEnabled) === Boolean(b.advisorEnabled) &&
    (a.advisorReviewMode ?? "") === (b.advisorReviewMode ?? "") &&
    (a.executionMode ?? "") === (b.executionMode ?? "")
  );
}

// Remove the OMP-only keys from an arbitrary runtime_config record, returning
// the surviving provider-neutral / other-provider keys (possibly `{}`).
// Runtime switching (model-change-cleanup pattern): settings that only the
// omp CLI understands must not linger on an agent rebound to another runtime.
export function stripOmpRuntimeConfig(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!(ompWireKeys as readonly string[]).includes(key)) {
      out[key] = value;
    }
  }
  return out;
}
