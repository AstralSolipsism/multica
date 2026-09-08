#!/usr/bin/env python3
"""OL-37 two-live-run checks. Execute phases in the order in the CLI handoff.

Uses only the installed business CLI and the current run's environment. It does
not create runs, inject credentials, access storage, migrate, or delete files.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def private_write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["a-seed", "b-read", "a-advance", "b-conflict", "b-adopt", "a-verify"])
    parser.add_argument("--project", required=True, help="Project UUID from this run's brief")
    parser.add_argument("--case", required=True, help="Fresh logical path prefix shared by both runs, e.g. ol37/20260908-01")
    args = parser.parse_args()
    task_id = os.environ.get("MULTICA_TASK_ID")
    require(task_id, "Execute inside an active daemon-managed run with its task identity")
    case_hash = hashlib.sha256((args.project + ":" + args.case).encode()).hexdigest()[:16]
    root = Path("project-file-check-" + case_hash)
    root.mkdir(mode=0o700, exist_ok=True)
    identity = {"task_id": task_id, "project_id": args.project, "case": args.case}
    identity_path = root / "run.json"
    if identity_path.exists():
        require(json.loads(identity_path.read_text()) == identity, "Phase must run in the same original run and workdir")
    else:
        private_write(identity_path, json.dumps(identity))
    report_path = root / (args.phase + ".json")
    require(not report_path.exists(), "Phase already completed; inspect its report, do not resend as a new decision")
    logical_path = args.case + "/race.txt"
    cli_binary = os.environ.get("MULTICA_BIN", "multica")
    evidence = []

    def command(*parts, exit_code=0):
        process = subprocess.run([cli_binary, "project", "file", *map(str, parts), "--output", "json"],
                                 capture_output=True, text=True, timeout=180, check=False)
        require(process.returncode == exit_code,
                f"CLI exit {process.returncode}, expected {exit_code}: {process.stdout}\n{process.stderr}")
        result = json.loads(process.stdout)
        evidence.append({"command": list(map(str, parts)), "exit_code": process.returncode, "result": result})
        return result

    def op(name):
        return "ol37-" + case_hash + "-" + name

    def snapshot(name):
        return root / (name + ".request.json")

    def save(name, text, base, exit_code=0):
        draft = root / (name + ".draft.txt")
        private_write(draft, text)
        return command("save", args.project, logical_path, "--from-file", draft,
                       "--content-type", "text/plain", "--base-revision", base,
                       "--operation-id", op(name), "--request-file", snapshot(name), exit_code=exit_code)

    def read(name, **kwargs):
        destination = root / (name + ".txt")
        result = command("read", args.project, logical_path, "--to-file", destination, **kwargs)
        return result, destination.read_text()

    def same_replay(first, replay):
        require(replay.get("replayed") is True, "Replay flag missing")
        require({k: v for k, v in first.items() if k != "replayed"} ==
                {k: v for k, v in replay.items() if k != "replayed"}, "Complete replay fields differ")

    if args.phase == "a-seed":
        caps = command("capabilities", args.project)
        require(caps.get("enabled") is True and caps.get("read_only") is False, "Requires enabled writable test deployment")
        command("list", args.project, "--prefix", args.case + "/", "--limit", 2)
        result = save("a-seed", "A original\n", 0)
        require(result["status"] == "SAVED" and result["revision"] == 1, "Seed must create revision 1")
        meta, text = read("a-read")
        require(meta["revision"] == 1 and text == "A original\n", "Run A failed to read revision 1")
    elif args.phase == "b-read":
        meta, text = read("b-read")
        require(meta["revision"] == 1 and text == "A original\n", "Run B must read the same initial revision")
        private_write(root / "b-base.json", json.dumps(meta))
    elif args.phase == "a-advance":
        require((root / "a-seed.json").exists(), "Run A must seed first")
        result = save("a-advance", "A current\n", 1)
        require(result["revision"] == 2 and result["status"] == "SAVED", "Run A must advance to 2")
    elif args.phase == "b-conflict":
        base = json.loads((root / "b-base.json").read_text())["revision"]
        result = save("b-conflict", "B candidate\n", base, exit_code=6)
        require(result["status"] == "CONFLICT" and result["revision"] == 2 and result["conflict_current"] == 2,
                "Stale save must preserve a candidate at current revision 2")
        candidate = result["candidate_id"]
        private_write(root / "candidate.json", json.dumps(result))
        meta, text = read("after-conflict")
        require(meta["revision"] == 2 and text == "A current\n", "Conflict overwrote current file")
        destination = root / "candidate.txt"
        command("candidate", args.project, candidate, "--to-file", destination)
        require(destination.read_text() == "B candidate\n", "Candidate bytes lost")
        same_replay(result, command("retry", snapshot("b-conflict"), exit_code=6))
        same_replay(result, command("operation", args.project, op("b-conflict"), exit_code=6)["result"])
    elif args.phase == "b-adopt":
        conflict = json.loads((root / "candidate.json").read_text())
        meta, _ = read("before-adopt")
        require(meta["revision"] == 2, "Another writer advanced the case; inspect before deciding again")
        result = command("adopt", args.project, logical_path, conflict["candidate_id"],
                         "--expected-revision", meta["revision"], "--operation-id", op("b-adopt"),
                         "--request-file", snapshot("b-adopt"))
        require(result["status"] == "SAVED" and result["revision"] == 3 and
                "candidate_id" not in result and "conflict_current" not in result, "Invalid successful adoption")
        same_replay(result, command("retry", snapshot("b-adopt")))
        same_replay(result, command("operation", args.project, op("b-adopt"))["result"])
        same_replay(conflict, command("retry", snapshot("b-conflict"), exit_code=6))
    elif args.phase == "a-verify":
        meta, text = read("final")
        require(meta["revision"] == 3 and text == "B candidate\n", "Run A cannot see adopted content")
        result = command("operation", args.project, op("b-adopt"), exit_code=4)
        require(result.get("code") == "NOT_FOUND", "Run A must not read Run B's private operation ledger")

    report = {"phase": args.phase, "passed": True, **identity, "evidence": evidence}
    private_write(report_path, json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps({"phase": args.phase, "passed": True, "report": str(report_path)}))


if __name__ == "__main__":
    main()
