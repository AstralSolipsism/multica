#!/usr/bin/env python3
"""Build/independently verify backend archives; adapted from OL-31 r2 build-binaries.py.

Candidate identity comes exclusively from check-release.mjs. No service, registry,
release or download pointer is changed. OL-83 collects the component inventory.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

COMMANDS = ("server", "multica", "migrate", "backfill_task_usage_hourly", "backfill_codex_usage_cache")
ARCHES = ("amd64", "arm64")


def run(args, cwd, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True).strip()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def source_files(root):
    names = run(["git", "ls-tree", "-r", "--name-only", "HEAD", "server/migrations"], root).splitlines()
    require(any(name.endswith(".up.sql") for name in names), "no tracked up migrations")
    paths = {name.removeprefix("server/"): root / name for name in names}
    paths.update({name: root / name for name in ("LICENSE", "NOTICE")})
    for name, path in paths.items():
        require(path.is_file() and not path.is_symlink() and path.stat().st_size > 0,
                f"missing, empty or linked required source file: {name}")
    return paths


def build_settings(binary, root, identity, arch):
    info = json.loads(run(["go", "version", "-m", "-json", str(binary)], root))
    settings = {item["Key"]: item["Value"] for item in info["Settings"]}
    for key, value in {"GOOS": "linux", "GOARCH": arch, "CGO_ENABLED": "0",
                       "vcs.revision": identity["commit"], "vcs.modified": "false"}.items():
        require(settings.get(key) == value, f"{binary.name}: wrong {key}: {settings.get(key)}")
    require(info["Path"].endswith("/cmd/" + binary.name), f"wrong executable: {binary.name}")
    return info["GoVersion"]


def version_runner(root, arch):
    host = run(["go", "env", "GOHOSTOS", "GOHOSTARCH"], root).splitlines()
    require(host[0] == "linux", "backend version verification requires a Linux host")
    if host[1] == arch:
        return []
    emulator = "qemu-" + {"amd64": "x86_64", "arm64": "aarch64"}[arch]
    path = shutil.which(emulator) or shutil.which(emulator + "-static")
    require(path, f"linux/{arch} version verification requires {emulator} or {emulator}-static on PATH")
    return [path]


def verify_archive(archive, root, identity, arch):
    """Read bytes afresh; never trust a build's success, inventory or tar paths."""
    sources = source_files(root)
    expected = set(COMMANDS) | set(sources) | {"build-info.json", "checksums.txt", "expected-migrations.txt"}
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        require(all(m.isfile() and m.name in expected for m in members), "unexpected/unsafe archive entry")
        require(len(members) == len(expected) and {m.name for m in members} == expected,
                "missing or duplicate required archive entries")
        files = {m.name: tar.extractfile(m).read() for m in members}
        require(all(files.values()), "empty required archive file")
        for m in members:
            if m.name in COMMANDS:
                require(m.mode & 0o111, f"not executable: {m.name}")
    checksums = "".join(f"{digest(files[name])}  {name}\n" for name in sorted(expected - {"checksums.txt"}))
    require(files["checksums.txt"].decode() == checksums, "archive checksums differ")
    for name, source in sources.items():
        require(files[name] == source.read_bytes(), f"source content differs: {name}")
    migrations = sorted(name.removeprefix("migrations/") for name in sources if name.endswith(".up.sql"))
    require(files["expected-migrations.txt"].decode() == "\n".join(migrations) + "\n", "migration list differs")
    metadata = json.loads(files["build-info.json"])
    for key in ("repository", "tag", "version", "commit", "date"):
        require(metadata.get(key) == identity[key], f"archive identity differs: {key}")
    require(metadata.get("os") == "linux" and metadata.get("arch") == arch, "archive target differs")
    with tempfile.TemporaryDirectory(prefix="verify-backend-") as temporary:
        for command in COMMANDS:
            binary = Path(temporary) / command
            binary.write_bytes(files[command])
            binary.chmod(0o755)
            toolchain = build_settings(binary, root, identity, arch)
            require(toolchain == metadata.get("go"), f"toolchain differs: {command}")
        runner = version_runner(root, arch)
        cli = json.loads(run([*runner, str(Path(temporary) / "multica"), "version", "--output", "json"], root))
        require(all(cli.get(key) == identity[key] for key in ("version", "commit", "date")), "CLI runtime identity differs")
        require(cli.get("go") == metadata["go"] and cli.get("os") == "linux" and cli.get("arch") == arch,
                "CLI runtime toolchain/target differs")
        for command in COMMANDS:
            if command == "multica":
                continue
            output = run([*runner, str(Path(temporary) / command), "--version"], root)
            require(output == f'{command} {identity["version"]} (commit: {identity["commit"]})',
                    f"{command} runtime identity differs")
    return {"arch": arch, "archive_sha256": digest(archive.read_bytes()),
            "files": len(files), "up_migrations": len(migrations),
            "binary_metadata": "passed", "binary_versions": "passed",
            "version_execution": run([*runner, "--version"], root).splitlines()[0] if runner else "native",
            "native_version": "not_run_cross_target" if runner else "passed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="verify existing archives without building")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    identity = json.loads(run(["node", "scripts/check-release.mjs", "--require-tag"], root))
    assets = root / identity["artifact_dir"] / "assets"
    names = {arch: f'labrastro-backend-{identity["version"]}-linux-{arch}.tar.gz' for arch in ARCHES}
    if args.verify:
        for arch, name in names.items():
            print(json.dumps(verify_archive(assets / name, root, identity, arch)))
        return

    require(not any((assets / n).exists() for n in [*names.values(), "backend-build.json"]),
            "backend outputs already exist; verify them or use a fresh isolated checkout")
    for arch in ARCHES:
        version_runner(root, arch)
    source_files(root)
    assets.mkdir(parents=True, exist_ok=True)
    started = now()
    # A detached worktree excludes ignored Go files, go.work, bin/ and local
    # environment files while retaining genuine VCS build metadata.
    with tempfile.TemporaryDirectory(prefix="backend-", dir=assets.parent) as temporary:
        scratch = Path(temporary)
        source = scratch / "source"
        subprocess.run(["git", "worktree", "add", "--detach", str(source), identity["commit"]], cwd=root, check=True)
        try:
            sources = source_files(source)
            env = dict(os.environ, CGO_ENABLED="0", GOENV="off", GOFLAGS="", GOWORK="off")
            results, artifacts = [], []
            for arch, name in names.items():
                print(f"Building backend linux/{arch}", flush=True)
                target = scratch / arch
                target.mkdir()
                env.update(GOOS="linux", GOARCH=arch)
                for command in COMMANDS:
                    subprocess.run(["go", "build", "-trimpath", "-buildvcs=true", "-ldflags",
                                    f'-s -w -X main.version={identity["version"]} -X main.commit={identity["commit"]} -X main.date={identity["date"]}',
                                    "-o", str(target / command), "./cmd/" + command], cwd=source / "server", env=env, check=True)
                for name_in_archive, path in sources.items():
                    destination = target / name_in_archive
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, destination)
                migrations = sorted(n.removeprefix("migrations/") for n in sources if n.endswith(".up.sql"))
                (target / "expected-migrations.txt").write_text("\n".join(migrations) + "\n")
                toolchain = build_settings(target / "server", root, identity, arch)
                write_json(target / "build-info.json", {**identity, "os": "linux", "arch": arch,
                           "go": toolchain, "built_at": now(), "commands": list(COMMANDS)})
                paths = sorted(p for p in target.rglob("*") if p.is_file())
                (target / "checksums.txt").write_text("".join(f"{digest(p.read_bytes())}  {p.relative_to(target).as_posix()}\n" for p in paths))
                archive = scratch / name
                with tarfile.open(archive, "w:gz") as tar:
                    for path in sorted(p for p in target.rglob("*") if p.is_file()):
                        tar.add(path, arcname=path.relative_to(target).as_posix())
                results.append(verify_archive(archive, source, identity, arch))
                artifacts.append({"name": name, "path": f"assets/{name}",
                                  "download_path": f'releases/{identity["tag"]}/{name}',
                                  "bytes": archive.stat().st_size, "sha256": digest(archive.read_bytes()),
                                  "component": "backend", "os": "linux", "arch": arch})
            # No partial archive set is delivered when a required target fails.
            write_json(scratch / "backend-build.json", {**identity, "started_at": started, "finished_at": now(),
                       "required_targets": [f"linux/{a}" for a in ARCHES], "results": results, "artifacts": artifacts})
            for name in [*names.values(), "backend-build.json"]:
                shutil.move(scratch / name, assets / name)
        finally:
            subprocess.run(["git", "worktree", "remove", "--force", str(source)], cwd=root, check=True)
    print(f"Verified backend archives: {assets}")


if __name__ == "__main__":
    main()
