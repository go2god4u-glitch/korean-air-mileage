"""Application-owned SAS Chrome worker and bounded sequential searches."""
import copy
from datetime import date, timedelta, datetime, timezone
import json
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time
import uuid
from sas_store import validated


class SasError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def validate_queries(items, today=None):
    today = today or date.today()
    if not isinstance(items, list) or not 1 <= len(items) <= 20:
        raise SasError('INVALID_QUERY')
    import re
    safe = []
    for item in items:
        if not isinstance(item, dict):
            raise SasError('INVALID_QUERY')
        for key in ('origin', 'destination'):
            if not isinstance(item.get(key), str) or not re.fullmatch('[A-Z]{3}', item[key]):
                raise SasError('INVALID_QUERY')
        try:
            day = date.fromisoformat(item['date'])
        except (KeyError, ValueError, TypeError):
            raise SasError('INVALID_QUERY')
        if item['origin'] == item['destination'] or day < today or day > today+timedelta(days=359):
            raise SasError('INVALID_QUERY')
        q = {k:item[k] for k in ('origin','destination','date')}
        if q not in safe:
            safe.append(q)
    return safe


class SasWorker:
    def __init__(self, root, script="scripts/sas-browser.ts"):
        self.script = script
        self.root = Path(root)
        self.process = None
        self.lock = threading.RLock()
        self.pending = {}

    def _start(self):
        if self.process and self.process.poll() is None:
            return
        node = shutil.which('node')
        cli = self.root / 'node_modules/tsx/dist/cli.mjs'
        if not node or not cli.is_file():
            raise SasError('DEPENDENCIES_MISSING')
        # The worker's stderr used to be discarded, so a browser failure reached
        # the screen as a bare BROWSER_ERROR with nothing behind it to read. It
        # goes to a file instead: a pipe nobody drains would block the worker.
        log = self.root / 'data' / 'local' / 'award-worker.log'
        try:
            log.parent.mkdir(parents=True, exist_ok=True)
            errors = open(log, 'ab', buffering=0)
        except OSError:
            errors = subprocess.DEVNULL
        self.process = subprocess.Popen([node,str(cli),str(self.root/self.script)],cwd=str(self.root),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors)
        if errors is not subprocess.DEVNULL:
            errors.close()
        threading.Thread(target=self._reader,args=(self.process,),daemon=True).start()

    def _reader(self, process):
        try:
            while True:
                line = process.stdout.readline(512001)
                if not line or len(line)>512000:
                    break
                try:
                    value=json.loads(line.decode('utf-8'))
                    with self.lock:
                        wait=self.pending.get(value.get('id'))
                    if wait:
                        wait.put_nowait({'event':value['event']} if 'event' in value else value.get('result'))
                except (ValueError, UnicodeError, AttributeError, queue.Full):
                    continue
        finally:
            process.stdout.close()
            with self.lock:
                if self.process is process:
                    for wait in self.pending.values():
                        try: wait.put_nowait({'status':'failed','code':'BROWSER_ERROR'})
                        except queue.Full: pass

    def call(self, action, query=None, timeout=180, program=None, on_event=None):
        identity=uuid.uuid4().hex
        waiting=queue.Queue(maxsize=128 if on_event else 1)
        with self.lock:
            if action in ('status','cancel') and (not self.process or self.process.poll() is not None):
                return {'state':'closed'}
            self._start()
            self.pending[identity]=waiting
            try:
                self.process.stdin.write((json.dumps({'id':identity,'action':action,'query':query,'program':program})+'\n').encode())
                self.process.stdin.flush()
            except (OSError, ValueError):
                self.pending.pop(identity,None)
                raise SasError('BROWSER_ERROR')
        try:
            deadline=time.monotonic()+timeout
            while True:
                result=waiting.get(timeout=max(0,deadline-time.monotonic()))
                if isinstance(result,dict) and 'event' in result:
                    if on_event:on_event(result['event'])
                    continue
                break
            if not isinstance(result,dict):
                raise SasError('BROWSER_ERROR')
            return result
        except queue.Empty:
            raise SasError('SEARCH_TIMEOUT')
        finally:
            with self.lock:
                self.pending.pop(identity,None)

    def close(self):
        with self.lock:
            if self.process and self.process.poll() is None:
                try:self.process.stdin.close()
                except OSError:pass


class SasService:
    def __init__(self, root, store, worker=None, interval=30):
        self.store=store
        self.worker=worker or SasWorker(root)
        self.interval=interval
        self.lock=threading.RLock()
        self.stop=threading.Event()
        self.job=None
        self.thread=None
        self.browser_state_path=Path(root)/'data/local/sas-browser-status.json'
        self.last_browser_state=None
        try:
            if json.loads(self.browser_state_path.read_text()).get('state')=='restricted':
                self.last_browser_state={'state':'restricted'}
        except (OSError,ValueError,AttributeError):pass

    def status(self):
        with self.lock:
            job=copy.deepcopy(self.job)
        browser=self.worker.call('status',timeout=5)
        # Older workers may report the page title before their next restart.
        if browser.get('pageTitle')=='Denied boarding':browser={'state':'restricted'}
        self.record_browser(browser)
        if browser.get('state')=='closed' and self.last_browser_state:
            browser=self.last_browser_state
        return {'browser':browser,'job':job}

    def record_browser(self, browser):
        if browser.get('state') in ('restricted','ready','login_required'):
            self.last_browser_state=browser if browser['state']=='restricted' else None
            try:
                self.browser_state_path.parent.mkdir(parents=True,exist_ok=True)
                self.browser_state_path.write_text(json.dumps({'state':browser['state'],'at':datetime.now(timezone.utc).isoformat()}))
            except OSError:pass

    def open(self):
        result=self.worker.call('open',timeout=60)
        if result.get('status')=='failed':raise SasError(result.get('code','BROWSER_ERROR'))
        self.record_browser(result)
        return {'browser':result}

    def start(self, raw):
        items=validate_queries(raw)
        with self.lock:
            if self.thread and self.thread.is_alive():raise SasError('BUSY')
            self.stop.clear()
            self.job={'id':uuid.uuid4().hex,'items':items,'results':[],'status':'running','index':0}
            self.thread=threading.Thread(target=self._run,daemon=True)
            self.thread.start()
            return {'job':copy.deepcopy(self.job)}

    def cancel(self):
        with self.lock:
            if self.job and self.job['status'] in ('queued','running'):
                self.job['status']='cancelled'
            self.stop.set()
        self.worker.call('cancel',timeout=5)
        with self.lock:return {'job':copy.deepcopy(self.job)}

    def _run(self):
        for index,query in enumerate(self.job['items']):
            if self.stop.is_set():return
            try:
                result=self.worker.call('search',query,timeout=180)
                if self.stop.is_set():return
                if result.get('status')=='failed':raise SasError(result.get('code','SEARCH_FAILED'))
                try:
                    result=validated(result)
                    if any(result[k]!=query[k] for k in query) or not result['freshSearch']:
                        raise ValueError()
                except (ValueError,TypeError):raise SasError('QUERY_MISMATCH')
                self.store.save(result)
                with self.lock:
                    self.job['results'].append(result)
                    self.job['index']=index+1
                    self.job['status']='queued' if index+1<len(self.job['items']) else 'complete'
            except Exception as error:
                with self.lock:
                    if not self.stop.is_set():
                        code=error.code if isinstance(error,SasError) else 'SEARCH_FAILED'
                        if code=='ACCESS_RESTRICTED':self.record_browser({'state':'restricted'})
                        self.job['results'].append({'query':query,'status':'failed','code':code})
                        self.job['index']=index+1
                        self.job['status']='failed';self.job['code']=code
                return
            if index+1<len(self.job['items']):
                if self.stop.wait(self.interval):return
                with self.lock:self.job['status']='running'

    def close(self):
        self.stop.set()
        self.worker.close()
