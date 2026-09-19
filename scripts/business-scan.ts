// Unattended sweep of the Korean Air public bonus-seat calendar across a curated
// destination list, looking only for prestige (business) award seats. Meant to run
// on a schedule (GitHub Actions), never interactively. One call per
// origin/destination/month, same as the interactive collector — no retries, no
// concurrency, and an immediate stop on any access restriction.
//
// Chrome's headless mode is served an HTTP2 protocol error by Korean Air's edge
// (confirmed against the live site), so this launches "headed" like the
// interactive collector. In CI that must run under a virtual display (Xvfb) so no
// window is ever visible to anyone — see .github/workflows/business-scan.yml.
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

async function notifyTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[business-scan] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set; skipping notification.');
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    console.error('[business-scan] Telegram notify failed:', response.status, await response.text().catch(() => ''));
  }
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
        const result = await collectMonth(month, false, { origin, destination: destination.code, captureArtifacts: false });
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
    const lines = newHits
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 30)
      .map((h) => `- ${h.origin}→${h.destination} (${h.destinationName}) ${h.date}`)
      .join('\n');
    const more = newHits.length > 30 ? `\n...외 ${newHits.length - 30}건` : '';
    await notifyTelegram(`✈️ 새 비즈니스 마일리지 좌석 발견 (${newHits.length}건)\n${lines}${more}\n\n직접 확인: ${SOURCE_URL}`);
  }
  if (stoppedEarly) {
    await notifyTelegram(`⚠️ 대한항공이 조회를 제한해 자동 스캔을 멈췄어요 (${stopReason}). 다음 스케줄에서 다시 시도해요.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[business-scan] fatal error:', error);
  process.exitCode = 1;
});
