"use client";

import { useId, type ReactNode } from "react";
import {
  ompRuntimeConfigHandoffMissing,
  type OmpAdvisorReviewMode,
  type OmpExecutionMode,
  type OmpRuntimeConfig,
} from "@multica/core/agents";
import { Switch } from "@multica/ui/components/ui/switch";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "../../settings/components/settings-layout";
import { ModelPicker } from "./inspector/model-picker";

export function OmpRuntimeConfigPanel({
  provider,
  runtimeId,
  runtimeOnline,
  mainModel,
  value,
  canEdit,
  onChange,
  headerAction,
  compact = false,
}: {
  provider?: string;
  runtimeId: string | null;
  runtimeOnline: boolean;
  mainModel: string;
  value: OmpRuntimeConfig;
  canEdit: boolean;
  onChange: (next: OmpRuntimeConfig) => void;
  headerAction?: ReactNode;
  compact?: boolean;
}) {
  const { t } = useT("agents");
  const id = useId();
  if (provider !== "omp") return null;

  const executionMode = value.executionMode ?? "standard";
  const handoffMissing = ompRuntimeConfigHandoffMissing(value);
  const set = (next: Partial<OmpRuntimeConfig>) => onChange({ ...value, ...next });
  const modelPicker = (
    model: string | undefined,
    label: string,
    placeholder: string,
    key: "smolModel" | "slowModel" | "planModel" | "handoffModel",
    invalid = false,
  ) => (
    <ModelPicker
      variant="field"
      showLabel={false}
      runtimeId={runtimeId}
      runtimeOnline={runtimeOnline}
      value={model ?? ""}
      canEdit={canEdit}
      ariaLabel={label}
      placeholder={placeholder}
      invalid={invalid}
      onChange={(next) => set({ [key]: next || undefined })}
    />
  );

  return (
    <div
      className={cn("space-y-6", compact && "space-y-4")}
      data-testid="omp-runtime-config"
    >
      <SettingsSection
        title={t(($) => $.omp.panel.model_roles)}
        action={headerAction}
      >
        <SettingsCard>
          <SettingsRow
            label={t(($) => $.omp.panel.smol_model)}
            description={t(($) => $.omp.panel.smol_hint)}
            size="select-wide"
          >
            {modelPicker(
              value.smolModel,
              t(($) => $.omp.panel.smol_model),
              t(($) => $.omp.panel.model_inherit_main),
              "smolModel",
            )}
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t(($) => $.omp.panel.advisor)}>
        <SettingsCard>
          <SettingsRow
            label={t(($) => $.omp.panel.advisor_enabled)}
            description={
              value.advisorEnabled
                ? undefined
                : t(($) => $.omp.panel.advisor_disabled_hint)
            }
          >
            <Switch
              checked={value.advisorEnabled === true}
              disabled={!canEdit}
              aria-label={t(($) => $.omp.panel.advisor_enabled)}
              onCheckedChange={(checked) =>
                set({
                  advisorEnabled: checked,
                  advisorReviewMode: checked
                    ? value.advisorReviewMode ?? "agent-end"
                    : value.advisorReviewMode,
                })
              }
            />
          </SettingsRow>
          {value.advisorEnabled ? (
            <>
              <SettingsRow
                label={t(($) => $.omp.panel.slow_model)}
                size="select-wide"
                align="start"
              >
                <div>
                  {modelPicker(
                    value.slowModel,
                    t(($) => $.omp.panel.slow_model),
                    t(($) => $.omp.panel.slow_model_placeholder),
                    "slowModel",
                  )}
                  {mainModel && value.slowModel === mainModel ? (
                    <SameModelWarning />
                  ) : null}
                </div>
              </SettingsRow>
              <SettingsRow
                label={t(($) => $.omp.panel.review_mode)}
                size="none"
                align="start"
              >
                <div
                  role="radiogroup"
                  aria-label={t(($) => $.omp.panel.review_mode)}
                  className="grid min-w-0 gap-2 sm:w-96"
                >
                  <ReviewModeChoice
                    name={`${id}-review-mode`}
                    value="agent-end"
                    selected={(value.advisorReviewMode ?? "agent-end") === "agent-end"}
                    title={t(($) => $.omp.panel.review_agent_end)}
                    description={t(($) => $.omp.panel.review_agent_end_hint)}
                    disabled={!canEdit}
                    onSelect={(advisorReviewMode) => set({ advisorReviewMode })}
                  />
                  <ReviewModeChoice
                    name={`${id}-review-mode`}
                    value="turn"
                    selected={value.advisorReviewMode === "turn"}
                    title={t(($) => $.omp.panel.review_turn)}
                    description={t(($) => $.omp.panel.review_turn_hint)}
                    disabled={!canEdit}
                    onSelect={(advisorReviewMode) => set({ advisorReviewMode })}
                  />
                </div>
              </SettingsRow>
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t(($) => $.omp.panel.execution)}>
        <SettingsCard>
          <SettingsRow
            label={t(($) => $.omp.panel.mode_label)}
            size="none"
            align="start"
          >
            <div
              role="radiogroup"
              aria-label={t(($) => $.omp.panel.mode_label)}
              className="grid min-w-0 gap-2 sm:w-96"
            >
              <ExecutionModeChoice
                name={`${id}-execution-mode`}
                value="standard"
                selected={executionMode === "standard"}
                title={t(($) => $.omp.panel.mode_standard)}
                description={t(($) => $.omp.panel.mode_standard_hint)}
                disabled={!canEdit}
                onSelect={(next) => set({ executionMode: next })}
              />
              <ExecutionModeChoice
                name={`${id}-execution-mode`}
                value="plan_yolo"
                selected={executionMode === "plan_yolo"}
                title={t(($) => $.omp.panel.mode_plan_yolo)}
                description={t(($) => $.omp.panel.mode_plan_yolo_hint)}
                disabled={!canEdit}
                onSelect={(next) => set({ executionMode: next })}
              />
              <ExecutionModeChoice
                name={`${id}-execution-mode`}
                value="prewalk"
                selected={executionMode === "prewalk"}
                title={t(($) => $.omp.panel.mode_prewalk)}
                description={t(($) => $.omp.panel.mode_prewalk_hint)}
                disabled={!canEdit}
                onSelect={(next) => set({ executionMode: next })}
              />
            </div>
          </SettingsRow>
          {executionMode !== "standard" ? (
            <>
              <SettingsRow
                label={t(($) => $.omp.panel.plan_model)}
                size="select-wide"
              >
                {modelPicker(
                  value.planModel,
                  t(($) => $.omp.panel.plan_model),
                  t(($) => $.omp.panel.model_inherit_main),
                  "planModel",
                )}
              </SettingsRow>
              <SettingsRow
                label={t(($) => $.omp.panel.handoff_model)}
                description={t(($) =>
                  executionMode === "plan_yolo"
                    ? $.omp.panel.handoff_plan_yolo_hint
                    : $.omp.panel.handoff_prewalk_hint
                )}
                size="select-wide"
                align="start"
              >
                <div>
                  {modelPicker(
                    value.handoffModel,
                    t(($) => $.omp.panel.handoff_model),
                    t(($) => $.omp.panel.handoff_model_placeholder),
                    "handoffModel",
                    handoffMissing,
                  )}
                  {handoffMissing ? (
                    <p className="mt-2 text-caption text-destructive" role="alert">
                      {t(($) => $.omp.panel.handoff_required)}
                    </p>
                  ) : mainModel && value.handoffModel === mainModel ? (
                    <SameModelWarning />
                  ) : null}
                </div>
              </SettingsRow>
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t(($) => $.omp.panel.memory)}>
        <SettingsCard>
          <SettingsRow
            label={t(($) => $.omp.panel.memory_backend)}
            size="none"
            align="start"
          >
            <div
              role="radiogroup"
              aria-label={t(($) => $.omp.panel.memory_backend)}
              className="grid min-w-0 gap-2 sm:w-96"
            >
              {(["off", "sharpshooter", "mnemopi"] as const).map((backend) => (
                <Choice
                  key={backend}
                  name={`${id}-memory-backend`}
                  value={backend}
                  selected={(value.memoryBackend ?? "off") === backend}
                  title={t(($) => $.omp.panel[`memory_${backend}`])}
                  description={t(($) => $.omp.panel[`memory_${backend}_hint`])}
                  disabled={!canEdit}
                  onSelect={() =>
                    set({ memoryBackend: backend === "off" ? undefined : backend })
                  }
                />
              ))}
            </div>
          </SettingsRow>
          <SettingsRow
            label={t(($) => $.omp.panel.autolearn_enabled)}
            description={t(($) => $.omp.panel.autolearn_hint)}
          >
            <Switch
              checked={value.autolearnEnabled === true}
              disabled={!canEdit}
              aria-label={t(($) => $.omp.panel.autolearn_enabled)}
              onCheckedChange={(autolearnEnabled) =>
                set({ autolearnEnabled: autolearnEnabled || undefined })
              }
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

function ReviewModeChoice({
  name,
  value,
  selected,
  title,
  description,
  disabled,
  onSelect,
}: {
  name: string;
  value: OmpAdvisorReviewMode;
  selected: boolean;
  title: string;
  description: string;
  disabled: boolean;
  onSelect: (value: OmpAdvisorReviewMode) => void;
}) {
  return (
    <Choice
      name={name}
      value={value}
      selected={selected}
      title={title}
      description={description}
      disabled={disabled}
      onSelect={() => onSelect(value)}
    />
  );
}

function ExecutionModeChoice({
  name,
  value,
  selected,
  title,
  description,
  disabled,
  onSelect,
}: {
  name: string;
  value: OmpExecutionMode;
  selected: boolean;
  title: string;
  description: string;
  disabled: boolean;
  onSelect: (value: OmpExecutionMode) => void;
}) {
  return (
    <Choice
      name={name}
      value={value}
      selected={selected}
      title={title}
      description={description}
      disabled={disabled}
      onSelect={() => onSelect(value)}
    />
  );
}

function Choice({
  name,
  value,
  selected,
  title,
  description,
  disabled,
  onSelect,
}: {
  name: string;
  value: string;
  selected: boolean;
  title: string;
  description: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-ring",
        selected
          ? "border-primary bg-primary/5 hover:bg-primary/10"
          : "border-border hover:bg-muted",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <span className="min-w-0">
        <span className="block text-body font-medium">{title}</span>
        <span className="mt-0.5 block text-caption leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

function SameModelWarning() {
  const { t } = useT("agents");
  return (
    <p className="mt-2 text-caption text-warning" role="note">
      {t(($) => $.omp.panel.same_main_model)}
    </p>
  );
}

export function OmpRuntimeConfigSummary({ config }: { config: OmpRuntimeConfig }) {
  const { t } = useT("agents");
  const chips: string[] = [];
  const shortModel = (model: string) => model.split("/").at(-1) ?? model;
  if (config.smolModel) {
    const model = config.smolModel;
    chips.push(t(($) => $.omp.inspector.smol, { model: shortModel(model) }));
  }
  if (config.advisorEnabled) {
    chips.push(
      t(($) => $.omp.inspector.advisor, {
        model: config.slowModel
          ? shortModel(config.slowModel)
          : t(($) => $.omp.inspector.auto_model),
        mode:
          config.advisorReviewMode === "turn"
            ? t(($) => $.omp.inspector.turn)
            : t(($) => $.omp.inspector.agent_end),
      }),
    );
  }
  const executionMode = config.executionMode;
  if (executionMode === "plan_yolo" || executionMode === "prewalk") {
    const handoff = config.handoffModel
      ? shortModel(config.handoffModel)
      : t(($) => $.omp.inspector.handoff_missing);
    chips.push(
      t(
        ($) =>
          executionMode === "plan_yolo"
            ? $.omp.inspector.execution_plan_yolo
            : $.omp.inspector.execution_prewalk,
        { model: handoff },
      ),
    );
    if (config.planModel) {
      const model = config.planModel;
      chips.push(t(($) => $.omp.inspector.plan, { model: shortModel(model) }));
    }
  }
  if (config.memoryBackend === "sharpshooter" || config.memoryBackend === "mnemopi") {
    chips.push(
      t(
        ($) =>
          config.memoryBackend === "sharpshooter"
            ? $.omp.inspector.memory_sharpshooter
            : $.omp.inspector.memory_mnemopi,
      ),
    );
  }
  if (config.autolearnEnabled) {
    chips.push(t(($) => $.omp.inspector.autolearn));
  }
  if (chips.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-2 py-2 text-caption text-muted-foreground">
        {t(($) => $.omp.inspector.empty)}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5 py-1">
      {chips.map((chip) => (
        <span
          key={chip}
          className="inline-flex max-w-full items-center rounded-md bg-muted px-2 py-1 text-caption text-muted-foreground"
        >
          <span className="truncate">{chip}</span>
        </span>
      ))}
    </div>
  );
}
