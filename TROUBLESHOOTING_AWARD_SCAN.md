# 마일리지 좌석 스캔 · 증상별 진단서

> 1차 진단용. 증상에서 시작해 원인 후보를 좁히는 것이 목적이다.
> 시스템 구조는 [AWARD_SCAN_ARCHITECTURE.md](AWARD_SCAN_ARCHITECTURE.md),
> 외부 자원·대안은 [AWARD_SCAN_INTELLIGENCE.md](AWARD_SCAN_INTELLIGENCE.md)를 본다.

---

## 0. 30초 분류표

| 증상 | 가장 흔한 원인 | 바로 가기 |
|---|---|---|
| 페이지가 안 열림 (`연결할 수 없음`) | 로컬 서버가 꺼짐 | [1.1](#11-페이지가-안-열린다) |
| `조회 프로그램에 연결할 수 없어요` | 조회 중 서버 재시작 | [1.2](#12-조회-중-연결-오류가-떴다) |
| `LOCAL_ONLY` | 자동화 확장으로 접속 | [1.3](#13-local_only-오류) |
| Chrome 창이 뜬다 | headless 미적용 코드로 실행 중 | [2.1](#21-조회할-때-chrome-창이-뜬다) |
| 조회가 안 끝나고 매달림 | 띄운 Chrome을 안 죽임 | [2.2](#22-조회가-끝나지-않는다) |
| 아시아나만 `ACCESS_RESTRICTED` | 데이터센터 IP 차단 | [3.1](#31-아시아나-access_restricted) |
| 아시아나 `STRUCTURE_CHANGED` | `navigator.webdriver=true` | [3.2](#32-아시아나-structure_changed--search_failed) |
| 특정 노선만 계속 실패 | 미취항 노선 | [3.3](#33-특정-노선만-실패한다) |
| 한 달 전체가 실패 | 파서가 모르는 날짜 칸 | [4.1](#41-empty_unverified_state) |
| 텔레그램이 안 옴 | 새로 찾은 좌석이 없음 | [5.1](#51-텔레그램-알림이-오지-않는다) |
| 신청했는데 자동 조회 안 됨 | GitHub 미반영 | [5.2](#52-알림-신청이-자동-조회에-반영되지-않는다) |
| 검색 버튼이 비활성 | 비행시간 필터로 목적지 0곳 | [6.1](#61-검색-버튼이-눌리지-않는다) |

---

## 1. 접속 계열

### 1.1 페이지가 안 열린다

```bash
ps aux | grep local_app.py | grep -v grep     # 프로세스 확인
curl -s -o /dev/null -w "%{http_code}\n" -H "Sec-Fetch-Site: none" http://127.0.0.1:8765/
```

- 프로세스 없음 → `cd ~/coding/korean-air-mileage && python3 local_app.py --open`
- HTTP 200인데 브라우저만 안 되면 → 주소를 직접 입력했는지 확인. **HTML 파일을 직접 열면 동작하지 않는다** (API가 전부 `127.0.0.1:8765` 기준).

### 1.2 조회 중 연결 오류가 떴다

`조회 프로그램에 연결할 수 없어요. 실행 창이 열려 있는지 확인해 주세요.`

원인: 조회 진행 중 서버가 재시작/종료됨. **서버에서 도는 조회 자체는 살아 있을 수 있다.**

현재 코드는 상태 확인 실패를 8회까지 견딘다(`local_web/business-scan-ui.js` `pollFailures`).
8회 연속 실패해야 중단하므로, 이 메시지가 즉시 떴다면 서버가 완전히 죽은 것이다.

### 1.3 LOCAL_ONLY 오류

```json
{"error": {"code": "LOCAL_ONLY", "message": "다른 사이트에서는 이 프로그램을 사용할 수 없어요."}}
```

`local_app.py`의 `Handler.allowed()`가 `Sec-Fetch-Site: cross-site` 헤더를 거부한다.
Claude-in-Chrome 같은 **자동화 확장으로 열면 항상 이 오류**가 난다. 앱 버그가 아니다.

→ 일반 Chrome 주소창에 직접 입력하거나 `open -a "Google Chrome" http://127.0.0.1:8765/`

---

## 2. 브라우저 창 · 프로세스 계열

### 2.1 조회할 때 Chrome 창이 뜬다

**핵심 사실: 대한항공이 거부하는 것은 headless가 아니라 headless의 User-Agent다.**

Chrome이 headless로 뜨면 UA에 `HeadlessChrome`이 들어가고, 대한항공 엣지가 이를
`net::ERR_HTTP2_PROTOCOL_ERROR`로 끊는다. UA만 정상 문자열로 바꾸면 완전 headless로 통과한다.

적용 위치:
- `src/collector.ts` → `HEADLESS_USER_AGENT`, `headless` 인자가 true일 때 context에 주입
- `scripts/local-collect.ts` → `--hidden` 플래그를 받아 `collectMonth(month, hidden, …)`
- `local_app.py` `collect_leg()` → 항상 `--hidden`을 붙여 호출

창이 여전히 뜨면 **코드 수정 후 서버를 재시작하지 않은 것**이다. `local_app.py`는 기동 시점의
코드로 자식 프로세스를 띄우므로, 고친 뒤 반드시 재시작해야 한다.

> 과거 시도(실패): `--window-position=-8000,-8000`으로 화면 밖에 두는 방식.
> macOS가 창을 화면 안으로 되돌려서 소용없었다. 코드에서 제거됨.

### 2.2 조회가 끝나지 않는다

증상: 조회 1건인데 수십 분간 진행 중. CI에서는 job timeout(45분)까지 감.

원인: 우리가 **직접 spawn한 Chrome은 CDP 연결을 닫아도 죽지 않는다.** Node가 그 자식
프로세스를 붙들고 이벤트 루프를 못 비워서 스크립트가 종료되지 않는다.

```ts
// 틀림 — 연결만 닫힘
await browser.close();
// 맞음 — openNativeChrome이 돌려준 close()가 child.kill()까지 수행
await asianaChrome?.close();
```

`scripts/business-scan.ts`는 `main().finally()`에서 항상 정리하고 `process.exit()` 한다.

확인:
```bash
ps aux | grep -E "asiana-(scan|local)-profile" | grep -v grep | wc -l   # 0이어야 정상
pkill -f "asiana-scan-profile"   # 잔여 프로세스 정리
```

> 잔여 Chrome이 남으면 **같은 프로필을 다음 실행이 못 써서** 조회가 즉시 실패한다.
> "1초 만에 COLLECTION_FAILED"가 나오면 이걸 먼저 의심한다.

---

## 3. 아시아나 계열

### 3.1 아시아나 ACCESS_RESTRICTED

아시아나가 `Access Denied` 페이지를 반환한 것이다. 두 경우가 있다.

| 환경 | 판정 | 대응 |
|---|---|---|
| GitHub Actions | **구조적 차단** (데이터센터 IP) | 우회 불가. CI에서는 건너뛴다 |
| 로컬(집 IP) | 일시적 과요청 | 몇 시간 기다리면 풀린다 |

클라우드 차단은 실측 확인됨(2026-09-19). `navigator.webdriver=false`로 바꿔도 동일했으므로
봇 탐지가 아니라 IP 기반이다. `scripts/business-scan.ts`가 `process.env.CI`일 때
아시아나를 건너뛰고 로그를 남긴다.

로컬에서 반복 실패 시: `ASIANA_REQUEST_INTERVAL`(local_app.py, 기본 20초)을 늘린다.

### 3.2 아시아나 STRUCTURE_CHANGED / SEARCH_FAILED

**핵심 사실: 아시아나는 `navigator.webdriver === true`이면 도착지 자동완성을 아예 연결하지 않는다.**

Playwright가 직접 띄운 브라우저(`chromium.launch()`)는 이 값이 항상 true라서,
출발지는 입력되는데 도착지 후보가 0개로 나온다. 다음이 전부 실패했다:

- 10초 대기 / `change`+`blur` 이벤트 / `Tab` / 도착칸 클릭 / 키 입력
- `$('#txtArrivalAirport1').autocomplete('search', …)` → `cannot call methods on autocomplete prior to initialization`

해결: **Chrome을 직접 spawn하고 CDP로 붙는다.** 그러면 `webdriver=false`가 된다.
`src/sas/native-chrome.ts`의 `openNativeChrome(profile, {headless:true, userAgent:NATIVE_USER_AGENT})`.

두 조건이 **모두** 필요하다: `webdriver=false` + 정상 UA.

### 3.3 특정 노선만 실패한다

아시아나가 취항하지 않는 노선(예: ICN→ATL)은 도착지 자동완성 목록에 **아예 나타나지 않는다.**
과거에는 여기서 30초 타임아웃 후 일반 실패로 처리돼 매 실행마다 재시도했다.

현재는 `src/partners/asiana.ts`가 후보 목록을 10초만 기다린 뒤 `ROUTE_UNAVAILABLE`을 던지고,
스캐너가 이를 기록해 **다음 실행부터 건너뛴다.**

기록 위치:
- 로컬: `data/local/unsupported-routes.json`
- 클라우드: `public-data/unsupported-routes.json`

형식: `"프로그램|출발|도착"` (예: `"asiana-club|ICN|ATL"`). 잘못 기록됐으면 해당 줄을 지우면 된다.

---

## 4. 파서 계열

### 4.1 EMPTY_UNVERIFIED_STATE

파서가 **해석할 수 없는 날짜 칸**을 만나면 그 달 전체를 버린다. 모르는 상태를
"좌석 없음"으로 단정하면 있는 좌석을 놓치기 때문이며, 이는 의도된 안전장치다.

지금까지 확인해 해결한 칸 구조 3종:

| 상태 | DOM 식별자 | 파서 처리 |
|---|---|---|
| 좌석 없음 | `span.ux-class-icon.-no-seat.-gray` + "좌석 없음" | 모든 등급 `false` |
| 운항편 없음 | `td.-no-flight` + `span.-no-flight` + "운항편 없음" | `operatingStatus: 'NOT_OPERATED'` |
| 예약 미오픈 | `td.-disabled[aria-disabled=true]` + "선택 불가능", 아이콘 없음 | `availabilityType: 'NOT_YET_OPEN'`, 등급 `null` |

**새로운 구조가 또 나오면** 이 오류가 재발한다. 진단 절차:

```bash
# 해당 노선/월의 달력 DOM을 떠서 직접 본다 (headless, 창 안 뜸)
# scripts/ 아래 임시 스크립트를 만들어 dialog.evaluate(e => e.outerHTML) 저장
```

그 다음 `src/parser.ts`의 마커 판정부에 새 상태를 추가하되,
**절대 "좌석 없음"으로 뭉뚱그리지 않는다.** 모르면 `null`로 둔다.

관련 기록: 파리(CDG) 노선은 매일 운항하지 않아 "운항편 없음" 칸이 있었고,
이 때문에 과거 스캔 176건 중 48건이 실패했다. 수정 후 53→11건으로 감소.

---

## 5. 알림 계열

### 5.1 텔레그램 알림이 오지 않는다

순서대로 확인한다.

```bash
# 1) 봇 자체가 살아 있나
curl -s "https://api.telegram.org/bot$TOKEN/getMe"

# 2) 직접 발송되나
curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"<CHAT_ID>","text":"test"}'

# 3) 스캔이 뭘 찾았나
gh run view <RUN_ID> --repo go2god4u-glitch/korean-air-mileage --log | grep "business-scan"
```

**가장 흔한 원인: 새로 찾은 좌석이 없어서(`new=0`) 보낼 게 없는 것.**
알림은 *이전 실행에 없던* 좌석이 생겼을 때만 발송한다(`hitKey` 비교).

- `TELEGRAM_BOT_TOKEN/CHAT_ID not set` 로그 → GitHub Secrets 미등록
- 장문이 잘리는 문제는 해결됨: 노선·월별로 접어 4096자 제한에 맞춰 분할 발송
  (1,218건 → 메시지 2개로 검증)

### 5.2 알림 신청이 자동 조회에 반영되지 않는다

**신청은 저장만으로 적용되지 않는다. "GitHub에 반영하기"를 눌러야 한다.**

클라우드 스캔은 저장소의 `config/watches.json`을 읽으므로, 로컬 파일만 바뀌면 모른다.

```bash
# 로컬과 원격 비교
python3 -c "import json;print([w['label'] for w in json.load(open('config/watches.json'))['watches']])"
git show origin/main:config/watches.json | python3 -c "import json,sys;print([w['label'] for w in json.load(sys.stdin)['watches']])"
```

화면의 동기화 버튼이 "(변경 있음)"이면 미반영 상태다.

---

## 6. 화면 계열

### 6.1 검색 버튼이 눌리지 않는다

비행시간 필터가 선택한 지역의 노선을 **전부 걸러냈을 가능성**이 가장 높다.
예: 동북아시아 45곳 + "10시간 이상" → 남는 목적지 0곳.

안내 문구가 이유를 말해준다("…45곳 모두 걸러져 남은 목적지가 없어요").
비행시간 조건을 낮추거나 유럽·미주를 추가한다.

비행시간 값은 `config/flight-hours.json`에서 직접 수정할 수 있다(인천 기준 어림값).

---

## 7. 워크플로우 계열

### 7.1 결과가 저장되지 않는다 (push rejected)

스캔은 수십 분 걸리므로 그 사이 `main`이 움직인다. 과거에는 rebase 충돌로 결과가 유실됐다.

현재 워크플로우는 **실행 결과를 최신 main 위에 다시 얹는다**:

```bash
git fetch origin main
git reset --soft origin/main
git add public-data/business-hits.json
git commit && git push origin HEAD:main
```

3회까지 재시도한다. 이 파일에 한해 **실행 결과가 더 최신**이므로 병합이 아니라 덮어쓰기가 맞다.

### 7.2 Chrome 설치 단계 실패

```
gpg: cannot open '/dev/tty': No such device or address
```

`sudo gpg --dearmor`를 파이프로 받으면 CI에서 실패한다. 키를 파일로 내려받은 뒤
`--batch --yes`로 처리한다. 이미 Chrome이 있으면 설치를 건너뛴다.

---

## 8. 되풀이하지 말 것

| 하지 말 것 | 이유 |
|---|---|
| 코드 고치고 서버 재시작 안 하기 | 구 코드가 계속 돌아 "안 고쳐졌다"는 오해를 만든다 |
| 모르는 날짜 칸을 "좌석 없음"으로 처리 | 있는 좌석을 없다고 보고하게 된다 |
| 조회 실패를 "좌석 없음"으로 처리 | 위와 같음. 실패는 실패로 남긴다 |
| 아시아나를 빠르게 연속 조회 | 즉시 차단된다. 20초 간격 유지 |
| 한 항공사 차단으로 전체 중단 | 대한항공과 아시아나는 독립적으로 처리한다 |
| 테스트 데이터를 저장소에 남기기 | 사용자가 실제 신청으로 오해한다 |
| 실패 코드를 하나로 뭉치기 | 53건 실패가 전부 `COLLECTION_FAILED`라 진단 불가했다 |
