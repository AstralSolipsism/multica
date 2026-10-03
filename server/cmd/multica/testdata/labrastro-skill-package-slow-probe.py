#!/usr/bin/env python3
"""Compare built 60s/240s CLIs against a local 100s apply response.

Usage: python3 labrastro-skill-package-slow-probe.py BEFORE_BINARY AFTER_BINARY
This opt-in probe takes about 100 seconds and only uses synthetic workspace data.
"""

import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def probe(binary, expect_report):
    fixtures = Path(__file__).parent
    preview = json.loads((fixtures / "labrastro-skill-package-preview.json").read_text())
    report = json.loads((fixtures / "labrastro-skill-package-apply.json").read_text())
    report["failed"] = True
    report["results"][-1].update(
        status="failed", code="source_timeout", retryable=True
    )
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body))
            if self.path == "/api/skill-packages/preview":
                response = preview
            elif self.path == "/api/skill-packages/apply":
                time.sleep(100)
                response = report
            else:
                self.send_error(404)
                return
            data = json.dumps(response).encode()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                # The old CLI cancels its request before the report arrives.
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = False
    serving = threading.Thread(target=server.serve_forever)
    serving.start()
    try:
        with tempfile.TemporaryDirectory(prefix="ol105-slow-probe-", dir="/tmp") as temp_root:
            env = {key: value for key, value in os.environ.items() if not key.startswith("MULTICA_")}
            env.update(
                MULTICA_SERVER_URL=f"http://127.0.0.1:{server.server_port}",
                MULTICA_WORKSPACE_ID=report["package"]["workspace_id"],
                MULTICA_TOKEN="mat_offline_test",
                MULTICA_TASK_ID="10000000-0000-4000-8000-000000000001",
                MULTICA_TASK_CONFIG_ROOT=temp_root,
                MULTICA_HTTP_TIMEOUT="20s",
            )
            started = time.monotonic()
            completed = subprocess.run(
                [str(binary), "skill", "package", "import", preview["source"]["url"], "--all", "--output", "json"],
                cwd=temp_root, env=env, capture_output=True, text=True, timeout=260,
            )
            elapsed = time.monotonic() - started
    finally:
        server.shutdown()
        server.server_close()
        serving.join()

    assert [path for path, _ in requests] == [
        "/api/skill-packages/preview", "/api/skill-packages/apply"
    ], requests
    assert requests[1][1]["preview_id"] == preview["preview_id"], requests
    assert requests[1][1]["all"] is True, requests
    if expect_report:
        assert completed.returncode == 1, (completed.returncode, completed.stderr)
        assert json.loads(completed.stdout) == report, completed.stdout
        assert "Preview again" in completed.stderr, completed.stderr
        assert 100 <= elapsed < 240, elapsed
    else:
        assert completed.returncode == 2, (completed.returncode, completed.stderr)
        assert completed.stdout == "", completed.stdout
        assert 59 <= elapsed < 100, elapsed
    return {
        "binary": binary.name,
        "elapsed_seconds": round(elapsed, 2),
        "exit_code": completed.returncode,
        "stdout_bytes": len(completed.stdout.encode()),
        "complete_report": expect_report,
        "result_count": len(report["results"]) if expect_report else 0,
        "preview_requests": 1,
        "apply_requests": 1,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    args = parser.parse_args()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        before = executor.submit(probe, args.before.resolve(), False)
        after = executor.submit(probe, args.after.resolve(), True)
        print(json.dumps({"before": before.result(), "after": after.result()}, indent=2))
