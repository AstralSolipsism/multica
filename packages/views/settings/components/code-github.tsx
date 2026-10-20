"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ExternalLink, LoaderCircle, MoreHorizontal, Unplug } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@multica/ui/components/ui/avatar";
import { Button } from "@multica/ui/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { useWorkspaceId } from "@multica/core/hooks";
import { githubAppInstallationsOptions, githubKeys } from "@multica/core/github";
import { ApiError, api, errorCode } from "@multica/core/api";
import type {
  GitHubAppInstallation,
  GitHubInstallation,
  ListGitHubInstallationsResponse,
} from "@multica/core/types";
import { useT } from "../../i18n";
import { SettingsRow } from "./settings-layout";

/** Installations the caller manages elsewhere that this workspace lacks. */
function reusableInstallations(
  available: readonly GitHubAppInstallation[],
  connected: readonly GitHubInstallation[],
): GitHubAppInstallation[] {
  return available.filter(
    (item) =>
      !item.connected &&
      !connected.some((installation) => installation.installation_id === item.installation_id),
  );
}

function useAccountTypeLabel() {
  const { t } = useT("fork-ui");
  return (type: string) =>
    type === "Organization"
      ? t(($) => $.settings.github.account_type_organization)
      : type === "User"
        ? t(($) => $.settings.github.account_type_user)
        : type;
}

/** Decorative: the login is always written next to it. */
function GitHubAccountAvatar({
  login,
  avatarUrl,
  className = "size-6",
}: {
  login: string;
  avatarUrl: string | null;
  className?: string;
}) {
  return (
    <Avatar className={className} aria-hidden="true">
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
      <AvatarFallback className="text-micro">
        {(login.trim()[0] ?? "?").toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * Connects the first GitHub account, or another one. Accounts the caller
 * already manages in other workspaces are bound directly from a menu: GitHub's
 * install page cannot do it, since it parks an account that already has the
 * App on its Configure page and never calls back. With nothing to reuse, the
 * button goes straight to GitHub.
 */
export function GitHubConnectButton({
  installationData,
}: {
  installationData: ListGitHubInstallationsResponse;
}) {
  const { t } = useT("settings");
  const { t: tForkUi } = useT("fork-ui");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const accountTypeLabel = useAccountTypeLabel();
  const installations = installationData.installations;
  const [opening, setOpening] = useState(false);
  const [checking, setChecking] = useState(false);
  const [binding, setBinding] = useState<GitHubAppInstallation | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const appInstallations = useQuery({
    ...githubAppInstallationsOptions(wsId),
    enabled:
      !!wsId &&
      installationData.can_manage === true &&
      installationData.repository_browse_configured === true,
  });
  const reusable = reusableInstallations(
    appInstallations.data?.installations ?? [],
    installations,
  );

  async function openGitHubInstall() {
    setOpening(true);
    try {
      const resp = await api.getGitHubConnectURL(wsId);
      if (!resp.configured || !resp.url) {
        toast.error(t(($) => $.github.toast_not_configured));
        return;
      }
      window.open(resp.url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.github.toast_open_failed));
    } finally {
      setOpening(false);
    }
  }

  // Nothing reusable is known yet. A read still in flight decides between the
  // menu and GitHub; a failed one must not block connecting, so it counts as
  // nothing to reuse.
  async function connect() {
    if (appInstallations.isFetching) {
      setChecking(true);
      const latest = await qc
        .fetchQuery(githubAppInstallationsOptions(wsId))
        .then((response) => response.installations)
        .catch(() => []);
      setChecking(false);
      if (reusableInstallations(latest, installations).length > 0) {
        setMenuOpen(true);
        return;
      }
    }
    await openGitHubInstall();
  }

  function bindFailureMessage(e: unknown, login: string): string {
    if (e instanceof ApiError) {
      // Scope, not session: the installation left the caller's reuse scope,
      // or GitHub no longer has it.
      if (e.status === 404) {
        return tForkUi(($) => $.settings.github.toast_account_not_reusable, { login });
      }
      if (e.status === 422) {
        return tForkUi(($) => $.settings.github.toast_account_suspended, { login });
      }
      if (e.status === 403 && errorCode(e) === "github_app_auth_not_configured") {
        return t(($) => $.github.toast_not_configured);
      }
    }
    return tForkUi(($) => $.settings.github.toast_account_connect_failed, { login });
  }

  async function bind(item: GitHubAppInstallation) {
    if (binding) return;
    setBinding(item);
    try {
      await api.connectGitHubInstallation(wsId, item.installation_id);
      await qc.invalidateQueries({ queryKey: githubKeys.all(wsId) });
      toast.success(
        tForkUi(($) => $.settings.github.toast_account_connected, { login: item.account_login }),
      );
    } catch (e) {
      // The list offered an installation that can no longer be bound.
      if (e instanceof ApiError && (e.status === 404 || e.status === 422)) {
        void qc.invalidateQueries({ queryKey: githubKeys.appInstallations(wsId) });
      }
      toast.error(bindFailureMessage(e, item.account_login));
    } finally {
      setBinding(null);
    }
  }

  const busy = opening || checking || binding !== null;
  const disabled = busy || !installationData.configured;
  const label = opening
    ? t(($) => $.github.connect_opening)
    : binding
      ? tForkUi(($) => $.settings.github.connecting)
      : installations.length > 0
        ? tForkUi(($) => $.settings.github.add_account)
        : t(($) => $.github.connect_github);
  const content = (
    <>
      {busy ? <LoaderCircle className="animate-spin" /> : null}
      {label}
    </>
  );

  // An open menu stays mounted even if a refresh empties the list under it.
  if (reusable.length === 0 && !menuOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void connect()}
        disabled={disabled}
        aria-busy={busy || undefined}
      >
        {content}
      </Button>
    );
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger
        disabled={disabled}
        render={<Button variant="outline" size="sm" aria-busy={busy || undefined} />}
      >
        {content}
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-56 max-w-80">
        {reusable.length > 0 ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>{tForkUi(($) => $.settings.github.reuse_label)}</DropdownMenuLabel>
              {reusable.map((item) => {
                const type = accountTypeLabel(item.account_type);
                return (
                  <DropdownMenuItem
                    key={item.installation_id}
                    disabled={binding !== null}
                    onClick={() => void bind(item)}
                  >
                    <GitHubAccountAvatar
                      login={item.account_login}
                      avatarUrl={item.account_avatar_url}
                      className="size-5"
                    />
                    <span className="min-w-0 truncate">{item.account_login}</span>
                    {/* The space separates login and type in the item's accessible name. */}
                    {type ? (
                      <>
                        {" "}
                        <span className="ml-auto shrink-0 pl-3 text-caption text-muted-foreground">
                          {type}
                        </span>
                      </>
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={() => void openGitHubInstall()}>
          <ExternalLink />
          {tForkUi(($) => $.settings.github.install_on_another_account)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One row per connected GitHub account, beneath the GitHub row. Each account
 * disconnects on its own, after a confirmation that names it.
 */
export function GitHubAccountRows({
  installations,
  canManage,
}: {
  installations: GitHubInstallation[];
  canManage: boolean;
}) {
  const { t } = useT("settings");
  const { t: tForkUi } = useT("fork-ui");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const accountTypeLabel = useAccountTypeLabel();
  const [disconnectTarget, setDisconnectTarget] = useState<GitHubInstallation | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (!disconnectTarget || disconnecting) return;
    setDisconnecting(true);
    try {
      await api.deleteGitHubInstallation(wsId, disconnectTarget.id);
      await qc.invalidateQueries({ queryKey: githubKeys.all(wsId) });
      toast.success(t(($) => $.github.toast_disconnected));
      setDisconnectTarget(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.github.toast_disconnect_failed));
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <>
      {installations.map((installation) => {
        const type = accountTypeLabel(installation.account_type);
        return (
          <SettingsRow
            key={installation.id}
            className="min-h-12 py-2.5"
            label={
              // Indented under the GitHub label: these are its accounts.
              <span className="flex min-w-0 items-center gap-3 pl-12">
                <GitHubAccountAvatar
                  login={installation.account_login}
                  avatarUrl={installation.account_avatar_url}
                />
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="break-all">{installation.account_login}</span>
                  {type ? (
                    <>
                      {" "}
                      <span className="text-caption font-normal text-muted-foreground">{type}</span>
                    </>
                  ) : null}
                </span>
              </span>
            }
            description={
              installation.connected_by ? (
                <span className="block pl-21">
                  {t(($) => $.github.connected_by, { name: installation.connected_by })}
                </span>
              ) : undefined
            }
          >
            {canManage ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={tForkUi(($) => $.settings.github.account_actions, {
                        login: installation.account_login,
                      })}
                    />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDisconnectTarget(installation)}
                  >
                    <Unplug />
                    {t(($) => $.github.disconnect)}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </SettingsRow>
        );
      })}

      <AlertDialog
        open={!!disconnectTarget}
        onOpenChange={(v) => {
          if (!v && !disconnecting) setDisconnectTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tForkUi(($) => $.settings.github.disconnect_account_confirm_title, {
                login: disconnectTarget?.account_login ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.github.disconnect_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>
              {t(($) => $.github.disconnect_confirm_cancel)}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting
                ? t(($) => $.github.disconnecting)
                : t(($) => $.github.disconnect_confirm_action)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
