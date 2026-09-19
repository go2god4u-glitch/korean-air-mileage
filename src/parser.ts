import { load } from 'cheerio';
import type { AwardCalendar, AwardDate, ParseCalendarOptions } from './types.js';

export type CalendarParseErrorCode =
  | 'INVALID_MONTH'
  | 'UNSUPPORTED_ROUTE'
  | 'STRUCTURE_CHANGED'
  | 'ROUTE_MISMATCH'
  | 'MONTH_MISMATCH'
  | 'INVALID_DAY'
  | 'DUPLICATE_DAY'
  | 'INCOMPLETE_MONTH'
  | 'EMPTY_UNVERIFIED_STATE'
  | 'UNVERIFIED_UNAVAILABLE_STATE'
  | 'UNKNOWN_MARKER'
  | 'DUPLICATE_MARKER'
  | 'AMBIGUOUS_FIRST_CLASS';

export class CalendarParseError extends Error {
  constructor(public readonly code: CalendarParseErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CalendarParseError';
  }
}

const normalize = (text: string): string => text.replace(/\s+/gu, ' ').trim();

// Exact Korean legend labels observed on the official public calendar.
// First class is handled separately because its award/upgrade label is ambiguous.
const markerFields = new Map<string, keyof Pick<AwardDate,
  'economyAward' | 'premiumAward' | 'prestigeAward' | 'premiumUpgrade' | 'prestigeUpgrade'
>>([
  ['일반석 보너스', 'economyAward'],
  ['프리미엄석 보너스', 'premiumAward'],
  ['프레스티지석 보너스', 'prestigeAward'],
  ['프리미엄석 좌석승급', 'premiumUpgrade'],
  ['프레스티지석 좌석승급', 'prestigeUpgrade'],
]);

/**
 * Parse the observed anonymous one-way calendar DOM for an exact airport pair.
 * The caller must verify that all six UI filters are selected before capture.
 * Unsupported and unobserved states fail closed rather than inventing availability.
 */
export function parseCalendarHtml(html: string, options: ParseCalendarOptions): AwardCalendar {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(options.month) || Number(options.month.slice(0, 4)) < 1000) {
    throw new CalendarParseError('INVALID_MONTH', 'Expected a valid YYYY-MM month.');
  }
  if (!/^[A-Z]{3}$/u.test(options.origin) || !/^[A-Z]{3}$/u.test(options.destination) || options.origin === options.destination) {
    throw new CalendarParseError('UNSUPPORTED_ROUTE', 'Expected two distinct uppercase three-letter airport codes.');
  }

  const $ = load(html);
  const dialog = $('[role="dialog"][aria-labelledby="modals-travelCalendar-title"]');
  if (dialog.length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Expected exactly one public calendar dialog.');
  }
  const title = dialog.find('#modals-travelCalendar-title');
  if (title.length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Calendar route heading is missing or duplicated.');
  }
  const routeCodes = normalize(title.text()).match(/\b[A-Z]{3}\b/gu) ?? [];
  if (routeCodes.length !== 2 || routeCodes[0] !== options.origin || routeCodes[1] !== options.destination) {
    throw new CalendarParseError('ROUTE_MISMATCH', 'Calendar heading does not match the requested route and direction.');
  }

  const monthButton = dialog.find('#travelCalendarListBtn');
  if (monthButton.length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Calendar month selector is missing or duplicated.');
  }
  const displayedMonth = /^(\d{4})년 (\d{1,2})월$/u.exec(normalize(monthButton.text()));
  const [year, month] = options.month.split('-').map(Number) as [number, number];
  if (!displayedMonth || Number(displayedMonth[1]) !== year || Number(displayedMonth[2]) !== month) {
    throw new CalendarParseError('MONTH_MISMATCH', 'Displayed calendar month does not match the requested month.');
  }

  const tables = dialog.find('#bonusCalendarTableWrapEl table.bonus-calendar__table');
  if (tables.length !== 1 || tables.find('tbody').length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Expected exactly one calendar table and body.');
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const seenDays = new Set<number>();
  const dates: AwardDate[] = [];

  for (const element of tables.find('tbody td').toArray()) {
    const cell = $(element);
    const id = cell.attr('id');
    if (!id) {
      // The only observed padding cells are hidden, empty cells without IDs.
      if (cell.attr('aria-hidden') !== 'true' || normalize(cell.text()) !== '' || cell.children().length !== 0) {
        throw new CalendarParseError('STRUCTURE_CHANGED', 'Unexpected calendar cell without a date ID.');
      }
      continue;
    }
    const dayId = /^day_([1-9]\d?)$/u.exec(id);
    const day = Number(dayId?.[1]);
    if (!dayId || day < 1 || day > daysInMonth || cell.attr('aria-hidden') === 'true') {
      throw new CalendarParseError('INVALID_DAY', 'Calendar contains an invalid or hidden day.');
    }
    if (seenDays.has(day)) {
      throw new CalendarParseError('DUPLICATE_DAY', `Day ${day} appears more than once.`);
    }
    seenDays.add(day);

    const dayLabel = cell.find('.bonus-calendar__day > span[aria-hidden="true"]');
    if (dayLabel.length !== 1 || normalize(dayLabel.text()) !== String(day)) {
      throw new CalendarParseError('INVALID_DAY', `Day ${day} does not match its displayed date.`);
    }

    const icons = cell.find('.bonus-calendar__icons');
    const markerElements = icons.find('li');
    if (icons.length > 1) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} has multiple marker containers.`);
    }
    // Exact no-seat day-cell structure observed in ICN→CDG November 2026.
    const noSeat = cell.find('.bonus-calendar__day > span.ux-class-icon.-no-seat.-gray');
    const verifiedNoSeat = noSeat.length === 1 && normalize(noSeat.text()) === '좌석 없음';
    if (noSeat.length > 0 && (!verifiedNoSeat || markerElements.length > 0)) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} has inconsistent no-seat and availability markers.`);
    }
    // A day the route simply does not fly, observed in ICN→CDG December 2026. It is
    // a known state, not an unreadable one, and it never means a seat was missed.
    const noFlight = cell.find('.bonus-calendar__day > span.ux-class-icon.-no-flight.-gray');
    const verifiedNoFlight = noFlight.length === 1 && normalize(noFlight.text()) === '운항편 없음';
    if (noFlight.length > 0 && (!verifiedNoFlight || markerElements.length > 0 || verifiedNoSeat)) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} has inconsistent no-flight and availability markers.`);
    }
    if (markerElements.length === 0 && !verifiedNoSeat && !verifiedNoFlight) {
      throw new CalendarParseError('EMPTY_UNVERIFIED_STATE', `Day ${day} has no verified availability markers; unavailable-day DOM has not been observed.`);
    }

    const date: AwardDate = {
      date: `${options.month}-${String(day).padStart(2, '0')}`,
      operatingStatus: verifiedNoFlight ? 'NOT_OPERATED' : 'OPERATED',
      availabilityType: 'PUBLIC_INDICATOR',
      availableSeatCount: null,
      economyAward: false,
      premiumAward: false,
      prestigeAward: false,
      firstAward: false,
      firstAwardOrUpgrade: false,
      economyUpgrade: false,
      premiumUpgrade: false,
      prestigeUpgrade: false,
      firstUpgrade: false,
    };
    const seenMarkers = new Set<string>();
    for (const markerElement of markerElements.toArray()) {
      const marker = normalize($(markerElement).text());
      if (seenMarkers.has(marker)) {
        throw new CalendarParseError('DUPLICATE_MARKER', `Day ${day} repeats an availability marker.`);
      }
      seenMarkers.add(marker);
      if (marker === '일등석 보너스/좌석승급') {
        date.firstAward = null;
        date.firstUpgrade = null;
        date.firstAwardOrUpgrade = true;
        continue;
      }
      if (marker === '좌석 없음' || marker === '운항편 없음') {
        throw new CalendarParseError('UNVERIFIED_UNAVAILABLE_STATE', `Day ${day} uses an unavailable-state label whose actual day-cell DOM has not been observed.`);
      }
      const field = markerFields.get(marker);
      if (!field) {
        throw new CalendarParseError('UNKNOWN_MARKER', `Day ${day} contains an unknown availability marker.`);
      }
      date[field] = true;
    }
    dates.push(date);
  }

  if (seenDays.size !== daysInMonth) {
    throw new CalendarParseError('INCOMPLETE_MONTH', `Expected ${daysInMonth} distinct days; received ${seenDays.size}.`);
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  return {
    origin: options.origin,
    destination: options.destination,
    tripType: 'ONE_WAY',
    month: options.month,
    source: 'KOREAN_AIR_PUBLIC_AWARD_CALENDAR',
    sourceUpdatedAt: options.sourceUpdatedAt,
    collectedAt: options.collectedAt,
    dates,
  };
}
