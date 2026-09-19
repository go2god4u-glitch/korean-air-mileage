import { collectMonth, CollectionError } from '../src/collector.js';
import { CalendarParseError } from '../src/parser.js';

// Private bridge for the Python localhost server. One explicit call means one
// anonymous, headed, one-way monthly search. Cache/locking belongs to that server.
const args = process.argv.slice(2).filter((value) => value !== '--hidden');
const hidden = process.argv.slice(2).includes('--hidden');

try {
  const values = new Map<string, string>();
  const accepted = new Set(['--origin', '--destination', '--month']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!accepted.has(key) || values.has(key) || !value || value.startsWith('--')) {
      throw new CollectionError('INVALID_ARGUMENTS', '출발 공항, 도착 공항, 조회 월을 각각 한 번 입력하세요.');
    }
    values.set(key, value);
  }
  if (values.size !== accepted.size) {
    throw new CollectionError('INVALID_ARGUMENTS', '출발 공항, 도착 공항, 조회 월이 필요합니다.');
  }
  const result = await collectMonth(values.get('--month')!, false, {
    origin: values.get('--origin')!, destination: values.get('--destination')!, captureArtifacts: false,
    offscreen: hidden,
  });
  process.stdout.write(JSON.stringify({ calendar: result.data }) + '\n');
} catch (error) {
  // Never forward browser exception text: it may include URLs or page contents.
  const code = error instanceof CollectionError || error instanceof CalendarParseError ? error.code : 'COLLECTION_FAILED';
  const message = error instanceof CollectionError ? error.message
    : error instanceof CalendarParseError ? '공개 달력의 표시 형식을 확인할 수 없어 값을 저장하지 않았습니다.'
    : '공개 달력 조회를 완료하지 못했습니다. 공항 코드와 조회 가능 월을 확인하세요. 자동 재시도는 하지 않습니다.';
  process.stderr.write(JSON.stringify({ code, message }) + '\n');
  process.exitCode = 1;
}
