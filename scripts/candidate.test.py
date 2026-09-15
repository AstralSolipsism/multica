#!/usr/bin/env python3
"""Offline pipeline contract integration, never production candidate evidence.

Build tiny Go programs for six platforms, use the real backend archive builder,
Web assembler, Desktop asar/blockmap/stager and aggregate them. Images/installers
are explicitly synthetic; no Docker, network, project tags or Release writes.
"""
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from unittest.mock import patch
import zipfile
import candidate as c

SOURCE = c.ROOT
CTX = {"run_id": "123", "run_attempt": "1"}
NEEDS = {key: {"result": "success"} for key in c.NEEDS}


def reject(fn, message):
    try:
        fn()
    except (ValueError, FileNotFoundError, subprocess.CalledProcessError, tarfile.FilterError) as error:
        assert message in str(error), (message, str(error))
    else:
        raise AssertionError("expected failure: " + message)


def fixture(root):
    for name in (".goreleaser.yml", "scripts/candidate.py", "scripts/build-backend.py", "scripts/check-release.mjs", "scripts/build-candidate-web.mjs",
                 "scripts/verify-candidate-feeds.mjs", "scripts/candidate-fixture.mjs", "apps/desktop/scripts/package.mjs", "apps/desktop/scripts/stage-candidate.mjs"):
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / name, target)
    for name, value in {".gitignore": "dist/\nnode_modules\n.next/\n__pycache__/\n", "apps/web/package.json": '{"version":"1.2.3"}',
                        "apps/desktop/package.json": '{"name":"fixture"}', "server/go.mod": "module example.invalid/candidatefixture\n\ngo 1.26.6\n",
                        "LICENSE": "fixture license", "NOTICE": "fixture notice", "README.md": "fixture readme", "README.zh.md": "translated fixture readme",
                        "server/migrations/001_init.up.sql": "SELECT 1;"}.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    for name in c.backend.COMMANDS:
        target = root / "server/cmd" / name / "main.go"
        target.parent.mkdir(parents=True)
        body = '''package main
import ("encoding/json"; "os"; "runtime")
var version,commit,date string
func main() { json.NewEncoder(os.Stdout).Encode(map[string]string{"version":version,"commit":commit,"date":date,"go":runtime.Version(),"os":runtime.GOOS,"arch":runtime.GOARCH}) }
''' if name == "multica" else f'''package main
import "fmt"
var version,commit,date string
func main() {{ fmt.Printf("{name} %s (commit: %s)\\n",version,commit) }}
'''
        target.write_text(body)
    git = lambda *args: c.run(["git", *args])
    git("init", "-b", "main")
    git("config", "user.email", "candidate@example.invalid")
    git("config", "user.name", "Candidate fixture")
    git("config", "commit.gpgsign", "false")
    git("config", "tag.gpgsign", "false")
    git("remote", "add", "origin", "https://github.com/" + c.REPOSITORY)
    git("add", ".")
    git("commit", "-m", "isolated candidate fixture")
    commit = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/main", commit)
    git("tag", "v1.2.3-labrastro.1")
    (root / "apps/desktop/node_modules").symlink_to(SOURCE / "apps/desktop/node_modules", target_is_directory=True)
    return {"LABRASTRO_RELEASE_REPOSITORY": c.REPOSITORY, "LABRASTRO_RELEASE_TAG": "v1.2.3-labrastro.1", "LABRASTRO_RELEASE_SHA": commit,
            "LABRASTRO_RELEASE_MODE": "candidate", "GITHUB_REPOSITORY": c.REPOSITORY, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}


def build_inputs(root, meta):
    for job in c.JOBS:
        c.begin(job, meta, CTX)
    archives = root / "dist/goreleaser"
    binaries = root / "dist/binaries"
    binaries.mkdir(parents=True)
    subprocess.run(["goreleaser", "release", "--clean", "--skip=publish"], cwd=root,
                   env={**os.environ, "GORELEASER_CURRENT_TAG": meta["tag"]}, check=True)
    for system, arch in {(s, a) for s, a, _ in c.cli_names(meta["version"])}:
        binary = binaries / (system + "-" + arch)
        name = next(n for s, a, n in c.cli_names(meta["version"]) if (s, a) == (system, arch))
        if system == "windows":
            with zipfile.ZipFile(archives / name) as z:
                binary.write_bytes(z.read("multica.exe"))
        else:
            with tarfile.open(archives / name) as t:
                binary.write_bytes(t.extractfile("multica").read())
        binary.chmod(0o755)
    subprocess.run(["python3", "scripts/build-backend.py"], cwd=root, check=True)
    subprocess.run(["node", "scripts/candidate-fixture.mjs"], cwd=root, check=True)
    assets = root / meta["artifact_dir"] / "assets"
    for job in c.JOBS:
        if job.startswith("desktop-"):
            shutil.copyfile(root / "dist" / ("host-" + job.removeprefix("desktop-") + ".json"), assets / "desktop-verification.json")
        if job.startswith("images-"):
            arch = job.removeprefix("images-")
            directory = root / meta["artifact_dir"] / "local-images" / ("linux-" + arch)
            directory.mkdir(parents=True)
            images = [{"component": component, "arch": arch, "os": "linux", "id": "sha256:" + "a" * 64,
                       "status": "verified", "build_method": "local_from_source", "registry_required": False,
                       "evidence": meta if component == "web" else {"cli": meta}} for component in ("backend", "web")]
            c.write_json(directory / "images.json", {**meta, "images": images, "fixture_only": True})
        c.seal(job, meta, CTX)
    inputs = root / "dist/inputs"
    inputs.mkdir()
    for job in c.JOBS:
        shutil.move(root / "dist/transfer" / job, inputs / ("candidate-123-1-" + job))
    shutil.rmtree(root / meta["artifact_dir"])
    shutil.rmtree(root / "apps/desktop/dist")
    return inputs


def main():
    # Inspect the actual YAML graph, not a second hand-written workflow.
    workflow = json.loads(subprocess.check_output(["node", "-e", "console.log(JSON.stringify(require('./apps/desktop/node_modules/js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8'))))"], cwd=SOURCE, text=True))
    jobs = workflow["jobs"]
    assert set(jobs["assemble"]["needs"]) == set(c.NEEDS)
    assert "always()" in jobs["assemble"]["if"] and jobs["draft"]["needs"] == "assemble"
    assert jobs["draft"]["permissions"] == {"contents": "write"}
    assert not any("permissions" in v for k, v in jobs.items() if k != "draft")
    assert {r["platform"] for r in jobs["desktop"]["strategy"]["matrix"]["include"]} == {"win", "linux"}
    gate = jobs["assemble"]["steps"][0]["run"]
    for job in c.NEEDS:
        for state in ("skipped", "failure", "cancelled", None):
            needs = copy.deepcopy(NEEDS)
            needs[job]["result"] = state
            reject(lambda: c.check_needs(needs), "required jobs")
            value = subprocess.run(["bash", "-e", "-c", gate], env={**os.environ, "CANDIDATE_NEEDS": json.dumps(needs)}, capture_output=True)
            assert value.returncode != 0, (job, state)
    with tempfile.TemporaryDirectory(prefix="candidate-contract-") as temp, patch.object(c, "ROOT", Path(temp)):
        root = Path(temp)
        env = fixture(root)
        with patch.dict(os.environ, env):
            meta = c.identity()
            inputs = build_inputs(root, meta)
            c.load_inputs(inputs, meta, CTX)
            receipt_path = inputs / "candidate-123-1-cli/receipt.json"
            original = c.read(receipt_path)
            for field, value in (("run_id", "999"), ("run_attempt", "2"), ("version", "1.2.3-labrastro.2"), ("repository", "other/repo"), ("result", "skipped")):
                c.write_json(receipt_path, {**original, field: value})
                reject(lambda: c.load_inputs(inputs, meta, CTX), "identity differs" if field in ("version", "repository") else "receipt")
            c.write_json(receipt_path, original)
            residue = receipt_path.parent / "unexpected/receipt.json"
            residue.parent.mkdir()
            residue.write_text("{}")
            reject(lambda: c.load_inputs(inputs, meta, CTX), "payload")
            shutil.rmtree(residue.parent)
            package = next((inputs / "candidate-123-1-cli").glob("*.zip"))
            saved = package.read_bytes()
            package.write_bytes(saved + b"corrupt")
            reject(lambda: c.load_inputs(inputs, meta, CTX), "payload")
            package.unlink()
            reject(lambda: c.load_inputs(inputs, meta, CTX), "payload")
            package.write_bytes(saved)
            with patch.dict(os.environ, {"GITHUB_REPOSITORY": "other/repo"}):
                reject(c.context, "target GitHub repository")
            output = root / meta["artifact_dir"]
            with patch.object(c, "verify_candidate", side_effect=ValueError("late validation failure")):
                reject(lambda: c.assemble(inputs, output, meta, CTX, NEEDS), "late validation failure")
            assert not (output / "assets/manifest.json").exists()
            assert not (output / "assets/release-validation.json").exists()
            assert not (output / "downloads/releases" / meta["tag"] / "release-validation.json").exists()
            shutil.rmtree(output)
            shutil.rmtree(root / "apps/desktop/dist")
            c.assemble(inputs, output, meta, CTX, NEEDS)
            manifest = c.verify_candidate(output, meta, CTX)
            assert manifest["internal_upload_complete"] is False and len(manifest["images"]) == 4
            reject(lambda: c.assemble(inputs, output, meta, CTX, NEEDS), "already exists")
            reject(lambda: c.verify_cli(output / "assets", {**meta, "commit": "b" * 40}), "wrong vcs.revision")
            missing = output / "downloads/desktop" / meta["tag"] / f'labrastro-desktop-{meta["version"]}-windows-arm64.exe'
            saved = missing.read_bytes()
            missing.unlink()
            reject(lambda: c.verify_candidate(output, meta, CTX), "download set")
            missing.write_bytes(saved)
            feed = output / "activation/desktop/latest.yml"
            saved_feed = feed.read_bytes()
            feed.write_text("version: incorrect\n")
            reject(lambda: c.verify_candidate(output, meta, CTX), "verify-candidate-feeds")
            feed.write_bytes(saved_feed)
            # Existing draft and API failure must prevent every write. No gh
            # process is called by this test; the full writer is exercised.
            with patch.object(c, "gh", return_value=json.dumps([[{"tag_name": meta["tag"]}]])) as gh:
                reject(lambda: c.publish(output, meta, CTX), "Release already exists")
                assert gh.call_count == 1 and gh.call_args.args[0][0] == "api"
            with patch.object(c, "gh", side_effect=subprocess.CalledProcessError(1, "offline")) as gh:
                reject(lambda: c.publish(output, meta, CTX), "offline")
                assert gh.call_count == 1
            for corrupt in (False, True):
                calls = []

                def fake_gh(args):
                    calls.append(args)
                    if args[0] == "api":
                        assert args[1].startswith("repos/" + c.REPOSITORY + "/")
                        return json.dumps([] if "/releases?" in args[1] else {"ref": "refs/tags/" + meta["tag"], "object": {"sha": meta["tag_object"]}})
                    assert args[args.index("--repo") + 1] == c.REPOSITORY
                    if args[1] == "create":
                        assert "--verify-tag" in args and "--draft" in args and "--latest=false" in args
                    if args[1] == "view":
                        return json.dumps({"isDraft": True, "tagName": meta["tag"], "assets": [{"name": p.name} for p in c.files_in(output / "assets")]})
                    if args[1] == "download":
                        destination = Path(args[args.index("--dir") + 1])
                        for p in c.files_in(output / "assets"):
                            shutil.copyfile(p, destination / p.name)
                        if corrupt:
                            (destination / "NOTICE-extra").write_text("unexpected remote residue")
                    return ""

                with patch.object(c, "gh", side_effect=fake_gh):
                    if corrupt:
                        reject(lambda: c.publish(output, meta, CTX), "asset set differs")
                        assert not any(call[:2] == ["release", "edit"] for call in calls)
                        assert "INCOMPLETE" in (output.parent / "candidate-notes.md").read_text()
                    else:
                        c.publish(output, meta, CTX)
                        assert calls[-1][:2] == ["release", "edit"] and "--draft=true" in calls[-1]
                assert not any("--clobber" in call or "delete" in call for call in calls)
            with patch.object(c, "gh", return_value=json.dumps({"ref": "refs/tags/" + meta["tag"], "object": {"sha": "f" * 40}})):
                reject(lambda: c.remote_tag(meta), "remote tag object changed")
            # Tar traversal and linked payloads fail before being consumed.
            archive = root / "dist/unsafe.tar"
            with tarfile.open(archive, "w") as tar:
                entry = tarfile.TarInfo("../escape")
                entry.size = 1
                tar.addfile(entry, io.BytesIO(b"x"))
            reject(lambda: c.extract(archive, root / "dist/extract"), "unsafe path")
            (inputs / "candidate-123-1-cli/linked").symlink_to(receipt_path)
            reject(lambda: c.load_inputs(inputs, meta, CTX), "linked handoff")
    print("PASS: complete offline contract assembly; 32 job-failure gates; missing/corrupt/version/repository/attempt/feed/existing-release/API/traversal failures. Synthetic fixtures only.")


if __name__ == "__main__":
    main()
