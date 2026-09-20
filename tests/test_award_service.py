import tempfile
import unittest
from pathlib import Path
from datetime import date
from types import SimpleNamespace
from unittest.mock import Mock
from award_service import plan, month_days, AwardService
from sas_service import SasError

TODAY=date(2026,9,10)
def query(**kw):
    q=dict(program='asiana-club',origin='ICN',destination='NRT',month='2026-11',tripType='ONE_WAY',cabin='all');q.update(kw);return q

class MonthPlanTests(unittest.TestCase):
    def test_year_boundary_and_horizon(self):
        self.assertEqual(len(month_days('2027-01',TODAY)),31)
        self.assertEqual(month_days('2026-09',TODAY)[0],'2026-09-10')
        self.assertEqual(month_days('2027-09',TODAY)[-1],'2027-09-04')
        with self.assertRaises(SasError):month_days('2027-10',TODAY)
    def test_roundtrip_reverses_route(self):
        p,legs=plan(query(tripType='ROUND_TRIP',returnMonth='2026-12'),TODAY)
        self.assertEqual((legs[1]['origin'],legs[1]['destination']),('NRT','ICN'))
        self.assertEqual(sum(len(l['days']) for l in legs),61)
    def test_skyteam_requires_roundtrip_and_documents_reference_dates(self):
        with self.assertRaisesRegex(SasError,'ROUND_TRIP_REQUIRED'):plan(query(program='skyteam'),TODAY)
        p,legs=plan(query(program='skyteam',tripType='ROUND_TRIP',returnMonth='2026-11'),TODAY)
        self.assertEqual(legs[0]['referenceDate'],'2026-11-30')
        self.assertEqual(legs[1]['referenceDate'],'2026-11-01')
        self.assertEqual(legs[1]['days'][0]['date'],'2026-11-02')
    def test_unsupported_cabin_is_not_reported_empty(self):
        with self.assertRaises(SasError):plan(query(cabin='first'),TODAY)

class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.service=AwardService(self.tmp.name,SimpleNamespace(thread=None),interval=0)
        self.service.worker=Mock()
    def job(self,program='asiana-club'):
        p,legs=plan(query(program=program),TODAY)
        return dict(params=p,legs=legs,status='running',completed=0,total=30,code=None)
    def test_incomplete_calendar_keeps_missing_dates_unsearched(self):
        job=self.job();self.service.worker.call.return_value=dict(origin='ICN',destination='NRT',month='2026-11',status='complete',observedAt='2026-09-10T00:00:00Z',days=[dict(date='2026-11-01',status='empty',cabins=[],flights=[])])
        self.service._run(job)
        self.assertEqual(job['status'],'partial');self.assertEqual(job['completed'],1)
        self.assertEqual(job['legs'][0]['days'][1]['status'],'unsearched')
    def test_failed_search_is_not_empty(self):
        job=self.job('star-alliance')
        def stream(action,queries=None,**kwargs):
            if action=='cancel':return {'state':'cancelled'}
            q={k:queries[0][k] for k in ('origin','destination','date')}
            kwargs['on_event']({'type':'result','query':q,'result':{'status':'failed','code':'ACCESS_RESTRICTED'}})
            return {'status':'failed','code':'ACCESS_RESTRICTED'}
        self.service.worker.call.side_effect=stream
        self.service._run(job)
        self.assertEqual(job['status'],'failed');self.assertEqual(job['completed'],0)
        self.assertEqual(job['legs'][0]['days'][0]['status'],'failed')
        self.assertEqual(job['legs'][0]['days'][1]['status'],'unsearched')
    def test_wrong_route_result_is_rejected(self):
        job=self.job('star-alliance')
        def stream(action,queries=None,**kwargs):
            if action=='cancel':return {'state':'cancelled'}
            q={k:queries[0][k] for k in ('origin','destination','date')}
            kwargs['on_event']({'type':'result','query':q,'result':dict(q,origin='LAX',status='available')})
            return {'status':'complete'}
        self.service.worker.call.side_effect=stream
        self.service._run(job);self.assertEqual(job['code'],'QUERY_MISMATCH')
    def test_cancelling_another_program_does_not_stop_active_job(self):
        self.assertEqual(self.service.cancel('skyteam'),{'status':'idle'})
        self.assertFalse(self.service.stop.is_set())
    def test_sas_roundtrip_searches_every_day_with_reversed_route(self):
        from test_sas_store import sample
        p,legs=plan(query(program='sas-eurobonus',tripType='ROUND_TRIP',returnMonth='2026-11'),TODAY)
        job=dict(params=p,legs=legs,status='running',completed=0,total=60,code=None)
        self.service.sas=SimpleNamespace(worker=Mock(),store=Mock())
        def search(action,queries,timeout,on_event):
            self.assertEqual(action,'search-month')
            for q in reversed(queries):
                result=sample();result.update(q,freshSearch=True)
                on_event({'type':'searching','query':q})
                on_event({'type':'result','query':q,'result':result})
            return {'status':'complete'}
        self.service.sas.worker.call.side_effect=search
        self.service._run(job)
        self.assertEqual(job['status'],'complete')
        self.assertEqual(job['completed'],60)
        self.assertEqual(self.service.sas.worker.call.call_args_list[1].args[1][0],dict(origin='NRT',destination='ICN',date='2026-11-01'))
        self.assertEqual(job['legs'][1]['days'][0]['flights'][0]['cabin'],'business')

class LoginConfirmationTests(unittest.TestCase):
    def test_confirmation_uses_selected_profile_and_does_not_start_search(self):
        sas=SimpleNamespace(thread=None,worker=Mock())
        service=AwardService('.',sas)
        service.worker=Mock()
        sas.worker.call.return_value={'state':'ready','authenticated':True}
        service.worker.call.return_value={'state':'login_required'}
        self.assertTrue(service.confirm_login('sas-eurobonus')['browser']['authenticated'])
        sas.worker.call.assert_called_once_with('confirm-login',timeout=75,program='sas-eurobonus')
        self.assertEqual(service.confirm_login('korean-air')['browser']['state'],'login_required')
        service.worker.call.assert_called_once_with('confirm-login',timeout=75,program='korean-air')
        self.assertEqual(service.jobs,{})
        service.thread=Mock()
        service.thread.is_alive.return_value=True
        with self.assertRaisesRegex(SasError,'BUSY'):service.confirm_login('sas-eurobonus')

class SasMonthFailureTests(ProgressTests):
    def test_stream_failure_preserves_finished_dates_and_does_not_mark_rest_empty(self):
        from test_sas_store import sample
        job=self.job('sas-eurobonus')
        self.service.sas=SimpleNamespace(worker=Mock(),store=Mock())
        def stream(action,queries=None,timeout=180,on_event=None):
            if action=='cancel':return {'state':'cancelled'}
            first=sample();first.update(queries[0],freshSearch=True)
            on_event({'type':'result','query':queries[0],'result':first})
            on_event({'type':'searching','query':queries[1]})
            on_event({'type':'result','query':queries[1],'result':{'status':'failed','code':'ACCESS_RESTRICTED'}})
            on_event({'type':'searching','query':queries[2]})
            return {'status':'failed','code':'ACCESS_RESTRICTED'}
        self.service.sas.worker.call.side_effect=stream
        self.service._run(job)
        self.assertEqual(job['code'],'ACCESS_RESTRICTED')
        self.assertEqual(job['completed'],1)
        self.assertEqual(job['legs'][0]['days'][1]['status'],'failed')
        self.assertEqual(job['legs'][0]['days'][2]['status'],'unsearched')


class BookingPreferenceTests(unittest.TestCase):
    """The family's membership numbers steer whose miles are spent and who
    flies, so a malformed one must be dropped rather than clicked blindly."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.service = AwardService(self.tmp.name, SimpleNamespace(thread=None), interval=0)
        self.service.worker = Mock()

    def write(self, text):
        path = Path(self.tmp.name) / "data" / "local"
        path.mkdir(parents=True, exist_ok=True)
        (path / "asiana-booking.json").write_text(text, encoding="utf-8")

    def test_missing_file_selects_nothing_rather_than_failing(self):
        self.assertEqual(self.service.booking_preferences(), {})

    def test_unreadable_file_selects_nothing(self):
        self.write("{ not json")
        self.assertEqual(self.service.booking_preferences(), {})
        self.write('["a list, not settings"]')
        self.assertEqual(self.service.booking_preferences(), {})

    def test_reads_membership_numbers_for_miles_and_boarding(self):
        self.write('{"deductFrom":["111111111"],"boarding":["222222222"]}')
        self.assertEqual(self.service.booking_preferences(),
                         {"deductFrom": ["111111111"], "boarding": ["222222222"]})

    def test_drops_anything_that_is_not_a_membership_number(self):
        self.write('{"deductFrom":["111111111","mile_1 OR 1=1","12","  "],"boarding":[]}')
        # A junk entry must not survive into a selector, and an empty list must
        # not appear as a key that means "select these".
        self.assertEqual(self.service.booking_preferences(), {"deductFrom": ["111111111"]})

    def test_book_never_reports_held_when_the_hold_failed(self):
        self.service.worker.call.return_value = {
            "status": "available", "flights": ["OZ102 22,500마일"],
            "held": False, "holdFailure": "BOOKING_PAGE_TIMEOUT"}
        result = self.service.book(
            {"program": "asiana-club", "origin": "ICN", "destination": "NRT",
             "date": "2026-12-10", "account": "default"}, {"adults": 2})
        self.assertFalse(result["held"])
        self.assertEqual(result["holdFailure"], "BOOKING_PAGE_TIMEOUT")
        self.assertEqual(result["openedIn"], "app-partial")

    def test_book_asks_for_every_seat_the_party_needs(self):
        self.service.worker.call.return_value = {"status": "available", "held": True}
        self.service.book(
            {"program": "asiana-club", "origin": "ICN", "destination": "NRT",
             "date": "2026-12-10", "account": "default"}, {"adults": 2})
        sent = self.service.worker.call.call_args[0][1]
        self.assertEqual(sent["adults"], 2)
        self.assertEqual(sent["cabin"], "business")

    def test_book_ignores_an_implausible_party_size(self):
        self.service.worker.call.return_value = {"status": "available", "held": True}
        for bad in (0, 9, "2", None):
            self.service.book(
                {"program": "asiana-club", "origin": "ICN", "destination": "NRT",
                 "date": "2026-12-10", "account": "default"}, {"adults": bad})
            self.assertNotIn("adults", self.service.worker.call.call_args[0][1])
