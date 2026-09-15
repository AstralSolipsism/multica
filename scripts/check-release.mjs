#!/usr/bin/env node
// Shared, read-only candidate preflight. Build integration lives with each
// component; this script never fetches, tags, builds, uploads or activates.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { normalizeGitVersion } from "../apps/desktop/scripts/package.mjs";

export const RELEASE_REPOSITORY = "AstralSolipsism/multica";
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-labrastro\.([1-9]\d*)$/;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function tagParts(tag) {
  const match = TAG_PATTERN.exec(tag);
  return match && match[0] === tag ? match.slice(1).map(BigInt) : null;
}

export function checkRelease({ repository, tag, sha, version, requireTag = false, mode = "candidate" }, cwd = process.cwd(), env = process.env) {
  requireThat(repository === RELEASE_REPOSITORY, `repository must be ${RELEASE_REPOSITORY}`);
  requireThat(!env.GITHUB_REPOSITORY || env.GITHUB_REPOSITORY === repository, "GitHub repository does not match candidate repository");
  requireThat(["candidate", "rebuild"].includes(mode), "mode must be candidate or rebuild");
  requireThat(mode !== "rebuild" || requireTag, "rebuild mode requires --require-tag");
  for (const [key, value] of Object.entries({ REPOSITORY: repository, TAG: tag, SHA: sha, MODE: mode })) {
    const expected = env[`LABRASTRO_RELEASE_${key}`];
    requireThat(!expected || expected === value, `${key} disagrees with the explicit candidate input`);
  }
  const parts = tagParts(tag);
  requireThat(parts && parts.slice(0, 3).some(n => n > 0n), "tag must be vX.Y.Z-labrastro.N with a non-placeholder base and positive N (no leading zeros)");
  requireThat(sha?.length === 40 && /^[0-9a-f]{40}$/.test(sha), "sha must be the reviewed full 40-character commit SHA");
  const normalized = normalizeGitVersion(tag);
  requireThat(version === undefined || version === normalized, "build version does not match the candidate tag (snapshots are not candidates)");

  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const allowedRemotes = [
    `https://github.com/${repository}`, `https://github.com/${repository}.git`,
    `git@github.com:${repository}.git`, `ssh://git@github.com/${repository}.git`,
  ];
  for (const direction of [[], ["--push"]]) {
    const urls = git("remote", "get-url", ...direction, "--all", "origin").split("\n");
    requireThat(urls.every(url => allowedRemotes.includes(url)), "origin must point only to the target fork (fetch and push)");
  }
  requireThat(git("rev-parse", "--is-shallow-repository") === "false", "candidate needs full fork history and tags");
  requireThat(git("rev-parse", "HEAD") === sha, "HEAD is not the reviewed candidate SHA");
  requireThat(!git("status", "--porcelain", "--untracked-files=all"), "candidate worktree is dirty (including untracked files)");
  try {
    git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main");
  } catch {
    throw new Error("candidate SHA must be contained in the fetched fork main");
  }
  const base = parts.slice(0, 3).join(".");
  const webPackage = JSON.parse(git("show", "HEAD:apps/web/package.json"));
  requireThat(webPackage.version === base, "tag base must match apps/web/package.json version");

  const tags = git("tag", "--list", "v*-labrastro.*").split("\n").filter(t => tagParts(t));
  const tagExists = tags.includes(tag);
  if (tagExists) {
    requireThat(git("rev-parse", `refs/tags/${tag}^{commit}`) === sha, "existing candidate tag points to another commit; never move it");
  } else {
    requireThat(!requireTag, "candidate tag is not present; tag creation is a separate authorized step");
  }
  const aliases = git("tag", "--points-at", "HEAD").split("\n").filter(t => tagParts(t) && t !== tag);
  requireThat(aliases.length === 0, "candidate SHA already has another Labrastro tag");

  const identity = {
    repository, tag, version: normalized, commit: sha, tag_exists: tagExists,
    tag_object: tagExists ? git("rev-parse", `refs/tags/${tag}`) : null,
  };
  if (mode === "rebuild") {
    // Only a separately reviewed acceptance record on fetched fork main can
    // authorize historical verification. Local files and tag dates are not proof.
    let record;
    try {
      record = JSON.parse(git("show", `refs/remotes/origin/main:.github/release-history/${tag}.json`));
    } catch {
      throw new Error("rebuild requires a valid history record on fetched fork main");
    }
    requireThat(Object.entries({ ...identity, mode: "candidate" }).every(([key, value]) => record?.[key] === value),
      "history record does not match the accepted candidate identity and tag object");
  } else {
    // A new tag cannot turn a rejected proposal into an accepted candidate.
    // Exclude only this tag, never other tags based on source ancestry or dates.
    let lastRevision = 0n;
    for (const existing of tags) {
      if (existing === tag) continue;
      const previous = tagParts(existing);
      const difference = parts.slice(0, 3).findIndex((n, i) => n !== previous[i]);
      requireThat(difference === -1 || parts[difference] > previous[difference], "candidate base cannot go backwards");
      if (difference === -1 && previous[3] > lastRevision) lastRevision = previous[3];
    }
    requireThat(parts[3] === lastRevision + 1n, "candidate revision must be the next N for this base (start at 1)");
  }

  const epoch = git("show", "-s", "--format=%ct", sha);
  return {
    ...identity, mode,
    date: new Date(Number(epoch) * 1000).toISOString().replace(".000Z", "Z"),
    source_date_epoch: epoch,
    artifact_dir: `dist/candidate/${tag}`,
  };
}

export function releaseEnvironment(metadata) {
  return {
    LABRASTRO_RELEASE_REPOSITORY: metadata.repository,
    LABRASTRO_RELEASE_TAG: metadata.tag,
    LABRASTRO_RELEASE_SHA: metadata.commit,
    LABRASTRO_RELEASE_MODE: metadata.mode,
    VERSION: metadata.version, COMMIT: metadata.commit, DATE: metadata.date,
    NEXT_PUBLIC_APP_VERSION: metadata.version,
    SOURCE_DATE_EPOCH: metadata.source_date_epoch,
    LABRASTRO_ARTIFACT_DIR: metadata.artifact_dir,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      repository: { type: "string", default: process.env.LABRASTRO_RELEASE_REPOSITORY },
      tag: { type: "string", default: process.env.LABRASTRO_RELEASE_TAG },
      sha: { type: "string", default: process.env.LABRASTRO_RELEASE_SHA },
      mode: { type: "string", default: process.env.LABRASTRO_RELEASE_MODE ?? "candidate" },
      version: { type: "string" },
      "require-tag": { type: "boolean", default: false },
      format: { type: "string", default: "json" },
    } });
    requireThat(["json", "env"].includes(values.format), "format must be json or env");
    const metadata = checkRelease({ ...values, requireTag: values["require-tag"] });
    console.log(values.format === "json" ? JSON.stringify(metadata, null, 2)
      : Object.entries(releaseEnvironment(metadata)).map(([key, value]) => `${key}=${value}`).join("\n"));
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  }
}
