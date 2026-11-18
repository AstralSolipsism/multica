"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, CircleHelp, Loader2 } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import type {
  QuotaSource,
  QuotaSourceKind,
  QuotaSourceOpenCodeMode,
  QuotaSourceVisibility,
} from "@multica/core/api";
import {
  useCreateQuotaSource,
  useUpdateQuotaSource,
} from "@multica/core/runtimes";
import { toast } from "sonner";
import { useT } from "../../i18n";
import {
  QuotaSourceIcon,
  quotaSourceActionError,
  quotaSourceDefaultName,
  quotaSourceKindLabel,
  quotaSourceRequiresCredential,
} from "./quota-source-shared";

const QUOTA_SOURCE_KINDS = ["glm", "zenmux", "deepseek", "opencode", "jev_free"] as const;

const OPENCODE_MODES = ["payg", "go"] as const;

const QUOTA_SOURCE_KIND_BASE_URLS: Record<QuotaSourceKind, string> = {
  glm: "https://open.bigmodel.cn",
  zenmux: "https://zenmux.ai",
  deepseek: "https://api.deepseek.com",
  opencode: "https://opencode.ai",
  jev_free: "https://opencode.ai/zen/v1/systemone",
};

// Small "?" trigger beside a field label. The guidance card only opens on
// hover or keyboard focus so the form stays compact by default.
function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CircleHelp aria-hidden="true" className="size-3.5" />
          </button>
        }
      />
      <TooltipContent
        side="right"
        align="start"
        className="block max-w-sm whitespace-pre-line text-left text-caption leading-relaxed text-tooltip-foreground"
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

export function QuotaSourceForm({
  source,
  encryptionConfigured,
  onBack,
  onSaved,
  onSavingChange,
}: {
  source: QuotaSource | null;
  encryptionConfigured: boolean;
  onBack: () => void;
  onSaved: () => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const { t } = useT("runtimes");
  const createSource = useCreateQuotaSource();
  const updateSource = useUpdateQuotaSource();
  const initialKind: QuotaSourceKind =
    QUOTA_SOURCE_KINDS.find((candidate) => candidate === source?.kind) ?? "glm";
  const [kind, setKind] = useState<QuotaSourceKind>(initialKind);
  const [name, setName] = useState(source?.name ?? "");
  const [credential, setCredential] = useState("");
  const [replaceCredential, setReplaceCredential] = useState(!source);
  const [baseUrl, setBaseUrl] = useState(source?.base_url ?? "");
  // New OpenCode sources default to the pay-as-you-go balance; an existing
  // source without a stored mode (legacy bare Zen key) stays in Go mode.
  const [opencodeMode, setOpencodeMode] = useState<QuotaSourceOpenCodeMode>(
    source ? (source.opencode_mode === "payg" ? "payg" : "go") : "payg",
  );
  const [workspaceId, setWorkspaceId] = useState(source?.workspace_id ?? "");
  const [visibility, setVisibility] = useState<QuotaSourceVisibility>(
    source?.visibility === "shared" ? "shared" : "private",
  );
  const [formError, setFormError] = useState<string | null>(null);
  const saving = createSource.isPending || updateSource.isPending;
  const needsCredential = quotaSourceRequiresCredential(kind);
  const credentialRequired = needsCredential && (!source || replaceCredential);
  const isOpenCodePayg = kind === "opencode" && opencodeMode === "payg";

  useEffect(() => {
    onSavingChange(saving);
    return () => onSavingChange(false);
  }, [saving, onSavingChange]);

  const selectOpenCodeMode = (mode: QuotaSourceOpenCodeMode) => {
    if (mode === opencodeMode) return;
    setOpencodeMode(mode);
    setFormError(null);
    // The two modes use different secrets (console Cookie vs Zen API key):
    // drop whatever was typed and make an existing source re-enter the one
    // the new mode needs.
    setCredential("");
    if (source) {
      setReplaceCredential(true);
    }
  };

  const credentialLabel = isOpenCodePayg
    ? t(($) => $.quota_sources.form.session_cookie)
    : kind === "zenmux"
      ? t(($) => $.quota_sources.form.management_key)
      : kind === "opencode"
        ? t(($) => $.quota_sources.form.zen_api_key)
        : t(($) => $.quota_sources.form.api_key);

  const credentialHelp = isOpenCodePayg
    ? t(($) => $.quota_sources.form.help_opencode_cookie)
    : kind === "glm"
      ? t(($) => $.quota_sources.form.help_glm_key)
      : kind === "zenmux"
        ? t(($) => $.quota_sources.form.help_zenmux_key)
        : kind === "deepseek"
          ? t(($) => $.quota_sources.form.help_deepseek_key)
          : t(($) => $.quota_sources.form.help_opencode_zen_key);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const trimmedName = name.trim();
    const trimmedCredential = credential.trim();
    if (credentialRequired && !trimmedCredential) {
      setFormError(t(($) => $.quota_sources.form.credential_required));
      return;
    }
    setFormError(null);
    // Blank name falls back to the channel's short default name, matching the
    // server-side fallback.
    const effectiveName = trimmedName || quotaSourceDefaultName(kind);
    const opencodeFields =
      kind === "opencode"
        ? {
            opencode_mode: opencodeMode,
            workspace_id: opencodeMode === "payg" ? workspaceId.trim() : "",
          }
        : {};
    try {
      if (source) {
        // Only send base_url when it actually changed: the server treats a
        // changed address as a re-probe trigger, and re-sending an unchanged
        // (or cleared-to-default) value must not probe.
        const trimmedBase = baseUrl.trim();
        const baseChanged = trimmedBase !== (source.base_url ?? "");
        await updateSource.mutateAsync({
          id: source.id,
          input: {
            name: effectiveName,
            visibility,
            ...(baseChanged ? { base_url: trimmedBase } : {}),
            ...(needsCredential && replaceCredential ? { credential: trimmedCredential } : {}),
            ...opencodeFields,
          },
        });
        toast.success(t(($) => $.quota_sources.toasts.updated));
      } else {
        await createSource.mutateAsync({
          kind,
          name: effectiveName,
          credential: needsCredential ? trimmedCredential : "",
          ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
          visibility,
          ...(kind === "opencode"
            ? {
                opencode_mode: opencodeMode,
                ...(opencodeMode === "payg" && workspaceId.trim()
                  ? { workspace_id: workspaceId.trim() }
                  : {}),
              }
            : {}),
        });
        toast.success(t(($) => $.quota_sources.toasts.created));
      }
      onSaved();
    } catch (error) {
      setFormError(quotaSourceActionError(error, t));
    }
  };

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
      <DialogHeader className="shrink-0 px-5 pb-3 pt-5 pr-12">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t(($) => $.quota_sources.form.back)}
            onClick={onBack}
            disabled={saving}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <DialogTitle>
            {source
              ? t(($) => $.quota_sources.form.edit_title)
              : t(($) => $.quota_sources.form.add_title)}
          </DialogTitle>
        </div>
        <DialogDescription>
          {t(($) => $.quota_sources.form.description)}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5">
        {!encryptionConfigured && (
          <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-warning">
            {t(($) => $.quota_sources.errors.encryption_unconfigured)}
          </div>
        )}

        <section aria-labelledby="quota-source-kind">
          <h3 id="quota-source-kind" className="mb-2 text-caption font-semibold text-muted-foreground">
            {t(($) => $.quota_sources.form.kind_section)}
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {QUOTA_SOURCE_KINDS.map((option) => (
              <Button
                key={option}
                type="button"
                variant="outline"
                aria-pressed={kind === option}
                disabled={!!source || saving}
                className={kind === option ? "border-primary bg-accent hover:bg-accent/80" : undefined}
                onClick={() => {
                  setKind(option);
                  setFormError(null);
                }}
              >
                <QuotaSourceIcon kind={option} />
                {quotaSourceKindLabel(option, t)}
              </Button>
            ))}
          </div>
        </section>

        <section aria-labelledby="quota-source-credential" className="space-y-3">
          <h3 id="quota-source-credential" className="text-caption font-semibold text-muted-foreground">
            {t(($) => $.quota_sources.form.credential_section)}
          </h3>
          <div className="space-y-1.5">
            <label htmlFor="quota-source-name" className="text-caption font-medium">
              {t(($) => $.quota_sources.form.name)}
            </label>
            <Input
              id="quota-source-name"
              value={name}
              maxLength={64}
              disabled={saving}
              placeholder={t(($) => $.quota_sources.form.name_placeholder)}
              onChange={(event) => {
                setName(event.target.value);
                setFormError(null);
              }}
            />
          </div>

          {kind === "opencode" && (
            <div className="space-y-1.5">
              <span className="text-caption font-medium">
                {t(($) => $.quota_sources.form.opencode_mode_label)}
              </span>
              <div
                role="radiogroup"
                aria-label={t(($) => $.quota_sources.form.opencode_mode_label)}
                className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              >
                {OPENCODE_MODES.map((mode) => {
                  const label = mode === "payg"
                    ? t(($) => $.quota_sources.form.opencode_mode_payg)
                    : t(($) => $.quota_sources.form.opencode_mode_go);
                  const hint = mode === "payg"
                    ? t(($) => $.quota_sources.form.opencode_mode_payg_hint)
                    : t(($) => $.quota_sources.form.opencode_mode_go_hint);
                  return (
                    <label
                      key={mode}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2",
                        opencodeMode === mode && "border-primary bg-accent/60",
                      )}
                    >
                      <input
                        type="radio"
                        name="opencode-mode"
                        value={mode}
                        checked={opencodeMode === mode}
                        disabled={saving}
                        onChange={() => selectOpenCodeMode(mode)}
                        className="mt-1"
                      />
                      <span>
                        <span className="block text-body font-medium">{label}</span>
                        <span className="block text-caption text-muted-foreground">{hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {needsCredential ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <label htmlFor="quota-source-key" className="text-caption font-medium">
                  {credentialLabel}
                </label>
                <FieldHelp
                  label={t(($) => $.quota_sources.form.help_aria, { field: credentialLabel })}
                >
                  {credentialHelp}
                </FieldHelp>
              </div>
              {source && !replaceCredential ? (
                <div className="flex gap-2">
                  <Input
                    id="quota-source-key"
                    value={source.credential_hint
                      ? `•••• •••• •••• ${source.credential_hint}`
                      : "•••• •••• ••••"}
                    readOnly
                    aria-label={t(($) => $.quota_sources.form.saved_credential)}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={saving}
                    onClick={() => {
                      setReplaceCredential(true);
                      setFormError(null);
                    }}
                  >
                    {t(($) => $.quota_sources.form.replace_key)}
                  </Button>
                </div>
              ) : (
                <Input
                  id="quota-source-key"
                  type="password"
                  autoComplete="off"
                  value={credential}
                  disabled={saving}
                  placeholder={
                    isOpenCodePayg
                      ? t(($) => $.quota_sources.form.cookie_placeholder)
                      : t(($) => $.quota_sources.form.credential_placeholder)
                  }
                  onChange={(event) => {
                    setCredential(event.target.value);
                    setFormError(null);
                  }}
                />
              )}
              <p className="text-caption text-muted-foreground">
                {t(($) => $.quota_sources.form.credential_hint)}
              </p>
            </div>
          ) : (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.quota_sources.form.credential_free)}
            </p>
          )}

          {isOpenCodePayg && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <label htmlFor="quota-source-workspace" className="text-caption font-medium">
                  {t(($) => $.quota_sources.form.workspace_id)}
                </label>
                <FieldHelp
                  label={t(($) => $.quota_sources.form.help_aria, {
                    field: t(($) => $.quota_sources.form.workspace_id),
                  })}
                >
                  {t(($) => $.quota_sources.form.help_opencode_workspace)}
                </FieldHelp>
              </div>
              <Input
                id="quota-source-workspace"
                value={workspaceId}
                disabled={saving}
                spellCheck={false}
                placeholder={t(($) => $.quota_sources.form.workspace_placeholder)}
                onChange={(event) => {
                  setWorkspaceId(event.target.value);
                  setFormError(null);
                }}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="quota-source-base-url" className="text-caption font-medium">
              {t(($) => $.quota_sources.form.base_url)}
            </label>
            <Input
              id="quota-source-base-url"
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={baseUrl}
              disabled={saving}
              placeholder={QUOTA_SOURCE_KIND_BASE_URLS[kind]}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setFormError(null);
              }}
            />
          </div>
        </section>

        <fieldset disabled={saving}>
          <legend className="mb-2 text-caption font-semibold text-muted-foreground">
            {t(($) => $.quota_sources.form.visibility_section)}
          </legend>
          <div className="overflow-hidden rounded-md border">
            {(["private", "shared"] as const).map((option) => (
              <label
                key={option}
                className="flex cursor-pointer items-start gap-2 border-b px-3 py-2.5 last:border-b-0"
              >
                <input
                  type="radio"
                  name="quota-source-visibility"
                  value={option}
                  checked={visibility === option}
                  onChange={() => {
                    setVisibility(option);
                    setFormError(null);
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="block text-body font-medium">
                    {t(($) => $.quota_sources.visibility[option])}
                  </span>
                  <span className="block text-caption text-muted-foreground">
                    {option === "private"
                      ? t(($) => $.quota_sources.visibility.private_hint)
                      : t(($) => $.quota_sources.visibility.shared_hint)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {formError && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-caption text-destructive">
            {formError}
          </div>
        )}
      </div>

      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" onClick={onBack} disabled={saving}>
          {t(($) => $.quota_sources.form.cancel)}
        </Button>
        <Button type="submit" disabled={saving} aria-busy={saving}>
          {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
          {saving
            ? t(($) => $.quota_sources.form.saving)
            : t(($) => $.quota_sources.form.save)}
        </Button>
      </DialogFooter>
    </form>
  );
}
