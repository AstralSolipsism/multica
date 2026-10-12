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
from datetime import date, timedelta

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
# ^ whole fetch round capped at 10 minutes by default; env-overridable for ops
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


def list_managed_agents():
    """Active agents on codex runtimes, keyed by ID, plus per-agent anomalies.

    Agents with an empty model or a model outside MODEL_EFFORTS are reported
    and left alone: the daemon drops the effort setting for an empty model.
    """
    runtimes = run_multica(["runtime", "list", "--output", "json"])
    codex = {r["id"] for r in runtimes if r.get("provider") == "codex"}
    agents = run_multica(["agent", "list", "--output", "json"])
    managed, skipped = {}, []
    for a in agents:
        if a.get("runtime_id") not in codex or a.get("archived_at"):
            continue
        if not a.get("model"):
            skipped.append((a["id"], a.get("name", ""), "model is empty"))
        elif a["model"] not in MODEL_EFFORTS:
            skipped.append((a["id"], a.get("name", ""),
                            "model %s not in effort table" % a["model"]))
        else:
            managed[a["id"]] = a
    return managed, skipped


def pick_efforts(model, binding, scores):
    """Selection rule (spec §4). Returns (target, S, common_efforts, notes).

    target is None when no effort qualifies (model untouched this round).
    Raises TunerError when candidate efforts disagree with the binding's
    benchmark / task_set_sha256.
    """
    table = MODEL_EFFORTS[model]
    site = sorted({e["effort"] for e in (binding.get("model_efforts") or [])
                   if e.get("model") == model and e.get("effort")})
    common = [e for e in EFFORT_ORDER if e in table and e in site]
    notes = []
    if set(table) != set(site):
        notes.append("effort table and website disagree for %s (script=%s website=%s)"
                     % (model, sorted(table), site))
    ref = (binding.get("benchmark"), binding.get("task_set_sha256"))
    candidates = []
    for e in common:
        s = scores.get(e)
        if s is None or s.get("score") is None or s.get("coverage", 0) < COVERAGE_MIN:
            continue
        if (s.get("benchmark"), s.get("task_set_sha256")) != ref:
            raise TunerError("benchmark/task_set mismatch for %s/%s: got %r, binding has %r"
                             % (model, e, (s.get("benchmark"), s.get("task_set_sha256")), ref))
        candidates.append(e)
    if not candidates:
        return None, None, common, notes
    s_max = max(scores[e]["score"] for e in candidates)
    target = min((e for e in candidates if scores[e]["score"] >= s_max - TIE_RANGE),
                 key=EFFORT_ORDER.index)
    return target, s_max, common, notes


def degrade_peak(scores):
    """Peak score over the last HISTORY_WINDOW_DAYS UTC days.

    Per UTC day, the max score across efforts among coverage-filtered points;
    the window is anchored on the latest day present in the data (deterministic
    for tests; the live feed's last bucket is at most a day old).
    Returns (peak, day) or (None, None).
    """
    days = {}
    for s in scores.values():
        for p in (s or {}).get("history", {}).get("points", []):
            if p.get("coverage", 0) < COVERAGE_MIN or p.get("score") is None:
                continue
            day = (p.get("at") or "")[:10]
            if day:
                days.setdefault(day, []).append(p["score"])
    if not days:
        return None, None
    cutoff = (date.fromisoformat(max(days)) - timedelta(days=HISTORY_WINDOW_DAYS - 1)).isoformat()
    window = {d: v for d, v in days.items() if d >= cutoff}
    peak_day = max(window, key=lambda d: max(window[d]))
    return max(window[peak_day]), peak_day


def degrade_check(model, scores, s_max):
    """Alert string when S fell DEGRADE_THRESHOLD below the 7-day peak."""
    peak, peak_day = degrade_peak(scores)
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


def fetch_round(models, site_efforts, deadline):
    """Sequential fetch, one retry pass, bounded by the overall deadline.

    Returns {model: {effort: payload-or-None}} — None = missing this round.
    """
    results, failed = {}, []

    def attempt(model, effort):
        try:
            return http_get_json(SCORE_URL.format(model=model, effort=effort))
        except Exception as exc:  # timeouts, 524s, DNS — all retryable
            print("fetch %s/%s failed: %s" % (model, effort, exc), file=sys.stderr)
            return None

    for model in sorted(models):
        for effort in site_efforts.get(model, ()):  # cheapest-first table order
            if time.monotonic() > deadline:
                print("fetch budget exhausted; remaining efforts treated as missing",
                      file=sys.stderr)
                return results
            results.setdefault(model, {})[effort] = attempt(model, effort)
            if results[model][effort] is None:
                failed.append((model, effort))
    for model, effort in failed:  # one retry pass after everything else
        if time.monotonic() > deadline:
            break
        results[model][effort] = attempt(model, effort)
    return results


def fmt_score(x):
    return "null" if x is None else "%.1f" % x


def render_comment(changes, anomalies, alerts, scores, common_by_model):
    lines = []
    if changes:
        lines.append("**effort changes**")
        lines.extend("- %s (%s): %s → %s" % c for c in changes)
        lines.append("")
        lines.append("scores (max 150):")
        for model in sorted(common_by_model):
            for e in common_by_model[model]:
                s = scores.get(model, {}).get(e)
                if s is None:
                    lines.append("- %s/%s: missing this round" % (model, e))
                else:
                    lines.append("- %s/%s: score %s, coverage %s/64"
                                 % (model, e, fmt_score(s.get("score")), s.get("coverage")))
        lines.append("")
        lines.append("params: tie_range=%d coverage_min=%d degrade_threshold=%d window=%dd"
                     % (TIE_RANGE, COVERAGE_MIN, DEGRADE_THRESHOLD, HISTORY_WINDOW_DAYS))
    if anomalies:
        if lines:
            lines.append("")
        lines.append("**anomalies**")
        lines.extend("- " + a for a in anomalies)
    if alerts:
        if lines:
            lines.append("")
        lines.append("**整体降智，换档没用，要不要换模型由 Master 决定**")
        lines.extend("- " + a for a in alerts)
    return "\n".join(lines).strip() or None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tracking-issue", required=True,
                   help="parent issue key or ID (exclude list source, comment target)")
    p.add_argument("--dry-run", action="store_true",
                   help="fetch and compute as usual, print the result, change nothing")
    args = p.parse_args(argv)

    issues = []
    issue = run_multica(["issue", "get", args.tracking_issue, "--output", "json"])
    try:
        exclude = parse_exclude_list(issue.get("description") or "")
    except TunerError as exc:
        # spec §1.2: nothing is changed at all this round; the error is reported
        issues.append(str(exc))
        managed, targets, scores, common_by_model = {}, {}, {}, {}
        changes, alerts = [], []
    else:
        managed, skipped = list_managed_agents()
        for agent_id, name, why in skipped:
            issues.append("agent %s (%s) skipped: %s" % (agent_id, name, why))
        for agent_id in exclude:
            managed.pop(agent_id, None)
        targets, common_by_model, alerts, changes = {}, {}, [], []
        scores = {}
        if managed:
            deadline = time.monotonic() + FETCH_BUDGET_S
            binding = http_get_json(BINDING_URL)
            site_efforts = {}
            for e in binding.get("model_efforts", []):
                if e.get("model") in MODEL_EFFORTS and e.get("effort"):
                    efforts = site_efforts.setdefault(e["model"], [])
                    if e["effort"] not in efforts and e["effort"] in MODEL_EFFORTS[e["model"]]:
                        efforts.append(e["effort"])
            for m in site_efforts:  # keep script table order (cheapest first)
                site_efforts[m] = [e for e in MODEL_EFFORTS[m] if e in site_efforts[m]]
            models = {a["model"] for a in managed.values()}
            scores = fetch_round(models, site_efforts, deadline)
            for model in sorted(models):
                try:
                    target, s_max, common, notes = pick_efforts(model, binding,
                                                                scores.get(model, {}))
                except TunerError as exc:
                    issues.append(str(exc))
                    continue
                issues.extend(notes)
                targets[model] = target
                common_by_model[model] = common
                if target is not None:
                    alert = degrade_check(model, scores.get(model, {}), s_max)
                    if alert:
                        alerts.append(alert)
            changes, plan_issues = plan_changes(managed, targets, scores)
            issues.extend(plan_issues)

    for agent_id, name, old, new in changes:
        if args.dry_run:
            print("dry-run: would set %s (%s) thinking_level %s → %s"
                  % (agent_id, name, old, new))
        else:
            run_multica(["agent", "update", agent_id, "--thinking-level", new])
            after = run_multica(["agent", "get", agent_id, "--output", "json"])
            if (after.get("thinking_level") or "") != new:
                raise TunerError("agent %s: update to %s did not stick (read back %r)"
                                 % (agent_id, new, after.get("thinking_level")))

    body = render_comment(changes, issues, alerts, scores, common_by_model)
    if body:
        if args.dry_run:
            print("dry-run: comment not sent:")
            print(body)
        else:
            with open(COMMENT_FILE, "w", encoding="utf-8") as fh:
                fh.write(body + "\n")
            run_multica(["issue", "comment", "add", args.tracking_issue,
                         "--content-file", COMMENT_FILE])
    else:
        print("nothing to report")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except TunerError as exc:
        print("error: %s" % exc, file=sys.stderr)
        sys.exit(1)
