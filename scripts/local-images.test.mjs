import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { checkImageInfo } from "./local-images.mjs";

const root = resolve(import.meta.dirname, "..");
const identity = { version: "1.2.3-labrastro.1", tag: "v1.2.3-labrastro.1", commit: "a".repeat(40), date: "2026-09-15T00:00:00Z" };
const env = { ...process.env, VERSION: identity.version, COMMIT: identity.commit, DATE: identity.date,
  MULTICA_IMAGE_TAG: identity.tag, JWT_SECRET: "config-only-example-secret" };
const image = () => ({ Id: "sha256:" + "b".repeat(64), Os: "linux", Architecture: "amd64", Config: { Labels: {
  "org.opencontainers.image.version": identity.version, "org.opencontainers.image.revision": identity.commit,
  "org.opencontainers.image.created": identity.date, "org.opencontainers.image.source": "https://github.com/AstralSolipsism/multica",
} } });

test("independent image inspection requires full ID, architecture and candidate labels", () => {
  checkImageInfo(image(), identity, "amd64");
  for (const mutate of [i => i.Id = "short", i => i.Architecture = "arm64", i => i.Config.Labels["org.opencontainers.image.revision"] = "old"]) {
    const info = image(); mutate(info);
    assert.throws(() => checkImageInfo(info, identity, "amd64"));
  }
});

test("Compose builds share version/SHA/date; custom override preserves operator configuration", t => {
  const dir = mkdtempSync(join(tmpdir(), "local-compose-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = files => JSON.parse(execFileSync("docker", ["compose", "--env-file", ".env.example",
    ...files.flatMap(f => ["-f", f]), "config", "--format", "json"], { cwd: root, env, encoding: "utf8" }));
  const base = config(["docker-compose.selfhost.yml"]);
  const build = config(["docker-compose.selfhost.yml", "docker-compose.selfhost.build.yml"]);
  for (const [service, component] of [["backend", "backend"], ["frontend", "web"]]) {
    assert.equal(base.services[service].image, `labrastro-${component}:${identity.tag}`);
    assert.equal(build.services[service].image, base.services[service].image);
    assert.equal(build.services[service].pull_policy, "never");
    assert.equal(build.services[service].build.args.VERSION, identity.version);
    assert.equal(build.services[service].build.args.COMMIT, identity.commit);
    assert.equal(build.services[service].build.args.DATE, identity.date);
  }
  assert.equal(build.services.frontend.build.args.NEXT_PUBLIC_APP_VERSION, identity.version);
  const custom = join(dir, "custom.yml");
  writeFileSync(custom, `name: operator-fixture
services:
  backend:
    image: local-api:previous
    command: ["./server"]
    environment: {ROLE: inbound}
    networks: [existing]
    volumes: ["data:/app/data"]
  frontend:
    image: local-web:previous
    ports: ["127.0.0.1:3333:3000"]
  scheduler:
    image: local-scheduler:previous
    environment: {ROLE: scheduler}
networks:
  existing: {external: true, name: operator-net}
volumes:
  data: {external: true, name: operator-data}
`);
  const before = config([custom]);
  const after = config([custom, "deploy/compose.local-images.yml"]);
  for (const service of ["backend", "frontend"]) {
    assert.equal(after.services[service].pull_policy, "never");
    after.services[service].image = before.services[service].image;
    delete after.services[service].pull_policy;
  }
  assert.deepEqual(after, before);
  const missing = spawnSync("docker", ["compose", "--env-file", ".env.example", "-f", "docker-compose.selfhost.yml", "config"],
    { cwd: root, env: { ...env, MULTICA_IMAGE_TAG: "" }, encoding: "utf8" });
  assert.notEqual(missing.status, 0);
});

test("new image labels cannot conceal a stale CLI or backfill identity; no successful evidence is written", t => {
  const dir = mkdtempSync(join(tmpdir(), "local-image-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Image fixture"); git("config", "user.email", "image@example.invalid");
  git("config", "commit.gpgsign", "false"); git("config", "tag.gpgsign", "false");
  git("remote", "add", "origin", "https://github.com/AstralSolipsism/multica");
  mkdirSync(join(dir, "apps/web"), { recursive: true });
  writeFileSync(join(dir, "apps/web/package.json"), '{"version":"1.2.3"}');
  writeFileSync(join(dir, ".gitignore"), "dist/\n.env\n.next/\n");
  writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(dir, "Dockerfile.web"), "FROM scratch\n");
  git("add", "."); git("commit", "-m", "local image fixture");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha); git("tag", identity.tag);
  const info = image(); info.Config.Labels["org.opencontainers.image.revision"] = sha;
  info.Config.Labels["org.opencontainers.image.created"] = new Date(Number(git("show", "-s", "--format=%ct")) * 1000).toISOString().replace(".000Z", "Z");
  mkdirSync(join(dir, "dist/bin"), { recursive: true });
  writeFileSync(join(dir, ".env"), "ignored local configuration");
  mkdirSync(join(dir, ".next"));
  writeFileSync(join(dir, ".next/old.js"), "ignored old build");
  // Only Docker is stubbed: real preflight reads the local fixture, then the
  // verifier sees fresh labels surrounding a stale runtime executable.
  writeFileSync(join(dir, "dist/bin/docker"), `#!/usr/bin/env node
    const fs=require('fs'), path=require('path'), assert=require('assert/strict');
    const args=process.argv.slice(2);
    const state=path.join(process.cwd(),'dist/built');
    if(args[0]==='image') {
      if(process.env.TEST_BUILD==='1' && !fs.existsSync(state)) process.exit(1);
      console.log(${JSON.stringify(JSON.stringify([info]))});
    } else if(args[0]==='info') console.log('{}');
    else if(args[0]==='build') {
      const context=args.at(-1);
      assert(!fs.existsSync(path.join(context,'.env')));
      assert(!fs.existsSync(path.join(context,'.next')));
      assert(!fs.existsSync(path.join(context,'.git')));
      assert(fs.existsSync(path.join(context,'Dockerfile')));
      assert(args.includes('VERSION=${identity.version}'));
      if(args.includes('labrastro-web:${identity.tag}')) assert(args.includes('NEXT_PUBLIC_APP_VERSION=${identity.version}'));
      assert(args.includes('COMMIT=${sha}'));
      assert(args.includes('--no-cache'));
      fs.appendFileSync(state,'built\\n');
    } else if(args[0]==='run') {
      for(const flag of ['--read-only','--network=none','--pull=never','${info.Id}']) assert(args.includes(flag));
      const command=path.basename(args[args.indexOf('--entrypoint')+1]);
      assert(['multica','server','migrate','backfill_task_usage_hourly','backfill_codex_usage_cache'].includes(command));
      const version={version:'${identity.version}',commit:'${sha}',date:'${info.Config.Labels["org.opencontainers.image.created"]}',os:'linux',arch:'amd64'};
      if(command===process.env.TEST_STALE) version[process.env.TEST_FIELD]='old';
      if(command==='multica') console.log(JSON.stringify(version));
      else {
        assert.equal(args.at(-1),'--version');
        console.log(command+' '+version.version+' (commit: '+version.commit+')');
      }
    }
    else throw Error('unexpected Docker operation');
  `, { mode: 0o755 });
  for (const build of [false, true]) {
    for (const [command, field] of [["multica", "version"], ...["backfill_task_usage_hourly", "backfill_codex_usage_cache"]
      .flatMap(command => ["version", "commit"].map(field => [command, field]))]) {
      rmSync(join(dir, "dist/built"), { force: true });
      const result = spawnSync(process.execPath, [join(root, "scripts/local-images.mjs"), build ? "--no-cache" : "--verify", "--arch", "amd64"], {
        cwd: dir, encoding: "utf8", env: { ...env, PATH: join(dir, "dist/bin") + ":" + process.env.PATH,
          LABRASTRO_RELEASE_REPOSITORY: "AstralSolipsism/multica", LABRASTRO_RELEASE_TAG: identity.tag,
          LABRASTRO_RELEASE_SHA: sha, LABRASTRO_RELEASE_MODE: "candidate", GITHUB_REPOSITORY: "AstralSolipsism/multica",
          TEST_BUILD: build ? "1" : "0", TEST_STALE: command, TEST_FIELD: field },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, command === "multica" ? /old CLI/ : new RegExp(`image ${command} identity differs`));
      assert.equal(existsSync(join(dir, `dist/candidate/${identity.tag}/local-images/linux-amd64/images.json`)), false);
    }
  }
  assert.equal(existsSync(join(dir, "dist/built")), true);
});
