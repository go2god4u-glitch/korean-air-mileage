import { openNativeChrome } from './src/sas/native-chrome.js';
import { searchKoreanAirAward } from './src/partners/korean-air-award.js';
import { resolve } from 'node:path';
const n = await openNativeChrome(resolve('data/partner-chrome-profile'), { keepRunning: true });
const p = await n.context.newPage();
p.setDefaultTimeout(25000);
const r = await searchKoreanAirAward(p, {origin:'ICN',destination:'NRT',date:'2027-08-05',cabin:'business',hold:true}, ()=>false);
console.log('좌석 선택됨(held):', r.held, '| 항공편:', (r.flights||[]).slice(0,2));
await p.waitForTimeout(2000);
const info = await p.evaluate(()=>{
  const t=document.body.innerText.replace(/\s+/g,' ');
  const btns=Array.from(document.querySelectorAll('button,a'))
    .filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0;})
    .map(e=>(e.textContent||'').replace(/\s+/g,' ').trim())
    .filter(x=>/다음|계속|여정|확인|선택 완료/.test(x)&&x.length<12).slice(0,6);
  return {버튼:btns, 마일:(t.match(/공제 마일리지\s*[\d,]+/)||[])[0]||'', 요금:(t.match(/[\d,]+\s*원/g)||[]).slice(0,3)};
});
console.log('다음 단계 버튼:', JSON.stringify(info.버튼));
console.log('표시된 마일:', info.마일, '| 금액:', JSON.stringify(info.요금));
console.log('URL:', p.url());
