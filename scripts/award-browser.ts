import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import type {BrowserContext, Page} from 'playwright';
import {openNativeChrome, NATIVE_USER_AGENT} from '../src/sas/native-chrome.js';
import {sasRestriction} from '../src/sas/status.js';
import {searchSky} from '../src/partners/skyteam.js';
import {searchStar} from '../src/partners/star-alliance.js';
import {searchPartnerMonth} from '../src/partners/month.js';
import {searchAsiana} from '../src/partners/asiana.js';
import {searchKoreanAirAward, prepareKoreanAirAward} from '../src/partners/korean-air-award.js';
import {searchAsianaAward, prepareAsianaAward} from '../src/partners/asiana-award.js';
const urls:Record<string,string>={'korean-air':'https://www.koreanair.com/booking/search?bookingType=A&tripType=OW','asiana-club':'https://flyasiana.com/I/KR/KO/MileageSeatSearch.do','star-alliance':'https://flyasiana.com/C/KR/KO/index','skyteam':'https://www.koreanair.com/booking/search?bookingType=S&tripType=RT'};
let native:Awaited<ReturnType<typeof openNativeChrome>>|null=null;const pages=new Map<string,Page>();let busy=false,generation=0;let monthProgram:string|null=null;let monthTask:ReturnType<typeof searchPartnerMonth>|null=null;
// An airline identifies a login by browser session, so two accounts cannot share
// one profile. Each account gets its own Chrome, signed in once and kept.
const accounts=new Map<string,Awaited<ReturnType<typeof openNativeChrome>>>();
function accountId(raw?:unknown){
  const id=typeof raw==='string'?raw.trim():'';
  return /^[a-z0-9-]{1,24}$/i.test(id)?id:'default';
}
async function accountContext(id:string){
  if(id==='default'){
    if(!native){native=await openNativeChrome(resolve('data/partner-chrome-profile'),{keepRunning:true});native.context.on('close',()=>{native=null;pages.clear();generation++;});}
    return native.context;
  }
  let held=accounts.get(id);
  if(!held){
    held=await openNativeChrome(resolve(`data/account-${id}-profile`),{keepRunning:true});
    accounts.set(id,held);
    held.context.on('close',()=>{accounts.delete(id);generation++;});
  }
  return held.context;
}
// Asiana's public calendar needs no login, so it gets its own windowless browser
// instead of the shared, visible profile the login-based programs need.
// It leaves its destination autocomplete unwired when navigator.webdriver is
// true, and refuses Chrome's headless user agent, so this launches Chrome itself
// and attaches over CDP. No window is created.
// Several prepared tabs, fired together. At 09:00 the airline answers unevenly
// under load, so the first tab to come back decides and the rest are discarded.
const ARMED_TABS=3;
// Keyed by standby, because several can wait on the same 09:00 at once and one
// shared list meant the second arming closed the first one's tabs.
const armedByKey=new Map<string,Page[]>();
function armKey(c:any){return `${c.program}|${accountId(c.query?.account)}|${c.query?.origin}|${c.query?.destination}|${c.query?.date}|${c.query?.cabin}`;}
let headless:Awaited<ReturnType<typeof openNativeChrome>>|null=null;
let headlessPageRef:Page|null=null;
async function headlessPage(){
  if(headlessPageRef&&!headlessPageRef.isClosed())return headlessPageRef;
  headless=await openNativeChrome(resolve('data/asiana-local-profile'),{headless:true,userAgent:NATIVE_USER_AGENT});
  headlessPageRef=headless.context.pages()[0]??await headless.context.newPage();
  return headlessPageRef;
}
// Chrome raises its window — and un-minimises it — whenever a tab is created in
// it. The session check and the live verification each opened a fresh tab and
// closed it again, so a minimised window came back to the front every few
// minutes while a scan or a standby ran. One long-lived tab per purpose is
// created once and navigated from then on, so the window is disturbed once.
const scratch=new Map<string,Page>();
async function scratchTab(ctx:BrowserContext,key:string){
  const held=scratch.get(key);
  if(held&&!held.isClosed())return held;
  const tab=await ctx.newPage();
  scratch.set(key,tab);
  return tab;
}
async function ensure(program:string,navigate=true){
  if(!native){native=await openNativeChrome(resolve('data/partner-chrome-profile'),{keepRunning:true});native.context.on('close',()=>{native=null;pages.clear();generation++;});}
  let p=pages.get(program);if(!p||p.isClosed()){p=await native.context.newPage();pages.set(program,p);if(navigate)await p.goto(urls[program],{waitUntil:'domcontentloaded',timeout:45000});}return p;
}
// These pages redirect to the airline's login when the session is gone, so
// staying on them is the proof of being signed in. The 로그아웃 link only appears
// behind a menu on some layouts, and requiring it reported a working session as
// expired — a false alarm that would be read as "you cannot book" at 09:00.
async function state(program:string){
  const p=pages.get(program);if(!p||p.isClosed())return {state:'closed'};
  const body=await p.locator('body').innerText({timeout:2000});
  if(sasRestriction(body))return {state:'restricted'};
  if(/\/login|viewLogin/.test(p.url()))return {state:'login_required'};
  const visibleLogout=await p.getByRole('link',{name:/로그아웃|log\s*out/i}).first().isVisible().catch(()=>false)
    || await p.getByRole('button',{name:/로그아웃|log\s*out/i}).first().isVisible().catch(()=>false);
  const onOwnPage=/koreanair\.com\/(booking|payment)|flyasiana\.com\/I\//.test(p.url());
  return {state:'ready',authenticated:visibleLogout||onOwnPage};
}
async function run(c:any){
  if(!urls[c.program])return {status:'failed',code:'INVALID_QUERY'};
  if(c.action==='status')return monthProgram===c.program?{state:'searching'}:state(c.program);
  if(c.action==='cancel'){generation++;return {state:'cancelled'};}
  // Standby arming and firing run on their own tabs and own account profiles, so
  // several can proceed at once; everything else still takes the single lane.
  // 'book' joins them: it runs on its own tab and its own account profile, and
  // waiting behind a sweep is how a click came to look like nothing happened.
  const concurrent=c.action==='arm'||c.action==='fire'||c.action==='book';
  if(!concurrent&&busy)return {status:'failed',code:'BUSY'};
  if(!concurrent)busy=true;
  const initial=generation;
  if(c.action==='search-month'){
    try{
      if(!['skyteam','star-alliance'].includes(c.program)||!Array.isArray(c.query)||c.query.length<1||c.query.length>31)return {status:'failed',code:'INVALID_QUERY'};
      await ensure(c.program,true);const status=await state(c.program);if(status.state==='restricted')return {status:'failed',code:'ACCESS_RESTRICTED'};if(status.state==='login_required')return {status:'failed',code:'LOGIN_REQUIRED'};monthProgram=c.program;
      monthTask=searchPartnerMonth(native!.context,c.program,c.query,()=>generation!==initial,event=>process.stdout.write(JSON.stringify({id:c.id,event})+'\n'));
      return await monthTask;
    }finally{busy=false;monthProgram=null;monthTask=null;}
  }
  try{
    if(c.action==='search'&&c.program==='asiana-club')return await searchAsiana(await headlessPage(),c.query,()=>generation!==initial);
    // Live check of one date against the airline's own booking search. Needs the
    // shared logged-in Chrome, unlike the public calendar.
    // Booking opens as a tab in the browser the user already signed into, so the
    // session carries over and no second window appears.
    if(c.action==='open-url'){
      if(typeof c.query?.url!=='string'||!/^https:\/\/(www\.koreanair\.com|flyasiana\.com)\//.test(c.query.url))return {status:'failed',code:'INVALID_QUERY'};
      const id=accountId(c.query?.account);
      const ctx=await accountContext(id);
      const tab=await ctx.newPage();
      await tab.goto(c.query.url,{waitUntil:'domcontentloaded',timeout:45000});
      // Several account windows look identical once open, so each says whose it
      // is. addInitScript does not apply to a page reached over CDP, and the
      // airline redirects to its login page, so the badge is painted directly
      // and repainted on every navigation of this tab.
      const badge=typeof c.query?.badge==='string'?c.query.badge.slice(0,40):id;
      const paint=async()=>{
        await tab.evaluate(label=>{
          if(document.getElementById('kaw-account-badge'))return;
          document.title=`[${label}] `+document.title;
          const bar=document.createElement('div');
          bar.id='kaw-account-badge';
          bar.textContent=`${label} 전용 창 — 이 창에서 로그인해 주세요`;
          bar.style.cssText='position:fixed;inset:0 0 auto 0;z-index:2147483647;background:#162d53;color:#fff;'
            +'font:600 14px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:8px';
          document.documentElement.append(bar);
          if(document.body)document.body.style.paddingTop='40px';
        },badge).catch(()=>{});
      };
      tab.on('domcontentloaded',()=>{void paint();});
      await tab.waitForURL(/\/login|viewLogin/,{timeout:9000}).catch(()=>{});
      await paint();
      await tab.bringToFront();
      return {status:'opened',url:c.query.url,account:id};
    }
    // A verification runs on its own page. Reusing the program's public-calendar
    // tab left that page's state behind and the booking form read as unavailable.
    // A standby keeps one page with the form already filled, so the 09:00 click
    // is all that remains. 'arm' prepares it; 'fire' submits the prepared page.
    if(c.action==='arm'&&(c.program==='korean-air'||c.program==='asiana-club')){
      const ctx=await accountContext(accountId(c.query?.account));
      const key=armKey(c);
      await Promise.all((armedByKey.get(key)??[]).map(t=>t.close().catch(()=>{})));
      const armed:Page[]=[];
      armedByKey.set(key,armed);
      const count=Math.max(1,Math.min(ARMED_TABS,Number(c.query?.tabs)||ARMED_TABS));
      for(let i=0;i<count;i++){
        const tab=await ctx.newPage();
        try{
          if(c.program==='korean-air')await prepareKoreanAirAward(tab,c.query,()=>generation!==initial);
          else await prepareAsianaAward(tab,c.query,()=>generation!==initial);
          armed.push(tab);
        }
        catch(e){await tab.close().catch(()=>{});if(!armed.length)throw e;break;}
      }
      return {status:'armed',tabs:armed.length};
    }
    if(c.action==='fire'&&(c.program==='korean-air'||c.program==='asiana-club')){
      const key=armKey(c);
      const ready=(armedByKey.get(key)??[]).filter(t=>!t.isClosed());
      if(!ready.length)return {status:'failed',code:'NOT_ARMED'};
      // Waiting for every tab would be slower than one; the point is to take the
      // first tab that finds a seat and stop caring about the others.
      let done=false;
      const attempts=ready.map(async tab=>{
        try{
          const cancel=()=>generation!==initial||done;
          const result=c.program==='korean-air'
            ? await searchKoreanAirAward(tab,{...c.query,prepared:true},cancel)
            : await searchAsianaAward(tab,{...c.query,prepared:true},cancel);
          return {tab,result};
        }
        catch{return {tab,result:{status:'failed' as const,code:'SEARCH_FAILED'}};}
      });
      const win=await new Promise<{tab:Page,result:any}>(resolve=>{
        let left=attempts.length;let first:{tab:Page,result:any}|null=null;
        for(const attempt of attempts)void attempt.then(outcome=>{
          first??=outcome;
          if(outcome.result.status==='available'&&!done){done=true;resolve(outcome);return;}
          if(--left===0)resolve(first!);
        });
      });
      // Only raise the window when there is something to act on. Doing it on
      // every attempt pulled the window forward over whatever else was open.
      if(win.result.status==='available')await win.tab.bringToFront().catch(()=>{});
      void Promise.all(attempts).then(all=>all.forEach(x=>{if(x.tab!==win.tab)void x.tab.close().catch(()=>{});}));
      armedByKey.set(key,[win.tab]);
      return {...win.result,tabsTried:ready.length};
    }
    // Touching the airline's own page keeps its session alive. A standby that
    // waits overnight would otherwise find the login gone at 09:00, when there
    // is no time left to sign in again.
    if(c.action==='keepalive'){
      const id=accountId(c.query?.account);
      const ctx=await accountContext(id);
      const tab=await scratchTab(ctx,`${id}|keepalive`);
      await tab.goto(urls[c.program],{waitUntil:'domcontentloaded',timeout:45000});
      await tab.waitForURL(/\/login|viewLogin/,{timeout:9000}).catch(()=>{});
      const signedIn=!/\/login|viewLogin/.test(tab.url());
      return {status:'ok',account:id,authenticated:signedIn};
    }
    // Booking is a verification the user is about to act on, so it gets its own
    // tab and is deliberately raised — unlike every other check, which must not
    // pull a minimised window forward. It stops at the airline's payment screen.
    if(c.action==='book'){
      const id=accountId(c.query?.account);
      const ctx=await accountContext(id);
      const tab=await ctx.newPage();
      const query={...c.query,hold:true};
      const result=c.program==='korean-air'
        ? await searchKoreanAirAward(tab,query,()=>generation!==initial)
        : c.program==='asiana-club'
          ? await searchAsianaAward(tab,query,()=>generation!==initial)
          : {status:'failed',code:'INVALID_QUERY'};
      await tab.bringToFront().catch(()=>{});
      return {...result,account:id};
    }
    if(c.action==='verify'){
      const id=accountId(c.query?.account);
      const ctx=await accountContext(id);
      // Verifications are serialised by the busy lane, so one tab per account is
      // never entered twice at once. Each search navigates it from its own entry
      // page, so nothing of the previous check is carried in.
      const p=await scratchTab(ctx,`${id}|verify`);
      if(c.program==='korean-air')return await searchKoreanAirAward(p,c.query,()=>generation!==initial);
      if(c.program==='asiana-club')return await searchAsianaAward(p,c.query,()=>generation!==initial);
      return {status:'failed',code:'INVALID_QUERY'};
    }
    const p=await ensure(c.program,c.action==='open'||c.action==='confirm-login');if(c.action==='confirm-login'){
      if((await state(c.program)).state==='restricted')return {state:'restricted'};
      await p.goto(urls[c.program],{waitUntil:'domcontentloaded',timeout:45000});
      // The bounce to the login page can take several seconds. Answering before it
      // lands calls an expired session signed in, which is the worse mistake: it
      // is believed until 09:00, when there is no time left to sign in.
      await p.waitForURL(/\/login|viewLogin/,{timeout:9000}).catch(()=>{});
      return state(c.program);
    }if(c.action==='open'){await p.bringToFront();return state(c.program);}if((await state(c.program)).state==='restricted')return {status:'failed',code:'ACCESS_RESTRICTED'};
    if(c.program==='asiana-club')return await searchAsiana(p,c.query,()=>generation!==initial);
    if(c.program==='skyteam')return await searchSky(p,c.query,()=>generation!==initial);
    if(c.program==='star-alliance')return await searchStar(p,c.query,()=>generation!==initial);
    return {status:'failed',code:'FORM_REQUIRED'};
  }finally{if(!concurrent)busy=false;}
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});input.on('line',line=>{let c:any;try{c=JSON.parse(line);if(typeof c.id!=='string'||line.length>8192)return;}catch{return;}void run(c).then(result=>process.stdout.write(JSON.stringify({id:c.id,result})+'\n')).catch(error=>{
  // BROWSER_ERROR is all the screen can say; the reason belongs in the log, or
  // the next failure is diagnosed by guesswork again.
  console.error(`[award-browser] ${c.action}/${c.program}:`,error instanceof Error?error.stack??error.message:error);
  process.stdout.write(JSON.stringify({id:c.id,result:{status:'failed',code:'BROWSER_ERROR'}})+'\n');
});});input.on('close',()=>{generation++;void (async()=>{await monthTask?.catch(()=>{});await Promise.all([...armedByKey.values()].flat().map(t=>t.close().catch(()=>{})));await Promise.all([...accounts.values()].map(a=>a.close().catch(()=>{})));await native?.close();await headless?.close().catch(()=>{});process.exit(0);})();});
