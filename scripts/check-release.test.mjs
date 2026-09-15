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
function fixture(t, base = "1.2.3") {
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
  writeFileSync(join(cwd, "apps/web/package.json"), `${JSON.stringify({ version: base })}\n`);
  writeFileSync(join(cwd, ".gitignore"), "dist/\n");
  git("add", ".");
  git("commit", "-m", "previous release");
  const previous = git("rev-parse", "HEAD");
  git("tag", `v${base}-labrastro.1`);
  git("commit", "--allow-empty", "-m", "candidate source");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  const input = { repository: RELEASE_REPOSITORY, tag: `v${base}-labrastro.2`, sha };
  return { cwd, git, input, previous, check: (patch = {}, env = {}) => checkRelease({ ...input, ...patch }, cwd, env) };
}

function recordHistory({ cwd, git }, records) {
  const directory = join(cwd, ".github/release-history");
  mkdirSync(directory, { recursive: true });
  for (const record of records) {
    writeFileSync(join(directory, `${record.tag}.json`), JSON.stringify(record));
  }
  git("add", ".github/release-history");
  git("commit", "-m", "record accepted candidate identities");
  return git("rev-parse", "HEAD");
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
  assert.throws(() => check({}, { LABRASTRO_RELEASE_MODE: "rebuild" }), /disagrees/);
  assert.throws(() => check({ mode: "unknown" }), /mode must be/);
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

test("tags are immutable and a SHA has only one Labrastro tag", t => {
  const { git, input, check } = fixture(t);
  assert.throws(() => check({ tag: "v1.2.3-labrastro.1" }), /another commit/);
  git("tag", input.tag);
  git("tag", "v1.2.3-labrastro.3");
  assert.throws(() => check({ requireTag: true }), /another Labrastro tag/);
});

test("revisions advance numerically across .9 to .10", t => {
  const { git, input, check } = fixture(t);
  assert.throws(() => check({ tag: "v1.2.3-labrastro.3" }), /next N/);
  git("tag", input.tag);
  for (let revision = 3; revision <= 9; revision++) {
    git("commit", "--allow-empty", "-m", `candidate ${revision}`);
    git("tag", `v1.2.3-labrastro.${revision}`);
  }
  git("commit", "--allow-empty", "-m", "candidate 10");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  const tag = "v1.2.3-labrastro.10";
  assert.equal(check({ tag, sha }).version, tag.slice(1));
  git("tag", tag);
  assert.equal(check({ tag, sha, requireTag: true }).version, tag.slice(1));
});

test("creating a tag cannot bypass revision or base checks at the packaging entry", async t => {
  for (const { name, oldBase, newBase, tag, rejection } of [
    { name: "skipped revision", oldBase: "1.2.3", newBase: "1.2.3", tag: "v1.2.3-labrastro.99", rejection: /next N/ },
    { name: "backwards base", oldBase: "2.0.0", newBase: "1.2.3", tag: "v1.2.3-labrastro.1", rejection: /base cannot go backwards/ },
  ]) {
    for (const annotated of [false, true]) {
      await t.test(`${name}, ${annotated ? "annotated" : "lightweight"} tag`, t => {
        const { cwd, git, check } = fixture(t, oldBase);
        writeFileSync(join(cwd, "apps/web/package.json"), `${JSON.stringify({ version: newBase })}\n`);
        git("add", ".");
        git("commit", "--allow-empty", "-m", "invalid candidate source");
        const sha = git("rev-parse", "HEAD");
        git("update-ref", "refs/remotes/origin/main", sha);
        assert.throws(() => check({ tag, sha }), rejection);
        git("tag", ...(annotated ? ["-a", tag, "-m", "invalid candidate"] : [tag]));
        assert.throws(() => check({ tag, sha }), rejection);
        for (const format of ["json", "env"]) {
          const child = spawnSync(process.execPath, [script, "--require-tag", "--version", tag.slice(1), "--format", format], {
            cwd, encoding: "utf8", env: {
              ...process.env, GITHUB_REPOSITORY: RELEASE_REPOSITORY,
              LABRASTRO_RELEASE_REPOSITORY: RELEASE_REPOSITORY,
              LABRASTRO_RELEASE_TAG: tag, LABRASTRO_RELEASE_SHA: sha,
            },
          });
          assert.equal(child.status, 1, child.stderr);
          assert.match(child.stderr, rejection);
          assert.equal(child.stdout, "", "a rejected candidate must not emit build inputs");
        }
      });
    }
  }
});

test("first tagging old unused source after a higher base exists fails in every mode", async t => {
  for (const annotated of [false, true]) {
    await t.test(annotated ? "annotated" : "lightweight", t => {
      const { cwd, git, input, check } = fixture(t);
      writeFileSync(join(cwd, "apps/web/package.json"), '{"version":"2.0.0"}\n');
      git("add", ".");
      git("commit", "-m", "higher base on later source");
      const sha = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", sha);
      check({ tag: "v2.0.0-labrastro.1", sha });
      git("tag", "v2.0.0-labrastro.1");
      git("checkout", "--detach", input.sha);
      assert.equal(git("tag", "--points-at", "HEAD"), "");
      assert.throws(() => check(), /base cannot go backwards/);
      git("tag", ...(annotated ? ["-a", input.tag, "-m", "first retroactive tag"] : [input.tag]));
      assert.throws(() => check(), /base cannot go backwards/);
      for (const mode of ["candidate", "rebuild"]) {
        for (const format of ["json", "env"]) {
          const child = spawnSync(process.execPath, [script, "--require-tag", "--version", input.tag.slice(1), "--format", format], {
            cwd, encoding: "utf8", env: {
              ...process.env, GITHUB_REPOSITORY: RELEASE_REPOSITORY,
              LABRASTRO_RELEASE_REPOSITORY: RELEASE_REPOSITORY,
              LABRASTRO_RELEASE_TAG: input.tag, LABRASTRO_RELEASE_SHA: input.sha,
              LABRASTRO_RELEASE_MODE: mode,
            },
          });
          assert.equal(child.status, 1, child.stderr);
          assert.match(child.stderr, mode === "candidate" ? /base cannot go backwards/ : /history record/);
          assert.equal(child.stdout, "");
        }
      }
    });
  }
});

test("recorded historical identities rebuild after later revisions and a greater base exist", t => {
  const f = fixture(t);
  const { cwd, git, input, previous, check } = f;
  git("checkout", "--detach", previous);
  const first = check({ tag: "v1.2.3-labrastro.1", sha: previous, requireTag: true });
  git("checkout", "--detach", input.sha);
  git("tag", "-a", input.tag, "-m", "candidate 2");
  const second = check({ requireTag: true });
  git("update-ref", "refs/remotes/origin/main", recordHistory(f, [first, second]));
  git("commit", "--allow-empty", "-m", "candidate 3");
  const third = git("rev-parse", "HEAD");
  git("tag", "v1.2.3-labrastro.3");
  git("update-ref", "refs/remotes/origin/main", third);
  const thirdRecord = check({ tag: "v1.2.3-labrastro.3", sha: third, requireTag: true });
  git("update-ref", "refs/remotes/origin/main", recordHistory(f, [thirdRecord]));
  writeFileSync(join(cwd, "apps/web/package.json"), '{"version":"2.0.0"}\n');
  git("add", ".");
  git("commit", "-m", "next base");
  const nextBase = git("rev-parse", "HEAD");
  git("tag", "-a", "v2.0.0-labrastro.1", "-m", "next base candidate");
  git("update-ref", "refs/remotes/origin/main", nextBase);
  const nextRecord = check({ tag: "v2.0.0-labrastro.1", sha: nextBase, requireTag: true });
  git("update-ref", "refs/remotes/origin/main", recordHistory(f, [nextRecord]));
  for (const [tag, sha] of [
    ["v1.2.3-labrastro.1", previous], [input.tag, input.sha],
    ["v1.2.3-labrastro.3", third], ["v2.0.0-labrastro.1", nextBase],
  ]) {
    git("checkout", "--detach", sha);
    if (tag !== nextRecord.tag) {
      assert.throws(() => check({ tag, sha, requireTag: true }), /base cannot go backwards/);
    }
    const metadata = check({ tag, sha, requireTag: true, mode: "rebuild" });
    assert.equal(metadata.tag_exists, true);
    assert.equal(metadata.mode, "rebuild");
    assert.equal(metadata.version, tag.slice(1));
    assert.equal(metadata.commit, sha);
    assert.equal(metadata.tag_object, git("rev-parse", `refs/tags/${tag}`));
  }
  const env = releaseEnvironment(check({ tag: "v2.0.0-labrastro.1", sha: nextBase, requireTag: true, mode: "rebuild" }));
  const child = spawnSync(process.execPath, [script, "--require-tag", "--format", "env"], {
    cwd, encoding: "utf8", env: { ...process.env, ...env, GITHUB_REPOSITORY: RELEASE_REPOSITORY },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^LABRASTRO_RELEASE_MODE=rebuild$/m);
});

test("rebuild requires a main-branch record of the exact accepted tag object and identity", t => {
  const f = fixture(t);
  const { cwd, git, input, check } = f;
  git("tag", "-a", input.tag, "-m", "accepted candidate");
  const metadata = check({ requireTag: true });
  const rebuild = () => check({ mode: "rebuild", requireTag: true });
  assert.throws(() => check({ mode: "rebuild" }), /requires --require-tag/);
  assert.throws(rebuild, /history record/);
  const excludePath = join(cwd, ".git/info/exclude");
  const excludes = readFileSync(excludePath, "utf8");
  writeFileSync(excludePath, `${excludes}\n.github/release-history/\n`);
  mkdirSync(join(cwd, ".github/release-history"), { recursive: true });
  writeFileSync(join(cwd, ".github/release-history", `${input.tag}.json`), JSON.stringify(metadata));
  assert.equal(git("status", "--porcelain"), "");
  assert.throws(rebuild, /history record/, "an ignored local receipt is not approval");
  writeFileSync(excludePath, excludes);
  const history = recordHistory(f, [metadata]);
  git("checkout", "--detach", input.sha);
  assert.throws(rebuild, /history record/, "a record on an unmerged branch is not approval");
  git("update-ref", "refs/remotes/origin/main", history);
  assert.equal(rebuild().mode, "rebuild");
  for (const patch of [
    { repository: "someone/multica" }, { tag: "v1.2.3-labrastro.99" },
    { version: "1.2.3-labrastro.99" }, { commit: "0".repeat(40) },
    { tag_object: "0".repeat(40) }, { tag_exists: false }, { mode: "rebuild" },
  ]) {
    git("checkout", "--detach", history);
    writeFileSync(join(cwd, ".github/release-history", `${input.tag}.json`), JSON.stringify({ ...metadata, ...patch }));
    git("add", ".");
    git("commit", "-m", "invalid history record");
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    git("checkout", "--detach", input.sha);
    assert.throws(rebuild, /history record does not match/);
  }
  git("update-ref", "refs/remotes/origin/main", history);
  git("tag", "-f", "-a", input.tag, "-m", "recreated annotation at the same source SHA");
  assert.throws(rebuild, /history record does not match/);
});

test("a tagged rebuild still rejects conflicting versions on unrelated source history", t => {
  const { cwd, git, input, previous, check } = fixture(t);
  git("tag", input.tag);
  git("checkout", "-b", "other-candidate", previous);
  writeFileSync(join(cwd, "apps/web/package.json"), '{"version":"2.0.0"}\n');
  git("add", ".");
  git("commit", "-m", "unrelated higher base");
  git("tag", "v2.0.0-labrastro.1");
  git("checkout", "--detach", input.sha);
  assert.throws(() => check({ requireTag: true }), /base cannot go backwards/);
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
  assert.match(workflow, /run: node scripts\/check-release.mjs --require-tag --mode candidate/);
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
