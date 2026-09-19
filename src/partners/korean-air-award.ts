/**
 * 작전일지 — 성문 앞에서 직접 묻기
 *
 * 공개 달력은 전날 밤에 붙인 방(榜)이다. 방에 적힌 자리가 오늘 아침에도
 * 남아 있으리란 법이 없으니, 주공께서 "방만 보고 말을 달리게 하지 말라"
 * 하셨다. 하여 방으로 후보를 고른 뒤, 그 날짜 하나만은 성문지기에게 직접
 * 묻는다. 이것이 실시간이다.
 *
 * 다만 성문지기는 신분을 확인한다(로그인). 공개 달력과 달리 이 길은
 * 조회용 Chrome에 한 번 로그인해 두어야 열린다.
 *
 * 같은 성(대한항공)의 다른 문을 여는 skyteam.ts의 검증된 절차를 그대로
 * 따르되, 편도·보너스(bookingType=A) 조건으로 바꾸었다. 결과 화면의 주소는
 * 문마다 다를 수 있으므로 주소가 아니라 **항공편이 나타났는지**로 판별한다.
 */
import type { Page } from 'playwright';
import { sasRestriction } from '../sas/status.js';

export interface AwardQuery { origin: string; destination: string; date: string; cabin: 'business' | 'first' }

const CABIN_CODES: Record<string, string> = { business: 'C', first: 'F' };
const SEARCH_URL = 'https://www.koreanair.com/booking/search?bookingType=A&tripType=OW';
const NO_SEATS = '항공편 운항 스케줄이 없거나 모든 좌석이 매진되었습니다.';

async function waitForResult(page: Page, cancelled: () => boolean, origin: string): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  const flights = page.locator(`button[aria-label*="출발시간"][aria-label*="출발지 ${origin}"]:visible`);
  while (true) {
    if (cancelled()) throw new Error('CANCELLED');
    if (/\/login/.test(page.url())) throw new Error('LOGIN_REQUIRED');
    if (await flights.count()) return true;
    if (await page.getByText(NO_SEATS, { exact: true }).isVisible().catch(() => false)) return false;
    if (sasRestriction(await page.locator('body').innerText())) throw new Error('ACCESS_RESTRICTED');
    if (Date.now() > deadline) throw new Error('SEARCH_TIMEOUT');
    await page.waitForTimeout(400);
  }
}

async function chooseDate(page: Page, date: string): Promise<void> {
  const [year, month, day] = date.split('-').map(Number);
  const id = `month${year}${String(month).padStart(2, '0')}`;
  for (let step = 0; step < 14 && !(await page.locator('#' + id).isVisible()); step++) {
    await page.getByRole('button', { name: '다음 2달', exact: true }).click();
  }
  const cell = page.locator('#' + id + ' .ui-datepicker__td')
    .filter({ has: page.locator('.ui-datepicker__td-date').filter({ hasText: new RegExp('^' + day + '$') }) });
  if (!(await cell.isVisible())) throw new Error('DATE_UNAVAILABLE');
  if (((await cell.getAttribute('class')) ?? '').includes('-disabled')) throw new Error('DATE_NOT_BOOKABLE');
  await cell.click();
}

/** Asks the airline's own booking search whether this exact date still has the
 *  cabin available. Returns the live answer, never a cached one. */
export async function searchKoreanAirAward(page: Page, query: AwardQuery, cancelled: () => boolean) {
  const { origin, destination, date, cabin } = query;
  try {
    if (!CABIN_CODES[cabin]) throw new Error('INVALID_QUERY');
    if (cancelled()) throw new Error('CANCELLED');

    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (/\/login/.test(page.url())) throw new Error('LOGIN_REQUIRED');
    if (sasRestriction(await page.locator('body').innerText())) throw new Error('ACCESS_RESTRICTED');

    const cookies = page.getByRole('button', { name: '필수 쿠키만 허용', exact: true });
    if (await cookies.isVisible().catch(() => false)) await cookies.click();

    await page.locator('button:visible').filter({ hasText: /^출발지\s/ }).click();
    await page.getByPlaceholder('도시, 공항').fill('');
    await page.getByPlaceholder('도시, 공항').pressSequentially(origin, { delay: 100 });
    await page.getByRole('option').filter({ hasText: origin }).click();

    await page.locator('button:visible').filter({ hasText: /^(To\s*도착지|도착지\s)/ }).click();
    await page.getByPlaceholder('도시, 공항').fill('');
    await page.getByPlaceholder('도시, 공항').pressSequentially(destination, { delay: 100 });
    await page.getByRole('option').filter({ hasText: destination }).click();

    await page.locator('button:visible').filter({ hasText: '출발일' }).click();
    await chooseDate(page, date);
    const confirmDates = page.locator('[id^="dialog-calendar"] kds-button_1:visible').filter({ hasText: /^\s*선택\s*$/ });
    if (await confirmDates.isVisible().catch(() => false)) await confirmDates.click();

    await page.locator('kds-class_1').click();
    const radio = page.locator(`input[type="radio"][value="${CABIN_CODES[cabin]}"]`);
    const radioId = await radio.getAttribute('id');
    await page.locator(`label[for="${radioId}"]`).click();
    if (!(await radio.isChecked())) throw new Error('QUERY_MISMATCH');
    const confirmClass = page.locator('#bookingSeatModal kds-button_1:visible').filter({ hasText: /^\s*선택\s*$/ });
    if (await confirmClass.isVisible().catch(() => false)) await confirmClass.click();
    const closeClass = page.getByRole('button', { name: '저장 및 닫기', exact: true });
    if (await closeClass.isVisible().catch(() => false)) await closeClass.click();

    await page.getByText('항공편 검색', { exact: true }).click();
    const available = await waitForResult(page, cancelled, origin);

    // The result must be about the date we asked for, or it tells us nothing.
    const [year, month, day] = date.split('-').map(Number);
    const shown = await page.locator('body').innerText();
    if (!new RegExp(`${year}년\\s*0?${month}월\\s*0?${day}일`).test(shown)) throw new Error('QUERY_MISMATCH');

    const flights = available
      ? await page.locator(`button[aria-label*="출발시간"][aria-label*="출발지 ${origin}"]:visible`)
          .evaluateAll((nodes) => nodes.map((n) => (n.getAttribute('aria-label') ?? '').split(',')[0].trim()))
      : [];
    return {
      origin, destination, date, cabin,
      status: available ? 'available' as const : 'empty' as const,
      flights,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (/\/login/.test(page.url())) return { status: 'failed' as const, code: 'LOGIN_REQUIRED' };
    const code = error instanceof Error ? error.message : '';
    return { status: 'failed' as const, code: /^[A-Z_]+$/.test(code) ? code : 'SEARCH_FAILED' };
  }
}
