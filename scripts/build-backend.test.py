#!/usr/bin/env python3
"""Exercise the real builder/reader with tiny Go programs and local-only Git refs."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("backend", ROOT / "scripts/build-backend.py")
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


def call(args, cwd, **kwargs):
    return subprocess.check_output(args, cwd=cwd, text=True, **kwargs).strip()


def main():
    with tempfile.TemporaryDirectory(prefix="labrastro-backend-test-") as directory:
        root = Path(directory)
        for name in ["scripts/build-backend.py", "scripts/check-release.mjs", "apps/desktop/scripts/package.mjs"]:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, path)
        for name, content in {"apps/web/package.json": '{"version":"1.2.3"}',
                              ".gitignore": "dist/\nignored.go\n", "LICENSE": "fixture license\n", "NOTICE": "fixture notice\n",
                              "server/go.mod": "module example.invalid/backendfixture\n\ngo 1.26.6\n",
                              "server/migrations/001_first.up.sql": "SELECT 1;\n",
                              "server/migrations/001_second.up.sql": "SELECT 2;\n",
                              "server/migrations/001_first.down.sql": "SELECT 3;\n"}.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        for command in backend.COMMANDS:
            path = root / "server/cmd" / command / "main.go"
            path.parent.mkdir(parents=True, exist_ok=True)
            if command == "multica":
                output = 'fmt.Printf(`{"version":%q,"commit":%q,"date":%q,"go":%q,"os":%q,"arch":%q}`, version, commit, date, runtime.Version(), runtime.GOOS, runtime.GOARCH)'
            else:
                output = f'fmt.Printf("{command} %s (commit: %s)\\n", version, commit)'
            imports = 'import "fmt"\n' + ('import "runtime"\n' if command == "multica" else '')
            path.write_text('package main\n' + imports + 'var version="dev"\nvar commit="unknown"\nvar date="unknown"\nfunc main(){' + output + '}\n')
        git = lambda *args: call(["git", *args], root, stderr=subprocess.DEVNULL)
        git("init", "-b", "main")
        git("config", "user.name", "Backend fixture")
        git("config", "user.email", "backend@example.invalid")
        git("config", "commit.gpgsign", "false")
        git("config", "tag.gpgsign", "false")
        git("remote", "add", "origin", "https://github.com/AstralSolipsism/multica")
        git("add", ".")
        git("commit", "-m", "local fixture, never published")
        sha = git("rev-parse", "HEAD")
        git("update-ref", "refs/remotes/origin/main", sha)
        git("tag", "v1.2.3-labrastro.1")
        env = {k: v for k, v in os.environ.items() if not k.startswith("LABRASTRO_RELEASE_")}
        env.update(LABRASTRO_RELEASE_REPOSITORY="AstralSolipsism/multica", LABRASTRO_RELEASE_TAG="v1.2.3-labrastro.1",
                   LABRASTRO_RELEASE_SHA=sha, GITHUB_REPOSITORY="AstralSolipsism/multica", GOENV="off", GOWORK="off")
        # This ignored, invalid source must not contaminate the detached build.
        (root / "server/cmd/server/ignored.go").write_text("this is not Go")
        subprocess.run(["python3", "scripts/build-backend.py"], cwd=root, env=env, check=True)
        subprocess.run(["python3", "scripts/build-backend.py", "--verify"], cwd=root, env=env, check=True)
        identity = json.loads(call(["node", "scripts/check-release.mjs", "--require-tag"], root, env=env))
        original = {}
        for arch in backend.ARCHES:
            archive = root / identity["artifact_dir"] / f"assets/labrastro-backend-1.2.3-labrastro.1-linux-{arch}.tar.gz"
            with tarfile.open(archive) as tar:
                original[arch] = {m.name: tar.extractfile(m).read() for m in tar}

        def rejected(label, change, expected, rehash=False, arch="amd64"):
            files = dict(original[arch])
            change(files)
            if rehash:
                files["checksums.txt"] = "".join(f"{backend.digest(files[n])}  {n}\n" for n in sorted(files) if n != "checksums.txt").encode()
            bad = root / "dist/bad.tar.gz"
            with tarfile.open(bad, "w:gz") as tar:
                for name, data in files.items():
                    member = tarfile.TarInfo(name)
                    member.size, member.mode = len(data), 0o755
                    tar.addfile(member, io.BytesIO(data))
            try:
                backend.verify_archive(bad, root, identity, arch)
            except ValueError as error:
                backend.require(expected in str(error), f"{label}: unexpected rejection {error}")
            else:
                raise AssertionError(f"{label} was accepted")
            print(f"rejected: {label}")

        for name in [*backend.COMMANDS, "NOTICE", "migrations/001_second.up.sql"]:
            rejected(f"missing {name}", lambda f, n=name: f.pop(n), "missing")
        rejected("unsafe path", lambda f: f.update({"../outside": b"bad"}), "unsafe")
        rejected("tampered bytes", lambda f: f.update({"migrate": b"bad"}), "checksums")
        rejected("rehashed different migration", lambda f: f.update({"migrations/001_first.up.sql": b"SELECT 9;"}), "content differs", True)
        rejected("wrong executable", lambda f: f.update({"server": f["migrate"]}), "wrong executable", True)
        rejected("wrong metadata", lambda f: f.update({"build-info.json": json.dumps({**identity, "version": "dev"}).encode()}), "identity differs", True)
        # Same source SHA and valid checksums must not conceal wrong linked
        # values, including on the architecture that the host cannot execute.
        (root / "server/cmd/server/ignored.go").unlink()
        for arch in backend.ARCHES:
            cases = [(command, "version", "dev") for command in backend.COMMANDS]
            cases += [(command, "commit", "0" * 40) for command in backend.COMMANDS if command.startswith("backfill_")]
            cases += [("multica", "date", "unknown")]
            for command, key, value in cases:
                linked = {**identity, key: value}
                binary = root / "dist" / command
                flags = f'-s -w -X main.version={linked["version"]} -X main.commit={linked["commit"]} -X main.date={linked["date"]}'
                subprocess.run(["go", "build", "-trimpath", "-buildvcs=true", "-ldflags", flags,
                                "-o", str(binary), "./cmd/" + command], cwd=root / "server",
                               env=dict(env, CGO_ENABLED="0", GOOS="linux", GOARCH=arch), check=True)
                rejected(f"{arch} {command} wrong linked {key}", lambda f: f.update({command: binary.read_bytes()}),
                         "runtime identity differs", rehash=True, arch=arch)
        cross_arch = next(a for a in backend.ARCHES if a != call(["go", "env", "GOHOSTARCH"], root))
        with patch.object(backend.shutil, "which", return_value=None):
            rejected("missing cross-target runner", lambda f: None, "version verification requires qemu-", arch=cross_arch)
        # Candidate guards must run even when an output archive already exists.
        (root / "NOTICE").write_text("dirty")
        result = subprocess.run(["python3", "scripts/build-backend.py", "--verify"], cwd=root, env=env, capture_output=True, text=True)
        backend.require(result.returncode != 0 and "dirty" in result.stderr, "dirty verification did not fail closed")
        print("backend build/verification regression checks passed")


if __name__ == "__main__":
    main()
