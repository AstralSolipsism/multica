#!/usr/bin/env python3
"""Compare OL-128 plans in a disposable schema of a migrated LOCAL test DB.

DATABASE_URL=... python3 scripts/benchmark-message-scans.py --before-ref 7173798b8
Requires psql and git. Prints Markdown suitable for a PR description.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--before-ref", required=True)
args = parser.parse_args()
url = os.environ["DATABASE_URL"]
if urlparse(url).hostname not in ("localhost", "127.0.0.1", "::1"):
    raise SystemExit("DATABASE_URL must point to a local test database")
schema = "ol128_explain_" + str(os.getpid()) + "_" + str(time.time_ns())
query_path = "server/pkg/db/queries/labrastro_message.sql"
before = subprocess.check_output(
    ["git", "show", args.before_ref + ":" + query_path], cwd=ROOT, text=True
)
after = (ROOT / query_path).read_text()
tables = [
    "workspace", "user", "agent", "member", "issue", "autopilot",
    "autopilot_run", "agent_task_queue", "labrastro_message_route",
    "labrastro_message_approved_target", "labrastro_message_delivery",
    "inbox_item", "activity_log", "comment",
]
stems = [
    "9010_labrastro_message_delivery_run_index",
    "9011_labrastro_message_delivery_sending_index",
    "9012_labrastro_message_inbox_scan_index",
    "9013_labrastro_message_activity_scan_index",
    "9014_labrastro_message_comment_scan_index",
]


def sql(statement, scoped=True):
    prefix = f'SET search_path TO "{schema}",public; SET statement_timeout=\'60s\'; ' if scoped else ""
    result = subprocess.run(
        ["psql", url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
        input=prefix + statement, text=True, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def query(source, name):
    match = re.search(r"-- name: " + name + r" :\w+\n(.*?)(?=\n-- name:|\Z)", source, re.S)
    if not match:
        raise ValueError(name)
    statement = match[1].split(";")[0]
    values = {
        "limit": "200", "after_id": "'00000000-0000-0000-0000-000000000000'",
        "upper_id": "'ffffffff-ffff-ffff-ffff-ffffffffffff'",
        "scan_from": "now()-interval '1 minute'", "scan_through": "now()",
        "error_code": "'lease_expired'", "last_error": "'synthetic expired lease'",
    }
    statement = re.sub(r"sqlc\.(?:n?arg)\('([^']+)'\)", lambda m: "(" + values[m[1]] + ")", statement)
    return re.sub(r"sqlc\.embed\((\w+)\)", r"\1.*", statement)


def explain(source, name):
    statement = query(source, name)
    # Warm pages once, then measure with default planner settings. Roll back
    # UPDATE so both measurements see the same expired claims.
    measurement = f"BEGIN; EXPLAIN (ANALYZE, BUFFERS, SETTINGS) {statement}; ROLLBACK;"
    sql(measurement)
    return sql(measurement)


try:
    sql(f'CREATE SCHEMA "{schema}"', scoped=False)
    for table in tables:
        sql(f'CREATE TABLE "{table}" (LIKE public."{table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)')
        definitions = sql(
            "SELECT indexdef FROM pg_indexes WHERE schemaname='public' "
            f"AND tablename='{table}' AND indexname NOT IN ("
            "'idx_labrastro_message_delivery_run','idx_labrastro_message_delivery_sending',"
            "'idx_labrastro_message_inbox_scan','idx_labrastro_message_activity_scan',"
            "'idx_labrastro_message_comment_scan')"
        )
        for definition in definitions.splitlines():
            sql(definition.replace(" ON public.", f' ON "{schema}".'))
    sql("""
        INSERT INTO workspace(id,name,slug,description,issue_prefix)
        VALUES ('00000000-0000-0000-0000-000000000001','benchmark','ol128-benchmark','','BENCH');
        INSERT INTO "user"(id,name,email)
        VALUES ('00000000-0000-0000-0000-000000000002','benchmark','bench@example.invalid');
        INSERT INTO member(workspace_id,user_id,role)
        VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','owner');
        INSERT INTO issue(id,workspace_id,title,creator_type,creator_id,number)
        VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',
            'benchmark','member','00000000-0000-0000-0000-000000000002',1);
        INSERT INTO autopilot(id,workspace_id,title,assignee_id,status,execution_mode,created_by_type,created_by_id)
        VALUES ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',
            'benchmark','00000000-0000-0000-0000-000000000005','active','run_only','member','00000000-0000-0000-0000-000000000002');
        INSERT INTO labrastro_message_route(id,workspace_id,autopilot_id,installation_id,target_type,target_user_id,
            target_chat_id,target_key,source_kind,created_by,updated_by,effective_from)
        SELECT md5(scope)::uuid,'00000000-0000-0000-0000-000000000001',
            CASE WHEN scope='run' THEN '00000000-0000-0000-0000-000000000004'::uuid END,
            '00000000-0000-0000-0000-000000000006',
            CASE WHEN scope='inbox' THEN 'member' ELSE 'group' END,
            CASE WHEN scope='inbox' THEN '00000000-0000-0000-0000-000000000002'::uuid END,
            CASE WHEN scope<>'inbox' THEN 'oc_bench' END,
            CASE WHEN scope='inbox' THEN 'member:00000000-0000-0000-0000-000000000002' ELSE 'group:oc_bench' END,
            scope,'00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002',now()-interval '3 days'
        FROM unnest(ARRAY['run','inbox','activity','comment']) scope;
        INSERT INTO labrastro_message_approved_target(workspace_id,installation_id,target_key,target_type,source_kind,approved_by)
        SELECT workspace_id,installation_id,target_key,target_type,source_kind,created_by
        FROM labrastro_message_route WHERE source_kind IN ('activity','comment');
        INSERT INTO autopilot_run(id,autopilot_id,source,status,completed_at,result)
        SELECT md5('run:'||n)::uuid,'00000000-0000-0000-0000-000000000004','schedule','completed',
            now()-interval '1 day','{"output":"synthetic report"}'::jsonb FROM generate_series(1,50000) n;
        INSERT INTO labrastro_message_delivery(id,workspace_id,autopilot_id,run_id,dedup_key,source_kind,status,content_snapshot,
            target_snapshot,installation_id,target_key)
        SELECT gen_random_uuid(),rt.workspace_id,r.autopilot_id,r.id,'run:'||r.id,'run_only','sent','{}','{}',rt.installation_id,rt.target_key
        FROM autopilot_run r CROSS JOIN labrastro_message_route rt WHERE rt.source_kind='run';
        INSERT INTO inbox_item(id,workspace_id,issue_id,recipient_type,recipient_id,type,title,created_at)
        SELECT md5('inbox:'||n)::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003',
            'member','00000000-0000-0000-0000-000000000002',
            CASE WHEN n%2=0 THEN 'status_changed' ELSE 'assigned' END,'synthetic inbox',now()-interval '1 day'
        FROM generate_series(1,200000) n;
        INSERT INTO activity_log(id,workspace_id,issue_id,action,details,created_at)
        SELECT md5('activity:'||n)::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003',
            CASE WHEN n%2=0 THEN 'status_changed' ELSE 'created' END,'{}',now()-interval '1 day'
        FROM generate_series(1,200000) n;
        INSERT INTO comment(id,workspace_id,issue_id,author_type,author_id,content,type,created_at)
        SELECT md5('comment:'||n)::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003',
            'member','00000000-0000-0000-0000-000000000002','synthetic comment',
            CASE WHEN n%2=0 THEN 'comment' ELSE 'status_change' END,now()-interval '1 day'
        FROM generate_series(1,200000) n;
        INSERT INTO labrastro_message_delivery(id,workspace_id,source_ref_id,dedup_key,source_kind,source_scope,
            status,content_snapshot,target_snapshot,installation_id,target_key)
        SELECT gen_random_uuid(),rt.workspace_id,md5(rt.source_kind||':'||n)::uuid,rt.source_kind||':'||n,
            rt.source_kind,
            rt.source_kind,'sent','{}','{}',rt.installation_id,rt.target_key
        FROM labrastro_message_route rt CROSS JOIN generate_series(2,200000,2) n WHERE rt.source_kind<>'run';
        UPDATE inbox_item SET recipient_id='00000000-0000-0000-0000-000000000099' WHERE type='assigned';
        INSERT INTO labrastro_message_delivery(id,workspace_id,autopilot_id,source_scope,dedup_key,source_kind,status,content_snapshot,
            target_snapshot,installation_id,target_key,lease_token,lease_expires_at)
        SELECT gen_random_uuid(),workspace_id,autopilot_id,source_kind,'sending:'||source_kind||':'||n,'test_send','sending','{}','{}',
            installation_id,target_key,gen_random_uuid(),CASE WHEN n%2=0 THEN NULL ELSE now()-interval '1 hour' END
        FROM labrastro_message_route CROSS JOIN generate_series(1,5) n;
    """)
    for table in tables:
        sql(f'VACUUM ANALYZE "{schema}"."{table}"', scoped=False)
    names = [
        "ListLabrastroMessageDeliveryCandidateRoutes",
        "ListLabrastroMessageInboxSourceCandidates",
        "ListLabrastroMessageActivitySourceCandidates",
        "ListLabrastroMessageCommentSourceCandidates",
        "RequeueExpiredLabrastroMessageDeliveryClaims",
    ]
    plans = {"Before": {name: explain(before, name) for name in names}}
    for stem in stems:
        sql((ROOT / "server/migrations" / (stem + ".up.sql")).read_text())
    for table in tables:
        sql(f'VACUUM ANALYZE "{schema}"."{table}"', scoped=False)
    plans["After"] = {name: explain(after, name) for name in names}
    print("PostgreSQL:", sql("SHOW server_version"))
    print("Fixture: 50,000 runs; 200,000 rows in each source table; 350,020 deliveries.")
    print("100,000 rows per source already decided; remaining rows do not match a route/type.")
    print("All source timestamps are one day old. Steady window: last minute. Warm-page samples; default planner.\n")
    print("| Query | Before (ms) | After (ms) |\n|---|---:|---:|")
    for name in names:
        times = [re.search(r"Execution Time: ([\d.]+) ms", plans[phase][name])[1] for phase in plans]
        print(f"| {name} | {times[0]} | {times[1]} |")
    fence = chr(96) * 3
    for phase, entries in plans.items():
        for name, plan in entries.items():
            print(f"\n<details><summary>{phase}: {name}</summary>\n\n{fence}text\n{plan}\n{fence}\n\n</details>")
finally:
    sql(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE', scoped=False)
