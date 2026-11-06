import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { test } from "node:test";
import { checkImageInfo, archiveName, backendArchiveDockerfile, webArchiveDockerfile, BACKEND_COMMANDS } from "./local-images.mjs";

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


test("--from-archives packages verified archives without recompiling; wrong archive bytes fail closed", t => {
  const dir = mkdtempSync(join(tmpdir(), "local-image-archives-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Image fixture"); git("config", "user.email", "image@example.invalid");
  git("config", "commit.gpgsign", "false"); git("config", "tag.gpgsign", "false");
  git("remote", "add", "origin", "https://github.com/AstralSolipsism/multica");
  mkdirSync(join(dir, "server/migrations"), { recursive: true });
  writeFileSync(join(dir, "server/migrations/001_init.up.sql"), "SELECT 1;");
  writeFileSync(join(dir, ".gitignore"), "dist/\n.env\n.next/\n");
  writeFileSync(join(dir, "LICENSE"), "fixture license");
  writeFileSync(join(dir, "NOTICE"), "fixture notice");
  mkdirSync(join(dir, "docker"), { recursive: true });
  writeFileSync(join(dir, "docker/entrypoint.sh"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(dir, "apps/web"), { recursive: true });
  writeFileSync(join(dir, "apps/web/package.json"), '{"version":"1.2.3"}');
  git("add", "."); git("commit", "-m", "archive image fixture");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  git("tag", identity.tag);
  const commitIdentity = { ...identity, commit: sha,
    date: new Date(Number(git("show", "-s", "--format=%ct", sha)) * 1000).toISOString().replace(".000Z", "Z") };
  const info = { Id: "sha256:" + "c".repeat(64), Os: "linux", Architecture: "amd64", Config: { Labels: {
    "org.opencontainers.image.version": identity.version, "org.opencontainers.image.revision": sha,
    "org.opencontainers.image.created": commitIdentity.date, "org.opencontainers.image.source": "https://github.com/AstralSolipsism/multica",
  } } };
  // Build the candidate archives the way the component builders lay them out.
  const assets = join(dir, "dist/candidate", identity.tag, "assets");
  mkdirSync(assets, { recursive: true });
  const backendRoot = join(dir, "dist/scratch/backend-flat");
  mkdirSync(join(backendRoot, "migrations"), { recursive: true });
  const backendFiles = { ...Object.fromEntries(BACKEND_COMMANDS.map(command => [command, `binary-${command}\n`])),
    "go-build-info.txt": "go1.27.3\n", "build-info.json": JSON.stringify({ ...commitIdentity, os: "linux", arch: "amd64" }) + "\n",
    "expected-migrations.txt": "001_init.up.sql\n", "LICENSE": "fixture license", "NOTICE": "fixture notice",
    "migrations/001_init.up.sql": "SELECT 1;" };
  let archiveChecksums = "";
  for (const [name, body] of Object.entries(backendFiles)) {
    writeFileSync(join(backendRoot, name), body);
    archiveChecksums += `${createHash("sha256").update(body).digest("hex")}  ${name}\n`;
  }
  writeFileSync(join(backendRoot, "checksums.txt"), archiveChecksums);
  execFileSync("tar", ["-czf", join(assets, archiveName("backend", identity.version, "amd64")), "-C", backendRoot,
    ...Object.keys(backendFiles), "checksums.txt"]);
  const webTree = `labrastro-web-${identity.version}-linux-amd64-node-standalone`;
  const webRoot = join(dir, "dist/scratch", webTree);
  mkdirSync(join(webRoot, "apps/web/.next/static"), { recursive: true });
  writeFileSync(join(webRoot, "apps/web/server.js"), "console.log('server')\n");
  writeFileSync(join(webRoot, "apps/web/.next/static/main.js"), `console.log(${JSON.stringify(identity.version)})\n`);
  writeFileSync(join(webRoot, "LICENSE"), "fixture license");
  writeFileSync(join(webRoot, "NOTICE"), "fixture notice");
  writeFileSync(join(webRoot, "web-build.json"), JSON.stringify({ ...commitIdentity }) + "\n");
  execFileSync("tar", ["-czf", join(assets, archiveName("web", identity.version, "amd64")), "-C", join(dir, "dist/scratch"), webTree]);
  const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  const evidence = component => ({ artifacts: [{ name: archiveName(component, identity.version, "amd64"),
    bytes: statSync(join(assets, archiveName(component, identity.version, "amd64"))).size,
    sha256: sha256(join(assets, archiveName(component, identity.version, "amd64"))) }] });
  writeFileSync(join(assets, "backend-build.json"), JSON.stringify({ repository: "AstralSolipsism/multica", ...commitIdentity, ...evidence("backend") }));
  writeFileSync(join(assets, "web-inventory.json"), JSON.stringify({ ...commitIdentity, ...evidence("web") }));
  // The image-side checksums the stub reports: a fresh list over the same
  // bytes, matching what the generated Dockerfile produces at build time.
  const imageChecksums = [...Object.entries(backendFiles), ["entrypoint.sh", "#!/bin/sh\nexit 0\n"]]
    .map(([name, body]) => `${createHash("sha256").update(body).digest("hex")}  ${name.replace(/^(migrations)\//, "$1/")}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n") + "\n";
  // Docker stub: the archive path must build from the extracted archive
  // context (no git archive, no compiler build args) and pass byte anchoring.
  mkdirSync(join(dir, "dist/bin"), { recursive: true });
  writeFileSync(join(dir, "dist/bin/docker"), `#!/usr/bin/env node
    const fs=require('fs'), path=require('path'), assert=require('assert/strict');
    const args=process.argv.slice(2);
    const info=${JSON.stringify(info)};
    const archiveChecksums=${JSON.stringify(archiveChecksums)};
    const imageChecksums=${JSON.stringify(imageChecksums)};
    const identity=${JSON.stringify(commitIdentity)};
    const commands=${JSON.stringify(BACKEND_COMMANDS)};
    const goBuildInfo='go1.27.3';
    const state=path.join(process.cwd(),'dist/built');
    if(args[0]==='image') { if(!fs.existsSync(state)) process.exit(1); console.log(JSON.stringify([info])); }
    else if(args[0]==='info') console.log('{}');
    else if(args[0]==='version') console.log('{}');
    else if(args[0]==='build') {
      const context=args.at(-1);
      const dockerfile=fs.readFileSync(args[args.indexOf('--file')+1],'utf8');
      assert(!fs.existsSync(path.join(context,'.git')), 'no git context in archive mode');
      assert(!args.includes('VERSION='+identity.version), 'archive packaging must not pass compiler build args');
      assert(dockerfile.includes('org.opencontainers.image.revision="'+identity.commit+'"'));
      const isBackend=fs.existsSync(path.join(context,'app','checksums.txt'));
      if(isBackend) {
        assert(fs.existsSync(path.join(context,'app','checksums.txt')));
        assert(fs.existsSync(path.join(context,'app','build-info.json')));
        assert(fs.readFileSync(path.join(context,'entrypoint.sh'),'utf8').startsWith('#!/bin/sh'));
      } else {
        assert(fs.existsSync(path.join(context,'app','apps','web','server.js')));
        assert(dockerfile.includes('printf'));
      }
      fs.appendFileSync(state,'built');
    } else if(args[0]==='run') {
      for(const flag of ['--read-only','--network=none','--pull=never',info.Id]) assert(args.includes(flag));
      const command=args[args.indexOf('--entrypoint')+1], arg=args.at(-1);
      const respond={ 'cat':{
          '/app/checksums.txt':imageChecksums,
          '/app/archive-checksums.txt':archiveChecksums,
          '/app/build-info.json':JSON.stringify({version:identity.version,commit:identity.commit,date:identity.date}),
          '/app/go-build-info.txt':goBuildInfo },
        'sha256sum':null };
      if(command==='cat') console.log(respond.cat[arg] ?? '');
      else if(command==='/app/multica')
        console.log(JSON.stringify({...identity,os:'linux',arch:'amd64'}));
      else if(command==='node') {
        if(arg.startsWith('require(')) console.log(respond.cat['/app/build-info.json']);
        else if(arg.includes('.next/static')) { /* compiled version check passes */ }
        else if(arg==='-p') console.log(respond.cat['/app/build-info.json']);
        else console.log('');
      }
      else if(command==='sha256sum') {
        if(arg==='/app/checksums.txt') console.log(imageChecksums.split('\\n')[0]);
        else {
          const targets=args.slice(args.indexOf('sha256sum')+1).filter(a=>a.startsWith('/app/'));
          const answer=targets.map(a=>{
            const name=a.slice(5);
            const line=[...archiveChecksums.split('\\n'),...imageChecksums.split('\\n')].find(l=>l.endsWith('  '+name));
            return line ? line.slice(0,64)+'  '+a : '';
          }).filter(Boolean);
          if(!answer.length) throw Error('sha256sum stub miss: '+targets.join(','));
          console.log(answer.join('\\n'));
        }
      }
      else {
        assert.equal(arg,'--version');
        console.log(path.basename(command)+' '+identity.version+' (commit: '+identity.commit+')');
      }
    }
    else throw Error('unexpected Docker operation: '+args[0]);
  `, { mode: 0o755 });
  const envBase = { ...process.env, PATH: join(dir, "dist/bin") + ":" + process.env.PATH,
    LABRASTRO_RELEASE_REPOSITORY: "AstralSolipsism/multica", LABRASTRO_RELEASE_TAG: identity.tag,
    LABRASTRO_RELEASE_SHA: sha, LABRASTRO_RELEASE_MODE: "candidate", GITHUB_REPOSITORY: "AstralSolipsism/multica" };
  const imagesJson = join(dir, `dist/candidate/${identity.tag}/local-images/linux-amd64/images.json`);
  const result = spawnSync(process.execPath, [join(root, "scripts/local-images.mjs"), "--arch", "amd64", "--from-archives", "backend,web"],
    { cwd: dir, encoding: "utf8", env: envBase });
  assert.equal(result.status, 0, result.stderr);
  const evidenceFile = JSON.parse(readFileSync(imagesJson, "utf8"));
  const byComponent = Object.fromEntries(evidenceFile.images.map(item => [item.component, item]));
  assert.equal(byComponent.backend.build_method, "local_from_archives");
  assert.equal(byComponent.web.build_method, "local_from_archives");
  assert.equal(byComponent.backend.archive.name, archiveName("backend", identity.version, "amd64"));
  assert.equal(byComponent.backend.evidence.archive_anchor, "passed");
  // Corrupt the archive after evidence was recorded: the SHA-256 preflight
  // must fail the run before any image is built (fresh context: no images).
  rmSync(join(dir, "dist/built"), { force: true });
  writeFileSync(join(assets, archiveName("backend", identity.version, "amd64")), "corrupted bytes");
  const corrupt = spawnSync(process.execPath, [join(root, "scripts/local-images.mjs"), "--arch", "amd64", "--from-archives", "backend,web"],
    { cwd: dir, encoding: "utf8", env: envBase });
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /archive SHA-256 differs/);
  // Web archive packaging is amd64-only.
  const wrongArch = spawnSync(process.execPath, [join(root, "scripts/local-images.mjs"), "--arch", "arm64", "--from-archives", "web"],
    { cwd: dir, encoding: "utf8", env: envBase });
  assert.notEqual(wrongArch.status, 0);
  assert.match(wrongArch.stderr, /linux\/amd64 only/);
});

test("generated archive Dockerfiles pin labels, floors and entrypoint contract", () => {
  for (const dockerfile of [backendArchiveDockerfile(identity), webArchiveDockerfile(identity)]) {
    assert.match(dockerfile, /org\.opencontainers\.image\.revision="a{40}"/);
    assert.match(dockerfile, /org\.opencontainers\.image\.version="1\.2\.3-labrastro\.1"/);
    assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/AstralSolipsism\/multica"/);
  }
  assert.match(backendArchiveDockerfile(identity), /ENTRYPOINT \["\.\/entrypoint\.sh"\]/);
  assert.match(backendArchiveDockerfile(identity), /archive-checksums\.txt/);
  assert.match(webArchiveDockerfile(identity), /node:22\.23\.4-alpine/);
  assert.match(webArchiveDockerfile(identity), /libcrypto3>=3\.5\.8-r0/);
  assert.match(webArchiveDockerfile(identity), /CMD \["node", "apps\/web\/server\.js"\]/);
});
