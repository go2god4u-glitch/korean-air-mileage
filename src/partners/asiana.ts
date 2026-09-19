import type {Page} from 'playwright';
export interface MonthQuery {origin:string;destination:string;month:string}
// Asiana's form reacts to unhurried input: typing a code instantly can leave the
// destination autocomplete uninstalled, and back-to-back searches draw rate limits.
// Every step is deliberately paced — a slow search that completes beats a fast one
// that gets refused.
const TYPE_DELAY=140;
const settle=(page:Page,ms=1200)=>page.waitForTimeout(ms);
export async function searchAsiana(page:Page,q:MonthQuery,cancelled:()=>boolean) {
  try {
    if(cancelled())throw new Error('CANCELLED');
    await page.goto('https://flyasiana.com/I/KR/KO/MileageSeatSearch.do',{waitUntil:'domcontentloaded',timeout:45000});
    if(/Access Denied/i.test(await page.locator('body').innerText()))throw new Error('ACCESS_RESTRICTED');
    await settle(page);
    await page.getByRole('link',{name:'편도',exact:true}).click();
    await settle(page);
    await page.locator('#txtDepartureAirport1.ui-autocomplete-input').waitFor();
    await page.locator('#txtDepartureAirport1').click();
    await page.locator('#txtDepartureAirport1').fill('');
    await page.locator('#txtDepartureAirport1').pressSequentially(q.origin,{delay:TYPE_DELAY});
    const departure=page.locator('#divDepAirportAC1 li').filter({hasText:q.origin});
    try {await departure.first().waitFor({timeout:10000});} catch {throw new Error('ROUTE_UNAVAILABLE');}
    await departure.first().click();
    await settle(page);
    // The destination autocomplete is installed asynchronously once an origin is
    // committed, and sometimes only after the field itself is focused.
    const arrivalInput=page.locator('#txtArrivalAirport1');
    let ready=false;
    for(let attempt=0;attempt<6&&!ready;attempt++) {
      if(cancelled())throw new Error('CANCELLED');
      try {
        await arrivalInput.click({timeout:5000});
        await page.locator('#txtArrivalAirport1.ui-autocomplete-input').waitFor({timeout:5000});
        ready=true;
      } catch {await settle(page,1500);}
    }
    if(!ready)throw new Error('STRUCTURE_CHANGED');
    await arrivalInput.fill('');
    await arrivalInput.pressSequentially(q.destination,{delay:TYPE_DELAY});
    // An airport Asiana does not serve from this origin never reaches the suggestion
    // list. Say so explicitly instead of timing out on a click that can never happen.
    const arrival=page.locator('#divArrAirportAC1 li').filter({hasText:q.destination});
    try {await arrival.first().waitFor({timeout:10000});} catch {throw new Error('ROUTE_UNAVAILABLE');}
    await arrival.first().click();
    await settle(page);
    if(await page.locator('#departureAirport1').inputValue()!==q.origin||await page.locator('#arrivalAirport1').inputValue()!==q.destination)throw new Error('QUERY_MISMATCH');
    await page.locator('#sCalendarMonth').click();
    await settle(page);
    const [year,month]=q.month.split('-');
    await page.locator(`.month_btn[data-year="${year}"][data-month="${Number(month)}"]`).click();
    await settle(page);
    let dialogMessage='';const dialogHandler=async(d:any)=>{dialogMessage=d.message();await d.dismiss();};page.on('dialog',dialogHandler);
    try {
      await page.locator('#btn_MileageSeat_search').click();
      await page.locator('#depCalendar').waitFor({timeout:45000});
      if(dialogMessage)throw new Error('ROUTE_UNAVAILABLE');
    } finally {page.off('dialog',dialogHandler);}
    if(cancelled())throw new Error('CANCELLED');
    const header=await page.locator('#depCalendar h2').innerText();
    if(!header.includes(year+'년')||!header.includes(Number(month)+'월'))throw new Error('QUERY_MISMATCH');
    const raw=await page.locator('#depCalendar a[id^="cal_"]').evaluateAll(es=>es.map(e=>({date:e.getAttribute('data-date'),economy:e.getAttribute('data-economy'),business:e.getAttribute('data-business')})));
    if(!raw.length)throw new Error('UNRECOGNIZED_RESULT');
    const dates=raw.map(r=>{
      const date=r.date?.replace(/\./g,'-');if(!date?.startsWith(q.month+'-'))throw new Error('QUERY_MISMATCH');
      const flights=[];
      for(const [cabin,serialized,code] of [['economy',r.economy,'X'],['business',r.business,'I']]) {
        const rows=JSON.parse(serialized||'[]');if(!Array.isArray(rows))throw new Error('UNRECOGNIZED_RESULT');
        for(const f of rows) {
          if(f.brdCd!==q.origin||f.ofpCd!==q.destination||!String(f.deptrDt).startsWith(date.replace(/-/g,'')))throw new Error('QUERY_MISMATCH');
          if(f.bkgCd!==code)continue; // P is an upgrade, not a business award.
          if(!/^\d+$/.test(String(f.availQty)))throw new Error('UNRECOGNIZED_RESULT');
          if(Number(f.availQty)>0)flights.push({cabin,flightNumber:'OZ'+f.fltNbr,departureTime:String(f.deptrDt).slice(8,10)+':'+String(f.deptrDt).slice(10,12),points:null,availableSeatCount:null});
        }
      }
      return {date,status:flights.length?'available':'empty',cabins:[...new Set(flights.map(f=>f.cabin))],flights};
    });
    const body=await page.locator('body').innerText();const sourceAt=body.match(/좌석 상황은 대한민국 시간\s*\(([^)]+)\)/)?.[1]||null;
    return {...q,program:'asiana-club',status:'complete',days:dates,observedAt:new Date().toISOString(),sourceAt};
  } catch(e) {const code=e instanceof Error?e.message:'';return {status:'failed',code:/^[A-Z_]+$/.test(code)?code:'SEARCH_FAILED'};}
}
