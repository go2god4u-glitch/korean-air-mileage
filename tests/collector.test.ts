import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollectionError, validateFutureMonth, validateRoute } from '../src/collector.js';

describe('bounded public collection input', () => {
  it('accepts a reversed airport pair without hardcoding ICN as the departure', () => {
    expect(() => validateRoute('SIN', 'ICN')).not.toThrow();
  });

  it.each([['ICN', 'ICN'], ['SEL', 'SIN.*'], ['icn', 'SIN'], ['', 'JFK']])(
    'rejects unsafe or identical route %s → %s before any browser work', (origin, destination) => {
      expect(() => validateRoute(origin, destination)).toThrow(CollectionError);
    },
  );

  it('rejects the current month and months starting past the booking horizon', () => {
    const now = new Date('2026-09-07T03:00:00Z');
    expect(() => validateFutureMonth('2026-09', now)).toThrow(CollectionError);
    expect(() => validateFutureMonth('2027-10', now)).toThrow(CollectionError);
    expect(() => validateFutureMonth('2026-11', now)).not.toThrow();
    // The airline opens this month even though its later days are not bookable yet.
    expect(() => validateFutureMonth('2027-09', now)).not.toThrow();
  });
});

describe('local CLI failure protocol without network access', () => {
  it.each([
    [[], 'INVALID_ARGUMENTS'],
    [['--origin', 'ICN', '--origin', 'SIN', '--month', '2027-04'], 'INVALID_ARGUMENTS'],
    [['--origin', 'ICN', '--destination', 'SIN', '--month', '2027-13'], 'INVALID_MONTH'],
  ] as const)('prints one sanitized JSON error for invalid input %j', (args, code) => {
    let result: { stdout?: Buffer; stderr?: Buffer; status?: number } | undefined;
    try {
      execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/local-collect.ts', ...args], { stdio: 'pipe' });
    } catch (error) {
      result = error as typeof result;
    }
    expect(result?.status).toBe(1);
    expect(String(result?.stdout)).toBe('');
    const failure = JSON.parse(String(result?.stderr));
    expect(failure).toEqual({ code, message: expect.any(String) });
  });
});
