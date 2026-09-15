#!/usr/bin/env python3
"""Receipts, assembly and draft handoff for the native Actions candidate graph.

No tag creation, registry, internal upload or activation. Component builders
remain authoritative; receipts bind their bytes to one Actions run/attempt.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location("backend", Path(__file__).with_name("build-backend.py"))
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
require, now, write_json = backend.require, backend.now, backend.write_json
REPOSITORY = "AstralSolipsism/multica"
ROOT = Path(__file__).resolve().parents[1]
JOBS = ("prepare", "qa-go", "qa-web", "cli", "backend", "web", "desktop-linux", "desktop-win", "images-amd64", "images-arm64")
NEEDS = ("prepare", "qa-go", "qa-web", "cli", "backend", "web", "desktop", "images")
TARGETS = ("linux-x64", "linux-arm64", "win-x64", "win-arm64")


def run(args, **kwargs):
    return subprocess.check_output(args, cwd=ROOT, text=True, **kwargs).strip()


def sha(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def identity():
    return json.loads(run(["node", "scripts/check-release.mjs", "--require-tag", "--mode", "candidate"]))


def context():
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "not the target GitHub repository")
    result = {k: os.environ.get(v, "") for k, v in (("run_id", "GITHUB_RUN_ID"), ("run_attempt", "GITHUB_RUN_ATTEMPT"))}
    require(all(re.fullmatch(r"[1-9][0-9]*", v) for v in result.values()), "missing Actions run/attempt")
    return result


def same_identity(actual, expected):
    for key in ("repository", "tag", "version", "commit", "tag_object", "mode"):
        require(actual.get(key) == expected[key], f"candidate identity differs: {key}")
    require(actual.get("tag_exists") is True and actual.get("mode") == "candidate", "successful tagged candidate preflight required")


def safe_path(name):
    path = PurePosixPath(name)
    require(isinstance(name, str) and name and not path.is_absolute() and str(path) == name
            and all(p not in ("..", ".") for p in path.parts) and not re.search(r"[\\:\s#]", name),
            f"unsafe path: {name}")
    return name


def files_in(directory):
    require(directory.is_dir() and not directory.is_symlink(), f"missing directory: {directory}")
    result = []
    for path in sorted(directory.rglob("*")):
        require(not path.is_symlink(), f"linked handoff file: {path}")
        require(path.is_file() or path.is_dir(), f"special handoff file: {path}")
        if path.is_file():
            safe_path(path.relative_to(directory).as_posix())
            require(path.stat().st_size > 0, f"empty handoff file: {path}")
            result.append(path)
    return result


def file_record(path, base):
    return {"name": path.relative_to(base).as_posix(), "bytes": path.stat().st_size, "sha256": sha(path)}


def verify_records(directory, records):
    actual = [file_record(p, directory) for p in files_in(directory) if p != directory / "receipt.json"]
    require(actual == records, f"payload missing, changed or unexpected: {directory.name}")


def check_needs(needs):
    require(set(needs) == set(NEEDS), "required job set differs")
    failures = {k: v.get("result", "missing") for k, v in needs.items() if v.get("result") != "success"}
    require(not failures, f"required jobs failed/skipped/missing: {failures}")


def cli_names(version):
    return [(system, arch, name) for system in ("darwin", "linux", "windows") for arch in ("amd64", "arm64")
            for name in (f'multica-cli-{version}-{system}-{arch}.{"zip" if system == "windows" else "tar.gz"}',
                         f'multica_{system}_{arch}.{"zip" if system == "windows" else "tar.gz"}')]


def cli_source_files():
    # Match GoReleaser's root LICENSE*/README*/NOTICE collection against Git,
    # including translated READMEs, without accepting ignored local additions.
    names = run(["git", "ls-tree", "--name-only", "HEAD"]).splitlines()
    return [n for n in names if n == "NOTICE" or n.startswith(("LICENSE", "README"))]


def verify_cli(directory, meta):
    results, binaries = [], {}
    sources = cli_source_files()
    require({"LICENSE", "NOTICE", "README.md"} <= set(sources), "missing CLI source notices")
    for system, arch, name in cli_names(meta["version"]):
        path = directory / name
        binary_name = "multica.exe" if system == "windows" else "multica"
        expected = {binary_name, *sources}
        if system == "windows":
            with zipfile.ZipFile(path) as archive:
                members = archive.infolist()
                require(all(m.filename in expected for m in members), "unsafe CLI zip")
                data = {m.filename: archive.read(m) for m in members}
        else:
            with tarfile.open(path) as archive:
                members = archive.getmembers()
                require(all(m.isfile() and m.name in expected for m in members), "unsafe CLI tar")
                require(any(m.name == binary_name and m.mode & 0o111 for m in members), "CLI is not executable")
                data = {m.name: archive.extractfile(m).read() for m in members}
        require(len(members) == len(data) and set(data) == expected, "CLI archive required files differ")
        require(all(data.values()), "empty CLI archive member")
        for notice in sources:
            require(data[notice] == (ROOT / notice).read_bytes(), f"CLI {notice} differs from source")
        key = system + "/" + arch
        if key in binaries:
            require(data[binary_name] == binaries[key], f"legacy CLI bytes differ: {key}")
            continue
        binaries[key] = data[binary_name]
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / binary_name
            binary.write_bytes(data[binary_name])
            binary.chmod(0o755)
            info = json.loads(run(["go", "version", "-m", "-json", str(binary)]))
            settings = {s["Key"]: s["Value"] for s in info["Settings"]}
            for k, v in {"GOOS": system, "GOARCH": arch, "CGO_ENABLED": "0", "vcs.revision": meta["commit"], "vcs.modified": "false"}.items():
                require(settings.get(k) == v, f"CLI {key}: wrong {k}")
            require(info["Path"].endswith("/cmd/multica"), "wrong CLI command")
            flags = shlex.split(settings.get("-ldflags", ""))
            for field in ("version", "commit", "date"):
                require(f'main.{field}={meta[field]}' in flags, f"CLI {key}: wrong {field}")
            execution = "not_run_cross_target"
            if system == "linux":
                runner = backend.version_runner(ROOT, arch)
                value = json.loads(run([*runner, str(binary), "version", "--output", "json"]))
                require(all(value.get(k) == meta[k] for k in ("version", "commit", "date")), "CLI runtime identity differs")
                execution = "qemu" if runner else "native"
            results.append({"os": system, "arch": arch, "build": "passed", "binary_metadata": "passed", "version_execution": execution, "go": info["GoVersion"]})
    return results


def extract(archive, destination, prefix=None):
    # Python's data filter also rejects symlinks escaping the extraction root.
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        names = [m.name.rstrip("/") for m in members]
        require(len(names) == len(set(names)), "duplicate tar entry")
        for member, name in zip(members, names):
            safe_path(name)
            prefixes = [prefix] if isinstance(prefix, str) else prefix
            require(not prefixes or any(name == p or name.startswith(p + "/") for p in prefixes), "unexpected archive root")
            require(member.isfile() or member.isdir() or member.issym(), "unsafe tar member")
        tar.extractall(destination, filter="data")


def begin(job, meta, ctx):
    path = ROOT / "dist/job-start" / f"{job}.json"
    require(not path.exists(), "job already started; use a fresh checkout")
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, {**meta, **ctx, "job": job, "started_at": now()})


def seal(job, meta, ctx):
    receipt = read(ROOT / "dist/job-start" / f"{job}.json")
    same_identity(receipt, meta)
    require(all(receipt[k] == v for k, v in ctx.items()), "job started in another attempt")
    output = ROOT / "dist/transfer" / job
    require(not output.exists(), "sealed output exists; never overwrite a receipt")
    output.mkdir(parents=True)
    assets = ROOT / meta["artifact_dir"] / "assets"
    sources = []
    if job == "cli":
        sources = [ROOT / "dist/goreleaser" / name for _, _, name in cli_names(meta["version"])]
    elif job == "backend":
        sources = [assets / "backend-build.json", *[assets / f'labrastro-backend-{meta["version"]}-linux-{arch}.tar.gz' for arch in ("amd64", "arm64")]]
    elif job == "web":
        sources = [assets / name for name in ("web-build.json", "web-inventory.json", f'labrastro-web-{meta["version"]}-linux-amd64-node-standalone.tar.gz')]
    elif job.startswith("desktop-"):
        platform = job.removeprefix("desktop-")
        # Preserve full staging inputs, permissions and symlinks across Actions.
        with tarfile.open(output / f"{job}.tar.gz", "w:gz") as tar:
            for target in TARGETS:
                if target.startswith(platform + "-"):
                    path = ROOT / "apps/desktop/dist" / target
                    require(path.is_dir(), f"missing Desktop target {target}")
                    tar.add(path, arcname=target)
        shutil.copyfile(assets / "desktop-verification.json", output / "desktop-host.json")
    elif job.startswith("images-"):
        sources = [ROOT / meta["artifact_dir"] / "local-images" / ("linux-" + job.removeprefix("images-")) / "images.json"]
    for source in sources:
        require(source.is_file() and not source.is_symlink(), f"missing component output: {source}")
        shutil.copyfile(source, output / source.name)
    tools = {"python": sys.version, "node": run(["node", "--version"])}
    if os.environ.get("CANDIDATE_PNPM_VERSION"):
        tools["pnpm"] = os.environ["CANDIDATE_PNPM_VERSION"]
    for tool, args in (("go", ["go", "version"]), ("goreleaser", ["goreleaser", "--version"])):
        if shutil.which(tool):
            tools[tool] = run(args)
    write_json(output / "receipt.json", {**receipt, "finished_at": now(), "result": "success", "tools": tools,
               "files": [file_record(p, output) for p in files_in(output)]})


def load_inputs(inputs, meta, ctx):
    prefix = f'candidate-{ctx["run_id"]}-{ctx["run_attempt"]}-'
    require({p.name for p in inputs.iterdir()} == {prefix + job for job in JOBS}, "missing/extra component artifact; rerun ALL jobs")
    result = {}
    for job in JOBS:
        directory = inputs / (prefix + job)
        receipt = read(directory / "receipt.json")
        same_identity(receipt, meta)
        require(receipt["job"] == job and receipt["result"] == "success", f"failed receipt: {job}")
        require(all(receipt.get(k) == v for k, v in ctx.items()), "receipt from another run/attempt")
        require(receipt["started_at"] <= receipt["finished_at"], "invalid job times")
        verify_records(directory, receipt["files"])
        result[job] = (directory, receipt)
    return result


def artifact(path, meta, component, download=None, **target):
    return {**file_record(path, path.parent), "path": "assets/" + path.name,
            "download_path": download or f'releases/{meta["tag"]}/{path.name}', "component": component, **target}


def fragment(path, meta, assets):
    data = read(path)
    require(all(data.get(k) == meta[k] for k in ("tag", "version", "commit")), f"wrong fragment identity: {path.name}")
    for entry in data["artifacts"]:
        require(entry["path"] == "assets/" + safe_path(entry["name"]) and "/" not in entry["name"], "invalid flat name")
        file = assets / entry["name"]
        require(file.is_file() and sha(file) == entry["sha256"] and file.stat().st_size == entry["bytes"], "fragment bytes differ")
        safe_path(entry["download_path"])
        allowed = [f'{kind}/{meta["tag"]}/{entry["name"]}' for kind in ("cli", "desktop", "releases")]
        if entry["name"] == "cli-checksums.txt":
            allowed = [f'cli/{meta["tag"]}/checksums.txt']
        require(entry["download_path"] in allowed, "fragment download path differs")
    return data["artifacts"]


def assemble(inputs, output, meta, ctx, needs):
    require(not output.exists(), "candidate output already exists; use a fresh checkout")
    try:
        assemble_tree(inputs, output, meta, ctx, needs)
    except Exception:
        # A late verifier failure must not leave a successful completion marker.
        # Preserve partial component bytes for diagnosis; never resume them.
        for directory in (output / "assets", output / "downloads/releases" / meta["tag"]):
            for name in ("manifest.json", "checksums.txt", "release-validation.json"):
                (directory / name).unlink(missing_ok=True)
        raise


def assemble_tree(inputs, output, meta, ctx, needs):
    check_needs(needs)
    bundles = load_inputs(inputs, meta, ctx)
    assets = output / "assets"
    assets.mkdir(parents=True)
    entries = []
    for job in ("cli", "backend", "web"):
        for source in files_in(bundles[job][0]):
            if source.name != "receipt.json":
                require(not (assets / source.name).exists(), "duplicate component filename")
                shutil.copyfile(source, assets / source.name)
    cli_results = verify_cli(assets, meta)
    for system, arch, name in cli_names(meta["version"]):
        entries.append(artifact(assets / name, meta, "cli", f'cli/{meta["tag"]}/{name}', os=system, arch=arch))
    backend_results = [backend.verify_archive(assets / f'labrastro-backend-{meta["version"]}-linux-{arch}.tar.gz', ROOT, meta, arch) for arch in ("amd64", "arm64")]
    entries += fragment(assets / "backend-build.json", meta, assets)
    entries += fragment(assets / "web-inventory.json", meta, assets)
    web = read(assets / "web-build.json")
    require(all(web.get(k) == meta[k] for k in ("repository", "tag", "version", "commit")), "Web identity differs")
    require(web["build_platform"] == "linux/x64" and web["build_started_at"] <= web["build_finished_at"], "Web build evidence invalid")
    with tempfile.TemporaryDirectory() as temp:
        tree = f'labrastro-web-{meta["version"]}-linux-amd64-node-standalone'
        extract(assets / (tree + ".tar.gz"), temp, tree)
        unpacked = Path(temp) / tree
        require(read(unpacked / "web-build.json") == web, "Web archive evidence differs")
        require((unpacked / "apps/web/server.js").is_file(), "Web entry missing")
        for notice in ("LICENSE", "NOTICE"):
            require((unpacked / notice).read_bytes() == (ROOT / notice).read_bytes(), "Web notices differ")
        literal = json.dumps(meta["version"]).encode()
        require(any(literal in p.read_bytes() for p in (unpacked / "apps/web/.next/static").rglob("*.js")), "Web client version missing")
    dist = ROOT / "apps/desktop/dist"
    require(not dist.exists(), "Desktop scratch already exists")
    dist.mkdir(parents=True)
    hosts = {}
    for platform in ("linux", "win"):
        source = bundles["desktop-" + platform][0]
        extract(source / f"desktop-{platform}.tar.gz", dist, [t for t in TARGETS if t.startswith(platform + "-")])
        host = read(source / "desktop-host.json")
        require(set(host) == {t for t in TARGETS if t.startswith(platform + "-")}, "Desktop host target set differs")
        hosts.update(host)
    # The existing staging entry rechecks all four unpacked apps, bundled CLIs,
    # blockmaps and every generated/compatibility feed against actual files.
    require(output == ROOT / meta["artifact_dir"], "assembly output must use the shared candidate root")
    subprocess.run(["node", "apps/desktop/scripts/stage-candidate.mjs"], cwd=ROOT, check=True)
    desktop = read(assets / "desktop-verification.json")
    require(set(desktop) == set(TARGETS), "Desktop matrix incomplete")
    for target, evidence in desktop.items():
        require(hosts[target]["version"] == meta["version"] and hosts[target]["commit"] == meta["commit"], "Desktop host identity differs")
        require(all(evidence.get(k) is True and hosts[target].get(k) is True for k in ("bundled_cli_verified", "installer_hashes_verified", "metadata_paths_verified")), "Desktop validation failed")
    entries += fragment(assets / "desktop-inventory.json", meta, assets)
    images = []
    for arch in ("amd64", "arm64"):
        info = read(bundles["images-" + arch][0] / "images.json")
        same_identity(info, meta)
        require({i["component"] for i in info["images"]} == {"backend", "web"} and len(info["images"]) == 2, "image matrix differs")
        for item in info["images"]:
            require(item["arch"] == arch and item["os"] == "linux" and item["status"] == "verified"
                    and item["build_method"] == "local_from_source" and item["registry_required"] is False
                    and re.fullmatch(r"sha256:[a-f0-9]{64}", item["id"]), "invalid local image evidence")
            proof = item["evidence"] if item["component"] == "web" else item["evidence"]["cli"]
            require(all(proof.get(k) == meta[k] for k in ("version", "commit", "date")), "image binary identity differs")
            images.append(item)
        name = f"local-images-linux-{arch}.json"
        write_json(assets / name, info)
        entries.append(artifact(assets / name, meta, "images", os="linux", arch=arch))
    write_json(assets / "candidate-preflight.json", {k: bundles["prepare"][1][k] for k in meta})
    write_json(assets / "release-validation.json", {**meta, **ctx, "complete": True,
        "started_at": min(r["started_at"] for _, r in bundles.values()), "finished_at": now(),
        "required_jobs": list(JOBS), "job_results": {k: r for k, (_, r) in bundles.items()}, "needs": needs,
        "cli": cli_results, "backend": backend_results, "desktop": desktop, "desktop_on_build_hosts": hosts,
        "web": web, "images": images, "hashes": "passed", "feeds": "passed",
        "native_install_gui": "not_run", "windows_running_exe_lock": "not_run", "signing_notarization": "not_run",
        "internal_upload": "not_run", "production_deployment": "not_run", "feed_activation": "not_run"})
    for name, component in (("backend-build.json", "backend"), ("web-inventory.json", "web"), ("desktop-inventory.json", "desktop"),
                            ("candidate-preflight.json", "validation"), ("release-validation.json", "validation")):
        entries.append(artifact(assets / name, meta, component))
    cli_checksums = "".join(f'{e["sha256"]}  {e["name"]}\n' for e in sorted(entries, key=lambda e: e["name"]) if e["component"] == "cli")
    (assets / "cli-checksums.txt").write_text(cli_checksums)
    entries.append(artifact(assets / "cli-checksums.txt", meta, "cli", f'cli/{meta["tag"]}/checksums.txt'))
    entries.sort(key=lambda e: e["name"])
    require(len({e["name"] for e in entries}) == len(entries) == len({e["download_path"] for e in entries}), "duplicate manifest paths")
    manifest = {**meta, **ctx, "prepared_at": now(), "release_state": "draft",
                "release_url": f'https://github.com/{REPOSITORY}/releases/tag/{meta["tag"]}',
                "internal_upload_complete": False, "production_inventory_complete": False, "deployment_performed": False,
                "images": images, "artifacts": entries}
    write_json(assets / "manifest.json", manifest)
    (assets / "checksums.txt").write_text("".join(f"{sha(p)}  {p.name}\n" for p in files_in(assets)))
    for e in entries + [{"name": n, "download_path": f'releases/{meta["tag"]}/{n}'} for n in ("manifest.json", "checksums.txt")]:
        destination = output / "downloads" / e["download_path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(assets / e["name"], destination)
    verify_candidate(output, meta, ctx)


def verify_candidate(output, meta, ctx):
    assets = output / "assets"
    manifest = read(assets / "manifest.json")
    same_identity(manifest, meta)
    require(all(manifest.get(k) == v for k, v in ctx.items()), "candidate from another run/attempt")
    entries = fragment(assets / "manifest.json", meta, assets)
    require(all(manifest.get(k) is False for k in ("internal_upload_complete", "production_inventory_complete", "deployment_performed"))
            and manifest.get("release_state") == "draft"
            and manifest.get("release_url") == f'https://github.com/{REPOSITORY}/releases/tag/{meta["tag"]}', "invalid operational completion flags or release destination")
    expected = {e["name"] for e in entries} | {"manifest.json", "checksums.txt"}
    require(len(expected) == len(entries) + 2, "duplicate artifact name")
    require({p.relative_to(assets).as_posix() for p in files_in(assets)} == expected, "flat assets incomplete or unexpected")
    validation = read(assets / "release-validation.json")
    same_identity(validation, meta)
    require(validation.get("complete") is True and validation.get("feeds") == "passed" and validation.get("hashes") == "passed", "candidate validation failed")
    check_needs(validation["needs"])
    require(set(validation["job_results"]) == set(JOBS) and all(r["result"] == "success" for r in validation["job_results"].values()), "candidate job evidence incomplete")
    required = {n for _, _, n in cli_names(meta["version"])}
    required |= {f'labrastro-backend-{meta["version"]}-linux-{a}.tar.gz' for a in ("amd64", "arm64")}
    required |= {f'labrastro-web-{meta["version"]}-linux-amd64-node-standalone.tar.gz', f'labrastro-feed-metadata-{meta["version"]}.tar.gz'}
    required |= {f'labrastro-desktop-{meta["version"]}-{system}-{arch}.{ext}' for system, arch, ext in
                 (("linux", "x86_64", "AppImage"), ("linux", "arm64", "AppImage"), ("windows", "x64", "exe"), ("windows", "arm64", "exe"))}
    require(required <= expected, f"mandatory artifacts absent: {required - expected}")
    by_name = {e["name"]: e for e in entries}
    matrix = [(n, "cli", s, a) for s, a, n in cli_names(meta["version"])]
    matrix += [(f'labrastro-backend-{meta["version"]}-linux-{a}.tar.gz', "backend", "linux", a) for a in ("amd64", "arm64")]
    matrix += [(f'labrastro-web-{meta["version"]}-linux-amd64-node-standalone.tar.gz', "web", "linux", "amd64")]
    matrix += [(f'labrastro-desktop-{meta["version"]}-{s}-{a}.{ext}', "desktop", s, "amd64" if a in ("x64", "x86_64") else a)
               for s, a, ext in (("linux", "x86_64", "AppImage"), ("linux", "arm64", "AppImage"), ("windows", "x64", "exe"), ("windows", "arm64", "exe"))]
    for name, component, system, arch in matrix:
        require(all(by_name[name].get(k) == v for k, v in {"component": component, "os": system, "arch": arch}.items()), "manifest target identity differs")
    checksum_text = "".join(f"{sha(p)}  {p.name}\n" for p in files_in(assets) if p.name != "checksums.txt")
    require((assets / "checksums.txt").read_text() == checksum_text, "global checksums differ")
    cli_text = "".join(f"{sha(assets / n)}  {n}\n" for n in sorted(n for _, _, n in cli_names(meta["version"])))
    require((assets / "cli-checksums.txt").read_text() == cli_text, "CLI checksums differ")
    downloads = entries + [{"name": n, "download_path": f'releases/{meta["tag"]}/{n}'} for n in ("manifest.json", "checksums.txt")]
    require({p.relative_to(output / "downloads").as_posix() for p in files_in(output / "downloads")} == {e["download_path"] for e in downloads}, "download set incomplete or unexpected")
    for e in downloads:
        require(sha(output / "downloads" / e["download_path"]) == sha(assets / e["name"]), "download copy differs")
    files_in(output / "activation")
    require(read(output / "activation/latest.json") == {"version": meta["tag"]}, "inactive CLI pointer differs")
    subprocess.run(["node", "scripts/verify-candidate-feeds.mjs", str(output)], cwd=ROOT, check=True)
    return manifest


def gh(args):
    return run(["gh", *args])


def absent(tag):
    pages = json.loads(gh(["api", f"repos/{REPOSITORY}/releases?per_page=100", "--paginate", "--slurp"]))
    require(not any(r["tag_name"] == tag for page in pages for r in page), "Release already exists; no overwrite/resume. Inspect and explicitly remove only an incomplete draft before rerunning ALL jobs.")


def remote_tag(meta):
    value = json.loads(gh(["api", f'repos/{REPOSITORY}/git/ref/tags/{meta["tag"]}']))
    require(value.get("ref") == "refs/tags/" + meta["tag"] and value["object"]["sha"] == meta["tag_object"],
            "remote tag object changed after preflight")


def publish(output, meta, ctx):
    manifest = verify_candidate(output, meta, ctx)
    absent(meta["tag"])
    remote_tag(meta)
    notes = output.parent / "candidate-notes.md"
    notes.write_text(f'INCOMPLETE candidate upload. Do not consume.\n\nSource: {meta["commit"]}\nRun: {ctx["run_id"]}, attempt: {ctx["run_attempt"]}\n')
    gh(["release", "create", meta["tag"], "--repo", REPOSITORY, "--verify-tag", "--target", meta["commit"],
        "--draft", "--prerelease", "--latest=false", "--title", f'Labrastro {meta["version"]} (candidate)', "--notes-file", str(notes)])
    # No --clobber or automatic deletion. A failed upload leaves an explicitly
    # incomplete draft; an operator must inspect it before authorizing cleanup.
    gh(["release", "upload", meta["tag"], "--repo", REPOSITORY, *[str(p) for p in files_in(output / "assets")]])
    release = json.loads(gh(["release", "view", meta["tag"], "--repo", REPOSITORY, "--json", "isDraft,tagName,assets"]))
    require(release["isDraft"] and release["tagName"] == meta["tag"], "release is no longer the expected draft")
    expected = {p.name for p in files_in(output / "assets")}
    require({a["name"] for a in release["assets"]} == expected and len(release["assets"]) == len(expected), "remote assets incomplete/unexpected")
    with tempfile.TemporaryDirectory() as temp:
        gh(["release", "download", meta["tag"], "--repo", REPOSITORY, "--dir", temp])
        require({p.name for p in files_in(Path(temp))} == expected, "downloaded draft asset set differs")
        require(all(sha(Path(temp) / n) == sha(output / "assets" / n) for n in expected), "remote asset checksum differs")
    remote_tag(meta)
    notes.write_text(f'Complete build candidate; draft assets downloaded and SHA-256 verified.\n\n'
                     f'Source: `{meta["commit"]}`\nTag: `{meta["tag"]}`\n'
                     f'Run: https://github.com/{REPOSITORY}/actions/runs/{ctx["run_id"]}/attempts/{ctx["run_attempt"]}\n\n'
                     'See manifest.json, checksums.txt, cli-checksums.txt, release-validation.json and candidate-preflight.json.\n'
                     'Native installation/GUI, signing, Windows running-exe replacement, internal upload, production deployment and feed activation remain separate acceptance steps.\n'
                     'Local Image IDs describe disposable build runners; operations must rebuild and verify images on their own hosts.\n')
    gh(["release", "edit", meta["tag"], "--repo", REPOSITORY, "--draft=true", "--latest=false", "--notes-file", str(notes)])
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "seal", "assemble", "verify", "publish", "absent"))
    parser.add_argument("job", nargs="?", choices=JOBS)
    args = parser.parse_args()
    require(bool(args.job) == (args.command in ("start", "seal")), "only start/seal require a job name")
    meta, ctx = identity(), context()
    output = ROOT / meta["artifact_dir"]
    if args.command == "start":
        begin(args.job, meta, ctx)
    elif args.command == "seal":
        seal(args.job, meta, ctx)
    elif args.command == "assemble":
        assemble(ROOT / "dist/inputs", output, meta, ctx, json.loads(os.environ["CANDIDATE_NEEDS"]))
    elif args.command == "verify":
        verify_candidate(output, meta, ctx)
    elif args.command == "absent":
        absent(meta["tag"])
    else:
        publish(output, meta, ctx)


if __name__ == "__main__":
    main()
