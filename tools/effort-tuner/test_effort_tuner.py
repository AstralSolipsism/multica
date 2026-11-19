#!/usr/bin/env python3
"""Offline unit tests for effort_tuner (OL-1463). No network.

Run: python3 test_effort_tuner.py  (also works under pytest)
"""
import copy
import datetime
import itertools
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import effort_tuner as et

FIXTURES = Path(__file__).parent / "fixtures"
UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 19, 3, 0, tzinfo=UTC)
TODAY = NOW.date()

ID1 = "11111111-1111-1111-1111-111111111111"
ID2 = "22222222-2222-2222-2222-222222222222"
ID3 = "33333333-3333-3333-3333-333333333333"
ID4 = "44444444-4444-4444-4444-444444444444"


def load(name="intelligence-trends.json"):
    with open(FIXTURES / name, encoding="utf-8") as fh:
        return json.load(fh)


def fixture_batches():
    return et.sorted_batches(load())


def fixture_batch(batch_id):
    return next(b for b in load()["batches"] if b["id"] == batch_id)


def point(model, effort, score):
    return {"model": model, "effort": effort, "score": score}


def make_batch(points, completed="2026-11-18T00:00:00+00:00", compat="k",
               efforts=None, score_max=150):
    b = {"id": "b", "score_max": score_max, "compatibility_key": compat,
         "completed_at": completed, "points": points}
    if efforts is not None:
        b["model_efforts"] = efforts
    return b


def with_points(model, scores, compat="k", completed="2026-11-18T00:00:00+00:00"):
    return make_batch([point(model, e, s) for e, s in scores.items()],
                      completed=completed, compat=compat,
                      efforts={model: list(scores)})


def agent(id_hex, model, thinking_level="", name="A", runtime="rt-codex"):
    return {"id": id_hex, "name": name, "model": model,
            "thinking_level": thinking_level, "archived_at": None,
            "runtime_id": runtime}


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
            agent(ID1, "gpt-6.2-sol", "high"),
            agent(ID2, "", ""),                                       # empty model
            agent(ID3, "gpt-9", ""),                                  # unknown model
            {**agent(ID4, "gpt-6-astra"), "archived_at": "2026-10-01"},
            agent("55555555-5555-5555-5555-555555555555", "gpt-6-astra",
                  runtime="rt-other", name="other-runtime"),
        ]
        (managed, skipped), calls = self.run_filter(agents)
        self.assertEqual(list(managed), [ID1])
        self.assertEqual(len(skipped), 2)
        self.assertIn("model is empty", skipped[0][2])
        self.assertIn("not in effort table", skipped[1][2])
        self.assertEqual([c[0] for c in calls], ["runtime", "agent"])

    def test_excluded_agent_silenced_before_model_check(self):
        # spec OL-259 §1.2 (exclude) precedes §1.3 (model checks)
        agents = [agent(ID1, "", "", name="excluded-one"),
                  agent(ID2, "gpt-6-astra", "max", name="kept")]
        (managed, skipped), _ = self.run_filter(agents, exclude={ID1})
        self.assertEqual(list(managed), [ID2])
        self.assertEqual(skipped, [])

    def test_new_622_models_are_managed(self):
        for model in ("gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra"):
            self.assertIn(model, et.MODEL_EFFORTS)
            self.assertEqual(et.MODEL_EFFORTS[model], et.EFFORT_ORDER)

    def test_current_effort_empty_or_unknown_is_not_checked(self):
        a_empty = agent(ID1, "gpt-6-astra", "")
        a_odd = agent(ID2, "gpt-6-astra", "weird")
        scores = {e: 100.0 for e in et.EFFORT_ORDER}
        scores["low"] = None  # low has no usable score this round
        changes, anomalies = et.plan_changes(
            {a_empty["id"]: a_empty, a_odd["id"]: a_odd},
            {"gpt-6-astra": "low"}, {"gpt-6-astra": scores})
        self.assertEqual(anomalies, [])
        # no fetch check for empty/unknown current efforts; both would move to low
        self.assertEqual([c[0] for c in changes], [ID1, ID2])

    def test_luna_model_has_no_ultra(self):
        self.assertNotIn("ultra", et.MODEL_EFFORTS["gpt-6-luna"])


class TimestampTests(unittest.TestCase):
    def test_offsets_normalized_to_utc(self):
        self.assertEqual(et.parse_ts("2026-11-18T01:00:00+08:00"),
                         et.parse_ts("2026-11-17T17:00:00+00:00"))

    def test_naive_timestamp_is_utc(self):
        self.assertEqual(et.parse_ts("2026-11-18T01:00:00"),
                         et.parse_ts("2026-11-18T01:00:00Z"))

    def test_invalid_timestamps(self):
        for bad in (None, 1760000000, "", "not-a-date"):
            self.assertIsNone(et.parse_ts(bad))


class BatchSelectionTests(unittest.TestCase):
    def test_latest_batch_for_astra_falls_back_past_newest_batch(self):
        # the 2026-11-19 round measured only 6.1/6.2 models; astra keeps 11-17
        batch, completed = et.latest_batch("gpt-6-astra", fixture_batches())
        self.assertEqual(batch["id"], "fixture-20261117-astra")
        self.assertEqual(completed, et.parse_ts("2026-11-17T22:21:37.351972+00:00"))

    def test_utc_order_beats_raw_string_order(self):
        # 2026-11-18T01:00:00+08:00 is 11-17T17:00Z, i.e. older than the
        # 11-17T22:21Z batch although its raw string sorts later
        early = fixture_batch("fixture-20261118-early-shanghai")
        self.assertGreater(early["completed_at"], "2026-11-17T22:21:37.351972+00:00")
        batch, _ = et.latest_batch("gpt-6-astra", fixture_batches())
        self.assertNotEqual(batch["id"], "fixture-20261118-early-shanghai")

    def test_latest_batch_for_622_models_is_newest(self):
        for model in ("gpt-6.2-sol", "gpt-6.2-astra"):
            batch, _ = et.latest_batch(model, fixture_batches())
            self.assertEqual(batch["id"], "fixture-20261118-sol62")

    def test_batches_with_bad_envelope_skipped(self):
        payload = {"batches": [
            {"id": "bad-score-max", "score_max": 100,
             "completed_at": "2026-11-18T00:00:00Z",
             "points": [point("m", "low", 1)]},
            {"id": "bad-completed", "score_max": 150, "completed_at": "soon",
             "points": [point("m", "low", 1)]},
            "not-a-batch",
            {"id": "ok", "score_max": 150,
             "completed_at": "2026-11-17T00:00:00Z",
             "points": [point("m", "low", 1)]},
        ]}
        ids = [b["id"] for _, b in et.sorted_batches(payload)]
        self.assertEqual(ids, ["ok"])

    def test_no_batch_contains_model(self):
        payload = {"batches": [fixture_batch("fixture-20261118-sol62")]}
        self.assertEqual(et.latest_batch("gpt-6-astra", et.sorted_batches(payload)),
                         (None, None))

    def test_model_only_in_model_efforts_is_not_a_batch(self):
        # a listed model with no measured point must not become "latest"
        b = make_batch([], efforts={"gpt-6-astra": list(et.EFFORT_ORDER)})
        self.assertEqual(et.latest_batch("gpt-6-astra", [(NOW, b)]), (None, None))


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.astra_batch = fixture_batch("fixture-20261117-astra")
        self.astra_scores = et.model_scores("gpt-6-astra", self.astra_batch)

    def test_astra_picks_xhigh(self):
        target, s_max, common, notes = et.pick_efforts(
            "gpt-6-astra", self.astra_batch, self.astra_scores)
        self.assertEqual(target, "xhigh")
        self.assertAlmostEqual(s_max, 130.72500000000002)
        self.assertEqual(common, et.EFFORT_ORDER)
        self.assertEqual(notes, [])

    def test_tie_range_10_picks_high(self):
        with patch.object(et, "TIE_RANGE", 10):
            target, _, _, _ = et.pick_efforts(
                "gpt-6-astra", self.astra_batch, self.astra_scores)
        self.assertEqual(target, "high")

    def test_622_models_pick_max(self):
        batch = fixture_batch("fixture-20261118-sol62")
        for model in ("gpt-6.2-sol", "gpt-6.2-astra"):
            target, _, common, _ = et.pick_efforts(
                model, batch, et.model_scores(model, batch))
            # sol: xhigh 148.9 within 5 of max 149.8 and cheaper -> xhigh
            expected = "xhigh" if model == "gpt-6.2-sol" else "max"
            self.assertEqual(target, expected)
            self.assertEqual(common, et.EFFORT_ORDER)

    def test_missing_effort_off_table_still_selects(self):
        scores = dict(self.astra_scores)
        scores["xhigh"] = None  # xhigh has no score; agent is not on xhigh
        target, _, common, _ = et.pick_efforts("gpt-6-astra", self.astra_batch, scores)
        self.assertEqual(target, "max")
        self.assertEqual(common, et.EFFORT_ORDER)

    def test_null_scores_are_not_candidates(self):
        target, s_max, _, _ = et.pick_efforts(
            "gpt-6-astra", self.astra_batch,
            {e: None for e in et.EFFORT_ORDER})
        self.assertIsNone(target)
        self.assertIsNone(s_max)

    def test_tie_boundary_exactly_s_minus_range_counts(self):
        b = with_points("gpt-6-astra", {e: 90.0 for e in et.EFFORT_ORDER})
        b["points"][et.EFFORT_ORDER.index("low")]["score"] = 95.0
        b["points"][et.EFFORT_ORDER.index("high")]["score"] = 100.0
        target, _, _, _ = et.pick_efforts(
            "gpt-6-astra", b, et.model_scores("gpt-6-astra", b))
        self.assertEqual(target, "low")

    def test_ultra_only_when_clearly_ahead(self):
        b = with_points("gpt-6-astra", {e: 100.0 for e in et.EFFORT_ORDER})
        b["points"][et.EFFORT_ORDER.index("ultra")]["score"] = 120.0
        target, s_max, _, _ = et.pick_efforts(
            "gpt-6-astra", b, et.model_scores("gpt-6-astra", b))
        self.assertEqual((target, s_max), ("ultra", 120.0))

    def test_table_website_disagree_reports_and_intersects(self):
        b = copy.deepcopy(self.astra_batch)
        b["model_efforts"]["gpt-6-astra"].remove("ultra")
        scores = {"low": 100.0}  # fixture astra only has other scores
        target, _, common, notes = et.pick_efforts("gpt-6-astra", b, scores)
        self.assertEqual(target, "low")
        self.assertEqual(common, et.EFFORT_ORDER[:-1])
        self.assertEqual(len(notes), 1)
        self.assertIn("disagree", notes[0])

    def test_website_effort_name_with_markup_is_not_echoed(self):
        b = copy.deepcopy(self.astra_batch)
        b["model_efforts"]["gpt-6-astra"].append("[@master](mention://member/1)")
        target, _, _, notes = et.pick_efforts("gpt-6-astra", b, {"low": 100.0})
        self.assertEqual(target, "low")
        self.assertEqual(len(notes), 1)
        self.assertIn("<非法值，已省略>", notes[0])
        self.assertNotIn("mention://", notes[0])

    def test_malformed_scores_raise_with_type_names(self):
        for bad in (True, "121", "[@a](mention://agent/1)", float("nan"),
                    float("inf"), float("-inf")):
            b = with_points("gpt-6-astra", {"low": bad})
            with self.assertRaises(et.TunerError) as ctx:
                et.model_scores("gpt-6-astra", b)
            msg = str(ctx.exception)
            self.assertIn("not a finite number", msg)
            self.assertIn(type(bad).__name__, msg)
            self.assertNotIn("mention://", msg)
            self.assertNotIn("121", msg)

    def test_malformed_point_shapes_raise_type_names_only(self):
        for bad_points in ("not-a-list",
                           [{"model": "gpt-6-astra", "effort": 7, "score": 1}],
                           [{"model": "gpt-6-astra", "effort": "", "score": 1}]):
            with self.assertRaises(et.TunerError) as ctx:
                et.model_scores("gpt-6-astra", {"points": bad_points})
            self.assertNotIn("mention://", str(ctx.exception))

    def test_missing_effort_in_use_blocks_all_agents_of_model(self):
        scores = dict(self.astra_scores)
        scores["high"] = None
        managed = {ID1: agent(ID1, "gpt-6-astra", "high"),
                   ID2: agent(ID2, "gpt-6-astra", "ultra")}
        target = et.pick_efforts("gpt-6-astra", self.astra_batch, scores)[0]
        changes, anomalies = et.plan_changes(
            managed, {"gpt-6-astra": target}, {"gpt-6-astra": scores})
        self.assertEqual(changes, [])  # one blocked agent freezes the whole model
        self.assertEqual(len(anomalies), 2)  # missing-effort note + frozen-agent list
        self.assertIn("current effort high missing", anomalies[0])
        self.assertIn(ID1, anomalies[0])
        self.assertIn(ID1, anomalies[1])
        self.assertIn(ID2, anomalies[1])


class DegradeTests(unittest.TestCase):
    def batches(self, *items):
        return [(et.parse_ts(completed), batch)
                for completed, batch in items]

    def best_batch(self, scores, completed="2026-11-17T00:00:00Z",
                   compat="k", model="gpt-6-astra"):
        batch = with_points(model, scores, compat=compat, completed=completed)
        return completed, batch

    def test_threshold_boundary(self):
        s = {e: 100.0 for e in et.EFFORT_ORDER}
        old = self.best_batch({e: 110.0 for e in et.EFFORT_ORDER})
        batches = self.batches(old)
        self.assertIsNotNone(
            et.degrade_check("gpt-6-astra", batches, "k", 100.0, NOW))  # exactly -10
        self.assertIsNone(
            et.degrade_check("gpt-6-astra", batches, "k", 100.1, NOW))  # above threshold

    def test_same_compatibility_key_only(self):
        # a high score under another judge/rubric key must not mask degradation
        other = self.best_batch({e: 150.0 for e in et.EFFORT_ORDER},
                                compat="other")
        same = self.best_batch({e: 130.0 for e in et.EFFORT_ORDER}, compat="k")
        peak, day = et.degrade_peak("gpt-6-astra", self.batches(other, same), "k", NOW)
        self.assertEqual((peak, day), (130.0, "2026-11-17"))

    def test_missing_compatibility_key_never_alerts(self):
        same = self.best_batch({e: 130.0 for e in et.EFFORT_ORDER}, compat="")
        self.assertEqual(et.degrade_peak("gpt-6-astra", self.batches(same), "", NOW),
                         (None, None))

    def test_peak_per_utc_day_across_batches(self):
        first = self.best_batch({e: 100.0 for e in et.EFFORT_ORDER},
                                completed="2026-11-16T01:00:00Z")
        second = self.best_batch({e: 120.0 for e in et.EFFORT_ORDER},
                                 completed="2026-11-16T23:00:00Z")
        peak, day = et.degrade_peak("gpt-6-astra", self.batches(first, second), "k", NOW)
        self.assertEqual((peak, day), (120.0, "2026-11-16"))

    def test_window_is_seven_days(self):
        inside = self.best_batch({e: 140.0 for e in et.EFFORT_ORDER},
                                 completed="2026-11-13T00:00:00Z")  # today-6
        outside = self.best_batch({e: 150.0 for e in et.EFFORT_ORDER},
                                  completed="2026-11-12T23:59:59Z")  # today-7
        future = self.best_batch({e: 150.0 for e in et.EFFORT_ORDER},
                                 completed="2026-11-20T00:00:00Z")
        peak, _ = et.degrade_peak("gpt-6-astra",
                                  self.batches(inside, outside, future), "k", NOW)
        self.assertEqual(peak, 140.0)

    def test_malformed_history_points_are_skipped(self):
        good = with_points("gpt-6-astra", {"low": 90.0, "ultra": 100.0})
        good["points"] += [
            {"model": "gpt-6-astra", "effort": "low", "score": "abc"},
            {"model": "gpt-6-astra", "effort": "medium", "score": True},
            {"model": "gpt-6-astra", "effort": "high", "score": float("nan")},
            "not-a-point"]
        batches = self.batches(("2026-11-17T00:00:00Z", good))
        self.assertEqual(et.degrade_peak("gpt-6-astra", batches, "k", NOW),
                         (100.0, "2026-11-17"))

    def test_effort_not_common_does_not_count(self):
        b = with_points("gpt-6-astra", {"ultra": 150.0})
        b["model_efforts"]["gpt-6-astra"] = ["low"]
        batches = self.batches(("2026-11-17T00:00:00Z", b))
        self.assertEqual(et.degrade_peak("gpt-6-astra", batches, "k", NOW),
                         (None, None))


class FetchTests(unittest.TestCase):
    def test_success_first_attempt(self):
        calls = []

        def fake_get(url, timeout=None):
            calls.append((url, timeout))
            return load()

        with patch.object(et.time, "monotonic", side_effect=itertools.count()):
            payload = et.fetch_trends(deadline=1000, http_get=fake_get)
        self.assertEqual(payload["schema"], et.TRENDS_SCHEMA)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], et.TRENDS_URL)

    def test_one_retry_after_failure(self):
        calls = []

        def fake_get(url, timeout=None):
            calls.append(url)
            if len(calls) == 1:
                raise OSError("524")
            return load()

        with patch.object(et.time, "monotonic", side_effect=itertools.count()):
            payload = et.fetch_trends(deadline=100, http_get=fake_get)
        self.assertEqual(len(calls), 2)
        self.assertEqual(payload["schema"], et.TRENDS_SCHEMA)

    def test_both_attempts_fail(self):
        with patch.object(et, "http_get_json", side_effect=OSError("524")), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            with self.assertRaises(et.TunerError) as ctx:
                et.fetch_trends(deadline=100)
        self.assertIn("抓取失败", str(ctx.exception))

    def test_no_request_when_budget_exhausted(self):
        def fail(url, timeout=None):
            raise AssertionError("no request expected")

        with patch.object(et.time, "monotonic", return_value=1001):
            with self.assertRaises(et.TunerError):
                et.fetch_trends(deadline=1000, http_get=fail)

    def test_timeout_capped_by_deadline(self):
        seen = []

        def fake_get(url, timeout=None):
            seen.append(timeout)
            return load()

        with patch.object(et.time, "monotonic", return_value=1000):
            et.fetch_trends(deadline=1001, http_get=fake_get)
        self.assertEqual(seen, [1])

    def test_wrong_schema_rejected_and_sanitized(self):
        bad = load()
        bad["schema"] = "[@all](mention://all/all)"
        with patch.object(et.time, "monotonic", side_effect=itertools.count()), \
             self.assertRaises(et.TunerError) as ctx:
            et.fetch_trends(deadline=1000,
                            http_get=lambda url, timeout=None: bad)
        self.assertNotIn("mention://", str(ctx.exception))
        self.assertIn("schema", str(ctx.exception))

    def test_wrong_score_max_rejected(self):
        for bad_value in (100, True, "150", None):
            bad = load()
            bad["score_max"] = bad_value
            with patch.object(et.time, "monotonic", side_effect=itertools.count()), \
                 self.assertRaises(et.TunerError):
                et.fetch_trends(deadline=1000,
                                http_get=lambda url, timeout=None, b=bad: b)

    def test_non_dict_payload_types(self):
        for bad in ("not-a-dict", []):
            with patch.object(et.time, "monotonic", side_effect=itertools.count()), \
                 self.assertRaises(et.TunerError) as ctx:
                et.fetch_trends(deadline=1000,
                                http_get=lambda url, timeout=None, b=bad: b)
            self.assertIn(type(bad).__name__, str(ctx.exception))


class CommentTests(unittest.TestCase):
    def test_degrade_alert_in_comment(self):
        changes = [(ID1, "A", "high", "xhigh")]
        body = et.render_comment(changes, [], ["degrade: m down 12"], {},
                                 {"m": ["low"]})
        self.assertIn("整体降智", body)
        self.assertIn("degrade: m down 12", body)
        self.assertIn("high → xhigh", body)

    def test_no_changes_no_comment(self):
        self.assertIsNone(et.render_comment([], [], [], {}, {}))

    def test_missing_score_and_batch_day_listed(self):
        body = et.render_comment(
            [(ID1, "A", "high", "xhigh")], [], [],
            {"m": {"low": None, "high": 90.5}},
            {"m": ["low", "high"]}, {"m": "2026-11-17"})
        self.assertIn("`m/low`: missing this round (batch 2026-11-17)", body)
        self.assertIn("`m/high`: score 90.5 (batch 2026-11-17)", body)
        self.assertIn("freshness=72h", body)

    def test_anomaly_names_blocked_agents(self):
        body = et.render_comment(
            [], ["mismatch for gpt-6-astra；本轮未改该模型的 agent：%s (A)" % ID1],
            [], {}, {})
        self.assertIn("本轮未改", body)
        self.assertIn(ID1, body)


class CliPathTests(unittest.TestCase):
    def run_child(self, env_value):
        env = dict(os.environ)
        if env_value is None:
            env.pop("MULTICA_CLI_PATH", None)
        else:
            env["MULTICA_CLI_PATH"] = env_value
        out = subprocess.run(
            [sys.executable, "-c", "import effort_tuner as e; print(e.MULTICA)"],
            cwd=str(Path(__file__).parent), env=env,
            capture_output=True, text=True, check=True)
        return out.stdout.strip()

    def test_multica_cli_path_env_wins(self):
        self.assertEqual(self.run_child("/opt/fake/multica"), "/opt/fake/multica")

    def test_multica_falls_back_to_path(self):
        self.assertEqual(self.run_child(None), "multica")


# ---- end-to-end round tests with a fake multica and fake HTTP ----

DESC = "rules\n```effort-tuner-exclude\n%s\n```" % ID2


class FakeMultica:
    """Records multica calls; serves runtime/agent/issue data from fixtures."""

    def __init__(self, agents, issue=None, update_fails=(), get_fails=(), readback=None):
        self.agents = agents
        self.issue = issue if issue is not None else {"description": DESC}
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
    """Callable fake HTTP: serves the trends payload, optionally failing first."""

    def __init__(self, payload=None, failures=0):
        self.payload = load() if payload is None else payload
        self.failures = failures
        self.calls = []

    def __call__(self, url, timeout=None):
        self.calls.append(url)
        if len(self.calls) <= self.failures:
            raise OSError("524")
        return self.payload


class RoundTests(unittest.TestCase):
    MENTION_RE = re.compile(
        r"\[@?(.+?)\]\(mention://(member|agent|squad|issue|all)/([0-9a-fA-F-]+|all)\)")

    def run_round(self, fake_multica, http, dry_run=False):
        old = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                code = et.run_round("OL-252", dry_run=dry_run,
                                    multica=fake_multica, http_get=http, now=NOW)
                leftover = (Path(tmp) / "effort-tuner-comment.md").exists()
            finally:
                os.chdir(old)
        return code, leftover

    def run_with_budget(self, fake_multica, http, dry_run=False):
        with patch.object(et, "FETCH_BUDGET_S", 600), \
             patch.object(et.time, "monotonic", side_effect=itertools.count()):
            return self.run_round(fake_multica, http, dry_run=dry_run)

    def astra_payload(self, mutate):
        payload = load()
        mutate(payload)
        return payload

    def test_baseline_writes_and_posts_one_comment_via_content_file(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")])
        http = FakeHTTP()
        code, leftover = self.run_with_budget(m, http)
        self.assertEqual(code, 0)
        self.assertFalse(leftover)   # comment file cleaned up after posting
        updates = [c for c in m.calls if c[:2] == ["agent", "update"]]
        self.assertEqual(updates,
                         [["agent", "update", ID1, "--thinking-level", "xhigh"]])
        comment_calls = [c for c in m.calls if c[:3] == ["issue", "comment", "add"]]
        self.assertEqual(comment_calls,
                         [["issue", "comment", "add", "OL-252",
                           "--content-file", "effort-tuner-comment.md"]])
        self.assertEqual(len(m.comments), 1)
        self.assertIn("max → xhigh", m.comments[0])
        self.assertIn("batch 2026-11-17", m.comments[0])
        self.assertEqual(http.calls, [et.TRENDS_URL])  # one static GET

    def test_new_62_agent_is_tuned(self):
        m = FakeMultica([agent(ID1, "gpt-6.2-astra", "low", name="new")])
        code, _ = self.run_with_budget(m, FakeHTTP())
        self.assertEqual(code, 0)
        updates = [c for c in m.calls if c[:2] == ["agent", "update"]]
        self.assertEqual(updates,
                         [["agent", "update", ID1, "--thinking-level", "max"]])

    def test_dry_run_neither_updates_nor_comments(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")])
        code, leftover = self.run_with_budget(m, FakeHTTP(), dry_run=True)
        self.assertEqual(code, 0)
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertEqual(m.comments, [])
        self.assertFalse(leftover)

    def test_quiet_round_posts_no_comment(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "xhigh", name="one")])
        code, _ = self.run_with_budget(m, FakeHTTP())
        self.assertEqual(code, 0)
        self.assertEqual(m.comments, [])

    def test_fetch_failure_changes_nothing_and_reports(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")])
        code, _ = self.run_with_budget(m, FakeHTTP(failures=2))
        self.assertEqual(code, 0)
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertEqual(len(m.comments), 1)
        self.assertIn("抓取失败", m.comments[0])
        self.assertIn("本轮未改任何 agent", m.comments[0])

    def test_schema_mismatch_changes_nothing_and_reports(self):
        payload = self.astra_payload(lambda p: p.update({"schema": "v2"}))
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")])
        code, _ = self.run_with_budget(m, FakeHTTP(payload))
        self.assertEqual(code, 0)
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertIn("schema", m.comments[0])

    def test_stale_batch_blocks_model_and_reports(self):
        def stale(p):
            for b in p["batches"]:
                b["completed_at"] = "2026-11-01T00:00:00+00:00"
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")])
        code, _ = self.run_with_budget(m, FakeHTTP(self.astra_payload(stale)))
        self.assertEqual(code, 0)
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertEqual(len(m.comments), 1)
        self.assertIn("新鲜度", m.comments[0])
        self.assertIn(ID1, m.comments[0])

    def test_boundary_freshness_72h_still_used(self):
        def boundary(p):
            p["batches"] = [b for b in p["batches"]
                            if b["id"] != "fixture-20261118-early-shanghai"]
            b = next(b for b in p["batches"]
                     if b["id"] == "fixture-20261117-astra")
            b["completed_at"] = (NOW - datetime.timedelta(hours=72)).isoformat()
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")])
        code, _ = self.run_with_budget(m, FakeHTTP(self.astra_payload(boundary)))
        self.assertEqual(code, 0)
        updates = [c for c in m.calls if c[:2] == ["agent", "update"]]
        self.assertEqual(updates,
                         [["agent", "update", ID1, "--thinking-level", "xhigh"]])
        self.assertNotIn("新鲜度", m.comments[0])

    def test_current_effort_missing_blocks_model(self):
        def remove_xhigh(p):
            b = next(b for b in p["batches"]
                     if b["id"] == "fixture-20261117-astra")
            b["points"] = [pt for pt in b["points"]
                           if not (pt["model"] == "gpt-6-astra"
                                   and pt["effort"] == "xhigh")]
        m = FakeMultica([agent(ID1, "gpt-6-astra", "xhigh", name="one")])
        code, _ = self.run_with_budget(m, FakeHTTP(self.astra_payload(remove_xhigh)))
        self.assertEqual(code, 0)
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertIn("current effort xhigh missing", m.comments[0])
        self.assertIn("本轮未改该模型的 agent", m.comments[0])

    def test_no_batch_contains_model_reports_agents(self):
        payload = {"schema": et.TRENDS_SCHEMA, "score_max": 150,
                   "batches": [fixture_batch("fixture-20261118-sol62")]}
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")])
        code, _ = self.run_with_budget(m, FakeHTTP(payload))
        self.assertEqual(code, 0)
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertIn("没有包含该模型的有效批次", m.comments[0])
        self.assertIn(ID1, m.comments[0])

    def test_invalid_exclude_list_changes_nothing_and_reports(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max")],
                        issue={"description": "no block at all"})
        http = FakeHTTP()
        code, _ = self.run_with_budget(m, http)
        self.assertEqual(code, 0)
        self.assertEqual(http.calls, [])
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))
        self.assertEqual(len(m.comments), 1)
        self.assertIn("本轮未改任何 agent", m.comments[0])

    def test_excluded_agent_not_written_and_not_reported(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one"),
                         agent(ID2, "gpt-6-astra", "low", name="excluded")])
        code, _ = self.run_with_budget(m, FakeHTTP())
        self.assertFalse(any(ID2 in c for c in m.calls if c[:2] == ["agent", "update"]))
        self.assertNotIn(ID2, m.comments[0])

    def test_skipped_agent_lands_in_comment(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one"),
                         agent(ID3, "", "", name="empty-model")])
        code, _ = self.run_with_budget(m, FakeHTTP())
        self.assertIn("skipped", m.comments[0])
        self.assertIn("model is empty", m.comments[0])
        self.assertIn(ID3, m.comments[0])

    def test_write_error_continues_and_reports(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one"),
                         agent(ID3, "gpt-6-astra", "medium", name="two")],
                        update_fails={ID3})
        code, _ = self.run_with_budget(m, FakeHTTP())
        self.assertEqual(code, 0)
        updates = [c for c in m.calls if c[:2] == ["agent", "update"]]
        self.assertEqual(len(updates), 2)          # both agents attempted
        self.assertIn(ID1, m.comments[0])          # applied change recorded
        self.assertIn("失败", m.comments[0])
        self.assertIn(ID3, m.comments[0])

    def test_readback_mismatch_continues_and_reports(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")],
                        readback={ID1: "max"})  # did not stick
        code, _ = self.run_with_budget(m, FakeHTTP())
        self.assertEqual(code, 0)
        self.assertIn("回读为 max", m.comments[0])

    def test_readback_get_failure_says_cannot_confirm(self):
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")],
                        get_fails={ID1})
        self.run_with_budget(m, FakeHTTP())
        self.assertIn("无法确认是否生效", m.comments[0])

    def test_injected_score_string_sanitized(self):
        def poison(p):
            b = next(b for b in p["batches"]
                     if b["id"] == "fixture-20261117-astra")
            for pt in b["points"]:
                if pt["model"] == "gpt-6-astra" and pt["effort"] == "low":
                    pt["score"] = "[@victim](mention://agent/deadbeef)"
        m = FakeMultica([agent(ID1, "gpt-6-astra", "max", name="one")])
        self.run_with_budget(m, FakeHTTP(self.astra_payload(poison)))
        self.assertEqual(len(m.comments), 1)
        self.assertIsNone(self.MENTION_RE.search(m.comments[0]), m.comments[0])
        self.assertIn("not a finite number", m.comments[0])
        self.assertIn("str", m.comments[0])

    def test_no_target_for_model_posts_no_comment_for_it(self):
        def null_scores(p):
            b = next(b for b in p["batches"]
                     if b["id"] == "fixture-20261117-astra")
            for pt in b["points"]:
                pt["score"] = None
        m = FakeMultica([agent(ID1, "gpt-6-astra", "", name="one")])
        code, _ = self.run_with_budget(m, FakeHTTP(self.astra_payload(null_scores)))
        self.assertEqual(code, 0)
        self.assertEqual(m.comments, [])
        self.assertFalse(any(c[:2] == ["agent", "update"] for c in m.calls))


class MainTests(unittest.TestCase):
    def test_main_returns_1_on_tuner_error(self):
        with patch.object(et, "run_round", side_effect=et.TunerError("boom")):
            code = et.main(["--tracking-issue", "OL-252"])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
