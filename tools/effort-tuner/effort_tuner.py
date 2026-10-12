#!/usr/bin/env python3
"""Codex effort auto-tuner (OL-259).

Reads codexradar.com benchmark scores for the models used by managed Codex
agents and moves each agent to the cheapest reasoning effort level whose score
is within TIE_RANGE points of the best. See README.md for usage and rules.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

# ---- tunables (spec OL-259 §4.5) ----
TIE_RANGE = 5            # efforts scoring >= S - TIE_RANGE count as tied
COVERAGE_MIN = 56        # a fetched effort is a candidate only at this coverage
DEGRADE_THRESHOLD = 10   # alert when S <= peak - DEGRADE_THRESHOLD (7-day peak)
HISTORY_WINDOW_DAYS = 7
BINDING_URL = "https://codexradar.com/data/radar-bench-binding.json"
SCORE_URL = ("https://codexradar.com/api/radar-bench-score"
             "?model={model}&effort={effort}&view=summary&selection=user-selected-v1")
USER_AGENT = "labrastro-effort-tuner/1"
REQUEST_TIMEOUT_S = 130   # cold-cache requests hang ~2min then return 524
FETCH_BUDGET_S = int(os.environ.get("EFFORT_TUNER_BUDGET_S", "600"))
# ^ whole fetch round (binding + every score request, retries included) is
# capped by this deadline; env-overridable for ops
MULTICA = "multica"
EXCLUDE_BLOCK = "effort-tuner-exclude"
COMMENT_FILE = "effort-tuner-comment.md"

# codex-cli 0.160.1 `codex debug models`; cheapest first
EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"]
MODEL_EFFORTS = {
    "gpt-6-astra": EFFORT_ORDER,
    "gpt-6.1-sol": EFFORT_ORDER,
    "gpt-6-sol": EFFORT_ORDER,
    "gpt-5.6-sol": EFFORT_ORDER,
    "gpt-5.6-terra": EFFORT_ORDER,
    "gpt-6-luna": EFFORT_ORDER[:-1],
    "gpt-5.6-luna": EFFORT_ORDER[:-1],
}

# website-sourced effort names must look like plain identifiers before they
# are allowed into any message (they end up in issue comments)
EFFORT_NAME_RE = re.compile(r"^[a-z0-9._-]+$")


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


def parse_exclude_list(description):
    """Parse the ```effort-tuner-exclude fenced block -> set of agent IDs.

    Comments after # and blank lines are ignored; an empty block is fine.
    Raises TunerError when the block is missing or a line is not a valid UUID.
    """
    match = re.search(r"```" + EXCLUDE_BLOCK + r"\s*\n(.*?)```", description, re.S)
    if not match:
        raise TunerError("tracking-issue description has no ```%s``` block" % EXCLUDE_BLOCK)
    ids = set()
    for line in match.group(1).splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        try:
            ids.add(str(uuid.UUID(line)))
        except ValueError:
            raise TunerError("exclude list line is not a UUID: %r" % line) from None
    return ids


def list_managed_agents(exclude=(), multica=None):
    """Active agents on codex runtimes, keyed by ID, plus per-agent skip notes.

    Excluded agents are dropped before any model check (spec §1.2 precedes
    §1.3), so excluding an agent also silences its model problems. Agents with
    an empty model or a model outside MODEL_EFFORTS are reported and left
    alone: the daemon drops the effort setting for an empty model.
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


def common_efforts_for(model, binding):
    """Efforts present in both the script table and the website binding.

    Returns (common, note) — common is cheapest-first; note is a disagreement
    message (spec §3) or None. Single source of truth for "both sides have
    it": used for the fetch list and inside pick_efforts.
    """
    table = MODEL_EFFORTS[model]
    site = sorted({e["effort"] for e in (binding.get("model_efforts") or [])
                   if e.get("model") == model and e.get("effort")})
    common = [e for e in table if e in site and EFFORT_NAME_RE.fullmatch(e)]
    note = None
    if set(table) != set(site):
        note = ("effort table and website disagree for %s "
                "(script=`%s` website=`%s`)" % (model, sorted(table), site))
    return common, note


def check_payload(model, effort, s):
    """Raise TunerError when a fetched score payload cannot be interpreted."""
    if not isinstance(s, dict):
        raise TunerError("malformed payload for %s/%s: %r" % (model, effort, s))
    score, cov = s.get("score"), s.get("coverage")
    if isinstance(score, bool) or (score is not None
                                   and not isinstance(score, (int, float))):
        raise TunerError("score for %s/%s is not a number: %r" % (model, effort, score))
    if isinstance(cov, bool) or not isinstance(cov, int):
        raise TunerError("coverage for %s/%s is not an integer: %r" % (model, effort, cov))


def pick_efforts(model, binding, scores):
    """Selection rule (spec §4). Returns (target, S, common_efforts, notes).

    target is None when no effort qualifies (model untouched this round).
    Raises TunerError when a payload is malformed or candidate efforts
    disagree with the binding's benchmark / task_set_sha256.
    """
    common, note = common_efforts_for(model, binding)
    notes = [note] if note else []
    ref = (binding.get("benchmark"), binding.get("task_set_sha256"))
    candidates = []
    for e in common:
        s = scores.get(e)
        if s is None:
            continue
        check_payload(model, e, s)
        if s.get("score") is None or s.get("coverage") < COVERAGE_MIN:
            continue
        if (s.get("benchmark"), s.get("task_set_sha256")) != ref:
            raise TunerError("benchmark/task_set mismatch for %s/%s: got `%r`, "
                             "binding has `%r`"
                             % (model, e, (s.get("benchmark"), s.get("task_set_sha256")),
                                ref))
        candidates.append(e)
    if not candidates:
        return None, None, common, notes
    s_max = max(scores[e]["score"] for e in candidates)
    target = min((e for e in candidates if scores[e]["score"] >= s_max - TIE_RANGE),
                 key=EFFORT_ORDER.index)
    return target, s_max, common, notes


def degrade_peak(scores, today):
    """Peak score over the last HISTORY_WINDOW_DAYS UTC days ending at today.

    Per UTC day, the max score across efforts among coverage-filtered points;
    the window is [today-6, today] regardless of how stale the data is.
    Malformed history points are skipped (the degrade alert is advisory).
    Returns (peak, day) or (None, None).
    """
    days = {}
    for s in scores.values():
        if not isinstance(s, dict):
            continue
        for p in s.get("history", {}).get("points", []):
            cov, score = p.get("coverage"), p.get("score")
            if isinstance(cov, bool) or not isinstance(cov, int) or cov < COVERAGE_MIN:
                continue
            if isinstance(score, bool) or not isinstance(score, (int, float)):
                continue
            day = (p.get("at") or "")[:10]
            if day:
                days.setdefault(day, []).append(score)
    if not days:
        return None, None
    cutoff = (today - timedelta(days=HISTORY_WINDOW_DAYS - 1)).isoformat()
    window = {d: v for d, v in days.items() if cutoff <= d <= today.isoformat()}
    if not window:
        return None, None
    peak_day = max(window, key=lambda d: max(window[d]))
    return max(window[peak_day]), peak_day


def degrade_check(model, scores, s_max, today):
    """Alert string when S fell DEGRADE_THRESHOLD below the 7-day peak."""
    peak, peak_day = degrade_peak(scores, today)
    if peak is None or s_max is None or s_max > peak - DEGRADE_THRESHOLD:
        return None
    return ("degrade: %s best %.1f vs 7-day peak %.1f on %s (down %.1f pts)"
            % (model, s_max, peak, peak_day, peak - s_max))


def plan_changes(managed, targets, scores):
    """Decide per-agent writes (spec §5). Returns (changes, anomalies).

    A model is blocked for the round when any of its managed agents sits on an
    effort that is in the table but was not fetched: that agent must not move,
    and all agents of a model share one effort, so none of them move.
    """
    anomalies, blocked = [], set()
    for a in managed.values():
        model, current = a["model"], a.get("thinking_level") or ""
        if current and current in MODEL_EFFORTS[model] \
                and scores.get(model, {}).get(current) is None:
            anomalies.append("agent %s (%s): current effort %s missing this round; "
                             "model %s not changed" % (a["id"], a.get("name", ""),
                                                       current, model))
            blocked.add(model)
    changes = []
    for a in managed.values():
        model, current = a["model"], a.get("thinking_level") or ""
        target = None if a["model"] in blocked else targets.get(model)
        if target and target != current:
            changes.append((a["id"], a.get("name", ""), current or "(empty)", target))
    return changes, anomalies


def fetch_round(models, site_efforts, deadline, http_get=None):
    """Sequential fetch, one retry pass, bounded by the overall deadline.

    Each request's timeout is capped by the time left before the deadline, so
    the whole round (this plus the binding fetch) stays inside FETCH_BUDGET_S.
    Returns {model: {effort: payload-or-None}} — None = missing this round.
    """
    if http_get is None:
        http_get = globals()["http_get_json"]
    results, failed = {}, {}

    def attempt(model, effort):
        left = deadline - time.monotonic()
        if left <= 0:
            return None  # out of budget: treated as missing, like a failed fetch
        try:
            return http_get(SCORE_URL.format(model=model, effort=effort),
                            timeout=min(REQUEST_TIMEOUT_S, left))
        except Exception as exc:  # timeouts, 524s, DNS — all retryable
            print("fetch %s/%s failed: %s" % (model, effort, exc), file=sys.stderr)
            return None

    for model in sorted(models):
        results.setdefault(model, {})
        for effort in site_efforts.get(model, ()):  # cheapest-first table order
            results[model][effort] = attempt(model, effort)
            if results[model][effort] is None:
                failed.setdefault(model, []).append(effort)
    for model, efforts in failed.items():  # one retry pass after everything else
        for effort in efforts:
            results[model][effort] = attempt(model, effort)
    return results


def fetch_binding(deadline, http_get=None):
    """Fetch the binding doc with one retry; None when both attempts fail."""
    if http_get is None:
        http_get = globals()["http_get_json"]
    for attempt_no in (1, 2):
        left = deadline - time.monotonic()
        if left <= 0:
            break
        try:
            return http_get(BINDING_URL, timeout=min(REQUEST_TIMEOUT_S, left))
        except Exception as exc:
            print("binding fetch failed (attempt %d): %s" % (attempt_no, exc),
                  file=sys.stderr)
    return None


def fmt_score(x):
    return "null" if x is None else "%.1f" % x


def render_comment(changes, anomalies, alerts, scores, common_by_model):
    lines = []
    if changes:
        lines.append("**换档**")
        lines.extend("- %s (%s): %s → %s" % c for c in changes)
        lines.append("")
        lines.append("scores (max 150):")
        for model in sorted(common_by_model):
            for e in common_by_model[model]:
                s = scores.get(model, {}).get(e)
                if s is None:
                    lines.append("- `%s/%s`: missing this round" % (model, e))
                else:
                    lines.append("- `%s/%s`: score %s, coverage %s/64"
                                 % (model, e, fmt_score(s.get("score")), s.get("coverage")))
        lines.append("")
        lines.append("params: tie_range=%d coverage_min=%d degrade_threshold=%d window=%dd"
                     % (TIE_RANGE, COVERAGE_MIN, DEGRADE_THRESHOLD, HISTORY_WINDOW_DAYS))
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
    """Write per-agent effort changes (spec §5.2). Returns (applied, issues).

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
            after = multica(["agent", "get", agent_id, "--output", "json"])
        except TunerError as exc:
            issues.append("agent %s (%s) 改为 %s 失败：%s" % (agent_id, name, new, exc))
            continue
        got = after.get("thinking_level") or ""
        if got != new:
            issues.append("agent %s (%s) 改为 %s 失败：回读为 %s"
                          % (agent_id, name, new, got or "(empty)"))
            continue
        applied.append((agent_id, name, old, new))
        print("changed %s (%s): %s → %s" % (agent_id, name, old, new))
    return applied, issues


def run_round(tracking_issue, dry_run=False, multica=None, http_get=None, today=None):
    """One full round: read, fetch, decide, write, report. Returns exit code.

    multica / http_get / today are injection points for the offline tests.
    """
    if multica is None:
        multica = globals()["run_multica"]
    if http_get is None:
        http_get = globals()["http_get_json"]
    if today is None:
        today = datetime.now(timezone.utc).date()
    issues = []

    def finish(changes, alerts, scores, common_by_model):
        body = render_comment(changes, issues, alerts, scores, common_by_model)
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
        # spec §1.2: nothing is changed at all this round; the error is reported
        issues.append("%s；本轮未改任何 agent" % exc)
        return finish([], [], [], {})

    managed, skipped = list_managed_agents(exclude, multica=multica)
    for agent_id, name, why in skipped:
        issues.append("agent %s (%s) skipped: %s；本轮未改该 agent" % (agent_id, name, why))

    targets, common_by_model, alerts, scores = {}, {}, [], {}
    changes = []
    if managed:
        deadline = time.monotonic() + FETCH_BUDGET_S
        binding = fetch_binding(deadline, http_get=http_get)
        if binding is None:
            issues.append("binding 抓取失败；本轮未改任何 agent")
            return finish([], [], [], {})
        models = {a["model"] for a in managed.values()}
        fetch_lists = {m: common_efforts_for(m, binding)[0] for m in models}
        scores = fetch_round(models, fetch_lists, deadline, http_get=http_get)
        for model in sorted(models):
            model_agents = ["%s (%s)" % (a["id"], a.get("name", ""))
                            for a in managed.values() if a["model"] == model]
            try:
                target, s_max, common, notes = pick_efforts(model, binding,
                                                            scores.get(model, {}))
            except TunerError as exc:
                issues.append("%s；本轮未改该模型的 agent：%s"
                              % (exc, "、".join(model_agents)))
                continue
            issues.extend(notes)
            targets[model] = target
            common_by_model[model] = common
            if target is not None:
                alert = degrade_check(model, scores.get(model, {}), s_max, today)
                if alert:
                    alerts.append(alert)
        changes, plan_issues = plan_changes(managed, targets, scores)
        issues.extend(plan_issues)

    applied, write_issues = apply_changes(changes, dry_run=dry_run, multica=multica)
    issues.extend(write_issues)
    return finish(applied, alerts, scores, common_by_model)


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
