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

export interface AsianaAwardQuery { origin: string; destination: string; date: string; adults?: number; hold?: boolean; booking?: AsianaBookingPreferences }

const ENTRY_URL = 'https://flyasiana.com/I/KR/KO/RedemptionRegistTravel.do';
/** What the result page prints instead of a flight table on a day nothing flies. */
const NO_FLIGHT_NOTICE = /항공편이 없|조회된 항공편|검색 결과가 없|운항하지 않/u;
const TYPE_DELAY = 140;
const settle = (page: Page, ms = 1200) => page.waitForTimeout(ms);

/** Waits for something observable instead of for the clock.
 *
 *  The fixed pauses this replaces were doing two jobs badly: on a quick reply
 *  they burned the rest of the second, and on a slow one they moved on anyway.
 *  Each caller names the state it actually needs, so the flow costs what the
 *  page costs. `floor` keeps a beat where the form's own script needs one after
 *  the value lands. */
async function until(page: Page, ready: () => Promise<boolean>, timeout = 12_000, floor = 0): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await ready().catch(() => false)) {
      if (floor) await page.waitForTimeout(floor);
      return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}
/** Reads one of the form's hidden fields, which is where the page records what
 *  it actually committed — the visible box can show a name the form never took. */
const committedValue = (page: Page, id: string) => page.locator(`#${id}`).inputValue().catch(() => '');

/** Phase timings, so "make it faster" is aimed at the slow part rather than at
 *  whichever wait happens to look generous in the source. */
let phaseStart = 0;
function mark(label: string): void {
  if (process.env.AWARD_TIMING !== '1') return;
  const now = Date.now();
  if (phaseStart) console.error(`[asiana-award] ${label}: ${((now - phaseStart) / 1000).toFixed(1)}초`);
  phaseStart = now;
}

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
  // The suggestion is chosen once the form's own hidden field carries the code.
  const committed = `${field === 'Departure' ? 'departure' : 'arrival'}Airport1`;
  await until(page, async () => (await committedValue(page, committed)) === code, 10_000, 150);
}

/** Asiana books both travellers on one reservation, so the search must ask for
 *  that many seats: a flight with one left is not a flight a couple can take. */
async function setAdults(page: Page, adults: number): Promise<void> {
  if (adults <= 1) return;
  const field = page.locator('#adultCount');
  // The count is a stepper, not a select: typing into the box leaves the page's
  // own state at one, so the 증가 button is pressed until the value matches.
  const plus = field.locator('xpath=ancestor::div[contains(@class,"btn_number_box")][1]')
    .locator('button.btn_number.plus');
  for (let step = 0; step < 8; step++) {
    if ((await field.inputValue().catch(() => '')) === String(adults)) break;
    try { await plus.click({ timeout: 5000 }); } catch { throw new Error('PASSENGER_UNAVAILABLE'); }
    await until(page, async () => (await field.inputValue().catch(() => '')) === String(adults), 1500);
  }
  if ((await field.inputValue().catch(() => '')) !== String(adults)) throw new Error('PASSENGER_UNAVAILABLE');
  await page.waitForTimeout(150);
}

async function chooseDate(page: Page, date: string): Promise<void> {
  const target = new Date(date + 'T12:00:00Z');
  if (!(await page.locator('.ui-datepicker-title:visible').count())) {
    await page.locator('#sCalendar').click();
    await until(page, async () => (await page.locator('.ui-datepicker-title:visible').count()) > 0, 10_000, 150);
  }
  for (let step = 0; step < 18; step++) {
    const title = await page.locator('.ui-datepicker-title:visible').first().innerText();
    const match = title.match(/(20\d{2})\.\s*(\d+)/u);
    if (!match) throw new Error('DATE_UNAVAILABLE');
    const delta = (target.getUTCFullYear() - Number(match[1])) * 12 + target.getUTCMonth() + 1 - Number(match[2]);
    if (delta === 0 || delta === 1) break;
    await page.getByRole('link', { name: delta > 0 ? '다음달' : '이전달', exact: true }).click();
    await until(page, async () =>
      (await page.locator('.ui-datepicker-title:visible').first().innerText().catch(() => title)) !== title, 5000);
  }
  const cell = page.locator(`td[data-year="${target.getUTCFullYear()}"][data-month="${target.getUTCMonth()}"] a[data-date="${target.getUTCDate()}"]`);
  try { await cell.waitFor({ timeout: 8000 }); } catch { throw new Error('DATE_NOT_BOOKABLE'); }
  await cell.click();
  const compact = date.replace(/-/gu, '');
  await until(page, async () => (await committedValue(page, 'departureDate1')) === compact, 10_000, 150);
}

export interface AsianaRow { flight: string; business: string; radioId?: string; mileage?: string; cash?: string }
export interface AsianaOffer { flightNumber: string; soldOut: boolean; text: string; radioId: string; index: number }

/** Reads the business column of each flight row. The page states 매진 outright,
 *  so availability is never inferred from layout or from an absent marker.
 *
 *  Each offer keeps the row it came from. Rows without a business column are
 *  skipped, so a position in this list is not a position on the page — and
 *  holding a seat by position is how a first-class fare once got presented as
 *  business. The radio's own id travels with the offer instead. */
export function parseAsianaOffers(rows: AsianaRow[]): AsianaOffer[] {
  const offers: AsianaOffer[] = [];
  rows.forEach((row, index) => {
    const business = row.business.replace(/\s+/gu, ' ').trim();
    if (!business) return;
    const flightNumber = (row.flight.match(/OZ\s?\d{3,4}/u)?.[0] ?? '').replace(/\s/gu, '');
    // The page prints only the miles; the cash side lives in the radio's own
    // fare data, and it is the half that decides whether a fare is worth taking.
    // Both figures are per person — checked against a two-seat search, which
    // carried the same 100,500 here and charged KRW 201,000 at the till. Saying
    // "1인" is not decoration: a couple reading it as the total is off by half.
    const cash = Number(row.cash);
    const text = Number.isFinite(cash) && cash > 0
      ? `${business} + ${Math.round(cash).toLocaleString('ko-KR')}원 (1인)`
      : business;
    offers.push({
      flightNumber, soldOut: /매진|마감|선택 불가/u.test(business),
      text: text.slice(0, 60), radioId: row.radioId ?? '', index,
    });
  });
  return offers;
}

/** The page the fare leads to: passengers and payment on one screen. */
const BOOKING_PAGE = /RedemptionExpressBooking/u;

/** Who pays the miles and who flies, by Asiana membership number.
 *
 *  These are family members' numbers, so they are never written into the
 *  repository: they come from a local settings file the user owns. */
export interface AsianaBookingPreferences { deductFrom?: string[]; boarding?: string[] }

/** Flips one of the booking screen's switches. The checkbox itself is hidden
 *  behind its label, and rows that are fixed (the account holder's own) come
 *  through disabled — touching either would throw rather than do nothing. */
async function tickSwitch(page: Page, id: string): Promise<void> {
  if (!/^(mile|boarding)_\d{6,15}$/u.test(id)) return;
  const input = page.locator(`#${id}`);
  if (!(await input.count())) return;
  if (await input.isDisabled() || await input.isChecked()) return;
  await page.locator(`label[for="${id}"]`).click({ timeout: 8000 });
  // The page recalculates the mileage split after each switch; the next one is
  // only safe to touch once this one has registered.
  await until(page, () => input.isChecked(), 8000, 100);
}

/** Marks the family members who lend miles and the ones who travel.
 *  Deduction goes first: until the miles are covered the page prints 탑승 불가
 *  where the boarding switch would be. */
async function applyBookingPreferences(page: Page, prefs: AsianaBookingPreferences): Promise<void> {
  for (const account of prefs.deductFrom ?? []) await tickSwitch(page, `mile_${account}`);
  for (const account of prefs.boarding ?? []) await tickSwitch(page, `boarding_${account}`);
}

/** Takes the flow as far as the airline's own payment screen and stops there.
 *  The fare radio is transparent and its label carries the click, as on Korean
 *  Air. Nothing here pays: the security code, the contact details and 결제하기
 *  are the user's — Asiana puts a CAPTCHA in front of payment, so this screen
 *  is genuinely as far as any automation reaches. */
async function holdAsianaFare(page: Page, offer: AsianaOffer, prefs: AsianaBookingPreferences = {}) {
  if (!offer.radioId) return { held: false, reason: 'NO_FARE_CONTROL' };
  try {
    await page.locator(`label[for="${offer.radioId}"]`).click({ timeout: 10_000 });
    if (!(await page.locator(`#${offer.radioId}`).isChecked())) return { held: false, reason: 'FARE_NOT_SELECTED' };
    await page.locator('#express_next_btn:visible, #nextbtn:visible').first().click({ timeout: 12_000 });
    await page.waitForURL(BOOKING_PAGE, { timeout: 30_000 });
    // The passenger table is drawn after the page arrives; the switches do not
    // exist until it is, and clicking at a fixed moment raced it.
    await until(page, async () => (await page.locator('input[name="mile"]').count()) > 0, 25_000, 200);
    await applyBookingPreferences(page, prefs);
    return { held: true, reason: '' };
  } catch (error) {
    // A bare false is what made the last failure undiagnosable; the reason is
    // carried back and the detail is logged.
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    if (process.env.AWARD_DEBUG === '1') console.error('[asiana-award] hold 실패:', detail);
    return { held: false, reason: /Timeout/u.test(detail) ? 'BOOKING_PAGE_TIMEOUT' : 'HOLD_FAILED' };
  }
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
    const confirm = page.locator('button[onclick*="toFlightsSelect"]:visible');
    await until(page, () => confirm.first().isVisible(), 15_000, 100);
    mark('조회 버튼');
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
  // The result page arrives printing "Loading" and fills the flight table over a
  // second request. A fixed pause read that empty table whenever Asiana took
  // longer than the pause — reported as STRUCTURE_CHANGED, as if the page had
  // been redesigned. Wait for the table itself, or for the notice that stands in
  // its place when nothing flies that day.
  const tableDeadline = Date.now() + 40_000;
  while (Date.now() < tableDeadline) {
    if (cancelled()) throw new Error('CANCELLED');
    if (await page.locator('tr:has(td.business_area)').count().catch(() => 0)) break;
    const text = await page.locator('body').innerText().catch(() => '');
    if (NO_FLIGHT_NOTICE.test(text)) break;
    await page.waitForTimeout(200);
  }
  await settle(page, 250);
  mark('결과 표');

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

  const rows: AsianaRow[] = await page.locator('tr:has(td.business_area)').evaluateAll(
    (nodes) => nodes.slice(0, 40).map((row) => {
      const cell = row.querySelector('td.business_area');
      const radio = cell?.querySelector('input[type="radio"]') as HTMLInputElement | null;
      let fare: Record<string, string> = {};
      try { fare = JSON.parse(radio?.getAttribute('data-paxfare') ?? '[]')[0] ?? {}; } catch { fare = {}; }
      return {
        flight: row.textContent ?? '', business: cell?.textContent ?? '',
        radioId: radio?.id ?? '', mileage: fare.mileage ?? '', cash: fare.totalAmount ?? '',
      };
    }));
  // No rows and a notice means the day is simply blank; no rows and no notice
  // means we are reading something we do not understand, which must not pass as
  // "no seats" — a false empty is indistinguishable from a real one downstream.
  if (!rows.length) {
    if (NO_FLIGHT_NOTICE.test(shown)) {
      return {
        origin, destination, date, cabin: 'business' as const, status: 'empty' as const,
        flights: [], soldOut: false, observedAt: new Date().toISOString(),
      };
    }
    if (process.env.AWARD_DEBUG === '1') console.error('[asiana-award] no rows:', shown.slice(0, 300));
    throw new Error('STRUCTURE_CHANGED');
  }
  const offers = parseAsianaOffers(rows);
  const bookable = offers.filter((offer) => !offer.soldOut);
  const hold = query.hold && bookable.length
    ? await holdAsianaFare(page, bookable[0], query.booking ?? {})
    : { held: false, reason: '' };
  mark('운임 선택+결제화면');
  return {
    origin, destination, date, cabin: 'business' as const,
    status: bookable.length ? 'available' as const : 'empty' as const,
    flights: bookable.map((offer) => `${offer.flightNumber} ${offer.text}`.trim()),
    soldOut: offers.length > 0 && !bookable.length,
    held: hold.held, holdFailure: hold.reason,
    observedAt: new Date().toISOString(),
  };
}

/** Fills the form but stops before the search, so the 09:00 release costs only
 *  the two clicks that submit it. */
export async function prepareAsianaAward(page: Page, query: AsianaAwardQuery, cancelled: () => boolean): Promise<void> {
  const { origin, destination, date } = query;
  if (cancelled()) throw new Error('CANCELLED');
  await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await until(page, () => page.locator('#txtDepartureAirport1').isVisible(), 20_000, 200);
  if (/viewLogin/u.test(page.url())) throw new Error('LOGIN_REQUIRED');
  if (/Access Denied/iu.test(await page.locator('body').innerText())) throw new Error('ACCESS_RESTRICTED');

  const oneWay = page.getByRole('link', { name: '편도', exact: true });
  if (await oneWay.isVisible().catch(() => false)) await oneWay.click();
  else await page.getByText('편도', { exact: true }).first().click();
  await until(page, () => page.locator('#txtDepartureAirport1').isEditable(), 10_000, 150);

  await pickAirport(page, 'Departure', origin);
  await pickAirport(page, 'Arrival', destination);
  await chooseDate(page, date);
  await setAdults(page, query.adults ?? 1);

  const cabinLink = page.getByRole('link', { name: '비즈니스', exact: true });
  try { await cabinLink.first().click({ timeout: 8000 }); } catch { throw new Error('CABIN_UNAVAILABLE'); }
  await page.locator('#btn_coupon_layer').waitFor({ state: 'visible', timeout: 15_000 });
}

export async function searchAsianaAward(page: Page, query: AsianaAwardQuery & { prepared?: boolean }, cancelled: () => boolean) {
  const { origin, destination, date } = query;
  try {
    if (query.prepared) return await submitAsianaAward(page, query, cancelled);
    if (cancelled()) throw new Error('CANCELLED');
    phaseStart = Date.now();
    await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await until(page, () => page.locator('#txtDepartureAirport1').isVisible(), 20_000, 200);
    mark('폼 열기');
    if (/viewLogin/u.test(page.url())) throw new Error('LOGIN_REQUIRED');
    const body = await page.locator('body').innerText();
    if (/Access Denied/iu.test(body)) throw new Error('ACCESS_RESTRICTED');

    const oneWay = page.getByRole('link', { name: '편도', exact: true });
    if (await oneWay.isVisible().catch(() => false)) await oneWay.click();
    else await page.getByText('편도', { exact: true }).first().click();
    await until(page, () => page.locator('#txtDepartureAirport1').isEditable(), 10_000, 150);
    mark('편도');

    await pickAirport(page, 'Departure', origin);
    mark('출발지');
    await pickAirport(page, 'Arrival', destination);
    mark('도착지');
    await chooseDate(page, date);
    mark('날짜');
    await setAdults(page, query.adults ?? 1);
    mark('인원');

    // Asiana refuses the search without a cabin ("좌석등급을 선택해주세요"), unlike
    // Korean Air which prices every cabin on the result page.
    const cabinLink = page.getByRole('link', { name: '비즈니스', exact: true });
    try { await cabinLink.first().click({ timeout: 8000 }); } catch { throw new Error('CABIN_UNAVAILABLE'); }
    await until(page, () => page.locator('#btn_coupon_layer').isVisible(), 15_000, 150);
    mark('좌석등급');

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
