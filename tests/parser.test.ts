import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { CalendarParseError, parseCalendarHtml, type CalendarParseErrorCode } from '../src/parser.js';
import type { ParseCalendarOptions } from '../src/types.js';

const fixture = readFileSync(new URL('./fixtures/public-calendar-icn-jfk-2027-04.html', import.meta.url), 'utf8');
const sinFixture = readFileSync(new URL('./fixtures/public-calendar-icn-sin-2026-11.html', import.meta.url), 'utf8');
const cdgFixture = readFileSync(new URL('./fixtures/public-calendar-icn-cdg-2026-11.html', import.meta.url), 'utf8');
const options: ParseCalendarOptions = {
  origin: 'ICN',
  destination: 'JFK',
  month: '2027-04',
  sourceUpdatedAt: '2026-09-06T23:00:00+09:00',
  collectedAt: '2026-09-07T11:34:00+09:00',
};

// Mutations below are synthetic defensive cases, not observed airline day-cell states.
function mutate(change: ($: CheerioAPI) => void): string {
  const $ = load(fixture);
  change($);
  return $.html();
}

function expectFailure(html: string, code: CalendarParseErrorCode, settings = options): void {
  let thrown: unknown;
  try {
    parseCalendarHtml(html, settings);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CalendarParseError);
  expect((thrown as CalendarParseError).code).toBe(code);
}

describe('observed anonymous ICN → JFK public calendar', () => {
  it('parses every date in the actual April fixture without inferring seat counts', () => {
    const result = parseCalendarHtml(fixture, options);
    expect(result).toMatchObject({
      ...options,
      tripType: 'ONE_WAY',
      source: 'KOREAN_AIR_PUBLIC_AWARD_CALENDAR',
    });
    expect(result.dates).toHaveLength(30);
    expect(result.dates.map(({ date }) => date)).toEqual(
      Array.from({ length: 30 }, (_, index) => `2027-04-${String(index + 1).padStart(2, '0')}`),
    );
    for (const date of result.dates) {
      expect(date).toMatchObject({
        operatingStatus: 'OPERATED',
        availabilityType: 'PUBLIC_INDICATOR',
        availableSeatCount: null,
        economyAward: true,
        premiumAward: false,
        prestigeAward: false,
        firstAward: false,
        economyUpgrade: false,
        premiumUpgrade: false,
        firstUpgrade: false,
      });
    }
  });

  it('keeps prestige upgrades separate from prestige awards on the five observed dates', () => {
    const { dates } = parseCalendarHtml(fixture, options);
    expect(dates.filter((date) => date.prestigeUpgrade).map(({ date }) => date)).toEqual([
      '2027-04-04', '2027-04-09', '2027-04-15', '2027-04-17', '2027-04-18',
    ]);
    expect(dates.some((date) => date.prestigeAward)).toBe(false);
  });

  it('reads only day-cell markers, so legend labels do not create availability', () => {
    const result = parseCalendarHtml(fixture, options);
    expect(fixture).toContain('일등석 보너스/좌석승급');
    expect(fixture).toContain('좌석 없음');
    expect(fixture).toContain('운항편 없음');
    expect(result.dates.every((date) => !date.firstAward && !date.firstUpgrade)).toBe(true);
  });

  it('preserves a missing source update time as null', () => {
    expect(parseCalendarHtml(fixture, { ...options, sourceUpdatedAt: null }).sourceUpdatedAt).toBeNull();
  });
});

describe('observed anonymous calendars for other exact airport pairs', () => {
  it('extracts the 14 real prestige award dates in ICN → SIN November', () => {
    const result = parseCalendarHtml(sinFixture, { ...options, destination: 'SIN', month: '2026-11' });
    expect(result.origin).toBe('ICN');
    expect(result.destination).toBe('SIN');
    expect(result.dates.filter((date) => date.prestigeAward).map(({ date }) => Number(date.slice(-2)))).toEqual([
      4, 5, 7, 9, 15, 16, 18, 20, 21, 24, 25, 27, 28, 29,
    ]);
    expect(result.dates.every((date) => date.availableSeatCount === null)).toBe(true);
  });

  it('accepts the exact no-seat structure observed in ICN → CDG without fabricating positive dates', () => {
    const result = parseCalendarHtml(cdgFixture, { ...options, destination: 'CDG', month: '2026-11' });
    const $ = load(cdgFixture);
    const noSeatDays = $('.bonus-calendar__day > span.ux-class-icon.-no-seat.-gray')
      .toArray().map((element) => $(element).closest('td').attr('id')?.replace('day_', ''));
    expect(noSeatDays).toHaveLength(4);
    for (const day of noSeatDays) {
      const date = result.dates.find((date) => Number(date.date.slice(-2)) === Number(day));
      expect(date).toBeDefined();
      expect(date?.economyAward).toBe(false);
      expect(date?.premiumAward).toBe(false);
      expect(date?.prestigeAward).toBe(false);
      expect(date?.firstAward).toBe(false);
      expect(date?.availableSeatCount).toBeNull();
    }
    expect(result.dates).toHaveLength(30);
    expect(result.dates.some((date) => date.prestigeAward)).toBe(false);
  });
});

describe('synthetic structural and marker defenses', () => {
  it.each(['2027-4', '2027-00', '2027-13', '2027-02-01', '0000-04', 'not-a-month'])(
    'rejects invalid requested month %s', (month) => {
      expectFailure(fixture, 'INVALID_MONTH', { ...options, month });
    },
  );

  it.each(['icn', '', 'ICNN', 'ICN|SIN'])('rejects malformed airport code %s', (origin) => {
    expectFailure(fixture, 'UNSUPPORTED_ROUTE', { ...options, origin });
  });

  it('rejects a valid code when the actual result still belongs to a different route', () => {
    expectFailure(fixture, 'ROUTE_MISMATCH', { ...options, destination: 'LAX' });
  });

  it('rejects identical origin and destination', () => {
    expectFailure(fixture, 'UNSUPPORTED_ROUTE', { ...options, destination: 'ICN' });
  });

  it.each(['출발지 서울/인천 ICN 도착지 로스앤젤레스 LAX', '출발지 뉴욕 JFK 도착지 서울 ICN'])(
    'rejects mismatching route or direction: %s', (title) => {
      expectFailure(mutate(($) => { $('#modals-travelCalendar-title').text(title); }), 'ROUTE_MISMATCH');
    },
  );

  it('rejects a response for a different month', () => {
    expectFailure(fixture, 'MONTH_MISMATCH', { ...options, month: '2027-05' });
  });

  it('rejects a missing or repeated result dialog', () => {
    expectFailure('', 'STRUCTURE_CHANGED');
    expectFailure(`${fixture}\n${fixture}`, 'STRUCTURE_CHANGED');
  });

  it('rejects a missing month selector', () => {
    expectFailure(mutate(($) => { $('#travelCalendarListBtn').remove(); }), 'STRUCTURE_CHANGED');
  });

  it('rejects a partial month even when its remaining dates look valid', () => {
    expectFailure(mutate(($) => { $('#day_30').remove(); }), 'INCOMPLETE_MONTH');
  });

  it('rejects duplicate dates instead of counting them as a complete month', () => {
    expectFailure(mutate(($) => { $('#day_30').replaceWith($('#day_29').clone()); }), 'DUPLICATE_DAY');
  });

  it('checks the month length and rejects April 31', () => {
    expectFailure(mutate(($) => {
      $('#day_30').attr('id', 'day_31');
      $('#day_31 .bonus-calendar__day > span[aria-hidden="true"]').text('31');
    }), 'INVALID_DAY');
  });

  it('rejects mismatching date ID and displayed day', () => {
    expectFailure(mutate(($) => {
      $('#day_4 .bonus-calendar__day > span[aria-hidden="true"]').text('5');
    }), 'INVALID_DAY');
  });

  it('rejects a hidden date instead of accepting it as a visible result', () => {
    expectFailure(mutate(($) => { $('#day_4').attr('aria-hidden', 'true'); }), 'INVALID_DAY');
  });

  it('rejects an unlabelled visible cell', () => {
    expectFailure(mutate(($) => { $('tbody td[aria-hidden="true"]').first().removeAttr('aria-hidden'); }), 'STRUCTURE_CHANGED');
  });

  it.each(['remove', 'empty'] as const)('rejects %s markers as unverified, never as no seats', (change) => {
    expectFailure(mutate(($) => {
      const icons = $('#day_1 .bonus-calendar__icons');
      if (change === 'remove') icons.remove();
      else icons.empty();
    }), 'EMPTY_UNVERIFIED_STATE');
  });

  it.each(['좌석 없음', '운항편 없음'])(
    'rejects synthetic unavailable markup: %s; only the legend was observed', (marker) => {
      expectFailure(mutate(($) => { $('#day_1 .bonus-calendar__icons li').text(marker); }), 'UNVERIFIED_UNAVAILABLE_STATE');
    },
  );

  it('preserves a combined first-class marker as unknown award/upgrade without losing other cabins', () => {
    const { dates } = parseCalendarHtml(mutate(($) => {
      $('#day_1 .bonus-calendar__icons li').text('일등석 보너스/좌석승급');
    }), options);
    expect(dates[0]).toMatchObject({ firstAward: null, firstUpgrade: null, firstAwardOrUpgrade: true });
    expect(dates[1]?.economyAward).toBe(true);
  });

  const cdgOptions = { ...options, destination: 'CDG', month: '2026-11' };
  const cdgCellWithMarkers = () => {
    const $ = load(cdgFixture);
    const cell = $('td[id^="day_"]').filter((_, element) => $(element).find('.bonus-calendar__icons li').length > 0).first();
    return { $, cell, day: Number(cell.attr('id')!.replace('day_', '')) };
  };

  it('reads an observed no-flight day as not operated rather than unreadable', () => {
    const { $, cell, day } = cdgCellWithMarkers();
    cell.find('.bonus-calendar__icons').remove();
    cell.find('.bonus-calendar__day').append('<span class="ux-class-icon -no-flight -gray">&nbsp;운항편 없음 </span>');
    const { dates } = parseCalendarHtml($.html(), cdgOptions);
    expect(dates.find((date) => date.date.endsWith(String(day).padStart(2, '0'))))
      .toMatchObject({ operatingStatus: 'NOT_OPERATED', economyAward: false, prestigeAward: false });
  });

  it('rejects a no-flight day that also claims available seats', () => {
    const { $, cell } = cdgCellWithMarkers();
    cell.find('.bonus-calendar__day').append('<span class="ux-class-icon -no-flight -gray">&nbsp;운항편 없음 </span>');
    expectFailure($.html(), 'STRUCTURE_CHANGED', cdgOptions);
  });

  it('rejects conflicting no-seat and positive availability markers', () => {
    const $ = load(cdgFixture);
    const cell = $('.bonus-calendar__day > span.ux-class-icon.-no-seat.-gray').first().closest('td');
    cell.append('<ul class="bonus-calendar__icons"><li>일반석 보너스</li></ul>');
    expectFailure($.html(), 'STRUCTURE_CHANGED', { ...options, destination: 'CDG', month: '2026-11' });
  });

  it.each(['일반석 보너스 없음', '일반석 좌석승급', '일등석 보너스', 'Unknown cabin', ''])(
    'rejects unobserved or malformed exact marker text: %s', (marker) => {
      expectFailure(mutate(($) => { $('#day_1 .bonus-calendar__icons li').text(marker); }), 'UNKNOWN_MARKER');
    },
  );

  it('rejects repeated markers', () => {
    expectFailure(mutate(($) => {
      $('#day_1 .bonus-calendar__icons').append($('#day_1 .bonus-calendar__icons li').clone());
    }), 'DUPLICATE_MARKER');
  });

  it.each([
    ['프리미엄석 보너스', 'premiumAward'],
    ['프리미엄석 좌석승급', 'premiumUpgrade'],
    ['프레스티지석 보너스', 'prestigeAward'],
    ['프레스티지석 좌석승급', 'prestigeUpgrade'],
  ] as const)('maps the observed legend %s exactly in a synthetic day cell', (marker, field) => {
    const html = mutate(($) => { $('#day_1 .bonus-calendar__icons li').text(marker); });
    const [first] = parseCalendarHtml(html, options).dates;
    expect(first?.[field]).toBe(true);
    expect(first?.economyAward).toBe(false);
    const trueFlags = Object.entries(first!).filter(([, value]) => value === true).map(([key]) => key);
    expect(trueFlags).toEqual([field]);
  });
});
