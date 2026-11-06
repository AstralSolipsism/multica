#!/usr/bin/env node
// Build/verify local candidate images. Never starts the application entrypoint,
// mounts deployment data, pulls application images, pushes, or activates a feed.
//
// Two build paths per component, both ending in the same byte-level verification:
//  - default: full source build from a git archive of the candidate commit
//    (build_method "local_from_source");
//  - --from-archives backend,web: package images from the candidate component
//    archives after verifying their SHA-256 against the component evidence
//    (backend-build.json / web-inventory.json), without recompiling Go or
//    Next.js (build_method "local_from_archives"). The web archive is
//    linux/amd64 only; other architectures build web from source.
//
// Contract note: the backend archive ships exactly build-backend.py's COMMANDS
// (including `maintenance`, which has no --version output and is exempt from
// version-execution checks there and here) plus migrations, notices and
// evidence files — but NOT `go-build-info.txt`. scripts/build-backend.py's
// command set is the single source of truth for what an archive image contains.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { checkRelease, releaseEnvironment } from "./check-release.mjs";

const run = (args, options = {}) => (execFileSync("docker", args, { encoding: "utf8", ...options }) ?? "").trim();
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

// Binaries the backend archive ships per build-backend.py's COMMANDS.
// maintenance ships for operations (docs/maintenance-jobs.md) but, matching
// the archive verifier, is exempt from --version execution checks.
const BACKEND_COMMANDS = ["server", "multica", "migrate", "maintenance", "backfill_task_usage_hourly", "backfill_codex_usage_cache"];
const VERSION_CHECKED = ["server", "migrate", "backfill_task_usage_hourly", "backfill_codex_usage_cache"];
// Files the source Dockerfile ships besides migrations and notices.
const SOURCE_BINARIES = ["server", "multica", "migrate", "maintenance", "backfill_task_usage_hourly", "backfill_codex_usage_cache", "go-build-info.txt"];
// File set the backend archive ships per build-backend.py's exact member check.
const ARCHIVE_BINARIES = [...BACKEND_COMMANDS, "build-info.json", "expected-migrations.txt"];

export { BACKEND_COMMANDS };

export function checkImageInfo(info, identity, arch) {
  requireThat(/^sha256:[a-f0-9]{64}$/.test(info.Id), "missing full local Image ID");
  requireThat(info.Os === "linux" && info.Architecture === arch, "image architecture differs");
  const labels = info.Config.Labels ?? {};
  for (const [key, value] of Object.entries({ version: identity.version, revision: identity.commit,
    source: "https://github.com/AstralSolipsism/multica", created: identity.date })) {
    requireThat(labels[`org.opencontainers.image.${key}`] === value, `image ${key} differs`);
  }
}

export function archiveName(component, version, arch) {
  return component === "backend"
    ? `labrastro-backend-${version}-linux-${arch}.tar.gz`
    : `labrastro-web-${version}-linux-amd64-node-standalone.tar.gz`;
}

// Runtime-stage pins (base image, package floors) are read from the source
// Dockerfile so a security bump there flows into archive-packaged images;
// tests assert the generated Dockerfile matches the source's runtime stage.
// `packages` covers both apk and apt-get install lines.
export function runtimePins(dockerfileText) {
  const stages = [...dockerfileText.matchAll(/^FROM (\S+)(?: AS (\S+))?$/gm)];
  requireThat(stages.length > 0, "source Dockerfile has no FROM stages");
  const runner = stages.find(([, image, name]) => name === "runner") ?? stages.at(-1);
  const packages = [...dockerfileText.matchAll(/^RUN (?:apk add --no-cache|apt-get update && apt-get install -y --no-install-recommends) (.+)$/gm)]
    .flatMap(match => match[1].split("&&").map(part => part.trim()))
    .map(part => part.replace(/^(apt-get|apk)\S*\s+/g, "").trim())
    .filter(part => part && !part.startsWith("rm -rf"))
    .flatMap(part => part.split(/\s+/))
    .filter(token => /^[a-z][a-z0-9.+-]*$/.test(token));
  const floors = [...new Set(packages.filter(token => token.includes(">=")))];
  return { base: runner[1], packages: [...new Set(packages)], floors };
}

const quoted = value => `"${String(value).replace(/(["\\])/g, "\\$1")}"`;
const identityLabels = identity => `LABEL org.opencontainers.image.source="https://github.com/AstralSolipsism/multica" \\
      org.opencontainers.image.version=${quoted(identity.version)} \\
      org.opencontainers.image.revision=${quoted(identity.commit)} \\
      org.opencontainers.image.created=${quoted(identity.date)}`;

// Generated Dockerfiles mirror the runtime stages of ./Dockerfile and
// ./Dockerfile.web; the compile stages are replaced by the archive contents.
// build-info.json is written on the host and COPY'd in — printf escaping
// inside a generated RUN is a documented trap, so none is generated.
export function backendArchiveDockerfile(identity, pins) {
  requireThat(pins?.base, "backend runtime pins are required");
  return `# Generated by scripts/local-images.mjs --from-archives: package the
# SHA-256-verified backend candidate archive without recompiling Go.
# Runtime-stage pins are read from the source Dockerfile (runtimePins()).
FROM ${pins.base}

RUN apt-get update && apt-get install -y --no-install-recommends ${pins.packages.join(" ")} && rm -rf /var/lib/apt/lists/*

WORKDIR /app

${identityLabels(identity)}

COPY app/ ./
COPY entrypoint.sh ./
# Keep the archive's own checksum list as the byte-level anchor, then cover
# every image file (including entrypoint.sh) in the fresh list. The archive's
# own build-info.json stays as the in-image evidence.
RUN sed -i 's/\\r$//' entrypoint.sh && chmod +x entrypoint.sh && \\
    mv checksums.txt archive-checksums.txt && \\
    sha256sum ${[...BACKEND_COMMANDS, "LICENSE", "NOTICE", "entrypoint.sh", "build-info.json", "expected-migrations.txt"].join(" ")} \\
      migrations/* > checksums.txt

EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]
`;
}

export function webArchiveDockerfile(identity, pins) {
  requireThat(pins?.base, "web runtime pins are required");
  const floorLine = pins.floors.length
    ? `\nRUN apt-get update && apt-get install -y --no-install-recommends ${pins.floors.join(" ")} && rm -rf /var/lib/apt/lists/*\n`
    : "\n";
  return `# Generated by scripts/local-images.mjs --from-archives: package the
# SHA-256-verified web candidate archive without rebuilding Next.js.
# Runtime-stage pins are read from the source Dockerfile.web (runtimePins()).
# glibc base matches the CI-built standalone archive (sharp native modules).
FROM ${pins.base}

WORKDIR /app

${identityLabels(identity)}
${floorLine}
ENV NODE_ENV=production
ENV REMOTE_API_URL=http://backend:8080

# bookworm-slim ships passwd's useradd/groupadd, not busybox adduser/addgroup.
RUN groupadd --system --gid 1001 nodejs && \\
    useradd --system --uid 1001 --gid nodejs --no-create-home nextjs

COPY --chown=nextjs:nodejs app/ ./
COPY --chown=nextjs:nodejs build-info.json ./build-info.json

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
`;
}

// Verify candidate archive bytes against the component builder's evidence
// before any image consumes them; the evidence identity must be this candidate.
export function verifyArchiveEvidence(component, identity, arch) {
  const evidenceName = component === "backend" ? "backend-build.json" : "web-inventory.json";
  const name = archiveName(component, identity.version, arch);
  const assets = join(identity.artifact_dir, "assets");
  const archive = join(assets, name);
  requireThat(existsSync(archive), `missing candidate archive for --from-archives: ${archive}`);
  const evidence = JSON.parse(readFileSync(join(assets, evidenceName), "utf8"));
  const keys = component === "backend" ? ["repository", "tag", "version", "commit"] : ["tag", "version", "commit"];
  for (const key of keys) requireThat(evidence[key] === identity[key], `archive evidence ${key} differs (${evidenceName})`);
  const entry = (evidence.artifacts ?? []).find(item => item.name === name);
  requireThat(entry, `${evidenceName} does not inventory ${name}`);
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  requireThat(actual === entry.sha256, `archive SHA-256 differs from ${evidenceName}: ${name}`);
  requireThat(statSync(archive).size === entry.bytes, `archive size differs from ${evidenceName}: ${name}`);
  return { name, sha256: actual, bytes: entry.bytes };
}

function buildFromArchive(component, identity, arch, descriptor, scratch, noCache) {
  const context = join(scratch, `archive-${component}`);
  const app = join(context, "app");
  mkdirSync(app, { recursive: true });
  const archive = join(identity.artifact_dir, "assets", descriptor.name);
  const root = component === "web" ? `labrastro-web-${identity.version}-linux-amd64-node-standalone` : null;
  const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 1 << 24 }).split("\n").filter(Boolean);
  requireThat(members.length > 0 && members.every(member => root
    ? member === root || member.startsWith(root + "/")
    : !member.startsWith("/") && !member.split("/").includes("..")),
    "archive layout differs from the component contract");
  execFileSync("tar", ["-xzf", archive, "-C", app, ...(root ? ["--strip-components=1"] : [])]);
  // Pins come from the source Dockerfile at the same reviewed commit.
  const source = execFileSync("git", ["show", `${identity.commit}:${component === "backend" ? "Dockerfile" : "Dockerfile.web"}`], { encoding: "utf8", maxBuffer: 1 << 20 });
  const pins = runtimePins(source);
  writeFileSync(join(context, "Dockerfile"),
    component === "backend" ? backendArchiveDockerfile(identity, pins) : webArchiveDockerfile(identity, pins));
  if (component === "backend") {
    // The archive ships no entrypoint; take it from the same reviewed commit
    // the migration/license verification compares against.
    writeFileSync(join(context, "entrypoint.sh"), execFileSync("git", ["show", `${identity.commit}:docker/entrypoint.sh`]));
  }
  // Image-side build-info.json (web only): exact bytes on the host, no shell
  // escaping. The backend keeps the archive's own build-info.json untouched.
  if (component === "web") {
    writeFileSync(join(context, "build-info.json"), `${JSON.stringify({
      version: identity.version, commit: identity.commit, date: identity.date })}\n`);
  }
  run(["build", "--platform", `linux/${arch}`, ...(noCache ? ["--no-cache"] : []),
    "--file", join(context, "Dockerfile"), "--tag", `labrastro-${component}:${identity.tag}`, context], { stdio: "inherit" });
}

function archiveMemberBytes(archivePath, member) {
  return execFileSync("tar", ["-xOzf", archivePath, member], { maxBuffer: 1 << 26 });
}

function verifyImages(identity, arch) {
  return ["backend", "web"].map(component => {
    const name = `labrastro-${component}:${identity.tag}`;
    const [info] = JSON.parse(run(["image", "inspect", name]));
    checkImageInfo(info, identity, arch);
    // Verify by immutable ID with no network, mounts or application startup.
    const execute = (entrypoint, args) => run(["run", "--rm", "--pull=never", "--network=none",
      "--read-only", "--entrypoint", entrypoint, info.Id, ...args]);
    // The packaging mode is detected from the image itself, so a later --verify
    // re-checks the same anchoring without run-time state. An archive-anchored
    // image requires the candidate archive on disk; the anchor compares the
    // IMAGE against the verified HOST archive, not the image against itself.
    const hasFile = path => { try { execute("cat", [path]); return true; } catch { return false; } };
    const archiveAnchored = hasFile(component === "backend" ? "/app/archive-checksums.txt" : "/app/web-build.json");
    const archive = archiveAnchored ? verifyArchiveEvidence(component, identity, arch) : null;
    const archivePath = archive ? join(identity.artifact_dir, "assets", archive.name) : null;
    let evidence;
    if (component === "backend") {
      const cli = JSON.parse(execute("/app/multica", ["version", "--output", "json"]));
      requireThat(["version", "commit", "date"].every(key => cli[key] === identity[key]), "image contains an old CLI");
      requireThat(cli.os === "linux" && cli.arch === arch, "CLI runtime architecture differs");
      const versions = {};
      for (const command of VERSION_CHECKED) {
        versions[command] = execute(`/app/${command}`, ["--version"]);
        requireThat(versions[command] === `${command} ${identity.version} (commit: ${identity.commit})`,
          `image ${command} identity differs`);
      }
      execute("sha256sum", ["-c", "/app/checksums.txt"]);
      const actual = execute("cat", ["/app/checksums.txt"]);
      // Check migration/license bytes against the source too, not just a
      // checksum list produced inside a potentially stale image.
      const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", identity.commit, "server/migrations"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      const expected = [...tracked, "LICENSE", "NOTICE", "docker/entrypoint.sh"].map(path => {
        const bytes = execFileSync("git", ["show", `${identity.commit}:${path}`]);
        return `${createHash("sha256").update(bytes).digest("hex")}  ${path.replace(/^(server|docker)\//, "")}`;
      });
      const lines = actual.split("\n");
      requireThat(expected.every(line => lines.includes(line)), "image migration/license content differs from source");
      const binaries = archiveAnchored ? ARCHIVE_BINARIES : SOURCE_BINARIES;
      requireThat(lines.length === expected.length + binaries.length && binaries.every(name =>
        lines.some(line => line.endsWith(`  ${name}`) && /^[a-f0-9]{64}  /.test(line))), "image required file set differs");
      let goBuildInfo;
      if (archiveAnchored) {
        // Byte-level anchor against the HOST archive: the image's copy of the
        // archive checksum list must equal the verified archive's own list,
        // and the image binaries must match that same list. A self-consistent
        // stale image fails here because its list differs from the host's.
        const hostList = archiveMemberBytes(archivePath, "checksums.txt").toString("utf8");
        // `run()` trims docker output; compare trimmed so a trailing newline
        // difference does not mask a real byte difference.
        requireThat(execute("cat", ["/app/archive-checksums.txt"]) === hostList.trim()
          || execute("cat", ["/app/archive-checksums.txt"]) + "\n" === hostList,
          "image archive checksum list differs from the verified candidate archive");
        const listed = new Map(hostList.split("\n").filter(Boolean).map(line => { const [hash, file] = line.split("  "); return [file, hash]; }));
        const hashes = execute("sha256sum", BACKEND_COMMANDS.map(command => `/app/${command}`)).split("\n");
        requireThat(hashes.length === BACKEND_COMMANDS.length, "image binary hash probe differs");
        for (let index = 0; index < BACKEND_COMMANDS.length; index++) {
          const command = BACKEND_COMMANDS[index];
          requireThat(listed.has(command) && hashes[index].endsWith(`  /app/${command}`)
            && hashes[index].slice(0, 64) === listed.get(command),
            `image ${command} bytes differ from the verified archive`);
        }
        // Toolchain evidence comes from the archive's build-info.json; its
        // `go` field was pinned by the backend verifier at build time.
        const archiveInfo = JSON.parse(archiveMemberBytes(archivePath, "build-info.json").toString("utf8"));
        requireThat(archiveInfo.version === identity.version && archiveInfo.commit === identity.commit,
          "archive build-info identity differs");
        goBuildInfo = archiveInfo.go ?? "unknown";
      } else {
        goBuildInfo = execute("cat", ["/app/go-build-info.txt"]);
      }
      evidence = { cli, versions, binary_checksums: execute("sha256sum", ["/app/multica", ...Object.keys(versions).map(name => `/app/${name}`)]),
        migration_files: tracked.length, go_build_info: goBuildInfo,
        ...(archiveAnchored ? { archive_anchor: "passed" } : {}) };
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
      // Native-dependency probe (#19): the standalone server traces sharp into
      // node_modules; load it for real on the image's own runtime (no network,
      // read-only). A glibc/musl mismatch fails closed here instead of at the
      // first optimized image request in production.
      execute("node", ["-e", `process.chdir('/app/apps/web');
        const path=require('path');
        let resolved;
        try { resolved = require.resolve('sharp', { paths: [process.cwd(), '/app/apps/web/server.js/..'] }); }
        catch { throw Error('sharp is not present in the standalone tree'); }
        const sharp = require(resolved);
        if (typeof sharp.resize !== 'function') throw Error('sharp loaded but is not functional');`]);
      if (archiveAnchored) {
        // Anchor the image's web-build.json to the verified host archive copy.
        const hostBytes = archiveMemberBytes(archivePath, `${`labrastro-web-${identity.version}-linux-amd64-node-standalone`}/web-build.json`);
        requireThat((execute("cat", ["/app/web-build.json"]).trimEnd() + "\n") === hostBytes.toString("utf8"),
          "image web-build.json differs from the verified candidate archive");
      }
      evidence = { ...metadata, compiled_version: "passed", native_modules: "sharp:loaded",
        ...(archiveAnchored ? { archive_anchor: "passed" } : {}) };
    }
    return { component, name, id: info.Id, os: info.Os, arch: info.Architecture,
      labels: info.Config.Labels, build_method: archiveAnchored ? "local_from_archives" : "local_from_source",
      ...(archive ? { archive } : {}), registry_required: false,
      status: "verified", evidence };
  });
}

function main() {
  const { values } = parseArgs({ options: {
    verify: { type: "boolean", default: false },
    arch: { type: "string", default: process.arch === "arm64" ? "arm64" : "amd64" },
    "no-cache": { type: "boolean", default: false },
    "from-archives": { type: "string", default: "" },
  } });
  requireThat(["amd64", "arm64"].includes(values.arch), "arch must be amd64 or arm64");
  const fromArchives = [...new Set(values["from-archives"].split(",").map(value => value.trim()).filter(Boolean))];
  requireThat(fromArchives.every(component => ["backend", "web"].includes(component)),
    "--from-archives accepts a comma list of backend and web only");
  requireThat(!fromArchives.includes("web") || values.arch === "amd64",
    "the web candidate archive is linux/amd64 only; build web from source for other architectures");
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
    const descriptors = {};
    for (const component of fromArchives) descriptors[component] = verifyArchiveEvidence(component, identity, values.arch);
    const scratch = mkdtempSync(join(output, "source-"));
    try {
      let sourceReady = false;
      const ensureSource = () => {
        if (sourceReady) return;
        const archive = join(scratch, "source.tar");
        execFileSync("git", ["archive", "--format=tar", "-o", archive, identity.commit]);
        execFileSync("tar", ["-xf", archive, "-C", scratch]);
        rmSync(archive);
        sourceReady = true;
      };
      for (const component of ["backend", "web"]) {
        if (fromArchives.includes(component)) {
          buildFromArchive(component, identity, values.arch, descriptors[component], scratch, values["no-cache"]);
          continue;
        }
        // Source fallback keeps a full local build available.
        ensureSource();
        const dockerfile = component === "backend" ? "Dockerfile" : "Dockerfile.web";
        const buildArgs = ["VERSION", "COMMIT", "DATE", ...(component === "web" ? ["NEXT_PUBLIC_APP_VERSION"] : [])]
          .flatMap(key => ["--build-arg", `${key}=${releaseEnvironment(identity)[key]}`]);
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
