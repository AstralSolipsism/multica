#!/usr/bin/env python3
"""Offline unit tests for effort_tuner (OL-259 acceptance §1). No network.

Run: python3 test_effort_tuner.py  (also works under pytest)
"""
import json
import sys
import tempfile
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


class ExcludeListTests(unittest.TestCase):
    def desc(self, body):
        return "before\n```effort-tuner-exclude\n%s\n```\nafter" % body

    def test_normal_list(self):
        ids = et.parse_exclude_list(self.desc("%s # me\n\n%s" % (ID1, ID2)))
        self.assertEqual(ids, {ID1, ID2})

    def test_empty_list(self):
        self.assertEqual(et.parse_exclude_list(self.desc("# only comments\n\n")), set())

    def test_missing_block(self):
        with self.assertRaises(et.TunerError):
            et.parse_exclude_list("no block here")

    def test_invalid_line(self):
        with self.assertRaises(et.TunerError):
            et.parse_exclude_list(self.desc("not-a-uuid"))


class ManagedAgentTests(unittest.TestCase):
    def test_filtering_and_skips(self):
        runtimes = [{"id": "rt-codex", "provider": "codex"},
                    {"id": "rt-other", "provider": "claude"}]
        agents = [
            agent(ID1, "gpt-6-astra", "high"),
            agent(ID2, "", ""),                                   # empty model
            agent("33333333-3333-3333-3333-333333333333", "gpt-9", ""),  # unknown model
            {**agent("44444444-4444-4444-4444-444444444444", "gpt-6-astra"),
             "archived_at": "2026-10-01"},                          # archived
            agent("55555555-5555-5555-5555-555555555555", "gpt-6-astra",
                  runtime="rt-other", name="other-runtime"),  # non-codex runtime
        ]
        with patch.object(et, "run_multica",
                          side_effect=[runtimes, agents]) as rm:
            managed, skipped = et.list_managed_agents()
        self.assertEqual(list(managed), [ID1])
        self.assertEqual(len(skipped), 2)
        self.assertIn("model is empty", skipped[0][2])
        self.assertIn("not in effort table", skipped[1][2])
        self.assertEqual([c.args[0] for c in rm.call_args_list],
                         [["runtime", "list", "--output", "json"],
                          ["agent", "list", "--output", "json"]])

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
        self.assertEqual(len(anomalies), 1)
        self.assertIn("xhigh missing", anomalies[0])

    def test_missing_effort_in_use_blocks_all_agents_of_model(self):
        scores = astra_scores()
        scores["high"] = None
        managed = {ID1: agent(ID1, "gpt-6-astra", "high"),
                   ID2: agent(ID2, "gpt-6-astra", "ultra")}
        target = et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)[0]
        changes, anomalies = et.plan_changes(managed, {"gpt-6-astra": target},
                                             {"gpt-6-astra": scores})
        self.assertEqual(changes, [])  # one blocked agent freezes the whole model
        self.assertEqual(anomalies and [anomalies[0]],  # only the agent on `high`
                         ["agent %s (A): current effort high missing this round; "
                          "model gpt-6-astra not changed" % ID1])

    def test_task_set_mismatch_blocks_model(self):
        scores = astra_scores()
        scores["low"] = score_payload(120, 64, task_set="deadbeef")
        with self.assertRaises(et.TunerError):
            et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)

    def test_no_candidates_leaves_model_alone(self):
        scores = {e: score_payload(None, 10) for e in et.EFFORT_ORDER}
        target, s_max, _, _ = et.pick_efforts("gpt-6-astra", ASTRA_FULL, scores)
        self.assertIsNone(target)
        self.assertIsNone(s_max)

    def test_coverage_gate_uses_fixture_medium(self):
        # fixture medium has coverage 54 < 56 → excluded, xhigh wins
        target, _, _, _ = et.pick_efforts("gpt-6-astra", ASTRA_FULL, astra_scores())
        self.assertEqual(target, "xhigh")

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

    def test_sol_low_fixture_selects_and_degrades(self):
        b = binding_with([("gpt-6.1-sol", e) for e in et.EFFORT_ORDER])
        scores = {"low": load("score_gpt-6.1-sol_low.json")}
        target, s_max, _, _ = et.pick_efforts("gpt-6.1-sol", b, scores)
        self.assertEqual(target, "low")
        # 81.8 vs valid 7-day peak 84.2: below threshold, no alert. The two
        # early points score 112.5/110 at coverage 12/15 — had they counted,
        # this WOULD alert, so IsNone proves the coverage filter works.
        self.assertIsNone(et.degrade_check("gpt-6.1-sol", scores, s_max))

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
        peak, day = et.degrade_peak(scores)
        self.assertEqual((peak, day), (60.0, "2026-10-11"))

    def test_peak_takes_max_across_efforts_and_days(self):
        scores = {
            "low": score_payload(50, 64, points=[self.points("2026-10-09T00:00:00.000Z", 100.0, 64)]),
            "high": score_payload(50, 64, points=[self.points("2026-10-10T00:00:00.000Z", 120.0, 64)]),
        }
        peak, day = et.degrade_peak(scores)
        self.assertEqual((peak, day), (120.0, "2026-10-10"))

    def test_alert_at_threshold_not_below(self):
        scores = {"high": score_payload(100.0, 64, points=[
            self.points("2026-10-11T00:00:00.000Z", 110.0, 64)])}
        self.assertIsNotNone(et.degrade_check("m", scores, 100.0))  # exactly -10
        self.assertIsNone(et.degrade_check("m", scores, 100.1))     # above threshold

    def test_window_is_seven_days(self):
        scores = {"low": score_payload(100.0, 64, points=[
            self.points("2026-10-11T00:00:00.000Z", 95.0, 64),
            self.points("2026-10-05T00:00:00.000Z", 140.0, 64),  # 7th day back: inside
            self.points("2026-10-04T00:00:00.000Z", 150.0, 64),  # 8th day back: outside
        ])}
        peak, _ = et.degrade_peak(scores)
        self.assertEqual(peak, 140.0)


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
        self.assertIn("m/low: missing this round", body)
        self.assertIn("m/high: score 90.5, coverage 60/64", body)


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
            mtime.monotonic.side_effect = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
            results = et.fetch_round({"m"}, site, deadline=5)
        self.assertEqual(calls.count(calls[0]), 2)   # low retried exactly once
        self.assertEqual(results["m"]["low"], {"score": 1})
        self.assertEqual(results["m"]["high"], {"score": 1})

    def test_budget_exhaustion_returns_missing(self):
        with patch.object(et, "http_get_json", return_value={"score": 1}), \
             patch.object(et, "time") as mtime:
            mtime.monotonic.side_effect = itertools_count()
            results = et.fetch_round({"m"}, {"m": ["low", "high"]}, deadline=0)
        # low squeaks through (0 > 0 is false); the budget check kills high
        self.assertEqual(results["m"]["low"], {"score": 1})
        self.assertIsNone(results["m"].get("high"))


def itertools_count():
    import itertools
    return iter(itertools.count())


if __name__ == "__main__":
    unittest.main(verbosity=2)
