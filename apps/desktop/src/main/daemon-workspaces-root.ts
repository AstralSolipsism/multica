/**
 * Resolves the daemon's workspaces root for the Settings UI.
 *
 * Kept as a pure, electron-free module so the precedence rules stay
 * unit-tested. The rules mirror the Go side
 * (server/internal/daemon/config.go ResolveWorkspacesRoot):
 *
 *   MULTICA_WORKSPACES_ROOT env  >  profile config.json  >  built-in default
 *
 * Desktop always operates on its own named profile (never the user's default
 * CLI profile — see daemon-profile.ts), so the built-in default is
 * `~/multica_workspaces_<profile>`.
 */

import { homedir } from "os";
import { join, resolve } from "path";
import type { WorkspacesRootInfo } from "../shared/daemon-types";
import { assertResolvedProfile } from "./daemon-profile";

export function defaultWorkspacesRoot(profile: string, homeDir: string): string {
  assertResolvedProfile(profile);
  return join(homeDir, `multica_workspaces_${profile}`);
}

export function resolveWorkspacesRootInfo(
  profile: string,
  profileConfig: Record<string, unknown>,
  envValue: string | undefined,
  homeDir: string,
): WorkspacesRootInfo {
  const env = typeof envValue === "string" ? envValue.trim() : "";
  const custom =
    typeof profileConfig.workspaces_root === "string"
      ? profileConfig.workspaces_root.trim()
      : "";
  const defaultPath = defaultWorkspacesRoot(profile, homeDir);
  // The Go side applies filepath.Abs to env/config values; `resolve` is the
  // Node equivalent and is a no-op on already-absolute paths.
  const effectivePath = resolve(env || custom || defaultPath);
  return {
    effectivePath,
    customPath: custom || null,
    envOverride: env || null,
    defaultPath,
  };
}

export function resolveWorkspacesRootInfoFromEnv(
  profile: string,
  profileConfig: Record<string, unknown>,
): WorkspacesRootInfo {
  return resolveWorkspacesRootInfo(
    profile,
    profileConfig,
    process.env.MULTICA_WORKSPACES_ROOT,
    homedir(),
  );
}
