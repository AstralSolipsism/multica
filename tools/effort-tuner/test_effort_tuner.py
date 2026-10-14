#!/usr/bin/env python3
"""Offline unit tests for effort_tuner (OL-259 acceptance §1). No network.

Run: python3 test_effort_tuner.py  (also works under pytest)
"""
import datetime
import itertools
import json
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import effort_tuner as et

FIXTURES = Path(__file__).parent / "fixtures"


def load(name):
    with open(FIXTURES / name, encoding="utf-8") as fh:
        return json.load(fh)


def binding_with(models):
    """Binding fixture restricted to (model, effort) pairs in `models`."""
    b = load("binding.json")
    b["model_efforts"] = [{"model": m, "effort": e} for m, e in models]
    return b


ASTRA_FULL = binding_with([("gpt-6-astra", e) for e in et.EFFORT_ORDER])


def astra_scores(**override):
    """gpt-6-astra 2026-10-11 fixture; low is missing (never fetched)."""
    scores = {e: load("score_gpt-6-astra_%s.json" % e)
              for e in ["medium", "high", "xhigh", "max", "ultra"]}
    scores.update(override)
    return scores


def score_payload(score, coverage, points=(), benchmark="radar-bench-final64-20261004",
                  task_set="f75ff09b6117cd83d3ab6ea744fe379ac117676c042538d5df5e38489af27bc4"):
    return {"score": score, "coverage": coverage, "benchmark": benchmark,
            "task_set_sha256": task_set,
            "history": {"points": list(points)}}


def agent(id_hex, model, thinking_level="", name="A", runtime="rt-codex"):
    return {"id": id_hex, "name": name, "model": model,
            "thinking_level": thinking_level, "archived_at": None,
            "runtime_id": runtime}


ID1 = "11111111-1111-1111-1111-111111111111"
ID2 = "22222222-2222-2222-2222-222222222222"
TODAY = datetime.date(2026, 10, 12)


class ExcludeListTests(unittest.TestCase):
    def desc(self, body):
        return "before\n```effort-tuner-exclude\n%s\n```" % body

    def test_normal_list(self):
        ids = et.parse_exclude_list(self.desc("%s # me\n\n%s" % (ID1, ID2)))
        self.assertEqual(ids, {ID1, ID2})

    def test_empty_list(self):
        self.assertEqual(et.parse_exclude_list(self.desc("# only comments\n\n")), set())

    def test_missing_block(self):
        with self.assertRaises(et.TunerError):
            et.parse_exclude_list("no block here")

    def test_invalid_line_reports_line_number_and_sanitized_value(self):
        with self.assertRaises(et.TunerError) as ctx:
            et.parse_exclude_list(
                self.desc("%s\n[@someone](mention://member/deadbeef)" % ID1))
        # line number kept for locating; the pasted mention link is whitelisted
        self.assertIn("line 2", str(ctx.exception))
        self.assertIn("<非法值，已省略>", str(ctx.exception))
        self.assertNotIn("mention://", str(ctx.exception))


class ManagedAgentTests(unittest.TestCase):
    def run_filter(self, agents, exclude=()):
        runtimes = [{"id": "rt-codex", "provider": "codex"},
                    {"id": "rt-other", "provider": "claude"}]
        calls = []

        def multica(args):
            calls.append(args)
            return runtimes if args[0] == "runtime" else agents

        return et.list_managed_agents(exclude, multica=multica), calls

    def test_filtering_and_skips(self):
        agents = [
            agent(ID1, "gpt-6-astra", "high"),
            agent(ID2, "", ""),                                   # empty model
            agent("33333333-3333-3333-3333-333333333333", "gpt-9", ""),  # unknown model
            {**agent("44444444-4444-4444-4444-444444444444", "gpt-6-astra"),
             "archived_at": "2026-10-01"},                          # archived
            agent("55555555-5555-5555-5555-555555555555", "gpt-6-astra",
                  runtime="rt-other", name="other-runtime"),  # non-codex runtime
        ]
        (managed, skipped), calls = self.run_filter(agents)
        self.assertEqual(list(managed), [ID1])
        self.assertEqual(len(skipped), 2)
        self.assertIn("model is empty", skipped[0][2])
        self.assertIn("not in effort table", skipped[1][2])
        self.assertEqual([c[0] for c in calls], ["runtime", "agent"])

    def test_excluded_agent_silenced_before_model_check(self):
        # spec §1.2 (exclude) precedes §1.3 (model checks): an excluded agent
        # with an empty model is skipped silently, not reported every round
        agents = [agent(ID1, "", "", name="excluded-one"),
                  agent(ID2, "gpt-6-astra", "max", name="kept")]
        (managed, skipped), _ = self.run_filter(agents, exclude={ID1})
        self.assertEqual(list(managed), [ID2])
        self.assertEqual(skipped, [])

    def test_current_effort_empty_or_unknown_is_not_checked(self):
        a_empty = agent(ID1, "gpt-6-astra", "")
        a_odd = agent(ID2, "gpt-6-astra", "weird")
        scores = {e: score_payload(100, 64) for e in et.EFFORT_ORDER}
        scores["low"] = None  # low missing this round
        changes, anomalies = et.plan_changes(
            {a_empty["id"]: a_empty, a_odd["id"]: a_odd},
            {"gpt-6-astra": "low"}, {"gpt-6-astra": scores})
        self.assertEqual(anomalies, [])
        # no fetch check for empty/unknown current efforts; both would move to low
        self.assertEqual([c[0] for c in changes], [ID1, ID2])


class SelectionTests(unittest.TestCase):
    def test_astra_fixture_picks_xhigh(self):
        target, s_max, common, notes = et.pick_efforts("gpt-6-astra", ASTRA_FULL,
                                                       astra_scores())
        self.assertEqual(target, "xhigh")
        self.assertAlmostEqual(s_max, 121.12650175007094)
        self.assertEqual(common, et.EFFORT_ORDER)
        self.assertEqual(notes, [])

    def test_astra_fixture_tie_range_10_picks_high(self):
        with patch.object(et, "TIE_RANGE", 10):
            target, _, _, _ = et.pick_efforts("gpt-6-astra", ASTRA_FULL, astra_scores())
        self.assertEqual(target, "high")

    def test_missing_effort_off_table_still_selects(self):
        scores = astra_scores()
        scores["xhigh"] = None  # xhigh missing, agent not on xhigh
        target, _, common, _ = et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)
        self.assertEqual(target, "high")  # high ties with max (111.97 vs 113.67)
        self.assertEqual(common, et.EFFORT_ORDER)

    def test_missing_effort_in_use_blocks_agent(self):
        scores = astra_scores()
        scores["xhigh"] = None
        changes, anomalies = et.plan_changes(
            {ID1: agent(ID1, "gpt-6-astra", "xhigh")},
            {"gpt-6-astra": et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)[0]},
            {"gpt-6-astra": scores})
        self.assertEqual(changes, [])
        self.assertEqual(len(anomalies), 2)  # missing-effort note + frozen-agent list
        self.assertIn("xhigh missing", anomalies[0])
        self.assertIn(ID1, " ".join(anomalies))

    def test_missing_effort_in_use_blocks_all_agents_of_model(self):
        scores = astra_scores()
        scores["high"] = None
        managed = {ID1: agent(ID1, "gpt-6-astra", "high"),
                   ID2: agent(ID2, "gpt-6-astra", "ultra")}
        target = et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)[0]
        changes, anomalies = et.plan_changes(managed, {"gpt-6-astra": target},
                                             {"gpt-6-astra": scores})
        self.assertEqual(changes, [])  # one blocked agent freezes the whole model
        self.assertEqual(len(anomalies), 2)  # missing-effort note + frozen-agent list
        self.assertIn("current effort high missing", anomalies[0])
        self.assertIn(ID1, anomalies[0])
        # both agents of the model are named as untouched (review 3, 建议 3)
        self.assertIn(ID1, anomalies[1])
        self.assertIn(ID2, anomalies[1])

    def test_task_set_mismatch_blocks_model(self):
        scores = astra_scores()
        scores["low"] = score_payload(120, 64, task_set="deadbeef")
        with self.assertRaises(et.TunerError):
            et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)

    def test_benchmark_only_mismatch_blocks_model(self):
        # task_set matches but benchmark differs: still blocked (review 7)
        scores = astra_scores()
        scores["low"] = score_payload(120, 64, benchmark="radar-bench-other")
        with self.assertRaises(et.TunerError):
            et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)

    def test_no_candidates_leaves_model_alone(self):
        scores = {e: score_payload(None, 10) for e in et.EFFORT_ORDER}
        target, s_max, _, _ = et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)
        self.assertIsNone(target)
        self.assertIsNone(s_max)

    def test_top_score_below_coverage_gate_is_not_selected(self):
        # low scores highest but coverage 55 < 56 → not a candidate;
        # medium at exactly 56 IS a candidate and is selected (review 7)
        scores = {e: score_payload(90, 64) for e in et.EFFORT_ORDER}
        scores["low"] = score_payload(140, 55)
        scores["medium"] = score_payload(100, 56)
        target, s_max, _, _ = et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)
        self.assertEqual(target, "medium")
        self.assertEqual(s_max, 100)

    def test_tie_boundary_score_exactly_s_minus_range_counts(self):
        # score == S - TIE_RANGE exactly is tied → the cheaper effort wins
        scores = {e: score_payload(90, 64) for e in et.EFFORT_ORDER}
        scores["low"] = score_payload(95.0, 64)
        scores["high"] = score_payload(100.0, 64)
        target, _, _, _ = et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)
        self.assertEqual(target, "low")

    def test_table_website_disagree_reports_and_intersects(self):
        b = binding_with([("gpt-6-astra", "low"), ("gpt-6-astra", "medium")])
        scores = astra_scores(low=score_payload(100.0, 60))
        # only low+medium are common; fixture medium has coverage 54 (< 56), so
        # the target must be low — the much higher fixture xhigh (121) is
        # fetched but not common and must be ignored.
        target, _, common, notes = et.pick_efforts("gpt-6-astra", b, scores)
        self.assertEqual(target, "low")
        self.assertEqual(common, ["low", "medium"])
        self.assertEqual(len(notes), 1)
        self.assertIn("disagree", notes[0])

    def test_website_effort_name_with_markup_is_not_echoed(self):
        # a mention-link effort name reaches the disagree note but never the
        # comment verbatim — the note only carries whitelisted values
        b = binding_with([("gpt-6-astra", "[@master](mention://member/1)"),
                          ("gpt-6-astra", "low")])
        target, _, common, notes = et.pick_efforts("gpt-6-astra", b,
                                                   {"low": score_payload(100, 64)})
        self.assertEqual(target, "low")
        self.assertEqual(common, ["low"])
        self.assertEqual(len(notes), 1)
        self.assertIn("disagree", notes[0])
        self.assertNotIn("mention://", notes[0])
        self.assertIn("<非法值，已省略>", notes[0])

    def test_malformed_payloads_raise_with_type_names(self):
        # built from a valid payload with exactly one field poisoned, so the
        # score/coverage checks are actually reached (review round 2, N17)
        for field, bad in (("score", "121"),        # string score
                           ("score", "[@a](mention://agent/1)"),
                           ("score", True),         # bool is not a number
                           ("coverage", None),      # null coverage, non-null score
                           ("coverage", True),      # bool is not an int
                           ("coverage", "64")):
            scores = astra_scores()
            scores["low"] = {**score_payload(121, 64), field: bad}
            with self.assertRaises(et.TunerError) as ctx:
                et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)
            msg = str(ctx.exception)
            self.assertNotIn("mention://", msg)
            self.assertNotIn("121", msg)
        for bad in ("not-a-dict", "[@all](mention://all/all)"):
            scores = astra_scores()
            scores["low"] = bad
            with self.assertRaises(et.TunerError) as ctx:
                et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)
            self.assertNotIn("mention://", str(ctx.exception))
            self.assertIn(type(bad).__name__, str(ctx.exception))

    def test_null_score_allows_null_coverage_but_not_bad_coverage(self):
        # agreed deviation on 供参考 1: score-null efforts skip candidacy but
        # their coverage still lands in the score table, so only null/int pass
        scores = astra_scores()
        scores["low"] = score_payload(None, None)
        target, s_max, _, _ = et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)
        self.assertEqual(target, "xhigh")  # low not a candidate; rest unchanged
        scores["low"] = score_payload(None, "a lot")
        with self.assertRaises(et.TunerError):
            et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)

    def test_sol_low_fixture_selects_and_degrades(self):
        b = binding_with([("gpt-6.1-sol", e) for e in et.EFFORT_ORDER])
        scores = {"low": load("score_gpt-6.1-sol_low.json")}
        target, s_max, _, _ = et.pick_efforts("gpt-6.1-sol", b, scores)
        self.assertEqual(target, "low")
        # 81.8 vs 7-day peak 84.2 (window anchored at 10-12): below threshold,
        # no alert. The two early points score 112.5/110 at coverage 12/15 —
        # had they counted, this WOULD alert, so IsNone proves the filter works.
        self.assertIsNone(et.degrade_check("gpt-6.1-sol", scores, s_max,
                                           today=TODAY))

    def test_luna_model_has_no_ultra(self):
        self.assertNotIn("ultra", et.MODEL_EFFORTS["gpt-6-luna"])


class DegradeTests(unittest.TestCase):
    def points(self, at, score, coverage):
        return {"at": at, "score": score, "coverage": coverage}

    def test_low_coverage_points_filtered(self):
        scores = {"low": score_payload(50, 64, points=[
            self.points("2026-10-10T00:00:00.000Z", 130.0, 10),   # filtered out
            self.points("2026-10-11T00:00:00.000Z", 60.0, 64),
        ])}
        peak, day = et.degrade_peak(scores, today=TODAY)
        self.assertEqual((peak, day), (60.0, "2026-10-11"))

    def test_peak_takes_max_across_efforts_and_days(self):
        scores = {
            "low": score_payload(50, 64, points=[self.points("2026-10-09T00:00:00.000Z", 100.0, 64)]),
            "high": score_payload(50, 64, points=[self.points("2026-10-10T00:00:00.000Z", 120.0, 64)]),
        }
        peak, day = et.degrade_peak(scores, today=TODAY)
        self.assertEqual((peak, day), (120.0, "2026-10-10"))

    def test_alert_at_threshold_not_below(self):
        scores = {"high": score_payload(100.0, 64, points=[
            self.points("2026-10-11T00:00:00.000Z", 110.0, 64)])}
        self.assertIsNotNone(et.degrade_check("m", scores, 100.0, today=TODAY))  # exactly -10
        self.assertIsNone(et.degrade_check("m", scores, 100.1, today=TODAY))     # above threshold

    def test_window_anchored_on_today_not_latest_bucket(self):
        # review 3: latest bucket 10-09, today 10-12 → window 10-06..10-12;
        # the 121 peak on 10-04 is outside and must not trigger an alert
        scores = {"high": score_payload(110.0, 64, points=[
            self.points("2026-10-09T00:00:00.000Z", 110.0, 64),
            self.points("2026-10-04T00:00:00.000Z", 121.0, 64),
        ])}
        self.assertIsNone(et.degrade_check("m", scores, 110.0, today=TODAY))

    def test_stale_data_never_alerts(self):
        # every point older than the window → no peak, no alert
        scores = {"high": score_payload(100.0, 64, points=[
            self.points("2026-10-04T00:00:00.000Z", 121.0, 64)])}
        self.assertIsNone(et.degrade_check("m", scores, 100.0, today=TODAY))

    def test_window_is_seven_days(self):
        scores = {"low": score_payload(100.0, 64, points=[
            self.points("2026-10-12T00:00:00.000Z", 95.0, 64),
            self.points("2026-10-06T00:00:00.000Z", 140.0, 64),  # 7th day back: inside
            self.points("2026-10-05T00:00:00.000Z", 150.0, 64),  # 8th day back: outside
        ])}
        peak, _ = et.degrade_peak(scores, today=TODAY)
        self.assertEqual(peak, 140.0)

    def test_boundary_coverage_point_counts(self):
        # coverage exactly 56 counts toward the peak (review 7)
        scores = {"low": score_payload(50, 64, points=[
            self.points("2026-10-10T00:00:00.000Z", 130.0, 55),  # filtered out
            self.points("2026-10-11T00:00:00.000Z", 120.0, 56),
        ])}
        peak, _ = et.degrade_peak(scores, today=TODAY)
        self.assertEqual(peak, 120.0)

    def test_future_and_malformed_points_ignored(self):
        scores = {"low": score_payload(50, 64, points=[
            self.points("2026-10-15T00:00:00.000Z", 200.0, 64),  # future: outside
            {"at": "2026-10-11T00:00:00.000Z", "score": "abc", "coverage": 64},
            {"at": "2026-10-11T00:00:00.000Z", "score": 90.0, "coverage": None},
        ])}
        peak, day = et.degrade_peak(scores, today=TODAY)
        self.assertEqual((peak, day), (None, None))

    def test_null_history_and_non_dict_points_ignored(self):
        # review round 2, 建议 1 + follow-up: history/points may come back as
        # null; points entries and `at` may not be dicts/strings — all skipped
        scores = {"low": {**score_payload(50, 64), "history": None},
                  "high": score_payload(50, 64, points=[
                      self.points("2026-10-10T00:00:00.000Z", 90.0, 64),
                      {"at": 1760000000, "score": 200.0, "coverage": 64},
                      "not-a-point",
                  ])}
        peak, day = et.degrade_peak(scores, today=TODAY)
        self.assertEqual((peak, day), (90.0, "2026-10-10"))


class CommentTests(unittest.TestCase):
    def test_degrade_alert_in_comment(self):
        changes = [(ID1, "A", "high", "xhigh")]
        body = et.render_comment(changes, [], ["degrade: m down 12"], {}, {"m": ["low"]})
        self.assertIn("整体降智", body)
        self.assertIn("degrade: m down 12", body)
        self.assertIn("high → xhigh", body)

    def test_no_changes_no_comment(self):
        self.assertIsNone(et.render_comment([], [], [], {}, {}))

    def test_missing_effort_listed(self):
        body = et.render_comment([(ID1, "A", "high", "xhigh")], [], [],
                                 {"m": {"low": None, "high": score_payload(90.5, 60)}},
                                 {"m": ["low", "high"]})
        self.assertIn("`m/low`: missing this round", body)
        self.assertIn("`m/high`: score 90.5, coverage 60/64", body)

    def test_null_coverage_renders_as_null(self):
        # review round 2, 供参考 1 follow-up: null renders as `null`, not None
        body = et.render_comment([(ID1, "A", "high", "xhigh")], [], [],
                                 {"m": {"low": score_payload(None, None)}},
                                 {"m": ["low"]})
        self.assertIn("`m/low`: score null, coverage null/64", body)

    def test_anomaly_names_blocked_agents(self):
        # review 5: the anomaly section says which agents stayed untouched
        body = et.render_comment([], ["mismatch for gpt-6-astra；本轮未改该模型的 agent：%s (A)" % ID1],
                                 [], {}, {})
        self.assertIn("本轮未改", body)
        self.assertIn(ID1, body)


class FetchTests(unittest.TestCase):
    def test_retry_pass_and_budget(self):
        calls = []

        def fake_get(url, timeout=None):
            calls.append(url)
            if len(calls) <= 2:  # first two attempts fail, retry succeeds
                raise OSError("524")
            return {"score": 1}

        site = {"m": ["low", "high"]}
        with patch.object(et, "http_get_json", side_effect=fake_get), \
             patch.object(et, "time") as mtime:
            mtime.monotonic.side_effect = itertools.count()
            results = et.fetch_round({"m"}, site, deadline=5)
        self.assertEqual(calls.count(calls[0]), 2)   # low retried exactly once
        self.assertEqual(results["m"]["low"], {"score": 1})
        self.assertEqual(results["m"]["high"], {"score": 1})

    def test_budget_exhaustion_returns_missing(self):
        with patch.object(et, "http_get_json", return_value={"score": 1}), \
             patch.object(et, "time") as mtime:
            mtime.monotonic.side_effect = itertools.count()
            results = et.fetch_round({"m"}, {"m": ["low", "high"]}, deadline=0)
        self.assertEqual(results, {"m": {"low": None, "high": None}})  # zero budget → no request

    def test_request_timeout_capped_by_deadline(self):
        # review 4a: a request issued with little budget left gets a timeout
        # capped to the remaining time, not the full 130s
        seen = []

        def fake_get(url, timeout=None):
            seen.append(timeout)
            return {"score": 1}

        with patch.object(et, "http_get_json", side_effect=fake_get), \
             patch.object(et, "time") as mtime:
            mtime.monotonic.side_effect = iter([1000, 1001])  # 1s before deadline
            results = et.fetch_round({"m"}, {"m": ["low"]}, deadline=1001)
        self.assertEqual(seen, [1])
        self.assertEqual(results["m"]["low"], {"score": 1})

    def test_binding_retry(self):
        calls = []

        def fake_get(url, timeout=None):
            calls.append(url)
            if len(calls) == 1:
                raise OSError("524")
            return {"model_efforts": []}

        with patch.object(et, "http_get_json", side_effect=fake_get), \
             patch.object(et, "time") as mtime:
            mtime.monotonic.side_effect = itertools.count()
            binding = et.fetch_binding(deadline=100)
        self.assertEqual(len(calls), 2)
        self.assertEqual(binding, {"model_efforts": []})

    def test_binding_failure_returns_none(self):
        with patch.object(et, "http_get_json", side_effect=OSError("524")), \
             patch.object(et, "time") as mtime:
            mtime.monotonic.side_effect = itertools.count()
            self.assertIsNone(et.fetch_binding(deadline=100))

    def test_binding_timeout_capped_by_deadline(self):
        # review round 2 (N14): with 1s of budget left the binding request's
        # timeout is capped to that, not the full 130s
        seen = []

        def fake_get(url, timeout=None):
            seen.append(timeout)
            return {"model_efforts": []}

        with patch.object(et, "http_get_json", side_effect=fake_get), \
             patch.object(et.time, "monotonic", side_effect=iter([1000])):
            binding = et.fetch_binding(deadline=1001)
        self.assertEqual(seen, [1])
        self.assertEqual(binding, {"model_efforts": []})

    def test_binding_no_request_when_budget_exhausted(self):
        # review round 2 (N15): out of budget -> no request at all
        def fail(url, timeout=None):
            raise AssertionError("no request expected")

        with patch.object(et, "http_get_json", side_effect=fail), \
             patch.object(et.time, "monotonic", return_value=1001):
            self.assertIsNone(et.fetch_binding(deadline=1000))


# ---- end-to-end round tests with a fake multica and fake HTTP (review 6) ----

def issue_json(desc):
    return {"description": desc}


DESC = "rules\n```effort-tuner-exclude\n%s\n```" % ID2


class FakeMultica:
    """Records multica calls; serves runtime/agent/issue data from fixtures."""

    def __init__(self, agents, issue=None, update_fails=(), get_fails=(), readback=None):
        self.agents = agents
        self.issue = issue if issue is not None else issue_json(DESC)
        self.update_fails = set(update_fails)
        self.get_fails = set(get_fails)
        self.readback = dict(readback or {})   # agent_id -> value returned by get
        self.comments = []
        self.calls = []
        self.applied = {}   # agent_id -> thinking_level after a successful update

    def __call__(self, args):
        self.calls.append(args)
        head = args[0]
        if head == "runtime":
            return [{"id": "rt-codex", "provider": "codex"}]
        if head == "agent" and args[1] == "list":
            return self.agents
        if head == "agent" and args[1] == "get":
            if args[2] in self.get_fails:
                raise et.TunerError("multica agent get failed: 500")
            return {"thinking_level": self.readback.get(args[2], self.applied.get(args[2]))}
        if head == "agent" and args[1] == "update":
            if args[2] in self.update_fails:
                raise et.TunerError("multica agent update failed: 403 denied")
            i = args.index("--thinking-level")
            self.applied[args[2]] = args[i + 1]
            return {}
        if head == "issue" and args[1] == "get":
            return self.issue
        if head == "issue" and args[1] == "comment":
            i = args.index("--content-file")
            with open(args[i + 1], encoding="utf-8") as fh:
                self.comments.append(fh.read())
            return {}
        raise AssertionError("unexpected call: %r" % (args,))


class FakeHTTP:
    """Callable fake HTTP: serves the binding then per-effort fixture scores.

    score_overrides maps effort -> payload-or-None (None = always fail).
    """

    def __init__(self, binding, score_overrides=None):
        self.binding = binding
        self.overrides = score_overrides or {}
        self.calls = []

    def __call__(self, url, timeout=None):
        self.calls.append(url)
        if "radar-bench-binding" in url:
            return self.binding
        effort = url.split("effort=")[1].split("&")[0]
        if effort in self.overrides:
            payload = self.overrides[effort]
            if payload is None:
                raise OSError("524")
            return payload
        return load("score_gpt-6-astra_%s.json" % effort)


def http_for(binding, score_overrides=None):
    return FakeHTTP(binding, score_overrides)


class RoundTests(unittest.TestCase):
    def setUp(self):
        self.agents = [agent(ID1, "gpt-6-astra", "max", name="one"),
                       agent(ID2, "gpt-6-astra", "xhigh", name="excluded")]
        self.binding = binding_with([("gpt-6-astra", e) for e in et.EFFORT_ORDER])

    def run_round(self, fake_multica, http, dry_run=False):
        import os
        import tempfile
        # review round 2, 小问题 2: TemporaryDirectory cleans up after itself
        old = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                code = et.run_round("OL-252", dry_run=dry_run,
                                    multica=fake_multica, http_get=http,
                                    today=TODAY)
                leftover = (Path(tmp) / "effort-tuner-comment.md").exists()
            finally:
                os.chdir(old)
        return code, leftover

    def test_baseline_writes_and_posts_one_comment_via_content_file(self):
        m = FakeMultica(self.agents)
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assertFalse(leftover)   # comment file cleaned up after posting
        # agent one: max → xhigh; agent two is excluded, untouched
        updates = [c for c in m.calls if c[:2] == ["agent", "update"]]
        self.assertEqual(updates, [["agent", "update", ID1, "--thinking-level", "xhigh"]])
        # posted once, via --content-file, to the tracking issue
        comment_calls = [c for c in m.calls if c[:3] == ["issue", "comment", "add"]]
        self.assertEqual(comment_calls,
                         [["issue", "comment", "add", "OL-252",
                           "--content-file", "effort-tuner-comment.md"]])
        self.assertEqual(len(m.comments), 1)
        self.assertIn("max → xhigh", m.comments[0])

    def test_dry_run_neither_updates_nor_comments(self):
        m = FakeMultica(self.agents)
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http, dry_run=True)
        self.assertEqual(code, 0)
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertEqual(m.comments, [])
        # no fetch for the excluded agent's model list, but scores were fetched
        self.assertTrue(any("effort=low" in u for u in http.calls))

    def test_excluded_agent_not_written_and_not_reported(self):
        m = FakeMultica(self.agents)
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertFalse(any(ID2 in c for c in m.calls if c[:2] == ["agent", "update"]))
        body = m.comments[0]
        self.assertNotIn(ID2, body)

    def test_invalid_exclude_list_changes_nothing_and_reports(self):
        m = FakeMultica(self.agents, issue=issue_json("no block at all"))
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        # nothing fetched, nothing written, exactly one anomaly comment
        self.assertEqual(http.calls, [])
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertEqual(len(m.comments), 1)
        self.assertIn("本轮未改任何 agent", m.comments[0])

    def test_write_error_continues_and_reports(self):
        # review 1: agent one's update succeeds, agent three's fails —
        # the round continues, both the applied change and the failure land
        # in the same comment
        three = "33333333-3333-3333-3333-333333333333"
        agents = self.agents + [agent(three, "gpt-6-astra", "medium", name="three")]
        m = FakeMultica(agents, update_fails={three})
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        updates = [c for c in m.calls if c[:2] == ["agent", "update"]]
        self.assertEqual(len(updates), 2)          # both agents attempted
        self.assertEqual(len(m.comments), 1)       # comment still posted
        self.assertIn(ID1, m.comments[0])          # applied change recorded
        self.assertIn("失败", m.comments[0])
        self.assertIn(three, m.comments[0])

    def test_readback_mismatch_continues_and_reports(self):
        three = "33333333-3333-3333-3333-333333333333"
        agents = self.agents + [agent(three, "gpt-6-astra", "medium", name="three")]
        m = FakeMultica(agents, readback={three: "medium"})  # did not stick
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assertEqual(len(m.comments), 1)
        self.assertIn("回读为 medium", m.comments[0])

    def test_binding_failure_blocks_round_gracefully(self):
        m = FakeMultica(self.agents)
        calls = []

        def get(url, timeout=None):
            calls.append(url)
            raise OSError("524")

        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, get)
        self.assertEqual(code, 0)
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertEqual(len(m.comments), 1)
        self.assertIn("binding 抓取失败", m.comments[0])
        self.assertIn("本轮未改任何 agent", m.comments[0])

    def test_task_set_mismatch_names_affected_agents(self):
        # review 5: a benchmark mismatch lists the model's managed agents
        # as untouched in the same comment
        m = FakeMultica(self.agents)
        poisoned = dict(load("score_gpt-6-astra_xhigh.json"))
        poisoned["task_set_sha256"] = "deadbeef"
        http = http_for(self.binding, {"xhigh": poisoned})
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertEqual(len(m.comments), 1)
        self.assertIn("mismatch", m.comments[0])
        self.assertIn(ID1, m.comments[0])          # affected agent named
        self.assertNotIn(ID2, m.comments[0])       # excluded agent not dragged in

    def test_quiet_round_posts_no_comment(self):
        # everything already at target: no changes, no anomalies → no comment
        agents = [agent(ID1, "gpt-6-astra", "xhigh", name="one")]
        m = FakeMultica(agents)
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assertEqual(m.comments, [])


    # ---- review round 2, 应修 B: spec anomalies must reach the comment ----

    def test_current_effort_missing_lands_in_comment(self):
        # N30: agent on `low`, low missing this round -> "missing" anomaly in
        # the comment, nothing written, frozen agents named
        agents = [agent(ID1, "gpt-6-astra", "low", name="one")]
        m = FakeMultica(agents)
        http = http_for(self.binding, {"low": None})   # low fetch fails
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assertEqual(len(m.comments), 1)
        self.assertIn("current effort low missing", m.comments[0])
        self.assertIn(ID1, m.comments[0])
        self.assertIn("本轮未改该模型的 agent", m.comments[0])
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))

    def test_skipped_agent_lands_in_comment(self):
        # N32: empty-model agent outside the exclude list is reported
        three = "33333333-3333-3333-3333-333333333333"
        agents = [agent(ID1, "gpt-6-astra", "max", name="one"),
                  agent(three, "", "", name="empty-model")]
        m = FakeMultica(agents)
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assertEqual(len(m.comments), 1)
        self.assertIn("skipped", m.comments[0])
        self.assertIn("model is empty", m.comments[0])
        self.assertIn(three, m.comments[0])

    def test_table_disagreement_lands_in_comment(self):
        # N33: binding missing the low effort -> disagree note in the comment
        binding = binding_with([("gpt-6-astra", e) for e in et.EFFORT_ORDER[1:]])
        m = FakeMultica(self.agents)
        http = http_for(binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assertEqual(len(m.comments), 1)
        self.assertIn("disagree", m.comments[0])
        self.assertFalse(any("effort=low" in u for u in http.calls))

    # ---- review round 2, 应修 A: injection guard at the round layer ----

    # copy of the server's mention parser (server/internal/util/mention.go:16)
    MENTION_RE = re.compile(
        r"\[@?(.+?)\]\(mention://(member|agent|squad|issue|all)/([0-9a-fA-F-]+|all)\)")

    def assert_one_comment_without_mentions(self, m, expect_marker,
                                            expect_type_name=None):
        self.assertEqual(len(m.comments), 1)   # anti-vacuous: a comment exists
        body = m.comments[0]
        self.assertIsNone(self.MENTION_RE.search(body), body)
        self.assertIn(expect_marker, body)     # and the sanitizer kicked in
        if expect_type_name:
            self.assertIn(expect_type_name, body)

    def test_injected_effort_name_sanitized(self):
        # binding carries a mention-link effort name into the disagree note
        b = binding_with([("gpt-6-astra", "[@master](mention://member/1)")] +
                         [("gpt-6-astra", e) for e in et.EFFORT_ORDER])
        m = FakeMultica(self.agents)
        http = http_for(b)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assert_one_comment_without_mentions(m, "<非法值，已省略>")

    def test_injected_score_string_sanitized(self):
        # score is a mention string -> type name only, never the value
        poisoned = dict(load("score_gpt-6-astra_medium.json"))
        poisoned["score"] = "[@victim](mention://agent/deadbeef)"
        m = FakeMultica(self.agents)
        http = http_for(self.binding, {"medium": poisoned})
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assert_one_comment_without_mentions(
            m, "score for gpt-6-astra/medium is not a number", expect_type_name="str")

    def test_injected_whole_payload_string_sanitized(self):
        # the whole payload is an @all mention string -> dict expected, got str
        m = FakeMultica(self.agents)
        http = http_for(self.binding, {"low": "[@all](mention://all/all)"})
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assert_one_comment_without_mentions(
            m, "malformed payload for gpt-6-astra/low", expect_type_name="str")

    def test_injected_benchmark_backticks_sanitized(self):
        # benchmark with backticks would escape a code span and re-enable a
        # mention inside it; safe() keeps the whole tuple out
        poisoned = dict(load("score_gpt-6-astra_xhigh.json"))
        poisoned["benchmark"] = "radar-bench-final64-20261004` [@x](mention://member/1)"
        m = FakeMultica(self.agents)
        http = http_for(self.binding, {"xhigh": poisoned})
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assert_one_comment_without_mentions(m, "mismatch for gpt-6-astra/xhigh")

    def test_injected_exclude_list_line_sanitized(self):
        # a mention link pasted into the exclude block (instead of a bare ID)
        # is echoed with its line number but never verbatim
        desc = ("rules\n```effort-tuner-exclude\n%s\n"
                "[@victim](mention://agent/ccc32e7d-a604-4940-a7da-09c80ecbf170)\n```" % ID2)
        m = FakeMultica(self.agents, issue=issue_json(desc))
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assertEqual(http.calls, [])   # nothing fetched on a bad list
        self.assert_one_comment_without_mentions(m, "line 2")
        self.assertIn("本轮未改任何 agent", m.comments[0])

    # ---- review round 2, 小问题 1: readback get failure wording ----

    def test_readback_get_failure_continues_and_reports(self):
        # update succeeds, agent get fails: "cannot confirm", not "failed"
        m = FakeMultica(self.agents, get_fails={ID1})
        http = http_for(self.binding)
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            code, leftover = self.run_round(m, http)
        self.assertEqual(code, 0)
        self.assertEqual(len(m.comments), 1)
        self.assertIn("无法确认是否生效", m.comments[0])


class MainTests(unittest.TestCase):
    def test_main_returns_1_on_tuner_error(self):
        # review round 2 (N34): a TunerError escaping run_round exits 1
        with patch.object(et, "run_round", side_effect=et.TunerError("boom")):
            code = et.main(["--tracking-issue", "OL-252"])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
