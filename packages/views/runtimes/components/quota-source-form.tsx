"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Loader2 } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import type {
  QuotaSource,
  QuotaSourceKind,
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
  quotaSourceKindLabel,
} from "./quota-source-shared";

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
  const [kind, setKind] = useState<QuotaSourceKind>(
    source?.kind === "zenmux" ? "zenmux" : "glm",
  );
  const [name, setName] = useState(source?.name ?? "");
  const [credential, setCredential] = useState("");
  const [replaceCredential, setReplaceCredential] = useState(!source);
  const [baseUrl, setBaseUrl] = useState(source?.base_url ?? "");
  const [visibility, setVisibility] = useState<QuotaSourceVisibility>(
    source?.visibility === "shared" ? "shared" : "private",
  );
  const [formError, setFormError] = useState<string | null>(null);
  const saving = createSource.isPending || updateSource.isPending;
  const credentialRequired = !source || replaceCredential;

  useEffect(() => {
    onSavingChange(saving);
    return () => onSavingChange(false);
  }, [saving, onSavingChange]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const trimmedName = name.trim();
    const trimmedCredential = credential.trim();
    if (!trimmedName) {
      setFormError(t(($) => $.quota_sources.form.name_required));
      return;
    }
    if (credentialRequired && !trimmedCredential) {
      setFormError(t(($) => $.quota_sources.form.credential_required));
      return;
    }
    setFormError(null);
    try {
      if (source) {
        await updateSource.mutateAsync({
          id: source.id,
          input: {
            name: trimmedName,
            base_url: baseUrl.trim(),
            visibility,
            ...(replaceCredential ? { credential: trimmedCredential } : {}),
          },
        });
        toast.success(t(($) => $.quota_sources.toasts.updated));
      } else {
        await createSource.mutateAsync({
          kind,
          name: trimmedName,
          credential: trimmedCredential,
          base_url: baseUrl.trim(),
          visibility,
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
            {(["glm", "zenmux"] as const).map((option) => (
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

          <div className="space-y-1.5">
            <label htmlFor="quota-source-key" className="text-caption font-medium">
              {kind === "zenmux"
                ? t(($) => $.quota_sources.form.management_key)
                : t(($) => $.quota_sources.form.api_key)}
            </label>
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
                placeholder={t(($) => $.quota_sources.form.credential_placeholder)}
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
              placeholder={kind === "glm" ? "https://open.bigmodel.cn" : "https://zenmux.ai"}
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
