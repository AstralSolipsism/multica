#!/usr/bin/env node
// Build/verify local candidate images. Never starts the application entrypoint,
// mounts deployment data, pulls application images, pushes, or activates a feed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { checkRelease, releaseEnvironment } from "./check-release.mjs";

const run = (args, options = {}) => (execFileSync("docker", args, { encoding: "utf8", ...options }) ?? "").trim();
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

export function checkImageInfo(info, identity, arch) {
  requireThat(/^sha256:[a-f0-9]{64}$/.test(info.Id), "missing full local Image ID");
  requireThat(info.Os === "linux" && info.Architecture === arch, "image architecture differs");
  const labels = info.Config.Labels ?? {};
  for (const [key, value] of Object.entries({ version: identity.version, revision: identity.commit,
    source: "https://github.com/AstralSolipsism/multica", created: identity.date })) {
    requireThat(labels[`org.opencontainers.image.${key}`] === value, `image ${key} differs`);
  }
}

function verifyImages(identity, arch) {
  return ["backend", "web"].map(component => {
    const name = `labrastro-${component}:${identity.tag}`;
    const [info] = JSON.parse(run(["image", "inspect", name]));
    checkImageInfo(info, identity, arch);
    // Verify by immutable ID with no network, mounts or application startup.
    const execute = (entrypoint, args) => run(["run", "--rm", "--pull=never", "--network=none",
      "--read-only", "--entrypoint", entrypoint, info.Id, ...args]);
    let evidence;
    if (component === "backend") {
      const cli = JSON.parse(execute("/app/multica", ["version", "--output", "json"]));
      requireThat(["version", "commit", "date"].every(key => cli[key] === identity[key]), "image contains an old CLI");
      requireThat(cli.os === "linux" && cli.arch === arch, "CLI runtime architecture differs");
      const versions = {};
      for (const command of ["server", "migrate", "backfill_task_usage_hourly", "backfill_codex_usage_cache"]) {
        versions[command] = execute(`/app/${command}`, ["--version"]);
        requireThat(versions[command] === `${command} ${identity.version} (commit: ${identity.commit})`,
          `image ${command} identity differs`);
      }
      execute("sha256sum", ["-c", "/app/checksums.txt"]);
      const actual = execute("cat", ["/app/checksums.txt"]);
      // Check migration/license bytes against the source too, not just a
      // checksum list produced inside a potentially stale image.
      const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", identity.commit, "server/migrations"], { encoding: "utf8" }).trim().split("\n");
      const expected = [...tracked, "LICENSE", "NOTICE", "docker/entrypoint.sh"].map(path => {
        const bytes = execFileSync("git", ["show", `${identity.commit}:${path}`]);
        return `${createHash("sha256").update(bytes).digest("hex")}  ${path.replace(/^(server|docker)\//, "")}`;
      });
      const lines = actual.split("\n");
      requireThat(expected.every(line => lines.includes(line)), "image migration/license content differs from source");
      const binaries = ["server", "multica", "migrate", "backfill_task_usage_hourly", "backfill_codex_usage_cache", "go-build-info.txt"];
      requireThat(lines.length === expected.length + binaries.length && binaries.every(name =>
        lines.some(line => line.endsWith(`  ${name}`) && /^[a-f0-9]{64}  /.test(line))), "image required file set differs");
      evidence = { cli, versions, binary_checksums: execute("sha256sum", ["/app/multica", ...Object.keys(versions).map(name => `/app/${name}`)]),
        migration_files: tracked.length, go_build_info: execute("cat", ["/app/go-build-info.txt"]) };
    } else {
      const metadata = JSON.parse(execute("node", ["-p", "require('fs').readFileSync('/app/build-info.json','utf8')"]));
      for (const key of ["version", "commit", "date"]) requireThat(metadata[key] === identity[key], `Web ${key} differs`);
      for (const name of ["LICENSE", "NOTICE"]) {
        const expected = createHash("sha256").update(execFileSync("git", ["show", `${identity.commit}:${name}`])).digest("hex");
        requireThat(execute("sha256sum", [`/app/${name}`]).startsWith(expected + "  "), `Web ${name} differs from source`);
      }
      // Require the version in the compiled client, not only a label/sidecar.
      execute("node", ["-e", `const fs=require('fs'), path=require('path');
        const version=JSON.parse(fs.readFileSync('/app/build-info.json')).version;
        function matches(dir) { return fs.readdirSync(dir,{withFileTypes:true}).some(e =>
          e.isDirectory() ? matches(path.join(dir,e.name)) : e.name.endsWith('.js') && fs.readFileSync(path.join(dir,e.name),'utf8').includes(JSON.stringify(version))); }
        if (!matches('/app/apps/web/.next/static')) throw Error('compiled Web version missing');
        for (const name of ['LICENSE','NOTICE']) if (!fs.statSync('/app/'+name).size) throw Error(name+' missing');`]);
      evidence = { ...metadata, compiled_version: "passed" };
    }
    return { component, name, id: info.Id, os: info.Os, arch: info.Architecture,
      labels: info.Config.Labels, build_method: "local_from_source", registry_required: false,
      status: "verified", evidence };
  });
}

function main() {
  const { values } = parseArgs({ options: {
    verify: { type: "boolean", default: false },
    arch: { type: "string", default: process.arch === "arm64" ? "arm64" : "amd64" },
    "no-cache": { type: "boolean", default: false },
  } });
  requireThat(["amd64", "arm64"].includes(values.arch), "arch must be amd64 or arm64");
  const identity = checkRelease({ repository: process.env.LABRASTRO_RELEASE_REPOSITORY,
    tag: process.env.LABRASTRO_RELEASE_TAG, sha: process.env.LABRASTRO_RELEASE_SHA,
    mode: process.env.LABRASTRO_RELEASE_MODE ?? "candidate", requireTag: true });
  const output = resolve(identity.artifact_dir, "local-images", `linux-${values.arch}`);
  mkdirSync(output, { recursive: true });
  const started = new Date().toISOString();
  if (!values.verify) {
    // Never silently overwrite a candidate tag; --verify handles an existing
    // image. A deliberate rebuild uses a separate Docker context/daemon.
    for (const component of ["backend", "web"]) {
      let exists = false;
      try { run(["image", "inspect", `labrastro-${component}:${identity.tag}`], { stdio: ["ignore", "pipe", "pipe"] }); exists = true; } catch { /* daemon checked below */ }
      requireThat(!exists, "candidate image already exists; verify it or build in an isolated Docker context");
    }
    run(["info"]);
    const scratch = mkdtempSync(join(output, "source-"));
    try {
      const archive = join(scratch, "source.tar");
      execFileSync("git", ["archive", "--format=tar", "-o", archive, identity.commit]);
      execFileSync("tar", ["-xf", archive, "-C", scratch]);
      rmSync(archive);
      const environment = releaseEnvironment(identity);
      for (const component of ["backend", "web"]) {
        const dockerfile = component === "backend" ? "Dockerfile" : "Dockerfile.web";
        const buildArgs = ["VERSION", "COMMIT", "DATE", ...(component === "web" ? ["NEXT_PUBLIC_APP_VERSION"] : [])]
          .flatMap(key => ["--build-arg", `${key}=${environment[key]}`]);
        run(["build", "--platform", `linux/${values.arch}`, ...(values["no-cache"] ? ["--no-cache"] : []),
          "--file", join(scratch, dockerfile), "--tag", `labrastro-${component}:${identity.tag}`, ...buildArgs, scratch], { stdio: "inherit" });
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const images = verifyImages(identity, values.arch);
  writeFileSync(join(output, "images.json"), JSON.stringify({ ...identity, started_at: started,
    verified_at: new Date().toISOString(), docker: JSON.parse(run(["version", "--format", "{{json .}}"])), images }, null, 2) + "\n");
  writeFileSync(join(output, "images.env"), Object.entries({ ...releaseEnvironment(identity), MULTICA_IMAGE_TAG: identity.tag })
    .map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  console.log(`Verified local image evidence: ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`[local-images] ${error.message}`); process.exitCode = 1; }
}
