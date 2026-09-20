import { openNativeChrome } from './src/sas/native-chrome.js';
import { searchAsianaAward } from './src/partners/asiana-award.js';
import { resolve } from 'node:path';
const n = await openNativeChrome(resolve('data/partner-chrome-profile'), { keepRunning: true });
const p = await n.context.newPage();
p.setDefaultTimeout(25000);
const r = await searchAsianaAward(p, { origin:'ICN', destination:'NRT', date:'2026-11-10' }, () => false);
console.log('조회:', r.status, '|', (r.flights || []).slice(0,3));
console.log('URL:', p.url().slice(35, 95));
if (r.status === 'available') {
  // 결과 페이지의 선택 가능한 요소 파악
  const info = await p.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr:has(td.business_area)')).slice(0,3).map(tr => ({
      flight: (tr.textContent||'').replace(/\s+/g,' ').trim().slice(0,60),
      biz: (tr.querySelector('td.business_area')?.textContent||'').replace(/\s+/g,' ').trim().slice(0,30),
      clickable: Array.from(tr.querySelectorAll('a,button,input[type=radio]')).map(e=>({
        tag:e.tagName.toLowerCase(), t:(e.textContent||'').replace(/\s+/g,' ').trim().slice(0,18),
        cls:(e.className||'').toString().slice(0,30), oc:(e.getAttribute('onclick')||'').slice(0,40)})).slice(0,4),
    }));
    const next = Array.from(document.querySelectorAll('button,a'))
      .filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0;})
      .map(e=>(e.textContent||'').replace(/\s+/g,' ').trim())
      .filter(t=>/다음|선택|예약|계속|확인/.test(t)&&t.length<14).slice(0,8);
    return { rows, next };
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 1400));
}
