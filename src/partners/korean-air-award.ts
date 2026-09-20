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

/** The award result page labels every flight's cabin with either its mileage
 *  price or 매진. That is the live answer the public calendar cannot give. */
const CABIN_LABELS: Record<string, string> = { business: '프레스티지석', first: '일등석' };
const SEARCH_URL = 'https://www.koreanair.com/booking/search?bookingType=A&tripType=OW';
const RESULT_PATH = '/booking/select-award-flight';
const NO_SEATS = '항공편 운항 스케줄이 없거나 모든 좌석이 매진되었습니다.';
const CABIN_LABEL_SELECTOR = 'label[for^="flight-bonus"]';

export interface CabinOffer { flightNumber: string; cabin: string; miles: string | null; soldOut: boolean }

export function parseCabinOffers(labels: string[]): CabinOffer[] {
  const offers: CabinOffer[] = [];
  for (const raw of labels) {
    const text = raw.replace(/\s+/gu, ' ').trim();
    const match = /항공편명\s+(\S+)\s+(일반석|프레스티지석|일등석)\s+(매진|[\d,]+\s*마일)/u.exec(text);
    if (!match) continue;
    const [, flightNumber, cabin, value] = match;
    offers.push({ flightNumber, cabin, soldOut: value === '매진', miles: value === '매진' ? null : value.trim() });
  }
  return offers;
}

async function waitForResult(page: Page, cancelled: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 90_000;
  const cabins = page.locator(CABIN_LABEL_SELECTOR);
  while (true) {
    if (cancelled()) throw new Error('CANCELLED');
    if (/\/login/.test(page.url())) throw new Error('LOGIN_REQUIRED');
    if (page.url().includes(RESULT_PATH) && await cabins.count()) return true;
    if (await page.getByText(NO_SEATS, { exact: true }).isVisible().catch(() => false)) return false;
    if (sasRestriction(await page.locator('body').innerText())) throw new Error('ACCESS_RESTRICTED');
    if (Date.now() > deadline) throw new Error('SEARCH_TIMEOUT');
    await page.waitForTimeout(500);
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
/** Fills the search form but does not submit it.
 *
 *  Nearly all of a lookup is typing airport codes and walking the date picker.
 *  Doing that ahead of 09:00 leaves only the click when the seats actually
 *  appear, which is the difference between arriving first and arriving ninth. */
export async function prepareKoreanAirAward(page: Page, query: AwardQuery, cancelled: () => boolean): Promise<void> {
  const { origin, destination, date, cabin } = query;
  if (!CABIN_LABELS[cabin]) throw new Error('INVALID_QUERY');
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
  // Leave the submit for the caller: that click is the whole point of preparing.
  await page.getByText('항공편 검색', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
}

export async function searchKoreanAirAward(page: Page, query: AwardQuery & { hold?: boolean; prepared?: boolean }, cancelled: () => boolean) {
  const { origin, destination, date, cabin } = query;
  try {
    if (!query.prepared) await prepareKoreanAirAward(page, query, cancelled);
    if (cancelled()) throw new Error('CANCELLED');

    // The award search form has no cabin selector: every cabin comes back priced
    // or marked 매진 on the result page, which is exactly what we want to read.
    await page.getByText('항공편 검색', { exact: true }).click();
    const hasFlights = await waitForResult(page, cancelled);

    // The result must be about the date we asked for, or it tells us nothing.
    const [, month, day] = date.split('-').map(Number);
    const shown = (await page.locator('body').innerText()).replace(/\s+/gu, ' ');
    // The header prints the full date on a wide layout and only the day number on
    // a narrow one, so the day strip's own 선택됨 marker is the reliable witness.
    const spelled = new RegExp(`0?${month}월\\s*0?${day}일`).test(shown);
    const selectedDay = /출발일\s*(\d{1,2})\s*\([월화수목금토일]\)(?:(?!출발일).)*?선택됨/u.exec(shown);
    const picked = selectedDay ? Number(selectedDay[1]) === day : false;
    if (!spelled && !picked) {
      if (process.env.AWARD_DEBUG === '1') {
        console.error('[ke-award] date not on page:', `${month}월 ${day}일`, '| selected:', selectedDay?.[1], '|', shown.slice(0, 220));
      }
      throw new Error('QUERY_MISMATCH');
    }

    const offers = hasFlights
      ? parseCabinOffers(await page.locator(CABIN_LABEL_SELECTOR).evaluateAll((nodes) => nodes.map((n) => n.textContent ?? '')))
      : [];
    if (hasFlights && !offers.length) throw new Error('STRUCTURE_CHANGED');
    const wanted = offers.filter((offer) => offer.cabin === CABIN_LABELS[cabin]);
    const bookable = wanted.filter((offer) => !offer.soldOut);
    // `hold` leaves the page on the airline's own booking flow with the cabin
    // already chosen, so the user only has to confirm. It never pays: selecting a
    // fare is as far as this goes, and the miles are spent by them, not by us.
    let held = false;
    if (query.hold && bookable.length) {
      const index = offers.findIndex((offer) => offer === bookable[0]);
      // The label covers its radio, so clicking the input itself is intercepted.
      const radio = page.locator('input[id^="flight-bonus"]').nth(index);
      try {
        await page.locator(CABIN_LABEL_SELECTOR).nth(index).click({ timeout: 10_000 });
        held = await radio.isChecked();
      } catch { held = false; }
    }
    return {
      origin, destination, date, cabin,
      status: bookable.length ? 'available' as const : 'empty' as const,
      flights: bookable.map((offer) => `${offer.flightNumber} ${offer.miles}`),
      soldOut: wanted.length > 0 && !bookable.length,
      held,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (/\/login/.test(page.url())) return { status: 'failed' as const, code: 'LOGIN_REQUIRED' };
    const code = error instanceof Error ? error.message : '';
    return { status: 'failed' as const, code: /^[A-Z_]+$/.test(code) ? code : 'SEARCH_FAILED' };
  }
}
