import { chromium, type Page } from 'playwright';
import { parseCalendarHtml } from './parser.js';

export const SOURCE_URL =
  'https://www.koreanair.com/booking/book-and-manage/award-seat-availability';
// Observed in the browser on 2026-09-07. Only observe the UI's response; never replay it.
const OBSERVED_RESPONSE_PATH = '/api/hmp/bonusSeatView/bonusSeatView';
const FILTER_LABELS = [
  '일반석 보너스',
  '프리미엄석 보너스',
  '프리미엄석 좌석승급',
  '프레스티지석 보너스',
  '프레스티지석 좌석승급',
  '일등석 보너스/좌석승급',
] as const;

const HEADLESS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export class CollectionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CollectionError';
  }
}

export function parseSourceUpdatedAt(text: string): string | null {
  const match = text.match(
    /좌석 상황은 대한민국 시간\((\d{4})년 (\d{1,2})월 (\d{1,2})일 (\d{2}):(\d{2})\) 기준/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const value = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour}:${minute}:00+09:00`;
  if (!Number.isFinite(Date.parse(value))) return null;
  return value;
}

export function validateFutureMonth(month: string, now = new Date()): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new CollectionError('INVALID_MONTH', '탑승월은 YYYY-MM 형식이어야 합니다.');
  }
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const start = Date.parse(`${month}-01T00:00:00+09:00`);
  const currentDay = Date.parse(`${today}T00:00:00+09:00`);
  // A month qualifies once its first day is bookable. Later days in it may still
  // be past the horizon; those are recorded as NOT_YET_OPEN, never as no seats.
  // The airline opens the date 360 days out each morning at 09:00 KST.
  if (start <= currentDay || start > currentDay + 360 * 86_400_000) {
    throw new CollectionError('MONTH_OUT_OF_RANGE', '향후 360일 안에 시작하는 미래 한 달을 선택하세요.');
  }
}

async function checkRestriction(page: Page, blockedStatus: number | null): Promise<void> {
  if (blockedStatus) {
    throw new CollectionError('ACCESS_RESTRICTED', `공개 조회 응답 HTTP ${blockedStatus}: 재시도 없이 중단했습니다.`);
  }
  // Generic visible error text only. Do not inspect or manipulate security internals.
  const text = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
  if (/access denied|접근이 차단|접속이 차단|비정상적인 접근|보안 문자|자동입력 방지|로봇이 아님|verify you are human/i.test(text)) {
    throw new CollectionError('USER_ACTION_REQUIRED', '접근 제한 또는 보안 확인 화면입니다. 자동 처리를 중단했습니다.');
  }
}

function describeResponse(value: unknown) {
  const root = value as { flightList?: { flightDetailList?: Record<string, unknown>[] }[] };
  const dates = Array.isArray(root?.flightList) ? root.flightList : [];
  const records = dates.flatMap((day) => Array.isArray(day.flightDetailList) ? day.flightDetailList : []);
  return {
    endpoint: OBSERVED_RESPONSE_PATH,
    method: 'POST',
    dayCount: dates.length,
    statusRecordCount: records.length,
    fields: [...new Set(records.flatMap((record) => Object.keys(record)))].sort(),
    availableSeatTypes: [...new Set(records.map((record) => typeof record.availableSeat))],
    numericFields: [...new Set(records.flatMap((record) =>
      Object.entries(record).filter(([, value]) => typeof value === 'number').map(([key]) => key)))],
    note: '상태 항목 개수는 잔여 좌석 수가 아닙니다. 실제 날짜별 결과는 화면 DOM에서 추출합니다.',
  };
}

export interface CollectionOptions {
  origin?: string;
  destination?: string;
  /** The localhost application only needs calendar data, never page/session artifacts. */
  captureArtifacts?: boolean;
}

export function validateRoute(origin: string, destination: string): void {
  if (!/^[A-Z]{3}$/u.test(origin) || !/^[A-Z]{3}$/u.test(destination) || origin === destination) {
    throw new CollectionError('INVALID_ROUTE', '서로 다른 출발·도착 공항의 영문 3자리 코드를 입력하세요.');
  }
}

export async function collectMonth(month: string, headless = false, options: CollectionOptions = {}) {
  validateFutureMonth(month);
  const { origin = 'ICN', destination = 'JFK', captureArtifacts = true } = options;
  validateRoute(origin, destination);
  const browser = await chromium.launch({ channel: 'chrome', headless });
  const context = await browser.newContext({
    locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1440, height: 1100 },
    // Chrome's own headless user agent is refused by the airline edge with an HTTP2
    // error. The window is what stays hidden; the browser identifies itself normally.
    ...(headless ? { userAgent: HEADLESS_USER_AGENT } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  let blockedStatus: number | null = null;
  const requests: { method: string; path: string; status: number }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname !== 'koreanair.com' && !url.hostname.endsWith('.koreanair.com')) return;
    // Stop on a restriction from any first-party resource, including airport lookups.
    if ([401, 403, 429].includes(response.status())) blockedStatus = response.status();
    const mainDocument = response.request().isNavigationRequest() && response.frame() === page.mainFrame();
    if (url.pathname === OBSERVED_RESPONSE_PATH || mainDocument) {
      requests.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  });
  try {
    await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await checkRestriction(page, blockedStatus);
    await page.locator('#bonusTripTypeLabel_OW').waitFor({ state: 'attached', timeout: 30_000 });
    const consent = page.getByRole('button', { name: '필수 쿠키만 허용', exact: true });
    try {
      await consent.waitFor({ state: 'visible', timeout: 8_000 });
      await consent.click();
    } catch (error) {
      // Some regions do not present this banner. Continue only with an accessible form.
      if (!(await page.getByRole('radio', { name: '편도', exact: true }).isVisible())) throw error;
    }
    await checkRestriction(page, blockedStatus);
    const sourceUpdatedAt = parseSourceUpdatedAt(await page.locator('body').innerText());
    await page.locator('#bonusTripTypeLabel_OW').click();
    if (!(await page.locator('#bonusTripType_OW').isChecked())) {
      throw new CollectionError('STRUCTURE_CHANGED', '편도 선택 상태를 확인하지 못했습니다.');
    }
    await page.getByRole('button', { name: 'From 출발지', exact: true }).click();
    // The observed autocomplete requires per-key events; fill alone did not show
    // candidates. Preserve the verified UI entry method for every airport code.
    await page.getByRole('combobox', { name: '출발지 검색', exact: true }).pressSequentially(origin, { delay: 60 });
    await page.getByRole('option', { name: new RegExp(`^${origin}\\b`, 'u') }).click();
    await checkRestriction(page, blockedStatus);
    await page.getByRole('button', { name: 'To 도착지', exact: true }).click();
    await page.getByRole('combobox', { name: '도착지 검색', exact: true }).pressSequentially(destination, { delay: 60 });
    await page.getByRole('option', { name: new RegExp(`^${destination}\\b`, 'u') }).click();
    await checkRestriction(page, blockedStatus);
    await page.locator('#seatCalendarBtn').click();
    const [year, number] = month.split('-');
    await page.getByRole('group', { name: year, exact: true }).getByRole('button', { name: `${Number(number)}월`, exact: true }).click();
    await page.getByRole('button', { name: '선택', exact: true }).click();
    await checkRestriction(page, blockedStatus);

    // A single monthly search. There is no day-by-day navigation or direct API client.
    const responseObservation = captureArtifacts ? page.waitForResponse(
      (response) => new URL(response.url()).pathname === OBSERVED_RESPONSE_PATH,
      { timeout: 25_000 },
    ).then(async (response) => response.ok() ? describeResponse(await response.json()) : null).catch(() => null) : Promise.resolve(null);
    await page.getByRole('button', { name: '조회', exact: true }).click();
    const dialog = page.locator('[role="dialog"][aria-labelledby="modals-travelCalendar-title"]');
    await dialog.locator('#bonusCalendarTableWrapEl tbody td[id^="day_"]').first().waitFor({ timeout: 30_000 });
    await checkRestriction(page, blockedStatus);
    await dialog.locator('#bonusFilterBtn').click();
    const filter = page.getByRole('dialog', { name: '보너스 좌석 필터', exact: true });
    if (await filter.getByRole('checkbox').count() !== FILTER_LABELS.length) {
      throw new CollectionError('STRUCTURE_CHANGED', '좌석 필터 구조가 변경되었습니다.');
    }
    for (const name of FILTER_LABELS) {
      if (!(await filter.getByRole('checkbox', { name, exact: true }).isChecked())) {
        throw new CollectionError('FILTERED_RESULT', '일부 좌석 종류가 숨겨져 있어 수집을 중단했습니다.');
      }
    }
    await filter.getByRole('button', { name: '닫기', exact: true }).click();
    const html = await dialog.evaluate((element) => element.outerHTML);
    const data = parseCalendarHtml(html, {
      origin, destination, month, sourceUpdatedAt, collectedAt: new Date().toISOString(),
    });
    const screenshot = captureArtifacts ? await dialog.screenshot() : Buffer.alloc(0);
    return { data, html: captureArtifacts ? html : '', screenshot, evidence: {
      sourceUrl: SOURCE_URL, sourceDescription: '대한항공 공개 현황 기준',
      loggedIn: false, persistedSessionUsed: false, method: 'MONTHLY_DOM',
      requests, responseObservation: await responseObservation,
      cookies: captureArtifacts ? (await context.cookies()).map(({ name, domain, httpOnly, secure, sameSite }) =>
        ({ name, domain, httpOnly, secure, sameSite })) : [],
    } };
  } catch (error) {
    await checkRestriction(page, blockedStatus);
    throw error;
  } finally {
    await browser.close();
  }
}
