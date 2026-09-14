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

export function checkRelease({ repository, tag, sha, version, requireTag = false }, cwd = process.cwd(), env = process.env) {
  requireThat(repository === RELEASE_REPOSITORY, `repository must be ${RELEASE_REPOSITORY}`);
  requireThat(!env.GITHUB_REPOSITORY || env.GITHUB_REPOSITORY === repository, "GitHub repository does not match candidate repository");
  for (const [key, value] of Object.entries({ REPOSITORY: repository, TAG: tag, SHA: sha })) {
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

  // A tagged rebuild excludes itself and tags on descendant commits, so later
  // candidates do not invalidate a historical identity. Earlier and off-lineage
  // tags still constrain its sequence; tag existence alone proves nothing.
  const successors = new Set(tagExists ? git("tag", "--contains", sha).split("\n") : []);
  let lastRevision = 0n;
  for (const existing of tags) {
    if (successors.has(existing)) continue;
    const previous = tagParts(existing);
    const difference = parts.slice(0, 3).findIndex((n, i) => n !== previous[i]);
    requireThat(difference === -1 || parts[difference] > previous[difference], "candidate base cannot go backwards");
    if (difference === -1 && previous[3] > lastRevision) lastRevision = previous[3];
  }
  requireThat(parts[3] === lastRevision + 1n, "candidate revision must be the next N for this base (start at 1)");

  const epoch = git("show", "-s", "--format=%ct", sha);
  return {
    repository, tag, version: normalized, commit: sha,
    date: new Date(Number(epoch) * 1000).toISOString().replace(".000Z", "Z"),
    source_date_epoch: epoch, tag_exists: tagExists,
    artifact_dir: `dist/candidate/${tag}`,
  };
}

export function releaseEnvironment(metadata) {
  return {
    LABRASTRO_RELEASE_REPOSITORY: metadata.repository,
    LABRASTRO_RELEASE_TAG: metadata.tag,
    LABRASTRO_RELEASE_SHA: metadata.commit,
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
