import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { test } from "node:test";
import { checkImageInfo, archiveName, backendArchiveDockerfile, webArchiveDockerfile, runtimePins, BACKEND_COMMANDS } from "./local-images.mjs";

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




const ARCHIVE_TEST_COMMANDS = ["server", "multica", "migrate", "maintenance", "backfill_task_usage_hourly", "backfill_codex_usage_cache"];

function archiveFixture(t) {
  // Build a git fixture plus candidate component archives whose member sets
  // match the REAL builder contracts: backend archive members are exactly
  // build-backend.py COMMANDS + migrations + notices + evidence files (no
  // go-build-info.txt, maintenance included); web archive is the standalone
  // tree with web-build.json inside.
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
  // Source Dockerfiles at the fixture commit: runtime stages the generated
  // archive Dockerfiles must mirror (pins are READ from these at run time).
  writeFileSync(join(dir, "Dockerfile"), [
    "FROM golang:1.27.3-bookworm AS builder", "WORKDIR /src",
    "FROM debian:bookworm-slim AS runner",
    "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*",
    "WORKDIR /app", "COPY server .", 'ENTRYPOINT ["./entrypoint.sh"]', ""].join("\n"));
  writeFileSync(join(dir, "Dockerfile.web"), [
    "# comment", "FROM node:22.23.4-bookworm-slim AS deps", "RUN pnpm install",
    "FROM node:22.23.4-bookworm-slim AS builder", "RUN pnpm --filter @multica/web build",
    "FROM node:22.23.4-bookworm-slim AS runner", "WORKDIR /app",
    "COPY --from=builder /app .", 'CMD ["node", "apps/web/server.js"]', ""].join("\n"));
  git("add", "."); git("commit", "-m", "archive image fixture");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  git("tag", identity.tag);
  const commitIdentity = { ...identity, commit: sha,
    date: new Date(Number(git("show", "-s", "--format=%ct", sha)) * 1000).toISOString().replace(".000Z", "Z") };
  const assets = join(dir, "dist/candidate", identity.tag, "assets");
  mkdirSync(assets, { recursive: true });
  const backendRoot = join(dir, "dist/scratch/backend-flat");
  mkdirSync(join(backendRoot, "migrations"), { recursive: true });
  const backendFiles = {
    ...Object.fromEntries(ARCHIVE_TEST_COMMANDS.map(command => [command, `binary-${command}\n`])),
    "build-info.json": JSON.stringify({ ...commitIdentity, os: "linux", arch: "amd64", go: "go1.27.3" }) + "\n",
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
  // pnpm-shaped native module tree: sharp only as next's optionalDependency
  // sibling under .pnpm, exporting sharp's real factory API shape.
  const pnpmNext = join(webRoot, "node_modules/.pnpm/next@16.3.8/node_modules");
  mkdirSync(join(pnpmNext, "next"), { recursive: true });
  writeFileSync(join(pnpmNext, "next/package.json"), JSON.stringify({ name: "next", version: "16.3.8" }));
  mkdirSync(join(webRoot, "node_modules"), { recursive: true });
  rmSync(join(webRoot, "node_modules/next"), { recursive: true, force: true });
  execFileSync("ln", ["-s", ".pnpm/next@16.3.8/node_modules/next", join(webRoot, "node_modules/next")]);
  const sharpBody = "module.exports = function sharp() { return { resize() {}, jpeg() {} }; };\n";
  mkdirSync(join(pnpmNext, "sharp"));
  writeFileSync(join(pnpmNext, "sharp/package.json"), JSON.stringify({ name: "sharp", version: "0.35.4", main: "index.js" }));
  writeFileSync(join(pnpmNext, "sharp/index.js"), sharpBody);
  execFileSync("tar", ["-czf", join(assets, archiveName("web", identity.version, "amd64")), "-C", join(dir, "dist/scratch"), webTree]);
  const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  const evidence = component => ({ artifacts: [{ name: archiveName(component, identity.version, "amd64"),
    component, os: "linux", arch: "amd64",
    bytes: statSync(join(assets, archiveName(component, identity.version, "amd64"))).size,
    sha256: sha256(join(assets, archiveName(component, identity.version, "amd64"))) }] });
  writeFileSync(join(assets, "backend-build.json"), JSON.stringify({ repository: "AstralSolipsism/multica", ...commitIdentity, ...evidence("backend") }));
  writeFileSync(join(assets, "web-inventory.json"), JSON.stringify({ ...commitIdentity, ...evidence("web") }));
  return { dir, git, sha, commitIdentity, assets, backendFiles, archiveChecksums, webTree, sha256 };
}

// The image-side files the docker stub reports for an archive-packaged
// backend: a fresh checksums.txt over exactly what the generated RUN produces
// (archive members + entrypoint.sh + image build-info.json).
function imageChecksumList(backendFiles, entrypoint) {
  // The generated backend RUN hashes exactly: archive members (minus
  // checksums.txt) plus entrypoint.sh; build-info.json keeps the archive's
  // own bytes (no host-written copy anymore).
  const byName = new Map(Object.entries(backendFiles).filter(([name]) => name !== "checksums.txt"));
  byName.set("entrypoint.sh", entrypoint);
  return [...byName.entries()]
    .map(([name, body]) => `${createHash("sha256").update(body).digest("hex")}  ${name}`)
    .sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n") + "\n";
}

function writeDockerStub(t, fixture, variant = {}) {

  // variant.mutateImage: replace the stub's image-side manifest/binaries with
  // a DIFFERENT self-consistent set (the A1 attack) — verification must fail.
  const { dir, commitIdentity, backendFiles, archiveChecksums } = fixture;
  const webBuildOverride = variant.tamperedWebBuild
    ? JSON.stringify({ ...commitIdentity, built_at: "tampered" }) + "\n" : null;
  const entrypoint = "#!/bin/sh\nexit 0\n";
  const imageBuildInfo = JSON.stringify({ version: commitIdentity.version, commit: commitIdentity.commit, date: commitIdentity.date }) + "\n";
  // The backend image keeps the archive's own build-info.json (full evidence),
  // so the stub reports it for /app/build-info.json in the backend path.
  const archiveBuildInfo = backendFiles["build-info.json"];
  let imageList = imageChecksumList(backendFiles, entrypoint);
  let listed = archiveChecksums;
  let binaries = backendFiles;
  if (variant.selfConsistentStale) {
    const stale = { ...backendFiles };
    for (const command of ARCHIVE_TEST_COMMANDS) stale[command] = `stale-${command}\n`;
    let manifest = "";
    for (const [name, body] of Object.entries(stale)) if (name !== "checksums.txt") manifest += `${createHash("sha256").update(body).digest("hex")}  ${name}\n`;
    listed = manifest;
    binaries = stale;
    imageList = imageChecksumList(stale, entrypoint);
  }
  const info = { Id: "sha256:" + "c".repeat(64), Os: "linux", Architecture: "amd64", Config: { Labels: {
    "org.opencontainers.image.version": commitIdentity.version, "org.opencontainers.image.revision": commitIdentity.commit,
    "org.opencontainers.image.created": commitIdentity.date, "org.opencontainers.image.source": "https://github.com/AstralSolipsism/multica",
  } } };
  mkdirSync(join(dir, "dist/bin"), { recursive: true });
  writeFileSync(join(dir, "dist", "stub-web-build.json"),
    webBuildOverride ?? (JSON.stringify({ ...commitIdentity }) + "\n"));
  writeFileSync(join(dir, "dist/bin/docker"), `#!/usr/bin/env node
    const fs=require('fs'), path=require('path'), assert=require('assert/strict');
    const args=process.argv.slice(2);
    const info=${JSON.stringify(info)};
    const archiveChecksums=${JSON.stringify(listed)};
    const imageChecksums=${JSON.stringify(imageList)};
    const identity=${JSON.stringify(commitIdentity)};
    const commands=${JSON.stringify(ARCHIVE_TEST_COMMANDS)};
    const binaries=${JSON.stringify(binaries)};
    const binaryHashOverride=${JSON.stringify(variant.tamperedBinary ? { maintenance: "f".repeat(64) } : null)};
    const goBuildInfoBody=${JSON.stringify("go1.27.3\n")};
    const archiveBuildInfoBody=${JSON.stringify(archiveBuildInfo)};
    const webBuild=fs.readFileSync(path.join(process.cwd(),'dist','stub-web-build.json'),'utf8');
    // webBuildBody is prepared outside to avoid template-escape drift.
    const imageBuildInfo=${JSON.stringify(imageBuildInfo)};
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
      assert(!/apk add/.test(dockerfile), 'no apk in generated Dockerfile');
      assert(!/FROM .*alpine/.test(dockerfile), 'no alpine base in generated Dockerfile');
      // The generated Dockerfile must contain no raw newline inside a single
      // instruction and no printf-escaped JSON (COPY supplies build-info.json).
      for(const line of dockerfile.split('\\n'))
        assert(!/^\\s*'\\s*$/.test(line), 'broken RUN continuation');
      assert(!/printf/.test(dockerfile), 'build-info.json must be COPYed, not printf-generated');
      const isBackend=fs.existsSync(path.join(context,'app','checksums.txt'));
      if(!isBackend) assert(dockerfile.includes('useradd'), 'Debian user syntax in web image');
      if(isBackend) {
        assert(fs.existsSync(path.join(context,'app','maintenance')), 'archive image must ship maintenance');
        assert(!fs.existsSync(path.join(context,'app','go-build-info.txt')), 'backend archive has no go-build-info.txt');
        assert(fs.existsSync(path.join(context,'app','build-info.json')));
        assert(fs.readFileSync(path.join(context,'entrypoint.sh'),'utf8').startsWith('#!/bin/sh'));
        // Record the generated Dockerfile so the outer test can execute its
        // RUN fragment against the real archive layout.
        fs.copyFileSync(args[args.indexOf('--file')+1], path.join(process.cwd(),'dist','generated-'+(fs.existsSync(path.join(context,'app','checksums.txt'))?'backend':'web')+'.Dockerfile'));
      } else {
        assert(fs.existsSync(path.join(context,'app','apps','web','server.js')));
        assert(fs.existsSync(path.join(context,'build-info.json')));
        assert(JSON.parse(fs.readFileSync(path.join(context,'build-info.json'),'utf8')).version===identity.version);
      }
      fs.appendFileSync(state,'built');
    } else if(args[0]==='run') {
      for(const flag of ['--read-only','--network=none','--pull=never',info.Id]) assert(args.includes(flag));
      const command=args[args.indexOf('--entrypoint')+1], arg=args.at(-1);
      if(command==='cat') {
        const catMap={'/app/checksums.txt':imageChecksums,'/app/archive-checksums.txt':archiveChecksums,
          '/app/build-info.json':archiveBuildInfoBody,'/app/web-build.json':webBuild,
          '/app/go-build-info.txt':goBuildInfoBody};
        if(!(arg in catMap)) throw Error('unexpected cat '+arg);
        console.log(catMap[arg]);
      }
      else if(command==='/app/multica')
        console.log(JSON.stringify({...identity,os:'linux',arch:'amd64'}));
      else if(command==='node') {
        if(arg.startsWith('require(')||arg==='-p') console.log(imageBuildInfo);
        else if(arg.includes('.next/static')) { /* compiled version check passes */ }
        else if(arg.includes("require.resolve('sharp'")) {
          // Native probe: EXECUTE it for real against the extracted archive
          // tree (pure-JS sharp-shaped fixture) instead of faking success.
          const cp=require('child_process');
          // The build scratch is deleted before verify; re-extract the web
          // archive fresh so the probe runs against the real module layout.
          const assets=path.join(process.cwd(),'dist','candidate',identity.tag,'assets');
          const archive=assets+'/'+('labrastro-web-'+identity.version+'-linux-amd64-node-standalone.tar.gz');
          const tmp=fs.mkdtempSync(path.join(process.cwd(),'dist','probe-'));
          cp.spawnSync('tar',['-xzf',archive,'-C',tmp,'--strip-components=1'],{stdio:'ignore'});
          if(process.env.STUB_SHARP_FAIL==='1') {
            // Recreate the #20 regression shape: a module that loads fine but
            // exports no factory — the probe's functional check must reject it.
            const broken=path.join(tmp,'node_modules/.pnpm/next@16.3.8/node_modules/sharp/index.js');
            fs.writeFileSync(broken, 'module.exports = { resize: function() {} };\\n');
          }
          const context=tmp;
          const webDir=path.join(context,'apps','web');
          const appDir=context;
          const script=arg.split('\\n').map(line=>line
            .replace(/'\\/app\\/apps\\/web'/g, "'"+webDir+"'")
            .replace(/'\\/app'/g, "'"+appDir+"'")).join('\\n');
                    const result=cp.spawnSync(process.execPath,['-e',script],{encoding:'utf8'});
          if(result.status!==0) { console.error(result.stderr); process.exit(result.status ?? 1); }
        }
        else console.log('');
      }
      else if(command==='sha256sum') {
        if(args.includes('-c')) { console.log(''); }
        else {
        const targets=args.slice(args.indexOf('sha256sum')+1).filter(a=>a.startsWith('/app/'));
        const answer=targets.map(a=>{
          const name=a.slice(5);
          if(binaryHashOverride && name in binaryHashOverride) return binaryHashOverride[name]+'  '+a;
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
  return { dir };
}

function runLocalImages(fixture, args, extraEnv = {}) {
  const { dir } = fixture;
  return spawnSync(process.execPath, [join(root, "scripts/local-images.mjs"), ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: join(dir, "dist/bin") + ":" + process.env.PATH,
      LABRASTRO_RELEASE_REPOSITORY: "AstralSolipsism/multica", LABRASTRO_RELEASE_TAG: identity.tag,
      LABRASTRO_RELEASE_SHA: fixture.sha, LABRASTRO_RELEASE_MODE: "candidate",
      GITHUB_REPOSITORY: "AstralSolipsism/multica", ...extraEnv } });
}

test("--from-archives packages verified archives without recompiling; wrong archive bytes fail closed", t => {
  const fixture = archiveFixture(t);
  writeDockerStub(t, fixture);
  const imagesJson = join(fixture.dir, `dist/candidate/${identity.tag}/local-images/linux-amd64/images.json`);
  const result = runLocalImages(fixture, ["--arch", "amd64", "--from-archives", "backend,web"]);
  assert.equal(result.status, 0, result.stderr);
  // The stub copied each generated Dockerfile out; execute the backend RUN
  // fragment against a fresh copy of the real build context and compare the
  // checksums.txt it produces with the verifier's expectations.
  const generated = readFileSync(join(fixture.dir, "dist", "generated-backend.Dockerfile"), "utf8");
  // Join only the checksum-list RUN (the one that moves checksums.txt);
  // `apk add` lines are not executable on the test host.
  let fragment = "", collecting = false, found = false;
  let pending = "";
  for (const line of generated.split("\n")) {
    if (/^RUN /.test(line)) {
      const head = line.replace(/^RUN /, "").trim();
      pending = head.replace(/\\$/, "") + " ";
      collecting = true;
      continue;
    }
    if (collecting) {
      const trimmed = line.trim();
      if (trimmed.endsWith("\\")) { pending += trimmed.replace(/\\$/, "") + " "; }
      else {
        pending += trimmed;
        if (pending.includes("mv checksums.txt")) { fragment = pending; found = true; }
        collecting = false;
      }
    }
  }
  fragment = fragment.replace(/\s+/g, " ").trim();
  assert.ok(found && fragment.includes("archive-checksums.txt"), "RUN fragment not extracted");
  assert.ok(fragment.includes("archive-checksums.txt"), "RUN fragment not extracted");
  const runDir = mkdtempSync(join(fixture.dir, "dist", "runcheck-"));
  execFileSync("tar", ["-xzf", join(fixture.assets, archiveName("backend", identity.version, "amd64")), "-C", runDir]);
  writeFileSync(join(runDir, "entrypoint.sh"), "#!/bin/sh\nexit 0\n");
  execFileSync("sh", ["-c", `cd "${runDir}" && ${fragment}`]);
  const producedList = readFileSync(join(runDir, "checksums.txt"), "utf8");
  for (const command of ARCHIVE_TEST_COMMANDS) assert.match(producedList, new RegExp(`  ${command}\\n`), `RUN list missing ${command}`);
  assert.match(producedList, /  entrypoint\.sh\n/);
  assert.doesNotMatch(producedList, /go-build-info\.txt/, "RUN must not reference go-build-info.txt");
  rmSync(runDir, { recursive: true, force: true });
  const evidenceFile = JSON.parse(readFileSync(imagesJson, "utf8"));
  const byComponent = Object.fromEntries(evidenceFile.images.map(item => [item.component, item]));
  assert.equal(byComponent.backend.build_method, "local_from_archives");
  assert.equal(byComponent.web.build_method, "local_from_archives");
  assert.equal(byComponent.backend.archive.name, archiveName("backend", identity.version, "amd64"));
  assert.equal(byComponent.backend.evidence.archive_anchor, "passed");
  assert.equal(byComponent.backend.evidence.go_build_info, "go1.27.3");
  // Corrupt the archive after evidence was recorded: the SHA-256 preflight
  // must fail the run before any image is built (fresh context: no images).
  rmSync(join(fixture.dir, "dist/built"), { force: true });
  writeFileSync(join(fixture.assets, archiveName("backend", identity.version, "amd64")), "corrupted bytes");
  const corrupt = runLocalImages(fixture, ["--arch", "amd64", "--from-archives", "backend,web"]);
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /archive SHA-256 differs/);
  // Web archive packaging is amd64-only.
  const wrongArch = runLocalImages(fixture, ["--arch", "arm64", "--from-archives", "web"]);
  assert.notEqual(wrongArch.status, 0);
  assert.match(wrongArch.stderr, /linux\/amd64 only/);
});

test("A1: a self-consistent stale image fails the host-archive byte anchor", t => {
  const fixture = archiveFixture(t);
  writeDockerStub(t, fixture, { selfConsistentStale: true });
  // Image "exists" already, so use --verify (the attack targets exactly that).
  writeFileSync(join(fixture.dir, "dist/built"), "built");
  const result = runLocalImages(fixture, ["--arch", "amd64", "--verify"]);
  assert.notEqual(result.status, 0, "self-consistent stale image must fail");
  assert.match(result.stderr, /archive checksum list differs from the verified candidate archive/);
  assert.equal(existsSync(join(fixture.dir, `dist/candidate/${identity.tag}/local-images/linux-amd64/images.json`)), false);
});

test("archive evidence with a foreign identity fails closed", t => {
  const fixture = archiveFixture(t);
  writeDockerStub(t, fixture);
  const evidencePath = join(fixture.assets, "backend-build.json");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  writeFileSync(evidencePath, JSON.stringify({ ...evidence, tag: "v1.2.3-labrastro.9" }));
  const result = runLocalImages(fixture, ["--arch", "amd64", "--from-archives", "backend,web"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archive evidence tag differs/);
});

test("generated archive Dockerfiles mirror the source runtime stages", () => {
  const source = readFileSync(join(root, "Dockerfile"), "utf8");
  const sourceWeb = readFileSync(join(root, "Dockerfile.web"), "utf8");
  const backend = backendArchiveDockerfile(identity, runtimePins(source));
  const web = webArchiveDockerfile(identity, runtimePins(sourceWeb));
  for (const dockerfile of [backend, web]) {
    assert.match(dockerfile, /org\.opencontainers\.image\.revision="a{40}"/);
    assert.match(dockerfile, /org\.opencontainers\.image\.version="1\.2\.3-labrastro\.1"/);
    assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/AstralSolipsism\/multica"/);
    // One instruction per line: no raw newline can split a RUN.
    for (const line of dockerfile.split("\n")) assert.doesNotMatch(line, /^\s*'\s*$/);
  }
  assert.match(backend, /ENTRYPOINT \["\.\/entrypoint\.sh"\]/);
  assert.match(backend, /archive-checksums\.txt/);
  assert.match(backend, new RegExp(`FROM ${runtimePins(source).base.replace(/\./g, "\\.")}`));
  assert.ok(backend.includes("maintenance"), "archive image checksums cover maintenance");
  assert.match(web, new RegExp(`FROM ${runtimePins(sourceWeb).base.replace(/\./g, "\\.")}`));
  assert.match(web, /CMD \["node", "apps\/web\/server\.js"\]/);
  // A bumped source pin must change the generated Dockerfile (drift guard).
  const bumped = webArchiveDockerfile(identity, runtimePins(sourceWeb.replace(/node:22\.23\.4-bookworm-slim AS runner/, "node:22.24.0-bookworm-slim AS runner")));
  assert.ok(bumped.includes("node:22.24.0-bookworm-slim"), "pin drift must flow into the generated Dockerfile");
  // No Alpine/apk residue anywhere: images are Debian bookworm only.
  for (const dockerfile of [backend, web, readFileSync(join(root, "Dockerfile"), "utf8"), readFileSync(join(root, "Dockerfile.web"), "utf8")]) {
    assert.doesNotMatch(dockerfile, /^FROM .*alpine/m, "alpine base must be gone");
    assert.doesNotMatch(dockerfile, /apk add/, "apk must be gone");
  }
  assert.ok(web.includes("groupadd") && web.includes("useradd"), "Debian user syntax required");
  // The backend archive Dockerfile must keep the archive's build-info.json
  // (no host-written override) — S2 guard.
  assert.ok(!/COPY entrypoint.sh build-info\.json/.test(backend), "backend keeps archive build-info.json");
  assert.ok(backend.includes("COPY entrypoint.sh ./") && !backend.includes("COPY build-info.json"), "no host build-info in backend context");
});

test("R2: a binary whose hash contradicts the (matching) manifest fails", t => {
  const fixture = archiveFixture(t);
  writeDockerStub(t, fixture, { tamperedBinary: true });
  writeFileSync(join(fixture.dir, "dist/built"), "built");
  const result = runLocalImages(fixture, ["--arch", "amd64", "--verify"]);
  assert.notEqual(result.status, 0, "tampered binary must fail");
  assert.match(result.stderr, /maintenance bytes differ from the verified archive/);
});

test("R3: image web-build.json differing from the archive copy fails", t => {
  const fixture = archiveFixture(t);
  writeDockerStub(t, fixture, { tamperedWebBuild: true });
  writeFileSync(join(fixture.dir, "dist/built"), "built");
  const result = runLocalImages(fixture, ["--arch", "amd64", "--verify"]);
  assert.notEqual(result.status, 0, "tampered web-build.json must fail");
  assert.match(result.stderr, /web-build\.json differs from the verified candidate archive/);
});

test("command lists stay in sync: local-images BACKEND_COMMANDS equals build-backend COMMANDS", () => {
  // build-backend.py is the single source of truth for archive members.
  const source = execFileSync("python3", ["-c",
    "import importlib.util; s=importlib.util.spec_from_file_location('b','scripts/build-backend.py');"
    + " m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(','.join(m.COMMANDS))"],
    { cwd: root, encoding: "utf8" }).trim();
  assert.deepEqual(source.split(","), BACKEND_COMMANDS, "local-images.mjs and build-backend.py command sets differ");
});
test("#19: a web image whose sharp native module fails to load fails verification", t => {
  const fixture = archiveFixture(t);
  writeDockerStub(t, fixture);
  writeFileSync(join(fixture.dir, "dist/built"), "built");
  const result = runLocalImages(fixture, ["--arch", "amd64", "--verify"], { STUB_SHARP_FAIL: "1" });
  assert.notEqual(result.status, 0, "broken sharp load must fail verification");
  assert.match(result.stderr, /sharp/);
  assert.equal(existsSync(join(fixture.dir, `dist/candidate/${identity.tag}/local-images/linux-amd64/images.json`)), false);
});

test("#19: healthy sharp load is recorded in evidence", t => {
  const fixture = archiveFixture(t);
  writeDockerStub(t, fixture);
  const imagesJson = join(fixture.dir, `dist/candidate/${identity.tag}/local-images/linux-amd64/images.json`);
  const result = runLocalImages(fixture, ["--arch", "amd64", "--from-archives", "backend,web"]);
  assert.equal(result.status, 0, result.stderr);
  const evidenceFile = JSON.parse(readFileSync(imagesJson, "utf8"));
  assert.equal(evidenceFile.images.find(item => item.component === "web").evidence.native_modules, "sharp:loaded");
});
