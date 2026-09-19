"""Local viewer behavior tests; all calendars below are synthetic test data.

No browser is opened and no request is sent to Korean Air. Only loopback HTTP
is used for the handler tests, and every collector is mocked.
"""
import calendar
import copy
import http.client
import io
import os
import subprocess
import sys
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock
from urllib.parse import urlencode

import local_app as app


TODAY = date(2026, 9, 7)
NOW = datetime(2026, 9, 7, 3, 0, tzinfo=timezone.utc)
PARAMS = {
    "origin": "ICN", "destination": "SIN", "tripType": "ONE_WAY",
    "cabin": "prestige", "month": "2026-11",
}


def round_trip():
    return dict(PARAMS, tripType="ROUND_TRIP", returnMonth="2026-12")


def handoff_selection():
    return dict(PARAMS, outboundDate="2026-11-04", returnDate=None)


def handoff_result(selection, stage="date_selected"):
    return {"kind": "airline-handoff", "selection": dict(selection), "stage": stage,
            "message": app.HANDOFF_MESSAGES[stage]}


def synthetic_routes():
    """Small static test catalogue; not a record of current airline operations."""
    return {
        "sourceUrl": app.SOURCE_URL, "retrievedAt": NOW.isoformat(),
        "airports": [
            {"code": "ICN", "name": "서울/인천", "region": "대한민국"},
            {"code": "SIN", "name": "싱가포르", "region": "동남아시아"},
            {"code": "JFK", "name": "뉴욕", "region": "미주"},
        ],
        "destinations": {"ICN": ["SIN", "JFK"], "SIN": ["ICN"]},
    }


def synthetic_calendar(leg, collected_at=NOW):
    """Synthetic complete month, deliberately confined to temporary test roots."""
    year, month = map(int, leg["month"].split("-"))
    return {
        "origin": leg["origin"], "destination": leg["destination"],
        "month": leg["month"], "tripType": "ONE_WAY", "source": app.SOURCE,
        "collectedAt": collected_at.isoformat(),
        "sourceUpdatedAt": (NOW - timedelta(hours=13)).isoformat(),
        "dates": [{
            "date": "%s-%02d" % (leg["month"], day),
            "operatingStatus": "OPERATED", "availabilityType": "PUBLIC_INDICATOR",
            "availableSeatCount": None, "economyAward": True,
            "premiumAward": False, "prestigeAward": day == 4,
            "firstAward": False, "firstAwardOrUpgrade": False,
            "economyUpgrade": False, "premiumUpgrade": False,
            "prestigeUpgrade": day == 9, "firstUpgrade": False,
        } for day in range(1, calendar.monthrange(year, month)[1] + 1)],
    }


def await_job(service, job_id):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        with service.lock:
            job = service.get(job_id)
            if service.active is None and job["status"] in ("complete", "failed"):
                return job
        time.sleep(0.005)
    raise AssertionError("Mocked local job did not finish: %r" % service.get(job_id))


class RequestValidationTests(unittest.TestCase):
    def test_normalizes_airports_and_does_not_forward_unknown_values(self):
        params = app.validate_request(dict(PARAMS, origin=" icn ", destination="sin",
                                          extra="ignored"), TODAY)
        self.assertEqual(params, PARAMS)

    def test_all_cabin_choice_is_accepted_without_changing_the_default(self):
        params = app.validate_request(dict(PARAMS, cabin="all"), TODAY)
        self.assertEqual(params, dict(PARAMS, cabin="all"))
        without_cabin = {key: value for key, value in PARAMS.items() if key != "cabin"}
        self.assertEqual(app.validate_request(without_cabin, TODAY)["cabin"], "prestige")
        self.assertNotIn("all", app.CABINS)

    def test_rejects_invalid_inputs_before_collection(self):
        cases = [
            (None, "INVALID_INPUT"),
            (dict(PARAMS, origin="../../etc"), "INVALID_AIRPORT"),
            (dict(PARAMS, origin="ICN; echo test"), "INVALID_AIRPORT"),
            (dict(PARAMS, destination="ICN"), "SAME_AIRPORT"),
            (dict(PARAMS, tripType="MULTI"), "INVALID_TRIP"),
            (dict(PARAMS, cabin="first"), "INVALID_CABIN"),
            (dict(PARAMS, month="2026-13"), "INVALID_MONTH"),
            (dict(PARAMS, month="2026-09"), "MONTH_OUT_OF_RANGE"),
            (dict(PARAMS, month="2027-10"), "MONTH_OUT_OF_RANGE"),
            (dict(PARAMS, tripType="ROUND_TRIP"), "INVALID_MONTH"),
            (dict(round_trip(), returnMonth="2026-10"), "INVALID_RETURN_MONTH"),
        ]
        for raw, code in cases:
            with self.subTest(code=code, raw=raw):
                with self.assertRaises(app.AppError) as raised:
                    app.validate_request(raw, TODAY)
                self.assertEqual(raised.exception.code, code)

    def test_month_bounds_include_every_month_that_starts_in_the_booking_window(self):
        minimum, maximum = app.month_bounds(TODAY)
        self.assertEqual((minimum, maximum), ("2026-10", "2027-09"))
        limit = TODAY + timedelta(days=359)
        last_year, last_month = map(int, maximum.split("-"))
        # The month may run past the horizon; only its first day must be bookable.
        self.assertLessEqual(date(last_year, last_month, 1), limit)
        self.assertGreater(date(last_year, last_month, 1) + timedelta(days=31), limit)
        self.assertEqual(app.month_bounds(date(2026, 12, 31))[0], "2027-01")

    def test_round_trip_reverses_airports_and_uses_return_month(self):
        params = app.validate_request(round_trip(), TODAY)
        self.assertEqual(app.legs_for(params), [
            {"direction": "outbound", "origin": "ICN", "destination": "SIN", "month": "2026-11"},
            {"direction": "inbound", "origin": "SIN", "destination": "ICN", "month": "2026-12"},
        ])


class HandoffValidationTests(unittest.TestCase):
    def test_one_way_keeps_only_displayed_selection_and_clears_unused_return(self):
        raw = dict(handoff_selection(), origin=" icn ", extra="ignored", returnMonth="2026-12",
                   returnDate="2026-12-10")
        self.assertEqual(app.validate_handoff_request(raw, TODAY), handoff_selection())

    def test_round_trip_validates_both_dates_and_allows_same_day(self):
        raw = dict(round_trip(), outboundDate="2026-11-04", returnDate="2026-12-02")
        self.assertEqual(app.validate_handoff_request(raw, TODAY), raw)
        same_day = dict(raw, returnMonth="2026-11", returnDate="2026-11-04")
        self.assertEqual(app.validate_handoff_request(same_day, TODAY), same_day)

    def test_all_cabin_handoff_keeps_choice_and_both_validated_dates(self):
        for raw in (dict(handoff_selection(), cabin="all"),
                    dict(round_trip(), cabin="all", outboundDate="2026-11-04", returnDate="2026-12-02")):
            with self.subTest(trip=raw["tripType"]):
                self.assertEqual(app.validate_handoff_request(raw, TODAY), raw)

    def test_missing_impossible_mismatched_or_reversed_dates_are_rejected(self):
        cases = [
            (PARAMS, "INVALID_DATE"),
            (dict(handoff_selection(), outboundDate="2026-11-31"), "INVALID_DATE"),
            (dict(handoff_selection(), outboundDate="2026-11-4"), "INVALID_DATE"),
            (dict(handoff_selection(), outboundDate="2026-11-04T12:00"), "INVALID_DATE"),
            (dict(handoff_selection(), outboundDate=["2026-11-04"]), "INVALID_DATE"),
            (dict(handoff_selection(), outboundDate="2026-12-04"), "DATE_MONTH_MISMATCH"),
            (dict(round_trip(), outboundDate="2026-11-04"), "INVALID_DATE"),
            (dict(round_trip(), outboundDate="2026-11-04", returnDate="2026-11-08"), "DATE_MONTH_MISMATCH"),
            (dict(round_trip(), outboundDate="2026-11-04", returnMonth="2026-11",
                  returnDate="2026-11-03"), "INVALID_RETURN_DATE"),
            (dict(handoff_selection(), origin="ICN; unsafe"), "INVALID_AIRPORT"),
        ]
        for raw, code in cases:
            with self.subTest(raw=raw):
                with self.assertRaises(app.AppError) as raised:
                    app.validate_handoff_request(raw, TODAY)
                self.assertEqual(raised.exception.code, code)


class RouteCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / "config" / "award-routes.json"
        self.path.parent.mkdir()

    def write(self, value):
        self.path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def test_reads_static_file_and_preserves_directional_lists_without_fetching(self):
        value = synthetic_routes()
        self.write(value)
        with mock.patch.object(app.subprocess, "Popen", side_effect=AssertionError("No browser launch")):
            self.assertEqual(app.read_route_catalog(self.root), value)
        self.assertNotIn("JFK", app.read_route_catalog(self.root)["destinations"])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), value)

    def test_returns_only_documented_fields_and_trims_display_labels(self):
        value = synthetic_routes()
        value["internalNote"] = "not public API data"
        value["airports"][0].update(name="  서울/인천  ", extra="not returned")
        self.write(value)
        self.assertEqual(app.read_route_catalog(self.root), synthetic_routes())

    def test_empty_connections_are_valid_unknown_routes_without_inventing_pairs(self):
        value = synthetic_routes()
        value["destinations"] = {}
        self.write(value)
        result = app.read_route_catalog(self.root)
        self.assertEqual(result, value)
        self.assertEqual(result["destinations"], {})
        self.assertEqual(len(result["airports"]), 3)

    def test_missing_or_unreadable_file_is_a_safe_unavailable_error(self):
        for failure in (FileNotFoundError("private path"), PermissionError("private path")):
            with self.subTest(failure=type(failure).__name__):
                with mock.patch.object(Path, "open", side_effect=failure):
                    with self.assertRaises(app.AppError) as raised:
                        app.read_route_catalog(self.root)
                self.assertEqual(raised.exception.code, "ROUTES_UNAVAILABLE")
                self.assertEqual(raised.exception.status, 503)
                self.assertNotIn("private", raised.exception.message)

    def test_rejects_invalid_types_codes_duplicates_and_unknown_connections(self):
        mutations = [
            lambda value: value.update(sourceUrl="javascript:unsafe"),
            lambda value: value.update(sourceUrl="https://user:password@example.com/"),
            lambda value: value.update(retrievedAt="2026-09-07T03:00:00"),
            lambda value: value.update(airports=[]),
            lambda value: value["airports"].append(copy.deepcopy(value["airports"][0])),
            lambda value: value["airports"][0].update(code="icn"),
            lambda value: value["airports"][0].update(name=""),
            lambda value: value["airports"][0].update(region=42),
            lambda value: value["airports"].append("not an airport"),
            lambda value: value.update(destinations=[]),
            lambda value: value["destinations"].update(XXX=["ICN"]),
            lambda value: value["destinations"].update(ICN=["XXX"]),
            lambda value: value["destinations"].update(ICN="SIN"),
            lambda value: value["destinations"].update(ICN=[True]),
            lambda value: value["destinations"].update(ICN=["SIN", "SIN"]),
            lambda value: value["destinations"].update(ICN=["ICN"]),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(corruption=index):
                value = synthetic_routes()
                mutate(value)
                self.write(value)
                with self.assertRaises(app.AppError) as raised:
                    app.read_route_catalog(self.root)
                self.assertEqual(raised.exception.code, "ROUTES_INVALID")
                self.assertEqual(raised.exception.status, 503)

    def test_rejects_malformed_encoding_oversize_and_duplicate_json_keys(self):
        value = json.dumps(synthetic_routes())
        duplicate = value.replace('"ICN": ["SIN", "JFK"]', '"ICN": ["SIN"], "ICN": ["JFK"]')
        for content in (b"not JSON", b"\xff\xfe", b"[1,2,3]", duplicate.encode("utf-8"),
                        b" " * (app.ROUTE_CATALOG_LIMIT + 1)):
            with self.subTest(size=len(content)):
                self.path.write_bytes(content)
                with self.assertRaises(app.AppError) as raised:
                    app.read_route_catalog(self.root)
                self.assertEqual(raised.exception.code, "ROUTES_INVALID")


class TemporaryStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = app.CalendarStore(self.root)
        self.leg = app.legs_for(PARAMS)[0]
        self.clock = mock.patch.object(app, "utc_now", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        # Catch any accidental real collector invocation from these tests.
        self.subprocess_guard = mock.patch.object(app.subprocess, "Popen",
                                                  side_effect=AssertionError("External process forbidden in tests"))
        self.subprocess_guard.start()
        self.addCleanup(self.subprocess_guard.stop)

    def test_cache_preserves_original_source_and_collection_timestamps(self):
        value = synthetic_calendar(self.leg, NOW - timedelta(hours=2))
        self.store.save(value, self.leg)
        result = self.store.result(PARAMS)
        self.assertEqual(result["legs"][0]["calendar"], value)
        self.assertTrue(result["legs"][0]["cached"])
        self.assertFalse(result["legs"][0]["stale"])
        self.assertIsNone(result["legs"][0]["calendar"]["dates"][3]["availableSeatCount"])

    def test_newest_valid_cache_wins_without_rewriting_older_file(self):
        older = synthetic_calendar(self.leg, NOW - timedelta(hours=3))
        newer = synthetic_calendar(self.leg, NOW - timedelta(hours=1))
        self.store.save(older, self.leg)
        legacy = self.root / "data" / (app.cache_key(self.leg) + ".json")
        legacy.write_text(json.dumps(newer), encoding="utf-8")
        self.assertEqual(self.store.read(self.leg), newer)
        self.assertEqual(json.loads((self.store.directory / legacy.name).read_text()), older)
        legacy.write_text("not JSON", encoding="utf-8")
        self.assertEqual(self.store.read(self.leg), older)

    def test_rejects_corrupt_or_unverified_cache_instead_of_no_seats(self):
        corruptions = [
            lambda value: value.update(origin="JFK"),
            lambda value: value.update(source="UNKNOWN"),
            lambda value: value.update(collectedAt="2026-09-07T03:00:00"),
            lambda value: value["dates"].pop(),
            lambda value: value["dates"].__setitem__(1, copy.deepcopy(value["dates"][0])),
            lambda value: value["dates"][0].update(prestigeAward=0),
            lambda value: value["dates"][0].update(availableSeatCount=2),
        ]
        self.store.directory.mkdir(parents=True)
        path = self.store.directory / (app.cache_key(self.leg) + ".json")
        for index, corrupt in enumerate(corruptions):
            with self.subTest(corruption=index):
                value = synthetic_calendar(self.leg)
                corrupt(value)
                path.write_text(json.dumps(value), encoding="utf-8")
                result = self.store.result(PARAMS)
                self.assertEqual(result["state"], "missing")
                self.assertEqual(result["missing"], ["outbound"])
                self.assertIsNone(result["legs"][0]["calendar"])

    def test_stale_boundary_and_future_timestamp_do_not_count_as_fresh(self):
        for age, expected in [(timedelta(seconds=app.CACHE_SECONDS - 1), False),
                              (timedelta(seconds=app.CACHE_SECONDS), True),
                              (timedelta(seconds=-1), True)]:
            with self.subTest(age=age):
                self.assertEqual(self.store.stale(synthetic_calendar(self.leg, NOW - age)), expected)

    def test_atomic_write_failure_keeps_previous_valid_cache(self):
        old = synthetic_calendar(self.leg, NOW - timedelta(days=1))
        self.store.save(old, self.leg)
        with mock.patch.object(app.os, "replace", side_effect=OSError("synthetic disk failure")):
            with self.assertRaises(OSError):
                self.store.save(synthetic_calendar(self.leg), self.leg)
        self.assertEqual(self.store.read(self.leg), old)
        self.assertEqual(list(self.store.directory.glob("*.tmp")), [])

    def test_fresh_cache_makes_zero_new_queries_even_with_existing_restriction(self):
        self.store.save(synthetic_calendar(self.leg), self.leg)
        self.store.write_json(self.store.block_path, {"code": "ACCESS_RESTRICTED"})
        collector = mock.Mock(side_effect=AssertionError("Fresh cache must be used"))
        service = app.SearchService(self.store, collector)
        result = await_job(service, service.start(PARAMS))
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["result"]["legs"][0]["cached"])
        collector.assert_not_called()

    def test_all_reuses_existing_31_day_cache_without_an_all_award_field(self):
        params = dict(PARAMS, month="2026-12")
        leg = app.legs_for(params)[0]
        value = synthetic_calendar(leg)
        self.assertEqual(len(value["dates"]), 31)
        self.assertTrue(all("allAward" not in row for row in value["dates"]))
        self.store.save(value, leg)
        self.store.write_json(self.store.block_path, {"code": "ACCESS_RESTRICTED"})
        collector = mock.Mock(side_effect=AssertionError("Changing cabin must use the same cache"))
        service = app.SearchService(self.store, collector)
        for cabin in ("prestige", "all"):
            with self.subTest(cabin=cabin):
                request = dict(params, cabin=cabin)
                job = await_job(service, service.start(request))
                self.assertEqual(job["status"], "complete")
                self.assertEqual(job["result"]["params"]["cabin"], cabin)
                self.assertEqual(job["result"]["legs"][0]["calendar"], value)
                self.assertTrue(job["result"]["legs"][0]["cached"])
        collector.assert_not_called()
        self.assertEqual(sorted(path.name for path in self.store.directory.glob("*.json")),
                         [app.cache_key(leg) + ".json", "access-restricted.json"])
        # Selection aliases must not weaken the real award-marker checks.
        invalid = copy.deepcopy(value)
        del invalid["dates"][0]["premiumAward"]
        with self.assertRaises(ValueError):
            app.validate_calendar(invalid, leg)

    def test_one_explicit_query_saves_verified_result_and_later_uses_cache(self):
        value = synthetic_calendar(self.leg)
        collector = mock.Mock(return_value=value)
        service = app.SearchService(self.store, collector)
        first = await_job(service, service.start(PARAMS))
        self.assertEqual(first["status"], "complete")
        self.assertFalse(first["result"]["legs"][0]["cached"])
        self.assertEqual(self.store.read(self.leg), value)
        second = await_job(service, service.start(PARAMS))
        self.assertTrue(second["result"]["legs"][0]["cached"])
        collector.assert_called_once_with(self.leg)

    def test_round_trip_queries_reversed_inbound_once(self):
        params = round_trip()
        collector = mock.Mock(side_effect=synthetic_calendar)
        service = app.SearchService(self.store, collector)
        job = await_job(service, service.start(params))
        self.assertEqual(job["status"], "complete")
        self.assertEqual([call.args[0] for call in collector.call_args_list], app.legs_for(params))
        self.assertEqual(job["result"]["missing"], [])

    def test_outbound_failure_preserves_stale_cache_and_does_not_start_inbound(self):
        params = round_trip()
        old = synthetic_calendar(self.leg, NOW - timedelta(days=1))
        self.store.save(old, self.leg)
        collector = mock.Mock(side_effect=app.AppError("COLLECTION_FAILED", "synthetic failure"))
        service = app.SearchService(self.store, collector)
        job = await_job(service, service.start(params))
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["result"]["missing"], ["inbound"])
        self.assertEqual(job["result"]["legs"][0]["calendar"], old)
        self.assertTrue(job["result"]["legs"][0]["stale"])
        collector.assert_called_once_with(self.leg)

    def test_inbound_failure_keeps_new_outbound_and_old_inbound_without_fabricating_empty(self):
        params = round_trip()
        outbound, inbound = app.legs_for(params)
        old = synthetic_calendar(inbound, NOW - timedelta(days=1))
        self.store.save(old, inbound)
        collector = mock.Mock(side_effect=[synthetic_calendar(outbound),
                                          app.AppError("COLLECTION_FAILED", "synthetic inbound failure")])
        service = app.SearchService(self.store, collector)
        job = await_job(service, service.start(params))
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["result"]["missing"], [])
        self.assertFalse(job["result"]["legs"][0]["cached"])
        self.assertEqual(job["result"]["legs"][1]["calendar"], old)
        self.assertTrue(job["result"]["legs"][1]["stale"])

    def test_inbound_failure_without_previous_cache_is_missing_not_no_seats(self):
        params = round_trip()
        collector = mock.Mock(side_effect=[synthetic_calendar(self.leg),
                                          app.AppError("COLLECTION_FAILED", "synthetic inbound failure")])
        service = app.SearchService(self.store, collector)
        job = await_job(service, service.start(params))
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["result"]["missing"], ["inbound"])
        self.assertIsNone(job["result"]["legs"][1]["calendar"])
        self.assertEqual(self.store.read(self.leg), synthetic_calendar(self.leg))

    def test_bad_collector_result_does_not_overwrite_previous_cache(self):
        old = synthetic_calendar(self.leg, NOW - timedelta(days=1))
        self.store.save(old, self.leg)
        invalid = synthetic_calendar(self.leg)
        invalid["dates"].pop()
        service = app.SearchService(self.store, mock.Mock(return_value=invalid))
        job = await_job(service, service.start(PARAMS))
        self.assertEqual(job["status"], "failed")
        self.assertEqual(self.store.read(self.leg), old)
        self.assertEqual(job["result"]["legs"][0]["calendar"], old)

    def test_restrictions_persist_and_prevent_all_retries_including_after_restart(self):
        for code in sorted(app.RESTRICTIONS):
            with self.subTest(code=code):
                if self.store.block_path.exists():
                    self.store.block_path.unlink()
                collector = mock.Mock(side_effect=app.AppError(code, "synthetic restriction"))
                service = app.SearchService(self.store, collector)
                first = await_job(service, service.start(PARAMS))
                self.assertEqual(first["error"]["code"], code)
                self.assertTrue(self.store.block_path.is_file())
                second = await_job(service, service.start(PARAMS))
                self.assertEqual(second["error"]["code"], "ACCESS_RESTRICTED")
                restarted = app.SearchService(app.CalendarStore(self.root), collector)
                third = await_job(restarted, restarted.start(PARAMS))
                self.assertEqual(third["error"]["code"], "ACCESS_RESTRICTED")
                collector.assert_called_once_with(self.leg)

    def test_restriction_on_outbound_does_not_attempt_inbound(self):
        collector = mock.Mock(side_effect=app.AppError("ACCESS_RESTRICTED", "synthetic restriction"))
        service = app.SearchService(self.store, collector)
        job = await_job(service, service.start(round_trip()))
        self.assertEqual(job["result"]["missing"], ["outbound", "inbound"])
        collector.assert_called_once_with(self.leg)

    def test_restriction_still_finishes_and_blocks_retry_when_latch_file_cannot_be_written(self):
        collector = mock.Mock(side_effect=app.AppError("ACCESS_RESTRICTED", "synthetic restriction"))
        service = app.SearchService(self.store, collector)
        with mock.patch.object(self.store, "write_json", side_effect=OSError("synthetic full disk")):
            first = await_job(service, service.start(PARAMS))
            self.assertEqual(first["status"], "failed")
            self.assertEqual(first["error"]["code"], "ACCESS_RESTRICTED")
            second = await_job(service, service.start(PARAMS))
            self.assertEqual(second["status"], "failed")
            self.assertEqual(second["error"]["code"], "ACCESS_RESTRICTED")
        self.assertFalse(self.store.block_path.exists())
        collector.assert_called_once_with(self.leg)

    def test_concurrent_request_is_busy_and_does_not_create_second_job(self):
        entered, release = threading.Event(), threading.Event()

        def blocked_collector(leg):
            entered.set()
            if not release.wait(timeout=2):
                raise AssertionError("Test did not release mocked collector")
            return synthetic_calendar(leg)

        collector = mock.Mock(side_effect=blocked_collector)
        service = app.SearchService(self.store, collector)
        job_id = service.start(PARAMS)
        self.assertTrue(entered.wait(timeout=1))
        try:
            with self.assertRaises(app.AppError) as raised:
                service.start(PARAMS)
            self.assertEqual((raised.exception.code, raised.exception.status), ("BUSY", 409))
            self.assertEqual(len(service.jobs), 1)
        finally:
            release.set()
        self.assertEqual(await_job(service, job_id)["status"], "complete")
        collector.assert_called_once_with(self.leg)


    def test_handoff_ready_uses_shared_jobs_without_overwriting_calendar_cache(self):
        value = synthetic_calendar(self.leg)
        self.store.save(value, self.leg)
        handoff = mock.Mock(side_effect=handoff_result)
        service = app.SearchService(self.store, mock.Mock(), handoff)
        selection = handoff_selection()
        job = await_job(service, service.start_handoff(selection))
        self.assertEqual(job["status"], "complete")
        self.assertEqual(job["result"], handoff_result(selection))
        self.assertEqual(self.store.read(self.leg), value)
        handoff.assert_called_once_with(selection)
        service.collector.assert_not_called()

    def test_all_handoff_forwards_union_choice_unchanged(self):
        selection = dict(handoff_selection(), cabin="all")
        handoff = mock.Mock(side_effect=handoff_result)
        service = app.SearchService(self.store, mock.Mock(), handoff)
        job = await_job(service, service.start_handoff(selection))
        self.assertEqual(job["status"], "complete")
        self.assertEqual(job["result"], handoff_result(selection))
        handoff.assert_called_once_with(selection)
        service.collector.assert_not_called()

    def test_handoff_and_search_are_mutually_exclusive_during_automation(self):
        entered, release = threading.Event(), threading.Event()
        def blocked_handoff(selection):
            entered.set()
            self.assertTrue(release.wait(timeout=2))
            return handoff_result(selection)
        service = app.SearchService(self.store, mock.Mock(), blocked_handoff)
        job_id = service.start_handoff(handoff_selection())
        self.assertTrue(entered.wait(timeout=1))
        try:
            for start, params in ((service.start, PARAMS), (service.start_handoff, handoff_selection())):
                with self.assertRaises(app.AppError) as raised:
                    start(params)
                self.assertEqual((raised.exception.code, raised.exception.status), ("BUSY", 409))
            self.assertEqual(len(service.jobs), 1)
        finally:
            release.set()
        self.assertEqual(await_job(service, job_id)["status"], "complete")
        service.collector.assert_not_called()

    def test_handoff_cannot_start_while_search_is_running(self):
        entered, release = threading.Event(), threading.Event()
        def blocked_collector(leg):
            entered.set()
            self.assertTrue(release.wait(timeout=2))
            return synthetic_calendar(leg)
        handoff = mock.Mock()
        service = app.SearchService(self.store, blocked_collector, handoff)
        job_id = service.start(PARAMS)
        self.assertTrue(entered.wait(timeout=1))
        try:
            with self.assertRaises(app.AppError) as raised:
                service.start_handoff(handoff_selection())
            self.assertEqual(raised.exception.code, "BUSY")
        finally:
            release.set()
        self.assertEqual(await_job(service, job_id)["status"], "complete")
        handoff.assert_not_called()

    def test_handoff_restriction_blocks_both_automation_paths_after_restart(self):
        for code in sorted(app.RESTRICTIONS):
            with self.subTest(code=code):
                if self.store.block_path.exists():
                    self.store.block_path.unlink()
                handoff = mock.Mock(side_effect=app.AppError(code, "private child output"))
                collector = mock.Mock(side_effect=AssertionError("Restricted request must not run"))
                service = app.SearchService(self.store, collector, handoff)
                first = await_job(service, service.start_handoff(handoff_selection()))
                self.assertEqual(first["error"]["code"], code)
                self.assertNotIn("private child output", json.dumps(first))
                self.assertEqual(json.loads(self.store.block_path.read_text())["code"], code)
                for blocked in (service, app.SearchService(self.store, collector, handoff)):
                    with self.assertRaises(app.AppError) as raised:
                        blocked.start_handoff(handoff_selection())
                    self.assertEqual(raised.exception.code, "ACCESS_RESTRICTED")
                    job = await_job(blocked, blocked.start(PARAMS))
                    self.assertEqual(job["error"]["code"], "ACCESS_RESTRICTED")
                handoff.assert_called_once()
                collector.assert_not_called()

    def test_handoff_respects_latch_written_after_service_started(self):
        handoff = mock.Mock()
        service = app.SearchService(self.store, mock.Mock(), handoff)
        self.store.write_json(self.store.block_path, {"code": "ACCESS_RESTRICTED"})
        with self.assertRaises(app.AppError):
            service.start_handoff(handoff_selection())
        self.assertEqual(service.jobs, {})
        handoff.assert_not_called()

    def test_handoff_restriction_survives_disk_failure_in_memory(self):
        handoff = mock.Mock(side_effect=app.AppError("ACCESS_RESTRICTED", "sensitive output"))
        service = app.SearchService(self.store, mock.Mock(), handoff)
        with mock.patch.object(self.store, "write_json", side_effect=OSError("synthetic full disk")):
            job = await_job(service, service.start_handoff(handoff_selection()))
        self.assertEqual(job["error"]["code"], "ACCESS_RESTRICTED")
        with self.assertRaises(app.AppError):
            service.start_handoff(handoff_selection())
        handoff.assert_called_once()

    def test_handoff_failure_sanitizes_errors_keeps_cache_and_releases_busy(self):
        value = synthetic_calendar(self.leg)
        self.store.save(value, self.leg)
        for failure in (RuntimeError("private account stack"), app.AppError("CUSTOM_PRIVATE", "private token")):
            with self.subTest(failure=type(failure)):
                service = app.SearchService(self.store, mock.Mock(), mock.Mock(side_effect=failure))
                job = await_job(service, service.start_handoff(handoff_selection()))
                self.assertEqual(job["status"], "failed")
                self.assertEqual(job["error"]["code"], "HANDOFF_FAILED")
                self.assertNotIn("private", json.dumps(job))
                self.assertNotIn("result", job)
                self.assertFalse(service.restricted)
                self.assertIsNone(service.active)
                self.assertEqual(self.store.read(self.leg), value)

    def test_handoff_result_must_match_request_and_cannot_forward_private_messages(self):
        selection = handoff_selection()
        result = handoff_result(selection)
        result["message"] = "private account output"
        service = app.SearchService(self.store, mock.Mock(), mock.Mock(return_value=result))
        job = await_job(service, service.start_handoff(selection))
        self.assertEqual(job["result"], handoff_result(selection))
        for invalid in (None, dict(result, kind="calendar"), dict(result, stage="booked"),
                        dict(result, selection=dict(selection, outboundDate="2026-11-05"))):
            with self.subTest(invalid=invalid):
                service = app.SearchService(self.store, mock.Mock(), mock.Mock(return_value=invalid))
                job = await_job(service, service.start_handoff(selection))
                self.assertEqual(job["error"]["code"], "HANDOFF_FAILED")


class CollectorProcessContractTests(unittest.TestCase):
    """Validate the process boundary with a fully mocked process, never a browser."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        executable = self.root / "node_modules" / "tsx" / "dist" / "cli.mjs"
        executable.parent.mkdir(parents=True)
        executable.write_text("// synthetic placeholder; never executed\n", encoding="utf-8")
        self.leg = app.legs_for(PARAMS)[0]
        self.process = mock.Mock(returncode=0, pid=43210)
        self.process.communicate.return_value = (json.dumps({"calendar": synthetic_calendar(self.leg)}), "")
        self.popen_patch = mock.patch.object(app.subprocess, "Popen", return_value=self.process)
        self.popen = self.popen_patch.start()
        self.addCleanup(self.popen_patch.stop)
        self.node_patch = mock.patch.object(app.shutil, "which", return_value="/synthetic/node")
        self.node_patch.start()
        self.addCleanup(self.node_patch.stop)
        self.platform_patch = mock.patch.object(app, "is_windows", return_value=False)
        self.platform_patch.start()
        self.addCleanup(self.platform_patch.stop)
        self.kill_patch = mock.patch.object(app.os, "killpg", create=True)
        self.kill_patch.start()
        self.addCleanup(self.kill_patch.stop)

    def test_verified_process_output_is_returned_without_shell_interpolation(self):
        result = app.collect_leg(self.leg, self.root)
        self.assertEqual(result, synthetic_calendar(self.leg))
        self.assertEqual(self.popen.call_count, 1)
        arguments = self.popen.call_args.args[0]
        self.assertIsInstance(arguments, list)
        self.assertEqual(arguments[-7:], ["--origin", "ICN", "--destination", "SIN", "--month", "2026-11", "--hidden"])
        self.assertFalse(self.popen.call_args.kwargs.get("shell", False))

    def test_process_restriction_codes_reach_service_without_retry(self):
        self.process.returncode = 1
        for code in sorted(app.RESTRICTIONS):
            with self.subTest(code=code):
                self.process.communicate.return_value = ("", json.dumps({"code": code}))
                with self.assertRaises(app.AppError) as raised:
                    app.collect_leg(self.leg, self.root)
                self.assertEqual(raised.exception.code, code)
        self.assertEqual(self.popen.call_count, len(app.RESTRICTIONS))

    def test_non_string_process_error_code_is_controlled_failure(self):
        self.process.returncode = 1
        for code in ({"bad": "code"}, ["bad"], None, 403):
            with self.subTest(code=code):
                self.process.communicate.return_value = ("", json.dumps({"code": code}))
                with self.assertRaises(app.AppError) as raised:
                    app.collect_leg(self.leg, self.root)
                self.assertEqual(raised.exception.code, "COLLECTION_FAILED")

    def test_incomplete_success_output_is_invalid_instead_of_empty_availability(self):
        value = synthetic_calendar(self.leg)
        value["dates"].pop()
        self.process.communicate.return_value = (json.dumps({"calendar": value}), "")
        with self.assertRaises(app.AppError) as raised:
            app.collect_leg(self.leg, self.root)
        self.assertEqual(raised.exception.code, "INVALID_RESULT")

    def test_timeout_terminates_process_group_without_retrying_collection(self):
        self.process.communicate.side_effect = [app.subprocess.TimeoutExpired("synthetic", 180), ("", "")]
        with mock.patch.object(app.os, "killpg", create=True) as kill:
            with self.assertRaises(app.AppError) as raised:
                app.collect_leg(self.leg, self.root)
            self.assertEqual(raised.exception.code, "COLLECTION_TIMEOUT")
            kill.assert_called_once_with(self.process.pid, app.signal.SIGTERM)
        self.popen.assert_called_once()


class HandoffProcessContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for relative in ("node_modules/tsx/dist/cli.mjs", "scripts/open-airline.ts"):
            placeholder = self.root / relative
            placeholder.parent.mkdir(parents=True, exist_ok=True)
            placeholder.write_text("// synthetic, never executed", encoding="utf-8")
        self.process = mock.Mock(pid=45678)
        self.popen_patch = mock.patch.object(app.subprocess, "Popen", return_value=self.process)
        self.popen = self.popen_patch.start()
        self.addCleanup(self.popen_patch.stop)
        self.node_patch = mock.patch.object(app.shutil, "which", return_value="/synthetic/node")
        self.node_patch.start()
        self.addCleanup(self.node_patch.stop)
        self.platform_patch = mock.patch.object(app, "is_windows", return_value=False)
        self.platform_patch.start()
        self.addCleanup(self.platform_patch.stop)

    def test_ready_returns_without_waiting_or_killing_browser_and_reaps_asynchronously(self):
        selection = handoff_selection()
        with mock.patch.object(app, "read_handoff_status", return_value={"status": "ready", "stage": "date_selected", "selection": selection, "message": "private"}), \
             mock.patch.object(app.threading, "Thread") as thread, \
             mock.patch.object(app.os, "killpg", create=True) as kill:
            self.assertEqual(app.open_airline(selection, self.root), handoff_result(selection))
        self.assertEqual(self.popen.call_args.args[0], ["/synthetic/node", str(self.root / "node_modules/tsx/dist/cli.mjs"), str(self.root / "scripts/open-airline.ts")])
        self.assertFalse(self.popen.call_args.kwargs.get("shell", False))
        self.assertTrue(self.popen.call_args.kwargs["start_new_session"])
        self.assertEqual(self.popen.call_args.kwargs["stderr"], app.subprocess.DEVNULL)
        self.assertEqual(json.loads(self.process.stdin.write.call_args.args[0]), selection)
        self.process.stdin.close.assert_called_once()
        self.process.wait.assert_not_called()
        kill.assert_not_called()
        thread.assert_called_once_with(target=app.reap_handoff_process, args=(self.process,), daemon=True)
        thread.return_value.start.assert_called_once()

    def test_failure_restriction_and_unknown_status_cleanup_only_owned_process(self):
        for payload, expected in [({"status": "failed", "code": "ACCESS_RESTRICTED", "message": "private"}, "ACCESS_RESTRICTED"),
                                  ({"status": "failed", "code": ["unsafe"]}, "HANDOFF_FAILED"),
                                  ({"status": "ready", "stage": "booked"}, "HANDOFF_FAILED"),
                                  ({"status": "unexpected"}, "HANDOFF_FAILED")]:
            with self.subTest(payload=payload), \
                 mock.patch.object(app, "read_handoff_status", return_value=payload), \
                 mock.patch.object(app, "stop_handoff_process") as stop:
                with self.assertRaises(app.AppError) as raised:
                    app.open_airline(handoff_selection(), self.root)
                self.assertEqual(raised.exception.code, expected)
                self.assertNotIn("private", raised.exception.message)
                stop.assert_called_once_with(self.process)

    def test_all_handoff_process_keeps_all_in_stdin_and_checks_reported_choice(self):
        selection = dict(handoff_selection(), cabin="all")
        payload = {"status": "ready", "stage": "date_selected", "selection": selection}
        with mock.patch.object(app, "read_handoff_status", return_value=payload), \
             mock.patch.object(app.threading, "Thread"):
            self.assertEqual(app.open_airline(selection, self.root), handoff_result(selection))
        self.assertEqual(json.loads(self.process.stdin.write.call_args.args[0])["cabin"], "all")
        payload["selection"] = dict(selection, cabin="prestige")
        with mock.patch.object(app, "read_handoff_status", return_value=payload), \
             mock.patch.object(app, "stop_handoff_process") as stop:
            with self.assertRaises(app.AppError) as raised:
                app.open_airline(selection, self.root)
            self.assertEqual(raised.exception.code, "HANDOFF_FAILED")
            stop.assert_called_once_with(self.process)

    def test_ready_selection_allows_absent_unused_return_fields(self):
        selection = handoff_selection()
        reported = {key: value for key, value in selection.items() if value is not None}
        with mock.patch.object(app, "read_handoff_status", return_value={"status": "ready", "stage": "date_selected", "selection": reported}), \
             mock.patch.object(app.threading, "Thread"):
            self.assertEqual(app.open_airline(selection, self.root), handoff_result(selection))

    def test_mismatched_or_missing_ready_selection_is_failed_and_cleaned(self):
        selection = handoff_selection()
        for reported in (None, {}, dict(selection, destination="LAX"), dict(selection, cabin="economy"),
                         dict(selection, outboundDate="2026-11-05"), dict(selection, returnDate="2026-11-08"),
                         dict(selection, returnMonth="2026-12")):
            with self.subTest(reported=reported), \
                 mock.patch.object(app, "read_handoff_status", return_value={"status": "ready", "stage": "date_selected", "selection": reported}), \
                 mock.patch.object(app, "stop_handoff_process") as stop:
                with self.assertRaises(app.AppError) as raised:
                    app.open_airline(selection, self.root)
                self.assertEqual(raised.exception.code, "HANDOFF_FAILED")
                stop.assert_called_once_with(self.process)

    def test_unhashable_stage_is_a_controlled_failure_and_cleans_child(self):
        for stage in ([], {}):
            with self.subTest(stage=stage), \
                 mock.patch.object(app, "read_handoff_status", return_value={"status": "ready", "stage": stage, "selection": handoff_selection()}), \
                 mock.patch.object(app, "stop_handoff_process") as stop:
                with self.assertRaises(app.AppError) as raised:
                    app.open_airline(handoff_selection(), self.root)
                self.assertEqual(raised.exception.code, "HANDOFF_FAILED")
                stop.assert_called_once_with(self.process)

    def test_timeout_cleans_owned_process_and_reports_controlled_message(self):
        with mock.patch.object(app, "read_handoff_status", side_effect=app.handoff_error("HANDOFF_TIMEOUT")), \
             mock.patch.object(app, "stop_handoff_process") as stop:
            with self.assertRaises(app.AppError) as raised:
                app.open_airline(handoff_selection(), self.root)
            self.assertEqual(raised.exception.code, "HANDOFF_TIMEOUT")
            stop.assert_called_once_with(self.process)
        self.popen.assert_called_once()

    def test_broken_input_pipe_is_cleaned_and_does_not_expose_raw_error(self):
        self.process.stdin.write.side_effect = BrokenPipeError("private executable path")
        with mock.patch.object(app, "stop_handoff_process") as stop:
            with self.assertRaises(app.AppError) as raised:
                app.open_airline(handoff_selection(), self.root)
        self.assertEqual(raised.exception.code, "HANDOFF_FAILED")
        self.assertNotIn("private", raised.exception.message)
        self.process.stdin.close.assert_called_once()
        stop.assert_called_once_with(self.process)

    def test_process_group_stop_escalates_and_reaps_only_this_child(self):
        self.process.wait.side_effect = [app.subprocess.TimeoutExpired("synthetic", 5), 0]
        with mock.patch.object(app.os, "killpg", create=True) as kill:
            app.stop_handoff_process(self.process)
        self.assertEqual(kill.call_args_list, [mock.call(self.process.pid, app.signal.SIGTERM), mock.call(self.process.pid, getattr(app.signal, "SIGKILL", 9))])
        self.assertEqual(self.process.wait.call_args_list, [mock.call(timeout=5), mock.call(timeout=5)])
        self.process.stdout.close.assert_called_once()

    def test_already_exited_process_is_still_reaped(self):
        with mock.patch.object(app.os, "killpg", side_effect=ProcessLookupError(), create=True):
            app.stop_handoff_process(self.process)
        self.process.wait.assert_called_once_with(timeout=5)
        self.process.stdout.close.assert_called_once()

    def test_success_reaper_drains_without_retaining_child_output(self):
        self.process.stdout = io.BytesIO(b"discarded output after ready\n")
        app.reap_handoff_process(self.process)
        self.process.wait.assert_called_once_with()
        self.assertTrue(self.process.stdout.closed)


class HandoffStatusChildTests(unittest.TestCase):
    """Only synthetic Python children; no browser, Node, or airline connection."""
    def child(self, code):
        process = subprocess.Popen([sys.executable, "-u", "-c", code],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL,
                                   env=dict(os.environ, PYTHONIOENCODING="utf-8"),
                                   **app.process_creation_options())
        self.addCleanup(app.stop_handoff_process, process)
        return process

    def test_ready_utf8_line_returns_while_child_remains_open(self):
        expected = {"status": "ready", "stage": "date_selected", "message": "조회 완료"}
        code = "import json,time; print(json.dumps(%r, ensure_ascii=False), flush=True); time.sleep(60)" % expected
        process = self.child(code)
        self.assertEqual(app.read_handoff_status(process, timeout=3), expected)
        self.assertIsNone(process.poll())

    def test_partial_line_waits_for_completion_without_waiting_for_child_exit(self):
        expected = {"status": "ready", "stage": "date_selected"}
        line = json.dumps(expected)
        code = ("import sys,time; sys.stdout.write(%r); sys.stdout.flush(); time.sleep(.05); "
                "sys.stdout.write(%r); sys.stdout.flush(); time.sleep(60)") % (line[:8], line[8:] + "\n")
        process = self.child(code)
        self.assertEqual(app.read_handoff_status(process, timeout=3), expected)
        self.assertIsNone(process.poll())

    def test_failed_status_is_read_without_waiting_for_failed_helper_to_close(self):
        expected = {"status": "failed", "code": "FILTER_FAILED"}
        process = self.child("import time; print(%r, flush=True); time.sleep(60)" % json.dumps(expected))
        self.assertEqual(app.read_handoff_status(process, timeout=3), expected)
        self.assertIsNone(process.poll())

    def test_no_output_and_unfinished_line_timeout_and_reader_finishes_after_cleanup(self):
        for output in ("", '{"status":"ready"}'):
            with self.subTest(output=output):
                process = self.child("import sys,time; sys.stdout.write(%r); sys.stdout.flush(); time.sleep(60)" % output)
                started = time.monotonic()
                with self.assertRaises(app.AppError) as raised:
                    app.read_handoff_status(process, timeout=0.1)
                self.assertEqual(raised.exception.code, "HANDOFF_TIMEOUT")
                self.assertLess(time.monotonic() - started, 2)
                app.stop_handoff_process(process)
                self.assertIsNotNone(process.poll())
                self.assertFalse(process._handoff_reader_thread.is_alive())

    def test_eof_invalid_utf8_json_and_oversized_live_output_fail_without_hanging(self):
        for content in (b"", b"not-json\n", b"[]\n", b"\xff\n", b"x" * (app.HANDOFF_STATUS_LIMIT + 1)):
            with self.subTest(size=len(content)):
                # The oversized writer stays alive: the byte limit, not EOF,
                # must stop parsing its output.
                code = "import sys,time; sys.stdout.buffer.write(%r); sys.stdout.flush(); %s" % (content, "time.sleep(60)" if len(content) > app.HANDOFF_STATUS_LIMIT else "pass")
                process = self.child(code)
                with self.assertRaises(app.AppError) as raised:
                    app.read_handoff_status(process, timeout=3)
                self.assertEqual(raised.exception.code, "HANDOFF_FAILED")


class WindowsProcessCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.platform_patch = mock.patch.object(app, "is_windows", return_value=True)
        self.platform_patch.start()
        self.addCleanup(self.platform_patch.stop)
        self.process = mock.Mock(pid=54321, returncode=0)

    def test_windows_launch_uses_own_group_without_posix_flag(self):
        options = app.process_creation_options()
        self.assertEqual(options, {"creationflags": getattr(app.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)})
        self.assertNotIn("start_new_session", options)

    def test_windows_cleanup_targets_only_owned_pid_and_its_descendants(self):
        with mock.patch.object(app.subprocess, "run") as run, \
             mock.patch.object(app.os, "killpg", create=True) as killpg:
            app.stop_owned_process(self.process)
        self.assertEqual(run.call_args.args[0], ["taskkill", "/PID", "54321", "/T", "/F"])
        self.assertNotIn("/IM", run.call_args.args[0])
        self.assertNotIn("chrome", " ".join(run.call_args.args[0]).lower())
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        self.assertEqual(run.call_args.kwargs["timeout"], 10)
        self.process.wait.assert_called_once_with(timeout=5)
        killpg.assert_not_called()

    def test_unavailable_taskkill_falls_back_only_to_owned_child(self):
        for failure in (OSError("synthetic taskkill unavailable"), app.subprocess.TimeoutExpired("taskkill", 10)):
            with self.subTest(failure=type(failure)):
                self.process.reset_mock()
                with mock.patch.object(app.subprocess, "run", side_effect=failure):
                    app.stop_owned_process(self.process)
                self.process.kill.assert_called_once_with()
                self.process.wait.assert_called_once_with(timeout=5)

    def test_cleanup_reaps_after_forced_kill_if_first_wait_times_out(self):
        self.process.wait.side_effect = [app.subprocess.TimeoutExpired("synthetic", 5), 0]
        with mock.patch.object(app.subprocess, "run"):
            app.stop_owned_process(self.process)
        self.process.kill.assert_called_once_with()
        self.assertEqual(self.process.wait.call_args_list, [mock.call(timeout=5), mock.call(timeout=5)])

    def test_nonpositive_pid_never_triggers_a_system_cleanup_command(self):
        for pid in (0, -1, True, "54321"):
            with self.subTest(pid=pid), mock.patch.object(app.subprocess, "run") as run:
                self.process.pid = pid
                with self.assertRaises(ValueError):
                    app.stop_owned_process(self.process)
                run.assert_not_called()

    def test_windows_collector_timeout_uses_tree_cleanup_and_utf8(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tsx = root / "node_modules" / "tsx" / "dist" / "cli.mjs"
            tsx.parent.mkdir(parents=True)
            tsx.write_text("// never run", encoding="utf-8")
            self.process.communicate.side_effect = [app.subprocess.TimeoutExpired("synthetic", 180), ("", "")]
            with mock.patch.object(app.shutil, "which", return_value="C:/synthetic/node.exe"), \
                 mock.patch.object(app.subprocess, "Popen", return_value=self.process) as popen, \
                 mock.patch.object(app.subprocess, "run") as run:
                with self.assertRaises(app.AppError) as raised:
                    app.collect_leg(app.legs_for(PARAMS)[0], root)
            self.assertEqual(raised.exception.code, "COLLECTION_TIMEOUT")
            self.assertEqual(popen.call_args.kwargs["encoding"], "utf-8")
            self.assertEqual(popen.call_args.kwargs["errors"], "replace")
            self.assertNotIn("start_new_session", popen.call_args.kwargs)
            self.assertEqual(popen.call_args.kwargs["creationflags"], app.process_creation_options()["creationflags"])
            self.assertEqual(run.call_args.args[0], ["taskkill", "/PID", "54321", "/T", "/F"])

    def test_windows_handoff_success_keeps_browser_open_and_failure_cleans_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ("node_modules/tsx/dist/cli.mjs", "scripts/open-airline.ts"):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("// never run", encoding="utf-8")
            selection = handoff_selection()
            for payload, failed in (({"status": "ready", "stage": "date_selected", "selection": selection}, False),
                                    ({"status": "failed", "code": "FILTER_FAILED"}, True)):
                with self.subTest(failed=failed), \
                     mock.patch.object(app.shutil, "which", return_value="C:/synthetic/node.exe"), \
                     mock.patch.object(app.subprocess, "Popen", return_value=self.process) as popen, \
                     mock.patch.object(app.subprocess, "run") as run, \
                     mock.patch.object(app, "read_handoff_status", return_value=payload), \
                     mock.patch.object(app.threading.Thread, "start"):
                    if failed:
                        with self.assertRaises(app.AppError) as raised:
                            app.open_airline(selection, root)
                        self.assertEqual(raised.exception.code, "FILTER_FAILED")
                        run.assert_called_once()
                    else:
                        self.assertEqual(app.open_airline(selection, root), handoff_result(selection))
                        run.assert_not_called()
                    self.assertNotIn("start_new_session", popen.call_args.kwargs)
                    self.assertEqual(popen.call_args.kwargs["creationflags"], app.process_creation_options()["creationflags"])


class HttpBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.collector = mock.Mock(side_effect=AssertionError("Read-only HTTP must not collect"))
        cls.service = app.SearchService(app.CalendarStore(cls.temporary.name), cls.collector)
        cls.server = app.LocalServer(("127.0.0.1", 0), cls.service)
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port
        cls.origin = "http://127.0.0.1:%d" % cls.port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temporary.cleanup()

    def setUp(self):
        self.collector.reset_mock()
        self.config_date = mock.patch.object(app, "month_bounds", return_value=app.month_bounds(TODAY))
        self.config_date.start()
        self.addCleanup(self.config_date.stop)

    def request(self, method, path, payload=None, headers=None):
        request_headers = dict(headers or {})
        body = None if payload is None else json.dumps(payload)
        if payload is not None:
            request_headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            connection.close()

    def test_read_only_gets_do_not_query_airline(self):
        for path in ("/api/health", "/api/config", "/api/cache?" + urlencode(PARAMS)):
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(body["state"], "missing")
        self.collector.assert_not_called()

    def test_routes_get_returns_validated_local_catalogue_with_existing_response_protections(self):
        path = Path(self.temporary.name) / "config" / "award-routes.json"
        path.parent.mkdir(exist_ok=True)
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        value = synthetic_routes()
        path.write_text(json.dumps(value), encoding="utf-8")
        # URL parameters cannot redirect this reader to a different file or site.
        status, headers, body = self.request("GET", "/api/routes?file=../../local_app.py")
        self.assertEqual(status, 200)
        self.assertEqual(body, value)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.collector.assert_not_called()
        self.assertIsNone(self.service.active)

    def test_missing_or_corrupt_catalogue_returns_json_and_other_gets_still_work(self):
        path = Path(self.temporary.name) / "config" / "award-routes.json"
        path.parent.mkdir(exist_ok=True)
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        path.unlink(missing_ok=True)
        for content, expected in ((None, "ROUTES_UNAVAILABLE"), ("invalid JSON", "ROUTES_INVALID")):
            with self.subTest(expected=expected):
                if content is not None:
                    path.write_text(content, encoding="utf-8")
                status, headers, body = self.request("GET", "/api/routes")
                self.assertEqual(status, 503)
                self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
                self.assertEqual(body["error"]["code"], expected)
                self.assertEqual(self.request("GET", "/api/health")[0], 200)
                self.assertEqual(self.request("GET", "/api/cache?" + urlencode(PARAMS))[0], 200)
        self.collector.assert_not_called()

    def test_route_catalogue_keeps_local_host_and_cross_site_protection(self):
        for headers in ({"Host": "example.com:%d" % self.port}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, _, body = self.request("GET", "/api/routes", headers=headers)
                self.assertEqual(status, 403)
                self.assertEqual(body["error"]["code"], "LOCAL_ONLY")
        self.collector.assert_not_called()

    def test_external_host_and_cross_site_get_are_rejected(self):
        for headers in ({"Host": "example.com:%d" % self.port},
                        {"Host": "127.0.0.1.example.com:%d" % self.port},
                        {"Host": "127.0.0.1"}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, _, body = self.request("GET", "/api/health", headers=headers)
                self.assertEqual(status, 403)
                self.assertEqual(body["error"]["code"], "LOCAL_ONLY")
        self.collector.assert_not_called()

    def test_post_requires_exact_local_origin(self):
        for headers in ({}, {"Origin": "https://example.com"},
                        {"Origin": "null"}, {"Origin": self.origin + ".example.com"},
                        {"Origin": self.origin, "Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, _, body = self.request("POST", "/api/search", PARAMS, headers)
                self.assertEqual(status, 403)
                self.assertEqual(body["error"]["code"], "LOCAL_ONLY")
        self.collector.assert_not_called()

    def test_file_traversal_and_unknown_routes_never_serve_files(self):
        for path in ("/../local_app.py", "/%2e%2e/local_app.py", "/data/test.json",
                     "/etc/passwd", "/api/jobs/../../local_app.py"):
            with self.subTest(path=path):
                status, _, body = self.request("GET", path)
                self.assertEqual(status, 404)
                self.assertEqual(body["error"]["code"], "NOT_FOUND")
        self.collector.assert_not_called()

    def test_post_input_validation_prevents_job_creation(self):
        for payload, headers, expected in [
            (PARAMS, {"Content-Type": "text/plain"}, 415),
            (dict(PARAMS, origin="../"), {}, 400),
            (dict(PARAMS, unexpected="x" * 5000), {}, 400),
        ]:
            with self.subTest(expected=expected, headers=headers):
                headers = dict(headers, Origin=self.origin)
                status, _, _ = self.request("POST", "/api/search", payload, headers)
                self.assertEqual(status, expected)
        self.collector.assert_not_called()
        self.assertIsNone(self.service.active)

    def test_valid_same_origin_post_only_starts_the_explicit_job(self):
        with mock.patch.object(self.service, "start", return_value="a" * 32) as start:
            status, _, body = self.request("POST", "/api/search", PARAMS, {"Origin": self.origin})
            self.assertEqual(status, 202)
            self.assertEqual(body, {"jobId": "a" * 32})
            start.assert_called_once_with(PARAMS)
        self.collector.assert_not_called()


    def test_handoff_post_requires_local_origin_and_valid_selected_dates(self):
        with mock.patch.object(self.service, "start_handoff") as start:
            for payload, headers, expected in [
                (handoff_selection(), {}, 403),
                (PARAMS, {"Origin": self.origin}, 400),
                (dict(handoff_selection(), outboundDate="2026-12-04"), {"Origin": self.origin}, 400),
                (dict(round_trip(), outboundDate="2026-11-04"), {"Origin": self.origin}, 400),
            ]:
                with self.subTest(expected=expected, payload=payload):
                    status, _, _ = self.request("POST", "/api/open-airline", payload, headers)
                    self.assertEqual(status, expected)
            start.assert_not_called()

    def test_explicit_handoff_post_forwards_only_validated_selection(self):
        with mock.patch.object(self.service, "start_handoff", return_value="b" * 32) as start:
            status, _, body = self.request("POST", "/api/open-airline", dict(handoff_selection(), extra="ignored"), {"Origin": self.origin})
            self.assertEqual(status, 202)
            self.assertEqual(body, {"jobId": "b" * 32})
            start.assert_called_once_with(handoff_selection())
        self.collector.assert_not_called()

    def test_all_choice_is_accepted_by_cache_search_and_handoff_endpoints(self):
        params = dict(PARAMS, cabin="all")
        status, _, body = self.request("GET", "/api/cache?" + urlencode(params))
        self.assertEqual(status, 200)
        self.assertEqual(body["params"]["cabin"], "all")
        with mock.patch.object(self.service, "start", return_value="c" * 32) as start:
            status, _, _ = self.request("POST", "/api/search", params, {"Origin": self.origin})
            self.assertEqual(status, 202)
            start.assert_called_once_with(params)
        selection = dict(handoff_selection(), cabin="all")
        with mock.patch.object(self.service, "start_handoff", return_value="d" * 32) as start:
            status, _, _ = self.request("POST", "/api/open-airline", selection, {"Origin": self.origin})
            self.assertEqual(status, 202)
            start.assert_called_once_with(selection)
        self.collector.assert_not_called()

    def test_sas_receipts_are_same_origin_only_and_reject_invalid_results(self):
        status, _, body = self.request("GET", "/api/sas-results")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"results": []})
        status, _, _ = self.request("POST", "/api/sas-results", {"status": "empty"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("POST", "/api/sas-results", {"status": "empty"}, {"Origin": self.origin})
        self.assertEqual(status, 404)
        self.assertEqual(self.server.sas_store.list(), [])

    def test_account_page_requires_same_origin_post(self):
        with mock.patch.object(app, "open_account_page") as launch:
            for method, headers in [("GET", {}), ("POST", {}), ("POST", {"Origin": "https://example.com"})]:
                status, _, _ = self.request(method, "/api/open-account", {"program": "korean-air"}, headers)
                self.assertIn(status, (403, 404))
            launch.assert_not_called()

    def test_account_page_opens_only_allowlisted_url(self):
        with mock.patch.object(app.sys, "platform", "darwin"), mock.patch.object(app.subprocess, "Popen") as launch:
            launch.return_value.wait.return_value = 0
            status, _, body = self.request("POST", "/api/open-account", {"program": "korean-air", "url": "https://example.com"}, {"Origin": self.origin})
            self.assertEqual(status, 200)
            self.assertEqual(launch.call_args.args[0], ["open", "-a", "Google Chrome", app.ACCOUNT_PAGES["korean-air"]])
            self.assertNotIn("loggedIn", body)
            launch.reset_mock()
            for payload in ({"program": "unknown"}, {"program": []}, []):
                status, _, _ = self.request("POST", "/api/open-account", payload, {"Origin": self.origin})
                self.assertEqual(status, 400)
            launch.assert_not_called()

    def test_handoff_cannot_be_triggered_by_get(self):
        with mock.patch.object(self.service, "start_handoff") as start:
            status, _, _ = self.request("GET", "/api/open-airline?" + urlencode(handoff_selection()))
            self.assertEqual(status, 404)
            start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
