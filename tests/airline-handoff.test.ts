import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { CollectionError } from '../src/collector.js';
import {
  HandoffAccessGuard, handoffFilterPlan, handoffSelectionPlan, normalizeHandoffSelection,
  restrictedFirstPartyResponse, sanitizedHandoffFailure,
} from '../src/airline-handoff.js';

const now = new Date('2026-09-07T03:00:00Z');
const oneWay = {
  origin: 'ICN', destination: 'SIN', month: '2026-11',
  tripType: 'ONE_WAY', cabin: 'prestige', outboundDate: '2026-11-05',
};

describe('the selected itinerary crossing the localhost bridge', () => {
  it('normalizes airport codes and keeps the clicked date rather than the first award date', () => {
    expect(normalizeHandoffSelection({ ...oneWay, origin: ' icn ', destination: 'sin' }, now)).toEqual(oneWay);
    expect(handoffSelectionPlan(normalizeHandoffSelection(oneWay, now))).toMatchObject({
      tripSuffix: 'OW', months: ['2026-11'], awardLabels: ['프레스티지석 보너스'], outboundDay: 5, returnDay: null,
    });
  });

  it.each([
    { outboundDate: '2026-11-31' },
    { outboundDate: '2026-11-00' },
    { outboundDate: '2026-12-05' },
    { month: '2027-02', outboundDate: '2027-02-29' },
    { month: '2026-09', outboundDate: '2026-09-08' },
    { month: '2027-10', outboundDate: '2027-10-01' },
    { destination: 'ICN' },
    { destination: 'SIN.*' },
    { cabin: 'prestigeUpgrade' },
    { tripType: 'MULTI_CITY' },
    { returnDate: '2026-11-06', returnMonth: '2026-11' },
  ])('rejects invalid or inconsistent inputs before opening a browser: %j', (change) => {
    expect(() => normalizeHandoffSelection({ ...oneWay, ...change }, now)).toThrow();
  });

  it('plans two selections for a same-month round trip and keeps both clicked dates', () => {
    const result = normalizeHandoffSelection({
      ...oneWay, tripType: 'ROUND_TRIP', returnMonth: '2026-11', returnDate: '2026-11-18',
    }, now);
    expect(handoffSelectionPlan(result)).toEqual({
      tripSuffix: 'RT', months: ['2026-11', '2026-11'], awardLabels: ['프레스티지석 보너스'], outboundDay: 5, returnDay: 18,
    });
  });

  it.each([
    { returnMonth: '2026-10', returnDate: '2026-10-30' },
    { returnMonth: '2026-11', returnDate: '2026-11-04' },
    { returnMonth: '2026-11', returnDate: '2026-12-01' },
    { returnMonth: undefined, returnDate: '2026-12-01' },
  ])('rejects return dates that conflict with the selected journey: %j', (change) => {
    expect(() => normalizeHandoffSelection({ ...oneWay, tripType: 'ROUND_TRIP', ...change }, now)).toThrow();
  });
});

describe('all-class handoff only includes unambiguous mileage award filters', () => {
  it.each(['ONE_WAY', 'ROUND_TRIP'] as const)('accepts all classes for %s and preserves selected dates', (tripType) => {
    const selection = normalizeHandoffSelection({
      ...oneWay, cabin: 'all', tripType,
      ...(tripType === 'ROUND_TRIP' ? { returnMonth: '2026-11', returnDate: '2026-11-18' } : {}),
    }, now);
    expect(selection.cabin).toBe('all');
    expect(handoffSelectionPlan(selection)).toMatchObject({
      awardLabels: ['일반석 보너스', '프리미엄석 보너스', '프레스티지석 보너스'],
      outboundDay: 5, returnDay: tripType === 'ROUND_TRIP' ? 18 : null,
    });
  });

  it('enables three award filters and explicitly disables both upgrades and the mixed first-class filter', () => {
    expect(handoffFilterPlan('all')).toEqual([
      { name: '일반석 보너스', checked: true },
      { name: '프리미엄석 보너스', checked: true },
      { name: '프레스티지석 보너스', checked: true },
      { name: '프리미엄석 좌석승급', checked: false },
      { name: '프레스티지석 좌석승급', checked: false },
      { name: '일등석 보너스/좌석승급', checked: false },
    ]);
  });

  it.each([
    ['economy', '일반석 보너스'], ['premium', '프리미엄석 보너스'], ['prestige', '프레스티지석 보너스'],
  ] as const)('keeps %s limited to its one award type', (cabin, name) => {
    const plan = handoffFilterPlan(cabin);
    expect(plan).toHaveLength(6);
    expect(plan.filter(({ checked }) => checked)).toEqual([{ name, checked: true }]);
    expect(plan.filter(({ name }) => name.includes('좌석승급')).every(({ checked }) => !checked)).toBe(true);
  });
});

describe('restriction handling without making browser or network requests', () => {
  function fakePage(body = '') {
    const events = new EventEmitter();
    return Object.assign(events, { locator: vi.fn(() => ({ innerText: vi.fn(async () => body) })) });
  }

  it.each([401, 403, 429])('stops on first-party HTTP %s even for a supporting airport resource', (status) => {
    expect(restrictedFirstPartyResponse('https://www.koreanair.com/api/airport', status)).toBe(true);
    expect(restrictedFirstPartyResponse('https://koreanair.com/anything', status)).toBe(true);
    expect(restrictedFirstPartyResponse('https://koreanair.com.attacker.example/path', status)).toBe(false);
    expect(restrictedFirstPartyResponse('https://thirdparty.example/analytics', status)).toBe(false);
  });

  it('does not misclassify a successful or invalid URL as an access restriction', () => {
    expect(restrictedFirstPartyResponse('https://www.koreanair.com/', 200)).toBe(false);
    expect(restrictedFirstPartyResponse('invalid', 403)).toBe(false);
  });

  it('prevents any subsequent UI action after a blocked response', async () => {
    const page = fakePage();
    const guard = new HandoffAccessGuard(page as unknown as Page);
    const click = vi.fn(async () => undefined);
    page.emit('response', { url: () => 'https://www.koreanair.com/api/airport', status: () => 403 });
    await expect(guard.step(click)).rejects.toMatchObject({ code: 'ACCESS_RESTRICTED' });
    expect(click).not.toHaveBeenCalled();
    guard.dispose();
    expect(page.listenerCount('response')).toBe(0);
  });

  it('interrupts a pending wait rather than waiting to issue the next action', async () => {
    const page = fakePage();
    const guard = new HandoffAccessGuard(page as unknown as Page);
    const click = vi.fn(async () => {
      page.emit('response', { url: () => 'https://www.koreanair.com/api/airport', status: () => 429 });
      return new Promise<never>(() => undefined);
    });
    await expect(guard.step(click)).rejects.toMatchObject({ code: 'ACCESS_RESTRICTED' });
    expect(click).toHaveBeenCalledTimes(1);
    guard.dispose();
  });

  it('stops at a visible security challenge without clicking it', async () => {
    const page = fakePage('Verify you are human');
    const guard = new HandoffAccessGuard(page as unknown as Page);
    const click = vi.fn(async () => undefined);
    await expect(guard.step(click)).rejects.toMatchObject({ code: 'USER_ACTION_REQUIRED' });
    expect(click).not.toHaveBeenCalled();
    guard.dispose();
  });

  it('does not forward browser errors containing page contents or session tokens', () => {
    const result = sanitizedHandoffFailure(new Error('Timeout at private?token=secret <html>private</html>'));
    expect(result).toMatchObject({ status: 'failed', code: 'HANDOFF_FAILED' });
    expect(JSON.stringify(result)).not.toMatch(/private|token|secret|html/u);
  });

  it.each([
    ['outbound_filter_apply', 'FILTER_FAILED'], ['return_date_detail', 'DATE_NOT_SELECTED'],
    ['origin_select', 'FORM_FAILED'], ['browser_open', 'BROWSER_OPEN_FAILED'],
  ])('identifies the failed public UI stage %s without including browser exception text', (stage, code) => {
    expect(sanitizedHandoffFailure(new Error('Timeout private?token=secret'), stage)).toMatchObject({ status: 'failed', stage, code });
    expect(JSON.stringify(sanitizedHandoffFailure(new Error('private'), stage))).not.toContain('private');
  });

  it('preserves an access restriction instead of relabeling it as a filter failure', () => {
    expect(sanitizedHandoffFailure(new CollectionError('ACCESS_RESTRICTED', '접근 제한'), 'outbound_filter_apply'))
      .toMatchObject({ code: 'ACCESS_RESTRICTED', stage: 'outbound_filter_apply' });
  });
});

describe('CLI output before any browser is launched', () => {
  it.each(['not json', '{}', 'x'.repeat(4097)])('returns one JSON line for invalid input', (input) => {
    let result: { stdout?: Buffer; stderr?: Buffer; status?: number } | undefined;
    try {
      execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/open-airline.ts'], { input, stdio: 'pipe' });
    } catch (error) { result = error as typeof result; }
    expect(result?.status).toBe(1);
    const lines = String(result?.stdout).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ status: 'failed', code: expect.any(String), message: expect.any(String) });
    expect(String(result?.stderr)).toBe('');
  });
});
