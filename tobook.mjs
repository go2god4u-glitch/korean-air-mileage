import { openNativeChrome } from './src/sas/native-chrome.js';
import { prepareKoreanAirAward } from './src/partners/korean-air-award.js';
import { resolve } from 'node:path';
const n = await openNativeChrome(resolve('data/partner-chrome-profile'), { keepRunning: true });
const p = await n.context.newPage();
p.setDefaultTimeout(20000);
const log = (...a)=>console.log(...a);

await prepareKoreanAirAward(p, {origin:'ICN',destination:'NRT',date:'2027-08-05',cabin:'business'}, ()=>false);
log('1. 폼 준비 완료');
await p.getByText('항공편 검색',{exact:true}).click();
const dl=Date.now()+70000;
while(Date.now()<dl && !p.url().includes('select-award-flight')) await p.waitForTimeout(400);
await p.waitForTimeout(3500);
log('2. 검색 완료 →', p.url().slice(35));

const labels = await p.locator('label[for^="flight-bonus"]').evaluateAll(xs=>xs.map(x=>(x.textContent||'').replace(/\s+/g,' ').trim()));
const idx = labels.findIndex(t=>/프레스티지석/.test(t) && !/매진/.test(t));
log('3. 선택 대상:', labels[idx]);
await p.locator('label[for^="flight-bonus"]').nth(idx).click({force:true});
await p.waitForTimeout(2500);
log('   선택됨:', await p.locator('input[id^="flight-bonus"]').nth(idx).isChecked());

const btns = await p.evaluate(()=>Array.from(document.querySelectorAll('button,a'))
  .filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0;})
  .map(e=>(e.textContent||'').replace(/\s+/g,' ').trim())
  .filter(x=>x && x.length<14 && /다음|계속|선택|확인|예약|여정/.test(x)).slice(0,10));
log('4. 화면의 진행 버튼:', JSON.stringify(btns));
const body=(await p.locator('body').innerText()).replace(/\s+/g,' ');
log('5. 비용 표시:', (body.match(/공제 마일리지[^원]*?[\d,]+\s*마일/)||[''])[0], '|', JSON.stringify((body.match(/[\d,]{3,}\s*원/g)||[]).slice(0,4)));
log('URL:', p.url());
