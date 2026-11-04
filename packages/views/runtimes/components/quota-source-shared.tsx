"use client";

import { CreditCard } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import {
  ApiError,
  clientErrorMessage,
  errorCode,
  parseWithFallback,
} from "@multica/core/api";
import { QuotaSourceProbeErrorBodySchema } from "@multica/core/api/schemas";
import { useT } from "../../i18n";
import zhipuLogo from "./zhipu-logo.svg";

type RuntimesT = ReturnType<typeof useT<"runtimes">>["t"];

function staticAssetSrc(asset: string | { src: string }): string {
  return typeof asset === "string" ? asset : asset.src;
}

export function quotaSourceKindLabel(kind: string, t: RuntimesT): string {
  switch (kind) {
    case "glm":
      return t(($) => $.quota_sources.kinds.glm);
    case "zenmux":
      return t(($) => $.quota_sources.kinds.zenmux);
    default:
      return t(($) => $.quota_sources.kinds.unknown);
  }
}

export function QuotaSourceIcon({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}) {
  if (kind === "glm") {
    return (
      <img
        src={staticAssetSrc(zhipuLogo)}
        alt=""
        aria-hidden="true"
        className={cn("size-5 shrink-0", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground",
        className,
      )}
    >
      <CreditCard className="size-3.5" />
    </span>
  );
}

export function quotaSourceErrorLabel(code: string, t: RuntimesT): string {
  switch (code) {
    case "invalid_credential":
    case "credential_unreadable":
      return t(($) => $.quota_sources.errors.invalid_credential);
    case "rate_limited":
      return t(($) => $.quota_sources.errors.rate_limited);
    case "network_error":
      return t(($) => $.quota_sources.errors.network_error);
    case "invalid_base_url":
      return t(($) => $.quota_sources.errors.invalid_base_url);
    case "unexpected_response":
      return t(($) => $.quota_sources.errors.unexpected_response);
    case "provider_error":
      return t(($) => $.quota_sources.errors.provider_error);
    default:
      return t(($) => $.quota_sources.errors.generic);
  }
}

export function quotaSourceActionError(error: unknown, t: RuntimesT): string {
  if (
    errorCode(error) === "quota_source_encryption_unconfigured" ||
    (error instanceof ApiError && error.status === 503)
  ) {
    return t(($) => $.quota_sources.errors.encryption_unconfigured);
  }
  if (errorCode(error) === "refresh_cooldown") {
    return t(($) => $.quota_sources.errors.refresh_cooldown);
  }
  if (error instanceof ApiError && error.status === 422) {
    const body = parseWithFallback<{ reason?: string } | null>(
      error.body,
      QuotaSourceProbeErrorBodySchema,
      null,
      { endpoint: "quota-source-write" },
    );
    return quotaSourceErrorLabel(body?.reason ?? "", t);
  }
  return clientErrorMessage(error) ?? t(($) => $.quota_sources.errors.generic);
}
