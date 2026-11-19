#!/usr/bin/env python3
"""Codex effort auto-tuner (OL-259 / OL-1463).

Reads codexradar.com's four-task intelligence-trends dataset for the models
used by managed Codex agents and moves each agent to the cheapest reasoning
effort level whose score is within TIE_RANGE points of the best. See README.md
for usage and rules.
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

# ---- tunables (spec OL-1463 §3) ----
TIE_RANGE = 5            # efforts scoring >= S - TIE_RANGE count as tied
DEGRADE_THRESHOLD = 10   # alert when S <= peak - DEGRADE_THRESHOLD (7-day peak)
HISTORY_WINDOW_DAYS = 7
FRESHNESS_HOURS = 72     # a model's latest batch older than this is not used
TRENDS_URL = "https://codexradar.com/data/intelligence-trends.json"
TRENDS_SCHEMA = "intelligence-trends/1"
SCORE_MAX = 150
USER_AGENT = "labrastro-effort-tuner/1"
REQUEST_TIMEOUT_S = 130   # cold-cache requests hang ~2min then return 524
FETCH_BUDGET_S = int(os.environ.get("EFFORT_TUNER_BUDGET_S", "600"))
# ^ whole fetch round stays within this deadline; env-overridable for ops
MULTICA = os.environ.get("MULTICA_CLI_PATH", "multica")
EXCLUDE_BLOCK = "effort-tuner-exclude"
COMMENT_FILE = "effort-tuner-comment.md"

# codex-cli 0.160.1 `codex debug models`; cheapest first
EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"]
MODEL_EFFORTS = {
    "gpt-6-astra": EFFORT_ORDER,
    "gpt-6.1-sol": EFFORT_ORDER,
    "gpt-6.1-terra": EFFORT_ORDER,
    "gpt-6.2-sol": EFFORT_ORDER,
    "gpt-6.2-astra": EFFORT_ORDER,
    "gpt-6-sol": EFFORT_ORDER,
    "gpt-5.6-sol": EFFORT_ORDER,
    "gpt-5.6-terra": EFFORT_ORDER,
    "gpt-6-luna": EFFORT_ORDER[:-1],
    "gpt-5.6-luna": EFFORT_ORDER[:-1],
}

# External values (website payloads, echoed exclude-list lines) pass this
# whitelist before entering any message: the server parses mentions on raw
# comment text (server/internal/util/mention.go), so backticks are no
# protection and arbitrary strings must never be echoed verbatim.
SAFE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,80}$")


def safe(v):
    """Whitelist gate for external values on their way into a message."""
    s = str(v)
    return s if SAFE_RE.fullmatch(s) else "<非法值，已省略>"


def safe_all(values):
    """Render a collection of external values, each through safe()."""
    return "(%s)" % ", ".join(safe(v) for v in values)


class TunerError(Exception):
    """Anything that makes this round unsafe for a model; reported, not fatal."""


def run_multica(args):
    """Run a multica subcommand, parse stdout only (never stderr)."""
    proc = subprocess.run([MULTICA] + args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise TunerError("multica %s failed: %s" % (args[0], proc.stderr.strip()[:300]))
    return json.loads(proc.stdout)


def http_get_json(url, timeout=REQUEST_TIMEOUT_S):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_ts(value):
    """Parse an ISO-8601 timestamp into an aware UTC datetime, else None."""
    if not isinstance(value, str):
        return None
    try:
        ts = datetime.fromisoformat(value)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def parse_exclude_list(description):
    """Parse the ```effort-tuner-exclude fenced block -> set of agent IDs.

    Comments after # and blank lines are ignored; an empty block is fine.
    Raises TunerError when the block is missing or a line is not a valid UUID.
    """
    match = re.search(r"```" + EXCLUDE_BLOCK + r"\s*\n(.*?)```", description, re.S)
    if not match:
        raise TunerError("tracking-issue description has no ```%s``` block" % EXCLUDE_BLOCK)
    ids = set()
    for line_no, raw in enumerate(match.group(1).splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        try:
            ids.add(str(uuid.UUID(line)))
        except ValueError:
            raise TunerError("exclude list line %d is not a UUID: %s"
                             % (line_no, safe(line))) from None
    return ids


def list_managed_agents(exclude=(), multica=None):
    """Active agents on codex runtimes, keyed by ID, plus per-agent skip notes.

    Excluded agents are dropped before any model check (spec OL-259 §1.2
    precedes §1.3), so excluding an agent also silences its model problems.
    Agents with an empty model or a model outside MODEL_EFFORTS are reported
    and left alone: the daemon drops the effort setting for an empty model.
    """
    if multica is None:
        multica = globals()["run_multica"]
    runtimes = multica(["runtime", "list", "--output", "json"])
    codex = {r["id"] for r in runtimes if r.get("provider") == "codex"}
    agents = multica(["agent", "list", "--output", "json"])
    managed, skipped = {}, []
    for a in agents:
        if a.get("runtime_id") not in codex or a.get("archived_at"):
            continue
        if a["id"] in exclude:
            continue
        if not a.get("model"):
            skipped.append((a["id"], a.get("name", ""), "model is empty"))
        elif a["model"] not in MODEL_EFFORTS:
            skipped.append((a["id"], a.get("name", ""),
                            "model %s not in effort table" % a["model"]))
        else:
            managed[a["id"]] = a
    return managed, skipped


def score_max_ok(value):
    """Value is a numeric 150; bool is not a number and NaN/Inf never match."""
    return not isinstance(value, bool) and isinstance(value, (int, float)) \
        and math.isfinite(value) and value == SCORE_MAX


def fetch_trends(deadline, http_get=None):
    """Fetch intelligence-trends.json with one retry and validate its envelope.

    Each attempt's timeout is capped by the time left before the deadline, so
    the whole fetch stays inside FETCH_BUDGET_S. Raises TunerError on a failed
    fetch or an incompatible payload: the round then changes nothing.
    """
    if http_get is None:
        http_get = globals()["http_get_json"]
    payload = None
    for attempt_no in (1, 2):
        left = deadline - time.monotonic()
        if left <= 0:
            break
        try:
            payload = http_get(TRENDS_URL, timeout=min(REQUEST_TIMEOUT_S, left))
            break
        except Exception as exc:  # timeouts, 524s, DNS — all retryable
            print("trends fetch failed (attempt %d): %s" % (attempt_no, exc),
                  file=sys.stderr)
    if payload is None:
        raise TunerError("intelligence-trends 抓取失败")
    if not isinstance(payload, dict):
        raise TunerError("intelligence-trends 返回格式不对：expected dict, got %s"
                         % type(payload).__name__)
    schema = payload.get("schema")
    if schema != TRENDS_SCHEMA:
        raise TunerError("intelligence-trends schema 不对：expected %s, got %s"
                         % (safe(TRENDS_SCHEMA), safe(schema)))
    score_max = payload.get("score_max")
    if not score_max_ok(score_max):
        raise TunerError("intelligence-trends score_max 不是 %d：%s"
                         % (SCORE_MAX, safe(score_max)))
    batches = payload.get("batches")
    if not isinstance(batches, list):
        raise TunerError("intelligence-trends batches 不是列表：got %s"
                         % type(batches).__name__)
    for batch in batches:
        if not isinstance(batch, dict):
            raise TunerError("intelligence-trends batches 含非对象元素：got %s"
                             % type(batch).__name__)
    return payload


def batch_has_model(batch, model):
    """True when `batch` carries at least one point measured for `model`."""
    points = batch.get("points")
    return isinstance(points, list) and any(
        isinstance(p, dict) and p.get("model") == model for p in points)


def batch_score_max_ok(batch):
    """The batch's own score_max is exactly 150 (bool excluded)."""
    return score_max_ok(batch.get("score_max"))


def parsed_batches(payload):
    """Batches with a parseable UTC completed_at, newest first.

    fetch_trends already guarantees a list of dicts. Unparseable timestamps are
    dropped here; latest_batch reports them per model instead of letting a
    model silently fall back to older data.
    """
    out = []
    for batch in payload["batches"]:
        completed = parse_ts(batch.get("completed_at"))
        if completed is not None:
            out.append((completed, batch))
    out.sort(key=lambda item: item[0], reverse=True)
    return out


def latest_batch(model, payload):
    """Newest UTC batch that measured `model`, with its score_max validated.

    A batch carrying points for the model but an unparseable completed_at makes
    the model's recency unknowable, so that blocks the model rather than
    falling back. The newest batch must also have score_max == 150 (bool
    excluded); otherwise the model is blocked instead of using older data.
    Returns (batch, completed_at) or (None, None).
    """
    measured = [(parse_ts(batch.get("completed_at")), batch)
                for batch in payload["batches"] if batch_has_model(batch, model)]
    if not measured:
        return None, None
    if any(completed is None for completed, _ in measured):
        raise TunerError("model %s: 包含该模型的批次存在无法解析的 completed_at" % model)
    completed, batch = max(measured, key=lambda item: item[0])
    if not batch_score_max_ok(batch):
        raise TunerError("model %s: 最新批次 score_max 不是 %d：%s"
                         % (model, SCORE_MAX, safe(batch.get("score_max"))))
    return batch, completed


def common_efforts_for(model, batch):
    """Efforts present in both the script table and the batch's model_efforts.

    Returns (common, note) — common is cheapest-first; note is a disagreement
    message (spec OL-1463 §3) or None. Single source of truth for "both sides
    have it": used for ranking and for the 7-day peak.
    """
    table = MODEL_EFFORTS[model]
    model_efforts = batch.get("model_efforts")
    raw = model_efforts.get(model) if isinstance(model_efforts, dict) else None
    site = [e for e in raw if isinstance(e, str)] if isinstance(raw, list) else []
    common = [e for e in table if e in site]
    note = None
    if set(table) != set(site):
        note = ("effort table and website disagree for %s "
                "(script=%s website=%s)"
                % (model, safe_all(sorted(table)), safe_all(site)))
    return common, note


def model_scores(model, batch):
    """{effort: score} for `model` in `batch`; raises on unusable point shapes.

    A null score stays in the map (it is displayed as missing and never ranks).
    Bool, non-numeric, NaN and infinite scores are format errors rather than
    quietly-dropped candidates. Values are never echoed — only type names —
    so malformed payloads cannot smuggle strings into comments.
    """
    points = batch.get("points")
    if not isinstance(points, list):
        raise TunerError("batch points 格式不对：expected list, got %s"
                         % type(points).__name__)
    scores = {}
    for p in points:
        if not isinstance(p, dict) or p.get("model") != model:
            continue
        effort = p.get("effort")
        if not isinstance(effort, str) or not effort:
            raise TunerError("effort for %s is not a non-empty string: %s"
                             % (model, type(effort).__name__))
        if effort in scores:
            raise TunerError("duplicate point for %s/%s" % (model, safe(effort)))
        score = p.get("score")
        if score is None:
            scores[effort] = None
            continue
        if isinstance(score, bool) or not isinstance(score, (int, float)) \
                or not math.isfinite(score):
            raise TunerError("score for %s/%s is not a finite number: %s"
                             % (model, safe(effort), type(score).__name__))
        scores[effort] = score
    return scores


def pick_efforts(model, batch, scores):
    """Selection rule (spec OL-1463 §3). Returns (target, S, common, notes).

    target is None when no effort qualifies (model untouched this round).
    Raises TunerError when a candidate score is malformed.
    """
    common, note = common_efforts_for(model, batch)
    notes = [note] if note else []
    candidates = [e for e in common if scores.get(e) is not None]
    if not candidates:
        return None, None, common, notes
    s_max = max(scores[e] for e in candidates)
    target = min((e for e in candidates if scores[e] >= s_max - TIE_RANGE),
                 key=EFFORT_ORDER.index)
    return target, s_max, common, notes


def batch_best(model, batch):
    """Best usable score for `model` in one batch, or None (advisory path)."""
    if not batch_score_max_ok(batch):
        return None
    common, _ = common_efforts_for(model, batch)
    points = batch.get("points")
    if not isinstance(points, list):
        return None
    best = None
    for p in points:
        if not isinstance(p, dict) or p.get("model") != model:
            continue
        if p.get("effort") not in common:
            continue
        score = p.get("score")
        if isinstance(score, bool) or not isinstance(score, (int, float)) \
                or not math.isfinite(score):
            continue
        if best is None or score > best:
            best = score
    return best


def degrade_peak(model, payload, compatibility_key, now):
    """Peak score over the last HISTORY_WINDOW_DAYS UTC days ending at now.

    Only batches with the same non-empty compatibility_key count: a judge or
    rubric change makes older scores incomparable. Historical batches whose
    score_max is not 150 (bool included) or whose key is not a non-empty string
    are skipped. Per UTC day, the max across that day's batches; the window is
    [today-6, today] regardless of staleness. Returns (peak, day) or
    (None, None).
    """
    if not isinstance(compatibility_key, str) or not compatibility_key:
        return None, None
    today = now.astimezone(timezone.utc).date()
    cutoff = today - timedelta(days=HISTORY_WINDOW_DAYS - 1)
    days = {}
    for completed, batch in parsed_batches(payload):
        if not batch_score_max_ok(batch):
            continue
        batch_key = batch.get("compatibility_key")
        if not isinstance(batch_key, str) or not batch_key \
                or batch_key != compatibility_key:
            continue
        day = completed.date()
        if not (cutoff <= day <= today):
            continue
        best = batch_best(model, batch)
        if best is None:
            continue
        days[day] = max(days.get(day, best), best)
    if not days:
        return None, None
    peak_day = max(days, key=lambda d: days[d])
    return days[peak_day], peak_day.isoformat()


def degrade_check(model, payload, compatibility_key, s_max, now):
    """Alert string when S fell DEGRADE_THRESHOLD below the 7-day peak."""
    peak, peak_day = degrade_peak(model, payload, compatibility_key, now)
    if peak is None or s_max is None or s_max > peak - DEGRADE_THRESHOLD:
        return None
    return ("degrade: %s best %.1f vs 7-day peak %.1f on %s (down %.1f pts)"
            % (model, s_max, peak, safe(peak_day), peak - s_max))


def plan_changes(managed, targets, scores):
    """Decide per-agent writes (spec OL-259 §5). Returns (changes, anomalies).

    A model is blocked for the round when any of its managed agents sits on an
    effort that is in the table but has no usable score in the chosen batch:
    that agent must not move, and all agents of a model share one effort, so
    none of them move.
    """
    anomalies, blocked = [], set()
    for a in managed.values():
        model, current = a["model"], a.get("thinking_level") or ""
        # only models evaluated this round: models skipped for a model-level
        # anomaly (no batch, stale data, format error) are already named there
        if current and current in MODEL_EFFORTS[model] and model in scores \
                and scores[model].get(current) is None:
            anomalies.append("agent %s (%s): current effort %s missing this round; "
                             "model %s not changed" % (a["id"], a.get("name", ""),
                                                       current, model))
            blocked.add(model)
    changes = []
    for a in managed.values():
        model, current = a["model"], a.get("thinking_level") or ""
        target = None if model in blocked else targets.get(model)
        if target and target != current:
            changes.append((a["id"], a.get("name", ""), current or "(empty)", target))
    # same wording as the mismatch anomaly: name every agent left untouched
    frozen = {}
    for a in managed.values():
        if a["model"] in blocked:
            frozen.setdefault(a["model"], []).append(
                "%s (%s)" % (a["id"], a.get("name", "")))
    for model in sorted(frozen):
        anomalies.append("本轮未改该模型的 agent：%s" % "、".join(frozen[model]))
    return changes, anomalies


def fmt_score(x):
    return "null" if x is None else "%.1f" % x


def render_comment(changes, anomalies, alerts, scores, common_by_model,
                   batch_days=None):
    batch_days = batch_days or {}
    lines = []
    if changes:
        lines.append("**换档**")
        lines.extend("- %s (%s): %s → %s" % c for c in changes)
        lines.append("")
        lines.append("scores (max %d):" % SCORE_MAX)
        for model in sorted(common_by_model):
            day = batch_days.get(model)
            for e in common_by_model[model]:
                s = scores.get(model, {}).get(e)
                suffix = " (batch %s)" % safe(day) if day else ""
                if s is None:
                    lines.append("- `%s/%s`: missing this round%s"
                                 % (model, e, suffix))
                else:
                    lines.append("- `%s/%s`: score %s%s"
                                 % (model, e, fmt_score(s), suffix))
        lines.append("")
        lines.append("params: tie_range=%d freshness=%dh degrade_threshold=%d window=%dd"
                     % (TIE_RANGE, FRESHNESS_HOURS, DEGRADE_THRESHOLD,
                        HISTORY_WINDOW_DAYS))
    if anomalies:
        if lines:
            lines.append("")
        lines.append("**异常**")
        lines.extend("- " + a for a in anomalies)
    if alerts:
        if lines:
            lines.append("")
        lines.append("**整体降智，换档没用，要不要换模型由 Master 决定**")
        lines.extend("- " + a for a in alerts)
    return "\n".join(lines).strip() or None


def apply_changes(changes, dry_run=False, multica=None):
    """Write per-agent effort changes (spec OL-259 §5.2). Returns (applied, issues).

    A failed update or a mismatched read-back is recorded as an issue and the
    round moves on to the next agent; already-applied changes are kept and
    listed in the comment.
    """
    if multica is None:
        multica = globals()["run_multica"]
    applied, issues = [], []
    for agent_id, name, old, new in changes:
        if dry_run:
            print("dry-run: would set %s (%s) thinking_level %s → %s"
                  % (agent_id, name, old, new))
            applied.append((agent_id, name, old, new))
            continue
        try:
            multica(["agent", "update", agent_id, "--thinking-level", new])
        except TunerError as exc:
            issues.append("agent %s (%s) 改为 %s 失败：%s" % (agent_id, name, new, exc))
            continue
        try:
            after = multica(["agent", "get", agent_id, "--output", "json"])
        except TunerError as exc:
            # the update may already have taken effect — we just cannot confirm
            issues.append("agent %s (%s) 改为 %s 后无法确认是否生效：%s"
                          % (agent_id, name, new, exc))
            continue
        got = after.get("thinking_level") or ""
        if got != new:
            issues.append("agent %s (%s) 改为 %s 失败：回读为 %s"
                          % (agent_id, name, new, got or "(empty)"))
            continue
        applied.append((agent_id, name, old, new))
        print("changed %s (%s): %s → %s" % (agent_id, name, old, new))
    return applied, issues


def run_round(tracking_issue, dry_run=False, multica=None, http_get=None, now=None):
    """One full round: read, fetch, decide, write, report. Returns exit code.

    multica / http_get / now are injection points for the offline tests; `now`
    drives both freshness and the 7-day degrade window.
    """
    if multica is None:
        multica = globals()["run_multica"]
    if http_get is None:
        http_get = globals()["http_get_json"]
    if now is None:
        now = datetime.now(timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    issues = []

    def finish(changes, alerts, scores, common_by_model, batch_days):
        body = render_comment(changes, issues, alerts, scores, common_by_model,
                              batch_days)
        if body is None:
            print("nothing to report")
            return 0
        if dry_run:
            print("dry-run: comment not sent:")
            print(body)
            return 0
        with open(COMMENT_FILE, "w", encoding="utf-8") as fh:
            fh.write(body + "\n")
        try:
            multica(["issue", "comment", "add", tracking_issue,
                     "--content-file", COMMENT_FILE])
        finally:
            os.remove(COMMENT_FILE)
        print("comment posted to %s:" % tracking_issue)
        print(body)
        return 0

    issue = multica(["issue", "get", tracking_issue, "--output", "json"])
    try:
        exclude = parse_exclude_list(issue.get("description") or "")
    except TunerError as exc:
        # spec OL-259 §1.2: nothing is changed at all this round
        issues.append("%s；本轮未改任何 agent" % exc)
        return finish([], [], {}, {}, {})

    managed, skipped = list_managed_agents(exclude, multica=multica)
    for agent_id, name, why in skipped:
        issues.append("agent %s (%s) skipped: %s；本轮未改该 agent" % (agent_id, name, why))

    targets, common_by_model, batch_days = {}, {}, {}
    alerts, scores, changes = [], {}, []
    if managed:
        deadline = time.monotonic() + FETCH_BUDGET_S
        try:
            payload = fetch_trends(deadline, http_get=http_get)
        except TunerError as exc:
            issues.append("%s；本轮未改任何 agent" % exc)
            return finish([], [], {}, {}, {})
        models = sorted({a["model"] for a in managed.values()})
        for model in models:
            model_agents = "、".join("%s (%s)" % (a["id"], a.get("name", ""))
                                    for a in managed.values()
                                    if a["model"] == model)
            try:
                batch, completed = latest_batch(model, payload)
            except TunerError as exc:
                issues.append("%s；本轮未改该模型的 agent：%s" % (exc, model_agents))
                continue
            if batch is None:
                issues.append("model %s: intelligence-trends 中没有包含该模型的有效批次；"
                              "本轮未改该模型的 agent：%s" % (model, model_agents))
                continue
            age = now - completed
            if age > timedelta(hours=FRESHNESS_HOURS):
                issues.append("model %s: 最新有效批次完成于 %s，距今 %.1f 小时，超过 %d 小时新鲜度阈值；"
                              "本轮未改该模型的 agent：%s"
                              % (model, safe(completed.strftime("%Y-%m-%dT%H:%M:%SZ")),
                                 age.total_seconds() / 3600.0, FRESHNESS_HOURS,
                                 model_agents))
                continue
            try:
                model_points = model_scores(model, batch)
                target, s_max, common, notes = pick_efforts(model, batch, model_points)
            except TunerError as exc:
                issues.append("%s；本轮未改该模型的 agent：%s" % (exc, model_agents))
                continue
            issues.extend(notes)
            scores[model] = model_points
            targets[model] = target
            common_by_model[model] = common
            batch_days[model] = completed.date().isoformat()
            if target is not None:
                alert = degrade_check(model, payload,
                                      batch.get("compatibility_key"), s_max, now)
                if alert:
                    alerts.append(alert)
        changes, plan_issues = plan_changes(managed, targets, scores)
        issues.extend(plan_issues)

    applied, write_issues = apply_changes(changes, dry_run=dry_run, multica=multica)
    issues.extend(write_issues)
    return finish(applied, alerts, scores, common_by_model, batch_days)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tracking-issue", required=True,
                   help="parent issue key or ID (exclude list source, comment target)")
    p.add_argument("--dry-run", action="store_true",
                   help="fetch and compute as usual, print the result, change nothing")
    args = p.parse_args(argv)
    try:
        return run_round(args.tracking_issue, dry_run=args.dry_run)
    except TunerError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
