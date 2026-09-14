import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkRelease, releaseEnvironment, RELEASE_REPOSITORY } from "./check-release.mjs";
import { deriveVersion } from "../apps/desktop/scripts/package.mjs";

const script = fileURLToPath(new URL("./check-release.mjs", import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "labrastro-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  // All refs below are synthetic and local. No test contacts a remote.
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "user.name", "Release test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("remote", "add", "origin", `https://github.com/${RELEASE_REPOSITORY}`);
  mkdirSync(join(cwd, "apps/web"), { recursive: true });
  writeFileSync(join(cwd, "apps/web/package.json"), '{"version":"1.2.3"}\n');
  writeFileSync(join(cwd, ".gitignore"), "dist/\n");
  git("add", ".");
  git("commit", "-m", "previous release");
  const previous = git("rev-parse", "HEAD");
  git("tag", "v1.2.3-labrastro.1");
  git("commit", "--allow-empty", "-m", "candidate source");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  const input = { repository: RELEASE_REPOSITORY, tag: "v1.2.3-labrastro.2", sha };
  return { cwd, git, input, previous, check: (patch = {}, env = {}) => checkRelease({ ...input, ...patch }, cwd, env) };
}

test("proposed and tagged candidates map to one version/SHA; preflight makes no tag or output", t => {
  const { cwd, git, input, check } = fixture(t);
  const before = git("tag", "--list");
  const metadata = check();
  assert.equal(metadata.version, "1.2.3-labrastro.2");
  assert.equal(metadata.commit, input.sha);
  assert.equal(metadata.tag_exists, false);
  assert.equal(metadata.artifact_dir, "dist/candidate/v1.2.3-labrastro.2");
  assert.equal(git("tag", "--list"), before);
  assert.equal(git("status", "--porcelain"), "");
  assert.throws(() => check({ requireTag: true }), /tag is not present/);
  git("tag", "-a", input.tag, "-m", "test tag");
  assert.equal(check({ requireTag: true }).tag_exists, true);
  assert.equal(deriveVersion(cwd), metadata.version);
  const env = releaseEnvironment(metadata);
  assert.equal(env.VERSION, metadata.version);
  assert.equal(env.NEXT_PUBLIC_APP_VERSION, env.VERSION);
  assert.equal(env.COMMIT, input.sha);
  assert.equal(env.DATE, metadata.date);
  const child = spawnSync(process.execPath, [script, "--require-tag", "--format", "env"], {
    cwd, encoding: "utf8", env: { ...process.env, ...env, GITHUB_REPOSITORY: RELEASE_REPOSITORY },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^VERSION=1\.2\.3-labrastro\.2$/m);
  assert.match(child.stdout, new RegExp(`^COMMIT=${input.sha}$`, "m"));
});

test("non-target repositories, unexpected remotes and conflicting inputs fail closed", t => {
  const { git, input, check } = fixture(t);
  for (const repository of ["multica-ai/multica", "AstralSolipsism/another", "someone/multica", undefined]) {
    assert.throws(() => check({ repository }), /repository must be/);
  }
  assert.throws(() => check({}, { GITHUB_REPOSITORY: "someone/multica" }), /GitHub repository/);
  assert.throws(() => check({}, { LABRASTRO_RELEASE_TAG: "v1.2.3-labrastro.9" }), /disagrees/);
  assert.throws(() => check({}, { LABRASTRO_RELEASE_SHA: "0".repeat(40) }), /disagrees/);
  git("remote", "set-url", "--push", "origin", "https://github.com/someone/multica");
  assert.throws(() => check(), /origin must point/);
  git("remote", "set-url", "--push", "origin", `https://github.com/${input.repository}`);
  git("remote", "set-url", "origin", "https://github.com/someone/multica");
  assert.throws(() => check(), /origin must point/);
});

test("candidate rejects placeholders, dirty/describe versions, mismatched version and SHA", t => {
  const { check, previous } = fixture(t);
  for (const tag of ["dev", "0.1.0", "v0.0.0-labrastro.1", "v1.2.3", "v1.2.3-labrastro.0", "v01.2.3-labrastro.1", "v1.2.3-labrastro.02", "v1.2.3-labrastro.2-dirty", "v1.2.3-labrastro.2-1-gabc123", "v1.2.3-labrastro.2+build", "../v1.2.3-labrastro.2", "v1.2.3-labrastro.2\n"]) {
    assert.throws(() => check({ tag }), /tag must be/);
  }
  assert.throws(() => check({ sha: previous.slice(0, 9) }), /40-character/);
  assert.throws(() => check({ sha: previous }), /HEAD is not/);
  for (const version of ["dev", "0.1.0", "1.2.3-labrastro.2-SNAPSHOT", "v1.2.3-labrastro.2"]) {
    assert.throws(() => check({ version }), /build version/);
  }
  assert.throws(() => check({ tag: "v1.2.4-labrastro.1" }), /tag base/);
});

test("dirty tracked, staged and untracked source fail; ignored output and dev builds remain usable", t => {
  const { cwd, git, check } = fixture(t);
  mkdirSync(join(cwd, "dist"));
  writeFileSync(join(cwd, "dist/metadata.json"), "{}");
  check();
  writeFileSync(join(cwd, "untracked.txt"), "source override");
  assert.throws(() => check(), /dirty/);
  rmSync(join(cwd, "untracked.txt"));
  writeFileSync(join(cwd, "apps/web/package.json"), '{"version":"1.2.3","changed":true}');
  assert.throws(() => check(), /dirty/);
  assert.match(deriveVersion(cwd), /-dirty$/);
  git("add", ".");
  assert.throws(() => check(), /dirty/);
});

test("off-main and shallow candidate histories fail", t => {
  const { cwd, git, previous, check } = fixture(t);
  git("update-ref", "refs/remotes/origin/main", previous);
  assert.throws(() => check(), /contained in the fetched fork main/);
  writeFileSync(join(cwd, ".git/shallow"), `${previous}\n`);
  assert.throws(() => check(), /full fork history/);
});

test("tags are immutable, revisions advance numerically, and a SHA has only one Labrastro tag", t => {
  const { git, input, previous, check } = fixture(t);
  assert.throws(() => check({ tag: "v1.2.3-labrastro.1" }), /another commit/);
  assert.throws(() => check({ tag: "v1.2.3-labrastro.3" }), /next N/);
  git("tag", "v1.2.3-labrastro.9", previous);
  assert.equal(check({ tag: "v1.2.3-labrastro.10" }).version, "1.2.3-labrastro.10");
  git("tag", "v1.2.3-labrastro.10", input.sha);
  assert.throws(() => check({ tag: "v1.2.3-labrastro.11" }), /another Labrastro tag/);
  git("tag", "v2.0.0-labrastro.1", previous);
  assert.throws(() => check(), /base cannot go backwards/);
});

test("a new base starts its own revision sequence", t => {
  const { cwd, git, check } = fixture(t);
  writeFileSync(join(cwd, "apps/web/package.json"), '{"version":"1.2.4"}');
  git("add", ".");
  git("commit", "-m", "next base");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  assert.equal(check({ tag: "v1.2.4-labrastro.1", sha }).version, "1.2.4-labrastro.1");
  assert.throws(() => check({ tag: "v1.2.4-labrastro.2", sha }), /next N/);
});

test("release entry remains verification-only with explicit fork ownership and compatible CLI archives", () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const workflow = read(".github/workflows/release.yml");
  // This stage intentionally permits only this one verification job. Adding
  // artifact delivery requires replacing this invariant in the OL-83 review.
  const jobs = workflow.split("\njobs:\n")[1];
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):$/gm)].map(m => m[1]), ["verify"]);
  assert.match(jobs, /^    if: github.repository == 'AstralSolipsism\/multica'$/m);
  assert.match(jobs, /^          repository: AstralSolipsism\/multica$/m);
  assert.match(jobs, /^          persist-credentials: false$/m);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(workflow, /:\s*write\b|secrets\.|ghcr\.io|homebrew|--publish|args: release|workflow_dispatch|workflow_call/);
  assert.match(workflow, /args: check/);
  const config = read(".goreleaser.yml");
  assert.match(config, /release:\n  github:\n    owner: AstralSolipsism\n    name: multica\n  disable: true\n  draft: true\n  make_latest: false/);
  assert.match(config, /node scripts\/check-release.mjs --require-tag --tag=\{\{ .Tag \}\} --version=\{\{ .Version \}\}/);
  assert.doesNotMatch(config, /multica-ai|HOMEBREW|brews:|homebrew_casks:|dockers:|docker_manifests:|publishers:/);
  assert.match(config, /binary: multica/);
  assert.match(config, /main.commit=\{\{.FullCommit\}\}/);
  assert.match(config, /main.date=\{\{.CommitDate\}\}/);
  assert.match(config, /name_template: "\{\{ .ProjectName \}\}_\{\{ .Os \}\}_\{\{ .Arch \}\}"/);
  assert.match(config, /name_template: "\{\{ .ProjectName \}\}-cli-\{\{ .Version \}\}-\{\{ .Os \}\}-\{\{ .Arch \}\}"/);
  assert.equal([...config.matchAll(/- NOTICE/g)].length, 2);
  assert.equal([...config.matchAll(/- LICENSE\*/g)].length, 2);
});
