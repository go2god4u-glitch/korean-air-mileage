import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import type {Page} from 'playwright';
import {openNativeChrome, NATIVE_USER_AGENT} from '../src/sas/native-chrome.js';
import {sasRestriction} from '../src/sas/status.js';
import {searchSky} from '../src/partners/skyteam.js';
import {searchStar} from '../src/partners/star-alliance.js';
import {searchPartnerMonth} from '../src/partners/month.js';
import {searchAsiana} from '../src/partners/asiana.js';
import {searchKoreanAirAward, prepareKoreanAirAward} from '../src/partners/korean-air-award.js';
import {searchAsianaAward} from '../src/partners/asiana-award.js';
const urls:Record<string,string>={'korean-air':'https://www.koreanair.com/booking/search?bookingType=A&tripType=OW','asiana-club':'https://flyasiana.com/I/KR/KO/MileageSeatSearch.do','star-alliance':'https://flyasiana.com/C/KR/KO/index','skyteam':'https://www.koreanair.com/booking/search?bookingType=S&tripType=RT'};
let native:Awaited<ReturnType<typeof openNativeChrome>>|null=null;const pages=new Map<string,Page>();let busy=false,generation=0;let monthProgram:string|null=null;let monthTask:ReturnType<typeof searchPartnerMonth>|null=null;
// Asiana's public calendar needs no login, so it gets its own windowless browser
// instead of the shared, visible profile the login-based programs need.
// It leaves its destination autocomplete unwired when navigator.webdriver is
// true, and refuses Chrome's headless user agent, so this launches Chrome itself
// and attaches over CDP. No window is created.
// Several prepared tabs, fired together. At 09:00 the airline answers unevenly
// under load, so the first tab to come back decides and the rest are discarded.
const ARMED_TABS=3;
let armed:Page[]=[];
let headless:Awaited<ReturnType<typeof openNativeChrome>>|null=null;
let headlessPageRef:Page|null=null;
async function headlessPage(){
  if(headlessPageRef&&!headlessPageRef.isClosed())return headlessPageRef;
  headless=await openNativeChrome(resolve('data/asiana-local-profile'),{headless:true,userAgent:NATIVE_USER_AGENT});
  headlessPageRef=headless.context.pages()[0]??await headless.context.newPage();
  return headlessPageRef;
}
async function ensure(program:string,navigate=true){
  if(!native){native=await openNativeChrome(resolve('data/partner-chrome-profile'),{keepRunning:true});native.context.on('close',()=>{native=null;pages.clear();generation++;});}
  let p=pages.get(program);if(!p||p.isClosed()){p=await native.context.newPage();pages.set(program,p);if(navigate)await p.goto(urls[program],{waitUntil:'domcontentloaded',timeout:45000});}return p;
}
async function state(program:string){const p=pages.get(program);if(!p||p.isClosed())return {state:'closed'};const body=await p.locator('body').innerText({timeout:2000});if(sasRestriction(body))return {state:'restricted'};if(/\/login|viewLogin/.test(p.url()))return {state:'login_required'};const authenticated=await p.getByRole('link',{name:/로그아웃|log\s*out/i}).first().isVisible() || await p.getByRole('button',{name:/로그아웃|log\s*out/i}).first().isVisible();return {state:'ready',authenticated};}
async function run(c:any){
  if(!urls[c.program])return {status:'failed',code:'INVALID_QUERY'};
  if(c.action==='status')return monthProgram===c.program?{state:'searching'}:state(c.program);
  if(c.action==='cancel'){generation++;return {state:'cancelled'};}
  if(busy)return {status:'failed',code:'BUSY'};busy=true;const initial=generation;
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
      await ensure(c.program,false);
      const tab=await native!.context.newPage();
      await tab.goto(c.query.url,{waitUntil:'domcontentloaded',timeout:45000});
      await tab.bringToFront();
      return {status:'opened',url:c.query.url};
    }
    // A verification runs on its own page. Reusing the program's public-calendar
    // tab left that page's state behind and the booking form read as unavailable.
    // A standby keeps one page with the form already filled, so the 09:00 click
    // is all that remains. 'arm' prepares it; 'fire' submits the prepared page.
    if(c.action==='arm'&&c.program==='korean-air'){
      if(!native)await ensure(c.program,false);
      await Promise.all(armed.map(t=>t.close().catch(()=>{})));
      armed=[];
      const count=Math.max(1,Math.min(ARMED_TABS,Number(c.query?.tabs)||ARMED_TABS));
      for(let i=0;i<count;i++){
        const tab=await native!.context.newPage();
        try{await prepareKoreanAirAward(tab,c.query,()=>generation!==initial);armed.push(tab);}
        catch(e){await tab.close().catch(()=>{});if(!armed.length)throw e;break;}
      }
      return {status:'armed',tabs:armed.length};
    }
    if(c.action==='fire'&&c.program==='korean-air'){
      const ready=armed.filter(t=>!t.isClosed());
      if(!ready.length)return {status:'failed',code:'NOT_ARMED'};
      // Waiting for every tab would be slower than one; the point is to take the
      // first tab that finds a seat and stop caring about the others.
      let done=false;
      const attempts=ready.map(async tab=>{
        try{return {tab,result:await searchKoreanAirAward(tab,{...c.query,prepared:true},()=>generation!==initial||done)};}
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
      await win.tab.bringToFront().catch(()=>{});
      void Promise.all(attempts).then(all=>all.forEach(x=>{if(x.tab!==win.tab)void x.tab.close().catch(()=>{});}));
      armed=[win.tab];
      return {...win.result,tabsTried:ready.length};
    }
    if(c.action==='verify'){
      if(!native)await ensure(c.program,false);
      const p=await native!.context.newPage();
      try{
        if(c.program==='korean-air')return await searchKoreanAirAward(p,c.query,()=>generation!==initial);
        if(c.program==='asiana-club')return await searchAsianaAward(p,c.query,()=>generation!==initial);
        return {status:'failed',code:'INVALID_QUERY'};
      }finally{await p.close().catch(()=>{});}
    }
    const p=await ensure(c.program,c.action==='open'||c.action==='confirm-login');if(c.action==='confirm-login'){if((await state(c.program)).state==='restricted')return {state:'restricted'};await p.goto(urls[c.program],{waitUntil:'domcontentloaded',timeout:45000});for(let i=0;i<20;i++){const result=await state(c.program);if(result.state!=='ready'||result.authenticated||c.program==='asiana-club')return result;await p.waitForTimeout(300);}return state(c.program);}if(c.action==='open'){await p.bringToFront();return state(c.program);}if((await state(c.program)).state==='restricted')return {status:'failed',code:'ACCESS_RESTRICTED'};
    if(c.program==='asiana-club')return await searchAsiana(p,c.query,()=>generation!==initial);
    if(c.program==='skyteam')return await searchSky(p,c.query,()=>generation!==initial);
    if(c.program==='star-alliance')return await searchStar(p,c.query,()=>generation!==initial);
    return {status:'failed',code:'FORM_REQUIRED'};
  }finally{busy=false;}
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});input.on('line',line=>{let c:any;try{c=JSON.parse(line);if(typeof c.id!=='string'||line.length>8192)return;}catch{return;}void run(c).then(result=>process.stdout.write(JSON.stringify({id:c.id,result})+'\n')).catch(()=>process.stdout.write(JSON.stringify({id:c.id,result:{status:'failed',code:'BROWSER_ERROR'}})+'\n'));});input.on('close',()=>{generation++;void (async()=>{await monthTask?.catch(()=>{});await Promise.all(armed.map(t=>t.close().catch(()=>{})));await native?.close();await headless?.close().catch(()=>{});process.exit(0);})();});
