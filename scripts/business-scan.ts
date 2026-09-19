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
import { collectMonth, CollectionError, validateFutureMonth, SOURCE_URL } from '../src/collector.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = resolve(ROOT, 'config/business-watch.json');
const STATE_PATH = resolve(ROOT, 'public-data/business-hits.json');
const STOP_CODES = new Set(['ACCESS_RESTRICTED', 'USER_ACTION_REQUIRED', 'LOGIN_REQUIRED']);

interface Destination { code: string; name: string }
interface Config { origin: string; destinations: Destination[]; requestIntervalSeconds?: number }
interface Hit { origin: string; destination: string; destinationName: string; date: string; sourceUpdatedAt: string | null; collectedAt: string }

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

function hitKey(h: Pick<Hit, 'origin' | 'destination' | 'date'>): string {
  return `${h.origin}-${h.destination}-${h.date}`;
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
    const key = `${hit.origin}→${hit.destination} ${hit.destinationName}`;
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

async function main(): Promise<void> {
  const config = loadConfig();
  const origin = config.origin;
  const intervalMs = Math.max(0, (config.requestIntervalSeconds ?? 4) * 1000);
  const months = candidateMonths();
  const previous = loadPreviousHits();

  const currentByDestination = new Map<string, Hit[]>();
  const failures: { destination: string; month: string; code: string }[] = [];
  let stoppedEarly = false;
  let stopReason = '';

  outer: for (const destination of config.destinations) {
    const hits: Hit[] = [];
    let destinationFailed = false;
    for (const month of months) {
      try {
        const result = await collectMonth(month, true, { origin, destination: destination.code, captureArtifacts: false });
        for (const day of result.data.dates) {
          if (day.prestigeAward) {
            hits.push({
              origin, destination: destination.code, destinationName: destination.name, date: day.date,
              sourceUpdatedAt: result.data.sourceUpdatedAt ?? null, collectedAt: result.data.collectedAt,
            });
          }
        }
      } catch (error) {
        const code = error instanceof CollectionError ? error.code : 'COLLECTION_FAILED';
        failures.push({ destination: destination.code, month, code });
        destinationFailed = true;
        if (STOP_CODES.has(code)) {
          stoppedEarly = true;
          stopReason = code;
          break outer;
        }
      }
      await sleep(intervalMs);
    }
    if (!destinationFailed) currentByDestination.set(destination.code, hits);
  }

  // A destination that failed this run keeps its last known hits rather than
  // silently reporting "no seats" for a fetch problem that isn't a real close-out.
  const merged: Hit[] = [];
  for (const destination of config.destinations) {
    if (currentByDestination.has(destination.code)) {
      merged.push(...currentByDestination.get(destination.code)!);
    } else {
      merged.push(...previous.filter((h) => h.destination === destination.code));
    }
  }

  const previousKeys = new Set(previous.map(hitKey));
  const newHits = merged.filter((h) => !previousKeys.has(hitKey(h)));

  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), hits: merged }, null, 2) + '\n', 'utf8');

  console.log(`[business-scan] destinations=${config.destinations.length} months=${months.length} hits=${merged.length} new=${newHits.length} failures=${failures.length}`);
  for (const f of failures) console.log(`[business-scan] failed ${origin}-${f.destination} ${f.month}: ${f.code}`);

  if (newHits.length) {
    await notifyTelegram(`✈️ 새 비즈니스 마일리지 좌석 ${newHits.length}건`,
      [...hitBlocks(newHits), `직접 확인: ${SOURCE_URL}`]);
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
