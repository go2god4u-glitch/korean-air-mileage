/**
 * 작전일지 — 두 번째 성문
 *
 * 대한항공의 성문은 이미 직접 두드려 보았다(korean-air-award.ts). 아시아나는
 * 방(공개 달력)에 잔여 좌석 수까지 적어 내거는 점이 다르나, 그 방 또한 어제
 * 아침에 붙인 것이다. 하여 이 문도 직접 묻는다.
 *
 * 아시아나의 폼은 서두르면 열리지 않는다. 공개 달력에서 배운 대로 한 자씩
 * 천천히 넣고 단계마다 숨을 고른다. 로그인은 조회용 Chrome에 한 번 해두면
 * 이어진다.
 */
import type { Page } from 'playwright';

export interface AsianaAwardQuery { origin: string; destination: string; date: string }

const ENTRY_URL = 'https://flyasiana.com/I/KR/KO/RedemptionRegistTravel.do';
const TYPE_DELAY = 140;
const settle = (page: Page, ms = 1200) => page.waitForTimeout(ms);

/** Picks an airport through the autocomplete the page installs on each field. */
async function pickAirport(page: Page, field: 'Departure' | 'Arrival', code: string): Promise<void> {
  const input = page.locator(`#txt${field}Airport1`);
  const list = page.locator(`#div${field === 'Departure' ? 'Dep' : 'Arr'}AirportAC1 li`).filter({ hasText: code });
  let ready = false;
  for (let attempt = 0; attempt < 6 && !ready; attempt++) {
    try {
      await input.click({ timeout: 5000 });
      ready = true;
    } catch { await settle(page, 1500); }
  }
  if (!ready) throw new Error('STRUCTURE_CHANGED');
  await input.fill('');
  await input.pressSequentially(code, { delay: TYPE_DELAY });
  // An airport Asiana does not serve from here never reaches the list at all.
  try { await list.first().waitFor({ timeout: 10_000 }); } catch {
    if (process.env.AWARD_DEBUG === '1') {
      const shown = await page.locator(`#div${field === 'Departure' ? 'Dep' : 'Arr'}AirportAC1 li`)
        .allInnerTexts().catch(() => []);
      console.error(`[asiana-award] ${field} ${code}: 후보 ${JSON.stringify(shown.slice(0, 4))}`);
    }
    throw new Error('ROUTE_UNAVAILABLE');
  }
  await list.first().click();
  await settle(page);
}

async function chooseDate(page: Page, date: string): Promise<void> {
  const target = new Date(date + 'T12:00:00Z');
  if (!(await page.locator('.ui-datepicker-title:visible').count())) {
    await page.locator('#sCalendar').click();
    await settle(page);
  }
  for (let step = 0; step < 18; step++) {
    const title = await page.locator('.ui-datepicker-title:visible').first().innerText();
    const match = title.match(/(20\d{2})\.\s*(\d+)/u);
    if (!match) throw new Error('DATE_UNAVAILABLE');
    const delta = (target.getUTCFullYear() - Number(match[1])) * 12 + target.getUTCMonth() + 1 - Number(match[2]);
    if (delta === 0 || delta === 1) break;
    await page.getByRole('link', { name: delta > 0 ? '다음달' : '이전달', exact: true }).click();
    await page.waitForTimeout(350);
  }
  const cell = page.locator(`td[data-year="${target.getUTCFullYear()}"][data-month="${target.getUTCMonth()}"] a[data-date="${target.getUTCDate()}"]`);
  try { await cell.waitFor({ timeout: 8000 }); } catch { throw new Error('DATE_NOT_BOOKABLE'); }
  await cell.click();
  await settle(page);
}

export interface AsianaOffer { flightNumber: string; soldOut: boolean; text: string }

/** Reads the business column of each flight row. The page states 매진 outright,
 *  so availability is never inferred from layout or from an absent marker. */
export function parseAsianaOffers(rows: { flight: string; business: string }[]): AsianaOffer[] {
  const offers: AsianaOffer[] = [];
  for (const row of rows) {
    const business = row.business.replace(/\s+/gu, ' ').trim();
    if (!business) continue;
    const flightNumber = (row.flight.match(/OZ\s?\d{3,4}/u)?.[0] ?? '').replace(/\s/gu, '');
    offers.push({ flightNumber, soldOut: /매진|마감|선택 불가/u.test(business), text: business.slice(0, 60) });
  }
  return offers;
}

/** Everything after the form is filled: submit, wait, read the business column. */
async function submitAsianaAward(page: Page, query: AsianaAwardQuery, cancelled: () => boolean) {
  const { origin, destination, date } = query;
    let dialogMessage = '';
  const onDialog = async (dialog: { message: () => string; dismiss: () => Promise<void> }) => {
    dialogMessage = dialog.message();
    await dialog.dismiss().catch(() => {});
  };
  page.on('dialog', onDialog as never);
  try {
    // Searching takes two clicks: 항공권 조회 opens a mileage notice layer, and
    // the layer's own confirm is what actually submits (toFlightsSelect).
    await page.locator('#btn_coupon_layer').click({ timeout: 10_000 });
    await settle(page);
    const confirm = page.locator('button[onclick*="toFlightsSelect"]:visible');
    try { await confirm.first().click({ timeout: 15_000 }); } catch { throw new Error('CONFIRM_UNAVAILABLE'); }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (cancelled()) throw new Error('CANCELLED');
      if (dialogMessage) {
        if (process.env.AWARD_DEBUG === '1') console.error('[asiana-award] dialog:', dialogMessage);
        throw new Error('ROUTE_UNAVAILABLE');
      }
      if (!page.url().includes('RedemptionRegistTravel')) break;
      await page.waitForTimeout(500);
    }
  } finally { page.off('dialog', onDialog as never); }
  await settle(page, 2500);

  const shown = (await page.locator('body').innerText()).replace(/\s+/gu, ' ');
  if (/Access Denied/iu.test(shown)) throw new Error('ACCESS_RESTRICTED');
  // The result must be about the date we asked for. The page's own hidden field
  // is the reliable witness; its printed date has several formats.
  const committedOnResult = await page.locator('#departureDate1').inputValue().catch(() => '');
  const compact = date.replace(/-/gu, '');
  const [, month, day] = date.split('-').map(Number);
  const printed = new RegExp(`(^|[^\\d])0?${month}\\s*[./월-]\\s*0?${day}([^\\d]|$)`, 'u');
  if (committedOnResult ? committedOnResult !== compact : !printed.test(shown)) {
    if (process.env.AWARD_DEBUG === '1') {
      console.error('[asiana-award] date mismatch:', { asked: compact, field: committedOnResult, url: page.url() });
    }
    throw new Error('QUERY_MISMATCH');
  }

  const rows = await page.locator('tr:has(td.business_area)').evaluateAll(
    (nodes) => nodes.slice(0, 40).map((row) => ({
      flight: row.textContent ?? '',
      business: (row.querySelector('td.business_area') as HTMLElement | null)?.textContent ?? '',
    })));
  if (!rows.length) throw new Error('STRUCTURE_CHANGED');
  const offers = parseAsianaOffers(rows);
  const bookable = offers.filter((offer) => !offer.soldOut);
  return {
    origin, destination, date, cabin: 'business' as const,
    status: bookable.length ? 'available' as const : 'empty' as const,
    flights: bookable.map((offer) => `${offer.flightNumber} ${offer.text}`.trim()),
    soldOut: offers.length > 0 && !bookable.length,
    observedAt: new Date().toISOString(),
  };
}

/** Fills the form but stops before the search, so the 09:00 release costs only
 *  the two clicks that submit it. */
export async function prepareAsianaAward(page: Page, query: AsianaAwardQuery, cancelled: () => boolean): Promise<void> {
  const { origin, destination, date } = query;
  if (cancelled()) throw new Error('CANCELLED');
  await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page);
  if (/viewLogin/u.test(page.url())) throw new Error('LOGIN_REQUIRED');
  if (/Access Denied/iu.test(await page.locator('body').innerText())) throw new Error('ACCESS_RESTRICTED');

  const oneWay = page.getByRole('link', { name: '편도', exact: true });
  if (await oneWay.isVisible().catch(() => false)) await oneWay.click();
  else await page.getByText('편도', { exact: true }).first().click();
  await settle(page);

  await pickAirport(page, 'Departure', origin);
  await pickAirport(page, 'Arrival', destination);
  await chooseDate(page, date);

  const cabinLink = page.getByRole('link', { name: '비즈니스', exact: true });
  try { await cabinLink.first().click({ timeout: 8000 }); } catch { throw new Error('CABIN_UNAVAILABLE'); }
  await settle(page);
  await page.locator('#btn_coupon_layer').waitFor({ state: 'visible', timeout: 15_000 });
}

export async function searchAsianaAward(page: Page, query: AsianaAwardQuery & { prepared?: boolean }, cancelled: () => boolean) {
  const { origin, destination, date } = query;
  try {
    if (query.prepared) return await submitAsianaAward(page, query, cancelled);
    if (cancelled()) throw new Error('CANCELLED');
    await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page);
    if (/viewLogin/u.test(page.url())) throw new Error('LOGIN_REQUIRED');
    const body = await page.locator('body').innerText();
    if (/Access Denied/iu.test(body)) throw new Error('ACCESS_RESTRICTED');

    const oneWay = page.getByRole('link', { name: '편도', exact: true });
    if (await oneWay.isVisible().catch(() => false)) await oneWay.click();
    else await page.getByText('편도', { exact: true }).first().click();
    await settle(page);

    await pickAirport(page, 'Departure', origin);
    await pickAirport(page, 'Arrival', destination);
    await chooseDate(page, date);

    // Asiana refuses the search without a cabin ("좌석등급을 선택해주세요"), unlike
    // Korean Air which prices every cabin on the result page.
    const cabinLink = page.getByRole('link', { name: '비즈니스', exact: true });
    try { await cabinLink.first().click({ timeout: 8000 }); } catch { throw new Error('CABIN_UNAVAILABLE'); }
    await settle(page);

    const committed = {
      origin: await page.locator('#departureAirport1').inputValue(),
      destination: await page.locator('#arrivalAirport1').inputValue(),
      date: await page.locator('#departureDate1').inputValue(),
    };
    if (committed.origin !== origin || committed.destination !== destination
      || committed.date !== date.replace(/-/gu, '')) {
      if (process.env.AWARD_DEBUG === '1') console.error('[asiana-award] form mismatch:', JSON.stringify(committed));
      throw new Error('QUERY_MISMATCH');
    }

    return await submitAsianaAward(page, query, cancelled);
  } catch (error) {
    if (/viewLogin/u.test(page.url())) return { status: 'failed' as const, code: 'LOGIN_REQUIRED' };
    const code = error instanceof Error ? error.message : '';
    return { status: 'failed' as const, code: /^[A-Z_]+$/u.test(code) ? code : 'SEARCH_FAILED' };
  }
}
