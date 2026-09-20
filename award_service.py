"""Month plans and explicit per-day progress for local airline searches."""
import calendar
import copy
import json
import re
import threading
from datetime import date,timedelta,datetime,timezone
from pathlib import Path
from sas_service import SasWorker,SasError
from sas_store import validated

PROGRAMS=('sas-eurobonus','asiana-club','skyteam','star-alliance')
CABINS=('all','economy','premium economy','business','first')

def month_days(month,today=None):
    today=today or date.today()
    if not isinstance(month,str) or not re.fullmatch(r'\d{4}-\d{2}',month):raise SasError('INVALID_QUERY')
    try:
        first=date.fromisoformat(month+'-01')
        days=[first+timedelta(days=i) for i in range(calendar.monthrange(first.year,first.month)[1])]
    except ValueError:raise SasError('INVALID_QUERY')
    days=[d.isoformat() for d in days if today<=d<=today+timedelta(days=359)]
    if not days:raise SasError('INVALID_QUERY')
    return days

def plan(raw,today=None):
    if not isinstance(raw,dict) or raw.get('program') not in PROGRAMS:raise SasError('INVALID_QUERY')
    for k in ('origin','destination'):
        if not isinstance(raw.get(k),str) or not re.fullmatch('[A-Z]{3}',raw[k]):raise SasError('INVALID_QUERY')
    if raw['origin']==raw['destination'] or raw.get('tripType') not in ('ONE_WAY','ROUND_TRIP') or raw.get('cabin') not in CABINS:raise SasError('INVALID_QUERY')
    if raw['program']=='skyteam' and raw['tripType']!='ROUND_TRIP':raise SasError('ROUND_TRIP_REQUIRED')
    if raw['program']!='sas-eurobonus' and raw['cabin']=='premium economy':raise SasError('INVALID_QUERY')
    if raw['program']=='asiana-club' and raw['cabin']=='first':raise SasError('INVALID_QUERY')
    p={k:raw[k] for k in ('program','origin','destination','month','tripType','cabin') if k in raw}
    outbound=month_days(raw.get('month'),today)
    legs=[{'direction':'outbound','origin':p['origin'],'destination':p['destination'],'month':raw['month'],'days':[{'date':d,'status':'unsearched','cabins':[],'flights':[]} for d in outbound]}]
    if p['tripType']=='ROUND_TRIP':
        inbound=month_days(raw.get('returnMonth'),today)
        if inbound[-1]<outbound[0]:raise SasError('INVALID_QUERY')
        p['returnMonth']=raw['returnMonth']
        legs.append({'direction':'inbound','origin':p['destination'],'destination':p['origin'],'month':p['returnMonth'],'days':[{'date':d,'status':'unsearched','cabins':[],'flights':[]} for d in inbound]})
    if p['program']=='skyteam':
        # Partner booking requires a return date and a selected outbound flight.
        last_return=legs[1]['days'][-1]['date']
        first_out=legs[0]['days'][0]['date']
        legs[0]['days']=[d for d in legs[0]['days'] if d['date']<last_return]
        legs[1]['days']=[d for d in legs[1]['days'] if d['date']>first_out]
        if not all(l['days'] for l in legs):raise SasError('INVALID_QUERY')
        legs[0]['referenceDate']=last_return
        legs[1]['referenceDate']=first_out
    return p,legs

class AwardService:
    def __init__(self,root,sas_service,interval=30):
        self.root=Path(root);self.sas=sas_service;self.worker=SasWorker(root,'scripts/award-browser.ts');self.interval=interval
        self.lock=threading.RLock();self.stop=threading.Event();self.jobs={};self.thread=None
    def status(self,program):
        if program not in PROGRAMS:raise SasError('INVALID_QUERY')
        browser=self.sas.status()['browser'] if program=='sas-eurobonus' else self.worker.call('status',timeout=5,program=program)
        with self.lock:return {'browser':browser,'job':copy.deepcopy(self.jobs.get(program))}
    def open(self,program):
        if program not in PROGRAMS+('korean-air',):raise SasError('INVALID_QUERY')
        if program=='sas-eurobonus':return self.sas.open()
        browser=self.worker.call('open',timeout=60,program=program)
        if browser.get('status')=='failed':raise SasError(browser.get('code','BROWSER_ERROR'))
        return {'browser':browser}
    def booking_preferences(self):
        """Who lends miles and who flies, from the user's local settings.

        Family membership numbers are personal, so they live under data/ — which
        git ignores — and never in the repository. A missing or broken file is
        not an error: the booking screen then opens with nothing pre-selected,
        which is the airline's own default."""
        path=self.root/'data'/'local'/'asiana-booking.json'
        try:
            saved=json.loads(path.read_text(encoding='utf-8'))
        except (OSError,ValueError):
            return {}
        if not isinstance(saved,dict):return {}
        prefs={}
        for key in ('deductFrom','boarding'):
            numbers=[str(v) for v in saved.get(key) or [] if re.fullmatch(r'\d{6,15}',str(v))]
            if numbers:prefs[key]=numbers[:6]
        return prefs
    def book(self,booking,payload):
        """Drives the airline's own booking flow to its payment screen.

        Never pays, and never fills a passenger name: it selects the fare and
        allocates the family's miles, then leaves the screen to the user. The
        result says plainly whether the seat was reached, because a click that
        silently does nothing is the complaint this replaced."""
        adults=payload.get('adults') if isinstance(payload,dict) else None
        query={'origin':booking['origin'],'destination':booking['destination'],
               'date':booking['date'],'cabin':'business',
               'account':booking['account'],'booking':self.booking_preferences()}
        if isinstance(adults,int) and 1<=adults<=4:query['adults']=adults
        result=self.worker.call('book',query,program=booking['program'],timeout=180)
        return {'openedIn':'app' if result.get('held') else 'app-partial',
                'held':bool(result.get('held')),
                'holdFailure':result.get('holdFailure') or result.get('code') or '',
                'liveStatus':result.get('status'),'liveFlights':result.get('flights') or []}
    def confirm_login(self,program):
        if program not in PROGRAMS+('korean-air',):raise SasError('INVALID_QUERY')
        with self.lock:
            if self.thread and self.thread.is_alive():raise SasError('BUSY')
            if self.sas.thread and self.sas.thread.is_alive():raise SasError('BUSY')
        worker=self.sas.worker if program=='sas-eurobonus' else self.worker
        browser=worker.call('confirm-login',timeout=75,program=program)
        if browser.get('status')=='failed':raise SasError(browser.get('code','BROWSER_ERROR'))
        return {'browser':browser}
    def start(self,raw):
        p,legs=plan(raw)
        with self.lock:
            if self.thread and self.thread.is_alive():raise SasError('BUSY')
            if self.sas.thread and self.sas.thread.is_alive():raise SasError('BUSY')
            self.stop.clear();job={'params':p,'legs':legs,'status':'running','completed':0,'total':sum(len(l['days']) for l in legs),'code':None,'startedAt':datetime.now(timezone.utc).isoformat()}
            self.jobs[p['program']]=job
            self.thread=threading.Thread(target=self._run,args=(job,),daemon=True);self.thread.start()
            return {'job':copy.deepcopy(job)}
    def _run(self,job):
        program=job['params']['program']
        try:
            for leg in job['legs']:
                if self.stop.is_set():return
                if program=='sas-eurobonus':
                    self._run_sas_month(job,leg)
                elif program=='asiana-club':
                    r=self.worker.call('search', {k:leg[k] for k in ('origin','destination','month')},program=program)
                    if self.stop.is_set():return
                    if r.get('status')=='failed':raise SasError(r.get('code','SEARCH_FAILED'))
                    if any(r.get(k)!=leg[k] for k in ('origin','destination','month')):raise SasError('QUERY_MISMATCH')
                    bydate={d['date']:d for d in r['days']}
                    with self.lock:
                        for d in leg['days']:
                            if d['date'] in bydate:d.update(bydate[d['date']]);d['observedAt']=r['observedAt'];d['sourceAt']=r.get('sourceAt');job['completed']+=1
                    self._save(job)
                else:
                    self._run_partner_month(job,leg)
            if self.stop.is_set():return
            with self.lock:job['status']='complete' if job['completed']==job['total'] and all(d['status'] in ('available','empty') for leg in job['legs'] for d in leg['days']) else 'partial'
            self._save(job)
        except Exception as e:
            with self.lock:
                if self.stop.is_set():return
                job['status']='failed';job['code']=e.code if isinstance(e,SasError) else 'SEARCH_FAILED'
                if program=='sas-eurobonus' and job['code']=='ACCESS_RESTRICTED' and callable(getattr(self.sas,'record_browser',None)):self.sas.record_browser({'state':'restricted'})
                for leg in job['legs']:
                    for d in leg['days']:
                        if d['status']=='searching':d['status']='failed'
        finally:
            with self.lock:job['finishedAt']=datetime.now(timezone.utc).isoformat()
            self._save(job)
    def _run_sas_month(self,job,leg):
        queries=[dict(origin=leg['origin'],destination=leg['destination'],date=d['date']) for d in leg['days']]
        days={d['date']:d for d in leg['days']}
        finished=set()
        def progress(event):
            if self.stop.is_set():return
            q=event.get('query',{})
            if q not in queries:raise SasError('QUERY_MISMATCH')
            day=days[q['date']]
            if event.get('type')=='searching':
                with self.lock:day['status']='searching'
                return
            if event.get('type')!='result' or q['date'] in finished:raise SasError('UNRECOGNIZED_RESULT')
            r=event.get('result',{})
            if r.get('status')=='failed':
                with self.lock:day['status']='failed';day['code']=r.get('code','SEARCH_FAILED')
                return
            r=validated(r)
            if any(r[k]!=v for k,v in q.items()) or not r['freshSearch']:raise SasError('QUERY_MISMATCH')
            self.sas.store.save(r)
            flights=[dict(fare,departureTime=f['departureTime'],operatedBy=f['operatedBy'],itinerary=f['itinerary']) for f in r['flights'] for fare in f['fares']]
            with self.lock:
                day.update(status='available' if flights else 'empty',cabins=list(set(f['cabin'] for f in flights)),flights=flights,observedAt=r['observedAt'])
                job['completed']+=1;finished.add(q['date'])
            self._save(job)
        try:
            result=self.sas.worker.call('search-month',queries,timeout=600,on_event=progress)
            if self.stop.is_set():return
            if result.get('status')!='complete':raise SasError(result.get('code') or 'SEARCH_FAILED')
            if len(finished)!=len(queries):raise SasError('UNRECOGNIZED_RESULT')
        except Exception:
            self.sas.worker.call('cancel',timeout=5)
            raise
        finally:
            with self.lock:
                for day in leg['days']:
                    if day['status']=='searching':day['status']='unsearched'
    def _run_partner_month(self,job,leg):
        program=job['params']['program'];queries=[]
        days={d['date']:d for d in leg['days']};finished=set()
        for day in leg['days']:
            q=dict(origin=leg['origin'],destination=leg['destination'],date=day['date'],cabin=job['params']['cabin'])
            if program=='skyteam':q.update(origin=job['params']['origin'],destination=job['params']['destination'],direction=leg['direction'],date=day['date'] if leg['direction']=='outbound' else leg['referenceDate'],returnDate=leg['referenceDate'] if leg['direction']=='outbound' else day['date'])
            queries.append(q)
        def progress(event):
            if self.stop.is_set():return
            q=event.get('query',{})
            if q.get('origin')!=leg['origin'] or q.get('destination')!=leg['destination'] or q.get('date') not in days:raise SasError('QUERY_MISMATCH')
            day=days[q['date']]
            if event.get('type')=='searching':
                with self.lock:day['status']='searching'
                return
            if event.get('type')!='result' or q['date'] in finished:raise SasError('UNRECOGNIZED_RESULT')
            r=event.get('result',{})
            if r.get('status')=='failed':
                with self.lock:day['status']='failed';day['code']=r.get('code','SEARCH_FAILED')
                return
            if any(r.get(k)!=q[k] for k in ('origin','destination','date')):raise SasError('QUERY_MISMATCH')
            if r.get('status') not in ('available','empty','partial'):raise SasError('UNRECOGNIZED_RESULT')
            with self.lock:day.update(r);job['completed']+=1;finished.add(q['date'])
            self._save(job)
        try:
            result=self.worker.call('search-month',queries,program=program,timeout=1800,on_event=progress)
            if self.stop.is_set():return
            if result.get('status')!='complete':raise SasError(result.get('code') or 'SEARCH_FAILED')
            if len(finished)!=len(queries):raise SasError('UNRECOGNIZED_RESULT')
        except Exception:
            self.worker.call('cancel',program=program,timeout=5)
            raise
        finally:
            with self.lock:
                for day in leg['days']:
                    if day['status']=='searching':day['status']='unsearched'
    def _save(self,job):
        p=self.root/'data/local/month-results';p.mkdir(parents=True,exist_ok=True)
        (p/(job['params']['program']+'.json')).write_text(json.dumps(job,ensure_ascii=False),encoding='utf-8')
    def cancel(self,program):
        if program not in PROGRAMS:raise SasError('INVALID_QUERY')
        with self.lock:
            j=self.jobs.get(program)
            if not j or j['status']!='running':return {'status':'idle'}
        self.stop.set()
        if program=='sas-eurobonus':self.sas.worker.call('cancel',timeout=5)
        else:self.worker.call('cancel',timeout=5,program=program)
        with self.lock:
            j=self.jobs.get(program)
            if j and j['status']=='running':
                j['status']='cancelled'
                for leg in j['legs']:
                    for d in leg['days']:
                        if d['status']=='searching':d['status']='unsearched'
                self._save(j)
        return {'status':'cancelled'}
    def close(self):self.stop.set();self.worker.close()
