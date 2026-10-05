# Message compensation scans

The three persisted source scanners share the existing generation-guarded
cursor table, but each advances independently. Run/task repair still uses
complete, bounded ID cycles because those old records can change state later.

For inbox, activity and comment sources:

1. A new cursor starts at the epoch, so eligible historical sources receive
   their initial decision once. The first cycle can span several ticks.
2. At cycle start, capture database time, the table's maximum ID, and a stable
   transaction horizon. Every page uses the fixed interval
   `[cursor_ts - 1 minute, cycle_started_at]` and the existing inclusive ID
   pagination. UUIDv4 and UUIDv7 are both supported. All targets of a source
   drain before advancing beyond its ID.
3. Persist each page only after its decisions succeed. Promote `cursor_ts` to
   `cycle_stable_at` only after exhausting the cycle. Failures, process restarts,
   budget exhaustion and losing a generation CAS never skip pending work.
4. The next cycle overlaps the stable horizon. The delivery dedup key remains
   the exactly-once decision boundary, including suppressions and cancellations.

## Late commits and transaction duration

`created_at` uses PostgreSQL `now()`, which is **transaction start time**.
There is no enforced transaction duration limit across the application's
writers. A fixed one- or five-minute late-commit assumption would therefore
silently lose sufficiently old transactions. PostgreSQL 15 also has no
`transaction_timeout`; statement and idle timeouts would not bound a whole
transaction even if configured.

Instead the captured stable horizon is the earlier of database statement time
and the oldest open transaction's `xact_start` in this database. The effective
lookback is the observed open-transaction age **plus one minute of overlap**.
The extra minute is conservative boundary tolerance, not a claim that a
transaction cannot last longer. Even a transaction spanning many complete
scanner cycles keeps the horizon behind its start until it commits. Database
time avoids clock skew between application replicas. Source queries run after
the horizon query on the primary, outside a long-lived snapshot transaction.

Only sessions with a non-NULL `usesysid` constrain the horizon. Userless
maintenance processes such as autovacuum cannot insert application sources;
their activity fields may be hidden from ordinary roles, but they must not
force a historical rescan. Client connections, walsenders and background
workers with a user remain included even if their activity is hidden.

Ordinary application connections can observe sessions of the same database
role. If another role's session is not observable, activity tracking is
disabled for a backend, or two-phase commit is enabled, the query conservatively
pins the horizon to the epoch. Two-phase commit can move a transaction out of
`pg_stat_activity`, so polling `pg_prepared_xacts` would not provide an atomic
bound. Such deployments retain full-history scans; use a common observable
writer role, or grant the application role `pg_read_all_stats` / `pg_monitor`
when multiple roles connect to the database, and keep the default
`max_prepared_transactions=0` for bounded steady-state scans. A very long open
transaction also increases the scan window rather than risking missed delivery.
When a newly captured horizon lags database time by at least ten minutes, the
service logs its scanner, stable time and lag. Each service instance logs at
most once per scanner per ten minutes; the warning never advances the horizon.

This covers application inserts with database-generated timestamps, not manual
backdated imports or restoring arbitrarily old deleted sources. For an explicit
historical replay, stop the scanners and delete only the relevant source cursor
row; deduplication preserves decisions that already exist.

The database clock must also progress normally: a backward clock step larger
than the overlap can place a new source behind a previously saved watermark.
Use gradual clock synchronization; after a larger backward step, stop scanners
and reset the affected source cursors before resuming.

PostgreSQL references: [timestamp semantics](https://www.postgresql.org/docs/15/functions-datetime.html),
[activity visibility and transaction starts](https://www.postgresql.org/docs/15/monitoring-stats.html).

## Indexes and event scheduling

- `9010_labrastro_message_delivery_run_index`: run/installation/target lookup.
- `9011_labrastro_message_delivery_sending_index`: only sending leases.
- `9012_labrastro_message_inbox_scan_index`,
  `9013_labrastro_message_activity_scan_index`, and
  `9014_labrastro_message_comment_scan_index`: source time ranges over the
  scanner's definitional source types. Without these, a time predicate alone
  could still read all historical rows.
- `9015_labrastro_message_source_watermark`: captured stable horizon and a
  one-time source cursor restart. Run repair cursors are preserved. Up/down
  resets increment the generation so an in-flight old page loses its CAS.

Every index build has one concurrent statement, a concurrent drop, and the
fork runner's invalid-index cleanup registration. Roll back with workers
stopped and deploy the matching application version, since the new code reads
the new cursor column.

An event can start the first decision pass immediately. Subsequent event passes
wait at least one second after the previous event or periodic pass completes.
Events coalesce into one trailing pass; more events cannot postpone it. The
30-second periodic repair remains independent. `autopilot:run_done` retains
the same decision and send path as other source wakeups.

The run candidate query returns complete run, autopilot and route records plus
the task-side reverse-link repair evidence. It feeds the shared source-facts,
decision-input and decision-write functions directly, without reloading those
records for each candidate. `EnqueueRunDeliveries` restricts this same query
and decision loop to one run; it does not maintain a second route-selection path. Live binding/content lookups and send-time gates
retain their existing authorization and transient-error behavior.
