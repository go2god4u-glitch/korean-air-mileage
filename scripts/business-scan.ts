// Unattended sweep of the Korean Air public bonus-seat calendar across a curated
// destination list, looking only for prestige (business) award seats. Meant to run
// on a schedule (GitHub Actions), never interactively. One call per
// origin/destination/month, same as the interactive collector — no retries, no
// concurrency, and an immediate stop on any access restriction.
//
// Runs fully headless: the airline edge only refuses Chrome's own headless user
// agent, which the collector overrides, so no browser window is ever created.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { openNativeChrome, NATIVE_USER_AGENT } from '../src/sas/native-chrome.js';
import { collectMonth, CollectionError, validateFutureMonth, SOURCE_URL } from '../src/collector.js';
import { CalendarParseError } from '../src/parser.js';
import { searchAsiana } from '../src/partners/asiana.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = resolve(ROOT, 'config/business-watch.json');
const WATCHES_PATH = resolve(ROOT, 'config/watches.json');
const STATE_PATH = resolve(ROOT, 'public-data/business-hits.json');
const STOP_CODES = new Set(['ACCESS_RESTRICTED', 'USER_ACTION_REQUIRED', 'LOGIN_REQUIRED']);

interface Destination { code: string; name: string }
interface Config { origin: string; destinations: Destination[]; requestIntervalSeconds?: number }
interface Hit { watchId?: string; program?: string; origin: string; destination: string; destinationName: string; date: string; sourceUpdatedAt: string | null; collectedAt: string }

const PROGRAM_NAMES: Record<string, string> = { 'korean-air': '대한항공', 'asiana-club': '아시아나' };
// Asiana refuses rapid repeats, so its lookups are deliberately spaced out.
const ASIANA_INTERVAL_MS = 20_000;
const UNSUPPORTED_PATH = resolve(ROOT, 'public-data/unsupported-routes.json');
const HEADLESS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

let asianaBrowser: Browser | null = null;
let asianaPage: Page | null = null;

/** Asiana leaves its destination autocomplete unwired when navigator.webdriver is
 *  true, and refuses Chrome's headless user agent outright. Launching Chrome
 *  ourselves and attaching over CDP satisfies both — with no window at all. */
async function asianaWorkPage(): Promise<Page> {
  if (asianaPage && !asianaPage.isClosed()) return asianaPage;
  const native = await openNativeChrome(resolve(ROOT, 'data/asiana-scan-profile'),
    { headless: true, userAgent: NATIVE_USER_AGENT });
  asianaBrowser = native.browser;
  asianaPage = native.context.pages()[0] ?? await native.context.newPage();
  return asianaPage;
}

function loadUnsupported(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(UNSUPPORTED_PATH, 'utf8'));
    return new Set(Array.isArray(parsed.routes) ? parsed.routes : []);
  } catch {
    return new Set();
  }
}

function saveUnsupported(routes: Set<string>): void {
  mkdirSync(dirname(UNSUPPORTED_PATH), { recursive: true });
  writeFileSync(UNSUPPORTED_PATH, JSON.stringify({ routes: [...routes].sort() }, null, 2) + '\n', 'utf8');
}

function loadConfig(): Config {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (typeof raw.origin !== 'string' || !/^[A-Z]{3}$/.test(raw.origin)) throw new Error('config: origin must be a 3-letter airport code');
  if (!Array.isArray(raw.destinations) || raw.destinations.length === 0) throw new Error('config: destinations required');
  for (const d of raw.destinations) {
    if (typeof d.code !== 'string' || !/^[A-Z]{3}$/.test(d.code)) throw new Error('config: invalid destination code');
  }
  return raw;
}

function loadPreviousHits(): Hit[] {
  if (!existsSync(STATE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return Array.isArray(parsed.hits) ? parsed.hits : [];
  } catch {
    return [];
  }
}

function hitKey(h: Pick<Hit, 'origin' | 'destination' | 'date'> & { program?: string }): string {
  return `${h.program ?? 'korean-air'}-${h.origin}-${h.destination}-${h.date}`;
}

// Same 360-day public window the interactive app uses; only full months qualify.
function candidateMonths(): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 1; i <= 13; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    try {
      validateFutureMonth(value);
      months.push(value);
    } catch {
      if (months.length) break;
    }
  }
  return months;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TELEGRAM_LIMIT = 3800; // Telegram caps a message at 4096 characters.

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[business-scan] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set; skipping notification.');
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (response.ok) return true;
    const body = await response.text().catch(() => '');
    if (response.status === 429) {
      const retryAfter = Number(JSON.parse(body || '{}')?.parameters?.retry_after) || 5;
      console.log(`[business-scan] Telegram rate limited; waiting ${retryAfter}s`);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    console.error('[business-scan] Telegram notify failed:', response.status, body);
    return false;
  }
  return false;
}

/** Splits on whole lines so a route's dates are never cut mid-line, then sends
 *  every part — a long list arrives in sequence instead of being truncated. */
async function notifyTelegram(header: string, blocks: string[]): Promise<void> {
  const parts: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > TELEGRAM_LIMIT) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) parts.push(current);
  if (!parts.length) parts.push('(내용 없음)');
  for (const [index, part] of parts.entries()) {
    const label = parts.length > 1 ? `${header} (${index + 1}/${parts.length})` : header;
    const sent = await sendTelegram(`${label}\n\n${part}`);
    if (!sent) return;
    if (index < parts.length - 1) await sleep(1200);
  }
  console.log(`[business-scan] Telegram: ${parts.length} message(s) sent.`);
}

/** One block per route, with dates folded by month so a long list stays readable. */
function hitBlocks(hits: Hit[]): string[] {
  const byRoute = new Map<string, Hit[]>();
  for (const hit of hits) {
    const airline = PROGRAM_NAMES[hit.program ?? 'korean-air'] ?? hit.program ?? '';
    const key = `${hit.origin}→${hit.destination} ${hit.destinationName} · ${airline}`;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key)!.push(hit);
  }
  return [...byRoute.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([route, routeHits]) => {
      const byMonth = new Map<string, number[]>();
      for (const hit of routeHits.sort((a, b) => a.date.localeCompare(b.date))) {
        const month = hit.date.slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month)!.push(Number(hit.date.slice(8, 10)));
      }
      const lines = [...byMonth.entries()].map(([month, days]) =>
        `  ${Number(month.slice(5, 7))}월: ${days.join(', ')}일`);
      return `✈️ ${route} — ${routeHits.length}일\n${lines.join('\n')}`;
    });
}

interface Watch {
  id: string; label: string; origins: string[]; destinations: string[]; regions: string[];
  startDate: string; endDate: string; programs: string[]; enabled?: boolean;
}

function loadWatches(): Watch[] {
  try {
    const parsed = JSON.parse(readFileSync(WATCHES_PATH, 'utf8'));
    return Array.isArray(parsed.watches) ? parsed.watches.filter((w: Watch) => w.enabled !== false) : [];
  } catch {
    return [];
  }
}

function airportsByRegion(): Map<string, { code: string; name: string }[]> {
  const grouped = new Map<string, { code: string; name: string }[]>();
  try {
    const catalog = JSON.parse(readFileSync(resolve(ROOT, 'config/award-routes.json'), 'utf8'));
    for (const airport of catalog.airports ?? []) {
      if (!grouped.has(airport.region)) grouped.set(airport.region, []);
      grouped.get(airport.region)!.push({ code: airport.code, name: airport.name });
    }
  } catch { /* the watch can still use explicit codes */ }
  return grouped;
}

/** Turns one watch into the concrete destinations and months it needs looked up. */
function planWatch(watch: Watch, regions: Map<string, { code: string; name: string }[]>) {
  const names = new Map<string, string>();
  for (const list of regions.values()) for (const a of list) names.set(a.code, a.name);
  const destinations = new Map<string, string>();
  for (const code of watch.destinations) destinations.set(code, names.get(code) ?? code);
  for (const region of watch.regions) for (const a of regions.get(region) ?? []) destinations.set(a.code, a.name);
  for (const origin of watch.origins) destinations.delete(origin);
  const months = candidateMonths().filter((m) => m >= watch.startDate.slice(0, 7) && m <= watch.endDate.slice(0, 7));
  return { destinations: [...destinations.entries()].map(([code, name]) => ({ code, name })), months };
}

async function main(): Promise<void> {
  const watches = loadWatches();
  const regions = airportsByRegion();
  const previous = loadPreviousHits();
  const interval = 4000;

  // Without a standing watch the scheduled run still sweeps the curated list.
  const plans = watches.length ? watches.map((watch) => ({ watch, ...planWatch(watch, regions) })) : (() => {
    const config = loadConfig();
    const fallback: Watch = {
      id: 'default', label: '기본 관심 노선', origins: [config.origin], destinations: config.destinations.map((d) => d.code),
      regions: [], startDate: '0000-00-00', endDate: '9999-99-99', programs: ['korean-air', 'asiana-club'],
    };
    return [{ watch: fallback, destinations: config.destinations, months: candidateMonths() }];
  })();

  const merged: Hit[] = [];
  const newByWatch = new Map<string, Hit[]>();
  const failures: { watch: string; program: string; destination: string; month: string; code: string }[] = [];
  const unsupported = loadUnsupported();
  const restrictedPrograms = new Set<string>();
  let stoppedEarly = false;
  let stopReason = '';
  let lastAsianaAt = 0;

  /** One airline's view of one route/month, as the dates it has business seats on. */
  async function lookup(program: string, origin: string, destination: { code: string; name: string }, month: string, watch: Watch): Promise<Hit[]> {
    const found: Hit[] = [];
    if (program === 'asiana-club') {
      const wait = ASIANA_INTERVAL_MS - (Date.now() - lastAsianaAt);
      if (wait > 0) await sleep(wait);
      lastAsianaAt = Date.now();
      const page = await asianaWorkPage();
      const result = await searchAsiana(page, { origin, destination: destination.code, month }, () => false);
      if (!('days' in result)) throw new CollectionError(result.code || 'SEARCH_FAILED', 'Asiana lookup failed.');
      const observed = new Date().toISOString();
      for (const day of result.days) {
        if ((day.cabins ?? []).includes('business') && day.date >= watch.startDate && day.date <= watch.endDate) {
          found.push({
            watchId: watch.id, program, origin, destination: destination.code, destinationName: destination.name,
            date: day.date, sourceUpdatedAt: result.sourceAt ?? null, collectedAt: result.observedAt ?? observed,
          });
        }
      }
      return found;
    }
    const result = await collectMonth(month, true, { origin, destination: destination.code, captureArtifacts: false });
    for (const day of result.data.dates) {
      // A watch asks about its own dates only, not the whole month.
      if (day.prestigeAward && day.date >= watch.startDate && day.date <= watch.endDate) {
        found.push({
          watchId: watch.id, program, origin, destination: destination.code, destinationName: destination.name,
          date: day.date, sourceUpdatedAt: result.data.sourceUpdatedAt ?? null, collectedAt: result.data.collectedAt,
        });
      }
    }
    return found;
  }

  outer: for (const plan of plans) {
    const { watch } = plan;
    const previousKeys = new Set(previous.filter((h) => h.watchId === watch.id).map(hitKey));
    for (const program of watch.programs) {
     for (const origin of watch.origins) {
      for (const destination of plan.destinations) {
        if (destination.code === origin) continue;
        const routeKey = `${program}|${origin}|${destination.code}`;
        // An airline that does not fly the route is skipped, not retried hourly.
        if (restrictedPrograms.has(program) || unsupported.has(routeKey)) continue;
        const found: Hit[] = [];
        let failed = false;
        for (const month of plan.months) {
          try {
            found.push(...await lookup(program, origin, destination, month, watch));
          } catch (error) {
            // Parse failures carry their own code; folding them into one generic
            // code is what made the last sweep's 53 failures undiagnosable.
            const code = error instanceof CollectionError || error instanceof CalendarParseError
              ? error.code : 'COLLECTION_FAILED';
            failures.push({ watch: watch.label, program, destination: destination.code, month, code });
            failed = true;
            if (code === 'ROUTE_UNAVAILABLE' || code === 'UNSUPPORTED_ROUTE') {
              unsupported.add(routeKey);
              break;
            }
            if (STOP_CODES.has(code)) {
              // One airline refusing us must not cancel the other's sweep.
              if (program !== 'korean-air') { restrictedPrograms.add(program); break; }
              stoppedEarly = true; stopReason = code; break outer;
            }
          }
          await sleep(program === 'asiana-club' ? 0 : interval);
        }
        if (failed) {
          // A lookup that failed is not proof the seats are gone.
          merged.push(...previous.filter((h) => h.watchId === watch.id && h.origin === origin && h.destination === destination.code));
          continue;
        }
        merged.push(...found);
        const fresh = found.filter((h) => !previousKeys.has(hitKey(h)));
        if (fresh.length) newByWatch.set(watch.id, [...(newByWatch.get(watch.id) ?? []), ...fresh]);
      }
     }
    }
  }

  await asianaBrowser?.close().catch(() => {});
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), hits: merged }, null, 2) + '\n', 'utf8');
  saveUnsupported(unsupported);

  const newCount = [...newByWatch.values()].reduce((sum, list) => sum + list.length, 0);
  const byProgram = (program: string) => merged.filter((h) => (h.program ?? 'korean-air') === program).length;
  console.log(`[business-scan] watches=${plans.length} hits=${merged.length} (대한항공 ${byProgram('korean-air')} / 아시아나 ${byProgram('asiana-club')}) new=${newCount} failures=${failures.length}`);
  for (const f of failures) console.log(`[business-scan] failed [${f.watch}] ${f.program} ${f.destination} ${f.month}: ${f.code}`);
  if (restrictedPrograms.size) console.log(`[business-scan] restricted: ${[...restrictedPrograms].join(', ')}`);

  for (const plan of plans) {
    const fresh = newByWatch.get(plan.watch.id);
    if (!fresh?.length) continue;
    await notifyTelegram(`✈️ [${plan.watch.label}] 비즈니스석 ${fresh.length}건`,
      [...hitBlocks(fresh), `기간: ${plan.watch.startDate} ~ ${plan.watch.endDate}\n직접 확인: ${SOURCE_URL}`]);
  }
  if (stoppedEarly) {
    await notifyTelegram('⚠️ 자동 스캔 중단',
      [`대한항공이 조회를 제한해 스캔을 멈췄어요 (${stopReason}). 다음 스케줄에서 다시 시도해요.`]);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[business-scan] fatal error:', error);
  process.exitCode = 1;
});
