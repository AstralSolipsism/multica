// Run from the repository root with a migrated disposable DATABASE_URL.
// Only temporary schema clones are populated; no persistent rows are changed.
import { readFileSync } from "node:fs";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to a migrated disposable database");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const source = readFileSync("server/pkg/db/generated/labrastro_message.sql.go", "utf8");
const queries = new Map([...source.matchAll(/const (\w+) = `([\s\S]*?)`/g)].map((m) => [m[1], m[2]]));
const ws = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000002";
const issue = "00000000-0000-4000-8000-000000000003";
const inst = "00000000-0000-4000-8000-000000000004";
const ap = "00000000-0000-4000-8000-000000000005";
const tables = ["workspace", "user", "member", "agent", "issue", "inbox_item", "activity_log", "comment", "autopilot", "autopilot_run", "agent_task_queue", "labrastro_message_route", "labrastro_message_delivery", "labrastro_message_approved_target"];
const plans = {};
async function explain(label, name, args = []) {
  if (!queries.has(name)) throw new Error(`Missing generated query ${name}`);
  const result = await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + queries.get(name), args);
  plans[label] = result.rows[0]["QUERY PLAN"][0];
}
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '60s'");
  for (const table of tables) {
    await client.query(`CREATE TEMP TABLE "${table}" (LIKE public."${table}" INCLUDING ALL) ON COMMIT DROP`);
  }
  await client.query(`INSERT INTO workspace(id,name,slug) VALUES ($1,'F17 fixture','f17-fixture')`, [ws]);
  await client.query(`INSERT INTO "user"(id,name,email) VALUES ($1,'Fixture','f17@example.invalid')`, [user]);
  await client.query(`INSERT INTO member(workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [ws,user]);
  await client.query(`INSERT INTO issue(id,workspace_id,title,creator_type,creator_id) VALUES ($1,$2,'Fixture','member',$3)`, [issue,ws,user]);
  await client.query(`INSERT INTO autopilot(id,workspace_id,title,assignee_id,created_by_type,created_by_id) VALUES ($1,$2,'Fixture',$3,'member',$3)`, [ap,ws,user]);
  for (const scope of ["inbox", "activity", "comment", "run"]) {
    await client.query(`INSERT INTO labrastro_message_route(id,workspace_id,installation_id,source_kind,autopilot_id,target_type,target_user_id,target_chat_id,target_key,created_by,updated_by,effective_from)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$9,now()-interval '2 years')`,
      [ws,inst,scope,scope === "run" ? ap : null,scope === "inbox" ? "member" : "group",scope === "inbox" ? user : null,scope === "inbox" ? null : "oc_fixture",scope === "inbox" ? `member:${user}` : "group:oc_fixture",user]);
  }
  // 100,000 historical rows plus 20 recent rows per persisted source.
  const age = "CASE WHEN n<=100000 THEN now()-interval '1 year' ELSE now()-interval '10 seconds' END";
  await client.query(`INSERT INTO inbox_item(workspace_id,recipient_type,recipient_id,type,title,issue_id,created_at)
    SELECT $1,'member',$2,'status_changed','Fixture',$3,${age} FROM generate_series(1,100020) n`, [ws,user,issue]);
  await client.query(`INSERT INTO activity_log(workspace_id,issue_id,action,created_at)
    SELECT $1,$2,'status_changed',${age} FROM generate_series(1,100020) n`, [ws,issue]);
  await client.query(`INSERT INTO comment(workspace_id,issue_id,author_type,author_id,content,created_at)
    SELECT $1,$2,'member',$3,'Fixture',${age} FROM generate_series(1,100020) n`, [ws,issue,user]);
  await client.query(`INSERT INTO autopilot_run(autopilot_id,source,status,completed_at)
    SELECT $1,'manual','completed',now()-interval '1 day' FROM generate_series(1,100000)`, [ap]);
  await client.query(`INSERT INTO labrastro_message_delivery(id,workspace_id,autopilot_id,run_id,installation_id,target_key,dedup_key,source_kind,source_scope,status,content_snapshot,target_snapshot)
    SELECT gen_random_uuid(),$1,$2,id,$3,'group:oc_fixture',id::text,'run_only','run','sent','{}','{}' FROM autopilot_run`, [ws,ap,inst]);
  for (const [scope, table] of [["inbox","inbox_item"],["activity","activity_log"],["comment","comment"]]) {
    await client.query(`INSERT INTO labrastro_message_delivery(id,workspace_id,route_id,installation_id,target_key,dedup_key,source_kind,source_scope,source_ref_id,status,content_snapshot,target_snapshot)
      SELECT gen_random_uuid(),$1,rt.id,$2,rt.target_key,s.id::text,$3,$3,s.id,'sent','{}','{}' FROM ${table} s JOIN labrastro_message_route rt ON rt.source_kind=$3 WHERE s.created_at < now()-interval '1 minute'`, [ws,inst,scope]);
  }
  for (const table of tables) await client.query(`ANALYZE "${table}"`);
  const { rows: [times] } = await client.query("SELECT now()-interval '1 minute' AS start, now() AS finish");
  const args = [times.start, times.finish, "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", 200];
  for (const scope of ["Inbox", "Activity", "Comment"]) {
    await explain(`${scope.toLowerCase()}-steady`, `listLabrastroMessage${scope}SourceCandidates`, args);
    await explain(`${scope.toLowerCase()}-idle`, `listLabrastroMessage${scope}SourceCandidates`, [times.finish,...args.slice(1)]);
    await explain(`${scope.toLowerCase()}-bootstrap`, `listLabrastroMessage${scope}SourceCandidates`, [new Date(0),...args.slice(1)]);
  }
  await explain("run-missing-set-idle", "listLabrastroMessageDeliveryCandidateRoutes", [null,200]);
  await explain("queue-idle", "claimDueLabrastroMessageDelivery");
  await explain("source-route-history", "listLabrastroMessageDeliveriesByRoute", [ws,(await client.query("SELECT id FROM labrastro_message_route WHERE source_kind='comment'")).rows[0].id,null,0,100]);
  console.log(JSON.stringify({ postgres: (await client.query("SHOW server_version")).rows[0].server_version, fixture: "100000 historical + 20 recent per source; 100000 settled runs; 400000 sent deliveries; default planner; temporary schema clones", plans }, null, 2));
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
