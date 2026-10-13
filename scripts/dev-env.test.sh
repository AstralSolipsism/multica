#!/usr/bin/env bash
# Registry-level behaviour of scripts/dev-env.sh, with no services started.
#
# Everything here runs against a throwaway MULTICA_DEV_HOME holding hand-written
# manifests, so the verbs are exercised end to end without a database, a
# backend, or a port.
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

export MULTICA_DEV_HOME="$tmp_dir/dev"
export MULTICA_DEV_WORKSPACES_PARENT="$tmp_dir/workspaces-parent"
export MULTICA_DEV_DESKTOP_APP_DATA="$tmp_dir/app-data"
export MULTICA_DEV_PROFILES_HOME="$tmp_dir/profiles"

fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/psql" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" DROP DATABASE "*) [ "${FAIL_DROP:-0}" != 1 ] ;;
  *) printf '1\n' ;;
esac
EOF
chmod +x "$fake_bin/psql"
export PATH="$fake_bin:$PATH"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

require_contains() {
  local file=$1 expected=$2
  if ! grep -Fq "$expected" "$file"; then
    echo "Expected output to contain: $expected" >&2
    echo "Observed:" >&2
    sed 's/^/  /' "$file" >&2
    exit 1
  fi
}

dev_env() {
  bash "$root_dir/scripts/dev-env.sh" "$@"
}

write_manifest() {
  local name=$1 dir=$2 offset=$3
  local profile="dev-dev-env-test-$offset"
  mkdir -p "$MULTICA_DEV_HOME/envs/$name/logs"
  cat > "$MULTICA_DEV_HOME/envs/$name/manifest.env" <<EOF
NAME=$name
DIR=$(printf '%q' "$dir")
CREATED_AT=2026-01-01T00:00:00Z
OWNER=agent
TTL_HOURS=0
ENV_FILE=.env.example
OFFSET=$offset
BACKEND_PORT=$((18080 + offset))
FRONTEND_PORT=$((13000 + offset))
DB_NAME=multica_dev_env_test_$offset
DATABASE_URL=postgres://multica:multica@localhost:5432/multica_dev_env_test_$offset?sslmode=disable
PROFILE=$profile
WORKSPACES_ROOT=$(printf '%q' "$MULTICA_DEV_WORKSPACES_PARENT/multica_workspaces_$profile")
DESKTOP_RENDERER_PORT=$((5174 + offset))
DESKTOP_APP_SUFFIX=$name
EOF
}

out="$tmp_dir/out"

assert_listener_ownership() {
  local case_name=$1 expected=$2 launcher=$3 listener=$4 listener_pgid=$5 recorded=${6:-}
  (
    # shellcheck disable=SC1090
    source "$root_dir/scripts/dev-env.sh"
    STATE_DIR="$tmp_dir/ownership-$case_name"
    mkdir -p "$STATE_DIR"
    [ -z "$recorded" ] || printf '%s\n' "$recorded" > "$(listener_pid_file web)"
    TEST_LAUNCHER=$launcher
    TEST_LISTENER=$listener
    TEST_LISTENER_PGID=$listener_pgid
    TEST_CASE=$case_name

    component_pid() { printf '%s' "$TEST_LAUNCHER"; }
    port_listener_pid() { printf '%s' "$TEST_LISTENER"; }
    process_group_id() { printf '%s' "$TEST_LISTENER_PGID"; }
    process_parent_id() {
      case "$TEST_CASE:$1" in
        nested:420) printf '310' ;;
        nested:310) printf '200' ;;
        nested:200) printf '%s' "$TEST_LAUNCHER" ;;
        *) printf '1' ;;
      esac
    }

    local actual=external
    if listener_belongs_to_component web 13000; then actual=owned; fi
    [ "$actual" = "$expected" ] \
      || fail "$case_name listener ownership = $actual, want $expected"
  )
}

assert_nested_listener_is_recorded() (
  # shellcheck disable=SC1090
  source "$root_dir/scripts/dev-env.sh"
  STATE_DIR="$tmp_dir/ownership-record"
  mkdir -p "$STATE_DIR"

  component_pid() { printf '100'; }
  port_listener_pid() { printf '420'; }
  process_group_id() { printf '310'; }
  process_parent_id() {
    case "$1" in
      420) printf '310' ;;
      310) printf '200' ;;
      200) printf '100' ;;
      *) printf '1' ;;
    esac
  }

  local claimed
  claimed="$(record_component_listener web 13000)" \
    || fail "nested listener was not claimed"
  [ "$claimed" = 420 ] || fail "claimed listener = $claimed, want 420"
  [ "$(cat "$(listener_pid_file web)")" = 420 ] \
    || fail "nested listener pid was not recorded"
)

assert_stop_handles_listener() {
  local case_name=$1 listener=$2 listener_pgid=$3 listener_parent=$4 recorded=${5:-}
  local expected_target=${6:-}
  (
    # shellcheck disable=SC1090
    source "$root_dir/scripts/dev-env.sh"
    STATE_DIR="$tmp_dir/stop-$case_name"
    mkdir -p "$STATE_DIR"
    BACKEND_PORT=18080
    FRONTEND_PORT=13000
    DESKTOP_RENDERER_PORT=5174
    local signals="$STATE_DIR/signals"
    [ -z "$recorded" ] || printf '%s\n' "$recorded" > "$(listener_pid_file web)"
    TEST_CASE=$case_name
    TEST_LISTENER=$listener
    TEST_LISTENER_PGID=$listener_pgid
    TEST_LISTENER_PARENT=$listener_parent

    component_pid() { [ "$TEST_CASE" = nested ] && printf '100'; }
    port_listener_pid() { printf '%s' "$TEST_LISTENER"; }
    process_group_id() { printf '%s' "$TEST_LISTENER_PGID"; }
    process_parent_id() {
      case "$1" in
        "$TEST_LISTENER") printf '%s' "$TEST_LISTENER_PARENT" ;;
        "$TEST_LISTENER_PARENT") printf '100' ;;
        *) printf '1' ;;
      esac
    }
    sleep() { :; }
    kill() {
      [ "$1" != -0 ] || return 1
      printf 'signal=%s target=%s\n' "$1" "${2:-}" >> "$signals"
    }

    stop_component web > "$out" 2>&1 || fail "$case_name stop failed"
    if [ -n "$expected_target" ]; then
      require_contains "$signals" "target=$expected_target"
    elif [ -s "$signals" ]; then
      fail "$case_name stop signalled an external listener: $(cat "$signals")"
    fi
  )
}

# ---------------------------------------------------------------------------
# An empty registry is a normal state, not an error.
# ---------------------------------------------------------------------------
dev_env list > "$out" 2>&1 || fail "list on an empty registry must succeed"
require_contains "$out" "No environments registered"

dev_env list --json > "$out" 2>&1 || fail "list --json on an empty registry must succeed"
if [ "$(cat "$out")" != "[]" ]; then
  fail "list --json on an empty registry = $(cat "$out"), want []"
fi

# ---------------------------------------------------------------------------
# Manifest serialization and user-provided names are safe. A manifest is
# sourced by Bash, so values must be shell-escaped and a name must never be
# able to walk outside envs/ before destroy eventually runs rm -rf.
# ---------------------------------------------------------------------------
quoted="$tmp_dir/quoted.env"
dangerous='a path with spaces;$(touch should-not-exist)'
bash -c 'source "$1"; write_manifest_value DIR "$2"' _ "$root_dir/scripts/dev-env.sh" "$dangerous" > "$quoted"
loaded="$(bash -c 'source "$1"; printf %s "$DIR"' _ "$quoted")"
[ "$loaded" = "$dangerous" ] || fail "manifest value did not round-trip safely"
[ ! -e "$root_dir/should-not-exist" ] || fail "loading a manifest executed its value"

status=0
dev_env up --name ../../escape > "$out" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "up accepted a path-traversing environment name"
require_contains "$out" "Invalid environment name"

status=0
dev_env up --ttl nope > "$out" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "up accepted a non-numeric TTL"
require_contains "$out" "TTL must be a positive integer"

# Rewriting an allocated database name must preserve the existing connection
# endpoint, credentials and query parameters.
rewritten="$(bash -c 'source "$1"; database_url_with_name "$2" "$3"' _ \
  "$root_dir/scripts/dev-env.sh" \
  'postgres://dev:p%40ss@127.0.0.1:55432/old_db?sslmode=require&application_name=dev' \
  'new_db')"
[ "$rewritten" = 'postgres://dev:p%40ss@127.0.0.1:55432/new_db?sslmode=require&application_name=dev' ] \
  || fail "database URL rewrite changed more than the database name: $rewritten"

# ---------------------------------------------------------------------------
# A registered environment is visible to both renderings, and the JSON one
# parses — agents read it, so a stray log line in it is a broken contract.
# ---------------------------------------------------------------------------
write_manifest "probe-901" "$tmp_dir/checkout" 901
mkdir -p "$tmp_dir/checkout"

dev_env list > "$out" 2>&1 || fail "list must succeed with one environment"
require_contains "$out" "probe-901"
require_contains "$out" "18981"

dev_env status probe-901 --json > "$out" 2>&1 || fail "status --json must succeed"
node -e '
  const fs = require("fs");
  const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (payload.name !== "probe-901") throw new Error("name = " + payload.name);
  if (payload.backend_port !== 18981) throw new Error("backend_port = " + payload.backend_port);
  for (const key of ["api", "web", "daemon", "desktop"]) {
    if (!payload.components[key]) throw new Error("missing component " + key);
    if (payload.components[key].state !== "stopped") {
      throw new Error(key + " state = " + payload.components[key].state);
    }
  }
' "$out" || fail "status --json is not machine-readable"

# ---------------------------------------------------------------------------
# Stopping an environment that is not running is a no-op that SUCCEEDS.
#
# This is the regression that made `make down` exit 1 after reporting success:
# on bash 3.2 a command substitution whose function ends in a failing command
# aborts the whole script under `set -e`, and "no process is listening on this
# port" is that function's normal answer.
# ---------------------------------------------------------------------------
status=0
dev_env down probe-901 --components api,web > "$out" 2>&1 || status=$?
if [ "$status" -ne 0 ]; then
  echo "Observed:" >&2
  sed 's/^/  /' "$out" >&2
  fail "down on a stopped environment exited $status, want 0"
fi
require_contains "$out" "stopped"

# Commands launched through env-exec must not inherit the daemon-task identity
# hints that make human/profile CLI commands reject --profile.
write_manifest "clean-env-903" "$root_dir" 903
MULTICA_TASK_CONFIG_ROOT=/task/config \
MULTICA_TASK_WORKSPACES_ROOT=/task/workspaces \
MULTICA_WORKSPACES_ROOT=/owner/workspaces \
  dev_env exec clean-env-903 -- sh -c '
    test -z "${MULTICA_TASK_CONFIG_ROOT:-}" &&
    test -z "${MULTICA_TASK_WORKSPACES_ROOT:-}" &&
    test "$MULTICA_WORKSPACES_ROOT" = "$1"
  ' _ "$MULTICA_DEV_WORKSPACES_PARENT/multica_workspaces_dev-dev-env-test-903" \
  > "$out" 2>&1 || fail "env-exec leaked daemon task identity or owner workspaces root"

# A health response without process identity is never proof that the process is
# this checkout's freshly launched API.
if bash -c 'source "$1"; api_started_after '\''{"status":"ok"}'\'' 1' _ "$root_dir/scripts/dev-env.sh"; then
  fail "legacy /health without started_at was accepted as current"
fi

# The health payload an api process reports must match the checkout's commit
# for the process to count as ours. start_api injects checkout_commit's value
# into the launch as a make argument (COMMIT=<sha> make api-dev, whose
# -X main.commit ends up in /health), so the comparison and the injection
# share one source: a short SHA injected behind our back never equals the
# reported one and start_api kills its own freshly launched api as a foreign
# process.
api_identity_repo="$tmp_dir/api-identity-repo"
mkdir -p "$api_identity_repo"
git -C "$api_identity_repo" init -q
git -C "$api_identity_repo" -c user.email=dev@localhost -c user.name=dev \
  -c commit.gpgsign=false commit -q --allow-empty -m "identity fixture"
api_identity_full_sha="$(git -C "$api_identity_repo" rev-parse HEAD)"

# The launch line must pin COMMIT itself: an inherited COMMIT env var or a
# make command-line override (the OL-197 workaround was exactly that) would
# otherwise re-desync the injected commit from the compared one.
launch_args="$tmp_dir/api-launch-args"
(
  # shellcheck disable=SC1090
  source "$root_dir/scripts/dev-env.sh"
  DIR="$api_identity_repo"
  health_belongs_to_api() { :; }
  expected="$(checkout_commit)"
  health="$(printf '{"pid":1,"commit":"%s","started_at":"2026-01-01T00:00:00Z"}' "$api_identity_full_sha")"
  api_identity_matches "$health" "$expected" \
    || fail "api identity rejected its own checkout: expected $expected, health reports $api_identity_full_sha"
  foreign="$(printf '{"pid":1,"commit":"not-the-checkout","started_at":"2026-01-01T00:00:00Z"}')"
  if api_identity_matches "$foreign" "$expected"; then
    fail "api identity accepted a commit that is not this checkout's"
  fi

  # Prove the launch pins the same value the comparison uses, as a make
  # argument: a COMMIT on the outer make command line travels into the inner
  # make through MAKEFLAGS and outranks environment forms, so only an argument
  # reliably wins. Heredoc into a fresh bash: start_api's own stop-and-die
  # paths must run under a real set -e.
  cat > "$api_identity_repo/launch-probe.sh" <<PROBE
  #!/usr/bin/env bash
  set -euo pipefail
  source "$root_dir/scripts/dev-env.sh"
  DIR="$api_identity_repo"
  REPO_ROOT="$root_dir"
  ENV_FILE=.env.example
  BACKEND_PORT=19999
  port_free() { :; }
  now_epoch() { printf '0'; }
  launch_detached() { printf '%s\n' "\$*" > "$launch_args"; exit 0; }
  start_api
PROBE
  chmod +x "$api_identity_repo/launch-probe.sh"
  if ! BACKEND_PORT=19999 bash "$api_identity_repo/launch-probe.sh" > "$out" 2>&1; then
    fail "launch probe failed: $(cat "$out")"
  fi
  # Re-run the captured make command dry, with a hostile COMMIT riding in
  # MAKEFLAGS exactly as `make up ... COMMIT=<short>` would propagate it.
  # Whatever make would actually inject must be the compared commit.
  launch_cmd="$tmp_dir/launch-cmd"
  sed 's/^api //' "$launch_args" > "$launch_cmd"
  if ! MAKEFLAGS=" -- COMMIT=deadbee" bash -c 'cd "$0" && eval "$(cat "$1") -n"' \
      "$root_dir" "$launch_cmd" > "$out" 2>&1; then
    fail "dry-run of the launch command failed: $(cat "$out")"
  fi
  injected="$(sed -n 's/.*main.commit=\([^"]*\).*/\1/p' "$out" | head -1)"
  [ "$injected" = "$expected" ] \
    || fail "launch would inject commit '$injected' under a MAKEFLAGS COMMIT override, want '$expected'"
)

# kill -0 alone counts a zombie launcher as running, which makes stop_component
# fail forever on a corpse nothing reaps. A defunct process must read as dead —
# including with trailing flags, as real zombies often report (Zs).
(
  # shellcheck disable=SC1090
  source "$root_dir/scripts/dev-env.sh"
  ps() { printf 'Zs'; }
  if process_alive $$; then
    fail "process_alive accepted a zombie (stat Zs)"
  fi
  ps() { printf 'Sl'; }
  process_alive $$ || fail "process_alive rejected a live process"
  ps() { printf 'S'; }
  process_alive $$ || fail "process_alive rejected a live process (bare stat)"
)

# A zombie launcher must also read as gone where components are looked up.
# kill is stubbed so kill -0 always succeeds (as it does on a real zombie);
# the marker file carries the TERM delivery into $(...) subshells, where a
# shell variable set inside kill would not be visible.
zombie_marker="$tmp_dir/zombie-term-marker"
zombie_setup() {
  # runs inside the sourcing subshell: installs the shared stubs
  rm -f "$zombie_marker"
  ps() {
    # stat= before TERM: live; after: defunct, with flags
    if [ -f "$zombie_marker" ]; then printf 'Zs'; else printf 'Sl'; fi
  }
  kill() {
    [ "$1" = "-TERM" ] || [ "$1" = -TERM ] && : > "$zombie_marker"
    return 0
  }
  sleep() { :; }
}

# 1. component_pid gates the "already running" fast paths in start_*: a
#    launcher that already zombified must read as gone.
(
  # shellcheck disable=SC1090
  source "$root_dir/scripts/dev-env.sh"
  STATE_DIR="$tmp_dir/zombie-component"
  mkdir -p "$STATE_DIR"
  printf '4242\n' > "$(pid_file api)"
  zombie_setup
  : > "$zombie_marker"
  if component_pid api >/dev/null; then
    fail "component_pid accepted a zombie launcher"
  fi
)

# 2. A launcher that zombifies between TERM and the liveness re-check must not
#    be reported as still running. No listener on the port.
assert_stop_zombie_launcher() (
  # shellcheck disable=SC1090
  source "$root_dir/scripts/dev-env.sh"
  STATE_DIR="$tmp_dir/stop-zombie-launcher"
  mkdir -p "$STATE_DIR"
  BACKEND_PORT=18080 FRONTEND_PORT=13000 DESKTOP_RENDERER_PORT=5174
  local pid=777 output
  printf '%s\n' "$pid" > "$(pid_file web)"
  zombie_setup
  port_listener_pid() { :; }
  output="$(stop_component web 2>&1)" || fail "stop_component failed on a launcher that zombified"
  case "$output" in
    *still\ running*) fail "stop_component reported a zombie launcher as still running: $output" ;;
  esac
  [ -f "$(pid_file web)" ] && fail "stop_component kept the pid file of a zombie launcher"
  return 0
)
assert_stop_zombie_launcher

# 3. Same for the listener re-check after the process-group kill: a listener
#    that zombifies must be released without a still-running warning.
assert_stop_zombie_listener() (
  # shellcheck disable=SC1090
  source "$root_dir/scripts/dev-env.sh"
  STATE_DIR="$tmp_dir/stop-zombie-listener"
  mkdir -p "$STATE_DIR"
  BACKEND_PORT=18080 FRONTEND_PORT=13000 DESKTOP_RENDERER_PORT=5174
  local listener=888 output
  # no launcher pid file: the recorded listener alone proves ownership
  printf '%s\n' "$listener" > "$(listener_pid_file web)"
  zombie_setup
  port_listener_pid() { printf '%s' "$listener"; }
  output="$(stop_component web 2>&1)" || fail "stop_component failed on a listener that zombified"
  case "$output" in
    *still\ running*) fail "stop_component reported a zombie listener as still running: $output" ;;
  esac
  [ -f "$(listener_pid_file web)" ] && fail "stop_component kept the listener pid file of a zombie"
  return 0
)
assert_stop_zombie_listener

# A SIGKILLed lock holder zombified by an unreaping PID 1 must not wedge
# acquire_lock: the stale lock is taken over instead of waiting out the 10s.
(
  # shellcheck disable=SC1090
  source "$root_dir/scripts/dev-env.sh"
  LOCK_DIR="$tmp_dir/zombie-lock.d"
  mkdir -p "$LOCK_DIR"
  printf '4242\n' > "$LOCK_DIR/pid"
  ps() { printf 'Zs'; }
  kill() { return 0; }
  sleep() { fail "acquire_lock waited on a zombie lock holder"; }
  acquire_lock || fail "acquire_lock refused a dead holder's lock"
  [ "$(cat "$LOCK_DIR/pid")" = "$$" ] || fail "acquire_lock did not take over the stale lock"
  rm -rf "$LOCK_DIR"
)

# The lsof fallback: lsof silently skips processes whose comm contains an
# unmatched `(` (next-server truncates to "next-server (v1"), so port_listener_pid
# must consult ss before reporting a port free.
(
  # shellcheck disable=SC1090
  source "$root_dir/scripts/dev-env.sh"
  lsof() { :; }
  ss() { printf 'LISTEN 0 511 *:13000 *:* users:(("next-server (v1",pid=4242,fd=21))\n'; }
  found="$(port_listener_pid 13000)"
  [ "$found" = 4242 ] || fail "ss fallback lost the listener: got '$found', want 4242"
)

# The "ours but not commit X; restarting it" path in start_api: the stop that
# precedes the relaunch must not abort the script silently when it fails.
# Runs in a fresh bash so set -e stays armed inside start_api; asserts the
# stop's warning AND the port-busy die both print.
restart_case="$tmp_dir/restart-failed-stop"
mkdir -p "$restart_case"
cat > "$restart_case/probe.sh" <<'PROBE'
#!/usr/bin/env bash
set -euo pipefail
source "$PROBE_ROOT/scripts/dev-env.sh"
BACKEND_PORT=19999
health_json() { printf '{"pid":1,"commit":"stale","started_at":"2026-01-01T00:00:00Z"}'; }
component_pid() { printf '123'; }
health_belongs_to_api() { return 0; }
api_identity_matches() { return 1; }
stop_component() { warn "api launcher pid 123 is still running"; return 1; }
port_free() { return 1; }
describe_port_owner() { printf 'pid 123 (server)'; }
start_api
PROBE
status=0
PROBE_ROOT="$root_dir" bash "$restart_case/probe.sh" > "$out" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "start_api exited 0 after a failed restart stop"
require_contains "$out" "still running"
require_contains "$out" "is busy"

# A failed stop during a launch abort must print why it died instead of letting
# set -e exit silently — the original `make up` failure mode (OL-347).
# Runs in a fresh bash: putting the call on the left of || would defuse set -e
# inside the function and hide the silent abort it exists to catch.
abort_case="$tmp_dir/abort-launch"
mkdir -p "$abort_case"
cat > "$abort_case/probe.sh" <<PROBE
#!/usr/bin/env bash
set -euo pipefail
source "$root_dir/scripts/dev-env.sh"
stop_component() { warn "\$1 launcher pid 123 is still running"; return 1; }
abort_launch api "the recorded reason"
PROBE
status=0
bash "$abort_case/probe.sh" > "$out" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "abort_launch exited 0 while its stop failed"
require_contains "$out" "still running"
require_contains "$out" "the recorded reason"

# Listener ownership follows the process tree, not only the launcher's process
# group. Turbo/pnpm can create a nested process group for Next while keeping the
# listener below the launcher in the PPID chain.
assert_listener_ownership same-pgid owned 100 200 100
assert_listener_ownership nested owned 100 420 310
assert_listener_ownership recorded owned 100 200 200 200
assert_listener_ownership external external 100 999 999
assert_nested_listener_is_recorded

# Stopping first records an owned nested listener before killing the launcher's
# process group. An unrelated port occupant never receives a signal.
assert_stop_handles_listener nested 420 310 200 "" 420
assert_stop_handles_listener external 999 999 1 888

# A stop failure in `down` must not abort the run silently: the remaining
# components still get stopped and the failure is summed up at the end. Runs in
# a fresh bash with only web's stop failing, so daemon and desktop must still
# be handled in the output.
write_manifest "down-fails-905" "$root_dir" 905
down_probe="$tmp_dir/down-probe"
mkdir -p "$down_probe"
cat > "$down_probe/probe.sh" <<'PROBE'
#!/usr/bin/env bash
set -euo pipefail
source "$PROBE_ROOT/scripts/dev-env.sh"
stop_component() {
  if [ "$1" = web ]; then warn "web launcher pid 123 is still running"; return 1; fi
  info "$1 was not running"
}
cmd_down down-fails-905 --components api,web,daemon,desktop
PROBE
status=0
PROBE_ROOT="$root_dir" bash "$down_probe/probe.sh" > "$out" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "down exited 0 while stopping web failed"
require_contains "$out" "could not be stopped"
require_contains "$out" "api was not running"
require_contains "$out" "daemon was not running"
require_contains "$out" "desktop was not running"

# ---------------------------------------------------------------------------
# Unknown names and components fail loudly instead of doing something else.
# ---------------------------------------------------------------------------
status=0
dev_env status no-such-env > "$out" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "status on an unknown environment must fail"
require_contains "$out" "Unknown environment"

status=0
dev_env up --components nope > "$out" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "up with an unknown component must fail"
require_contains "$out" "Unknown component"

# ---------------------------------------------------------------------------
# gc reports what it would collect and touches nothing in --dry-run. An
# environment whose checkout is gone has no owner left to stop it, which is how
# 152 databases accumulated with nothing on the machine able to list them.
# ---------------------------------------------------------------------------
write_manifest "orphan-902" "$tmp_dir/deleted-checkout" 902

dev_env gc --dry-run > "$out" 2>&1 || fail "gc --dry-run must succeed"
require_contains "$out" "orphan-902 would be collected"
if grep -Fq "probe-901 would be collected" "$out"; then
  fail "gc must not collect an environment whose directory still exists"
fi
[ -f "$MULTICA_DEV_HOME/envs/orphan-902/manifest.env" ] || fail "gc --dry-run deleted a manifest"

# A failed database drop keeps the manifest and slot so cleanup can be retried;
# destroy must never print success and forget the only deletion recipe.
write_manifest "drop-fails-904" "$root_dir" 904
status=0
FAIL_DROP=1 dev_env destroy drop-fails-904 --yes > "$out" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "destroy succeeded after DROP DATABASE failed"
[ -f "$MULTICA_DEV_HOME/envs/drop-fails-904/manifest.env" ] \
  || fail "destroy discarded the manifest after DROP DATABASE failed"
require_contains "$out" "manifest and slot were kept"
dev_env destroy drop-fails-904 --yes > "$out" 2>&1 || fail "retrying destroy after database recovery failed"

# ---------------------------------------------------------------------------
# destroy consumes the manifest: the slot is free afterwards, which is what
# makes the registry an allocator rather than a second place to leak.
# ---------------------------------------------------------------------------
dev_env destroy probe-901 --yes > "$out" 2>&1 || fail "destroy must succeed"
[ ! -d "$MULTICA_DEV_HOME/envs/probe-901" ] || fail "destroy left the environment directory behind"

dev_env list > "$out" 2>&1 || fail "list must succeed after destroy"
if grep -Fq "probe-901" "$out"; then
  fail "destroyed environment is still listed"
fi

# Declining the confirmation is a successful no-op, not a failure.
printf 'n\n' | dev_env destroy orphan-902 > "$out" 2>&1 || fail "declining destroy must exit 0"
require_contains "$out" "Cancelled."
[ -d "$MULTICA_DEV_HOME/envs/orphan-902" ] || fail "declined destroy removed the environment anyway"

echo "✓ dev-env.sh registry behaviour verified"
