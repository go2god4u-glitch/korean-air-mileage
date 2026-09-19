import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {chromium, type Page} from 'playwright';
import {openNativeChrome} from '../src/sas/native-chrome.js';
import {sasRestriction} from '../src/sas/status.js';
import {searchSky} from '../src/partners/skyteam.js';
import {searchStar} from '../src/partners/star-alliance.js';
import {searchPartnerMonth} from '../src/partners/month.js';
import {searchAsiana} from '../src/partners/asiana.js';
const urls:Record<string,string>={'korean-air':'https://www.koreanair.com/booking/search?bookingType=A&tripType=OW','asiana-club':'https://flyasiana.com/I/KR/KO/MileageSeatSearch.do','star-alliance':'https://flyasiana.com/C/KR/KO/index','skyteam':'https://www.koreanair.com/booking/search?bookingType=S&tripType=RT'};
let native:Awaited<ReturnType<typeof openNativeChrome>>|null=null;const pages=new Map<string,Page>();let busy=false,generation=0;let monthProgram:string|null=null;let monthTask:ReturnType<typeof searchPartnerMonth>|null=null;
// Asiana's public calendar needs no login, and the site accepts headless Chrome as
// long as the headless user agent is replaced. It therefore gets its own windowless
// browser instead of the shared, visible login profile the other programs need.
let headless:{browser:import('playwright').Browser,page:Page}|null=null;
const HEADLESS_USER_AGENT='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
async function headlessPage(){
  if(headless&&!headless.page.isClosed())return headless.page;
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({locale:'ko-KR',timezoneId:'Asia/Seoul',userAgent:HEADLESS_USER_AGENT});
  headless={browser,page:await context.newPage()};
  return headless.page;
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
    const p=await ensure(c.program,c.action==='open'||c.action==='confirm-login');if(c.action==='confirm-login'){if((await state(c.program)).state==='restricted')return {state:'restricted'};await p.goto(urls[c.program],{waitUntil:'domcontentloaded',timeout:45000});for(let i=0;i<20;i++){const result=await state(c.program);if(result.state!=='ready'||result.authenticated||c.program==='asiana-club')return result;await p.waitForTimeout(300);}return state(c.program);}if(c.action==='open'){await p.bringToFront();return state(c.program);}if((await state(c.program)).state==='restricted')return {status:'failed',code:'ACCESS_RESTRICTED'};
    if(c.program==='asiana-club')return await searchAsiana(p,c.query,()=>generation!==initial);
    if(c.program==='skyteam')return await searchSky(p,c.query,()=>generation!==initial);
    if(c.program==='star-alliance')return await searchStar(p,c.query,()=>generation!==initial);
    return {status:'failed',code:'FORM_REQUIRED'};
  }finally{busy=false;}
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});input.on('line',line=>{let c:any;try{c=JSON.parse(line);if(typeof c.id!=='string'||line.length>8192)return;}catch{return;}void run(c).then(result=>process.stdout.write(JSON.stringify({id:c.id,result})+'\n')).catch(()=>process.stdout.write(JSON.stringify({id:c.id,result:{status:'failed',code:'BROWSER_ERROR'}})+'\n'));});input.on('close',()=>{generation++;void (async()=>{await monthTask?.catch(()=>{});await native?.close();process.exit(0);})();});
