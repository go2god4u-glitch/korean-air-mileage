# 마일리지 좌석 스캔 · 증상별 진단서

> 1차 진단용. 증상에서 시작해 원인 후보를 좁히는 것이 목적이다.
> 시스템 구조는 [AWARD_SCAN_ARCHITECTURE.md](AWARD_SCAN_ARCHITECTURE.md),
> 외부 자원·대안은 [AWARD_SCAN_INTELLIGENCE.md](AWARD_SCAN_INTELLIGENCE.md)를 본다.

---

## 0. 30초 분류표

> **어떤 오류든 먼저 여기부터:** `tail -30 data/local/award-worker.log`
> 조회 워커의 에러가 전부 여기 쌓인다. 화면에는 `BROWSER_ERROR`라고만 뜨므로,
> 이 파일을 안 보면 원인 추정에 몇 시간을 쓰게 된다(실제로 그랬다).

| 증상 | 가장 흔한 원인 | 바로 가기 |
|---|---|---|
| 페이지가 안 열림 (`연결할 수 없음`) | 로컬 서버가 꺼짐 | [1.1](#11-페이지가-안-열린다) |
| 아시아나 조회가 전부 `BROWSER_ERROR` | 유령 Chrome이 프로필을 물고 있음 | [2.2](#22-chrome_open_failed--browser_error) |
| 최소화한 Chrome이 자꾸 앞으로 나옴 | 새 탭을 만들 때마다 창이 올라옴 | [2.1](#21-조회할-때-chrome-창이-뜬다) |
| 아시아나 예매 화면이 첫 화면으로 튕김 | 결제 세션 타이머(1~2분) 만료 | [3.3](#33-아시아나-예매-화면이-사라졌다) |
| `조회 프로그램에 연결할 수 없어요` | 조회 중 서버 재시작 | [1.2](#12-조회-중-연결-오류가-떴다) |
| `LOCAL_ONLY` | 자동화 확장으로 접속 | [1.3](#13-local_only-오류) |
| Chrome 창이 뜬다 | headless 미적용 코드로 실행 중 | [2.1](#21-조회할-때-chrome-창이-뜬다) |
| 조회가 안 끝나고 매달림 | 띄운 Chrome을 안 죽임 | [2.3](#23-조회가-끝나지-않는다) |
| 아시아나만 `ACCESS_RESTRICTED` | 데이터센터 IP 차단 | [3.1](#31-아시아나-access_restricted) |
| 아시아나 `STRUCTURE_CHANGED` | 결과 표가 아직 `Loading` | [3.2](#32-아시아나-structure_changed--search_failed) |
| 특정 노선만 계속 실패 | 미취항 노선 | [3.4](#34-특정-노선만-실패한다) |
| 한 달 전체가 실패 | 파서가 모르는 날짜 칸 | [4.1](#41-empty_unverified_state) |
| 텔레그램이 안 옴 | 새로 찾은 좌석이 없음 | [5.1](#51-텔레그램-알림이-오지-않는다) |
| 신청했는데 자동 조회 안 됨 | GitHub 미반영 | [5.2](#52-알림-신청이-자동-조회에-반영되지-않는다) |
| 검색 버튼이 비활성 | 비행시간 필터로 목적지 0곳 | [6.1](#61-검색-버튼이-눌리지-않는다) |
| 실시간 확인이 안 됨 | 항공사 로그인 만료 | [8.1](#81-실시간-확인-못함으로만-나온다) |
| 9시 대기가 끊김 | 프로그램 재시작 | [8.2](#82-9시-예매-대기가-끊겼다) |
| 9시에 자리를 놓침 | 준비 시간 부족·로그인 만료 | [8.3](#83-9시에-자리를-놓쳤다) |

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

### 2.1 조회할 때 Chrome 창이 뜬다 / 최소화해도 다시 올라온다

원인이 둘이다. **창이 처음부터 뜨는 것**과 **최소화한 창이 되살아나는 것**은 다른 문제다.

#### (가) 최소화한 창이 자꾸 앞으로 나온다

**원인은 `bringToFront()`가 아니라 `newPage()`다.** Chrome은 창에 새 탭이 생기면 그 창을
앞으로 올리고 최소화도 해제한다. 로그인 유지 확인(`keepalive`)과 실시간 검증(`verify`)이
매번 탭을 새로 열고 닫고 있어서, 스캔 도중 몇 분마다 창이 되살아났다.

해결: 용도별로 탭을 **하나 만들어 계속 재사용한다**(`scratchTab()` in `scripts/award-browser.ts`).
창이 방해받는 건 최초 1회뿐이다. 예매 클릭(`book`)과 로그인 열기(`open-url`)는
**일부러** 앞으로 올린다 — 사용자가 그 화면에서 뭔가 해야 하므로.

확인법: 스캔 중 탭 개수가 늘었다 줄었다 하면 아직 새로 여는 경로가 남은 것이다.
```bash
port=$(python3 -c "import json;print(json.load(open('data/partner-chrome-profile/local-debug-endpoint.json'))['endpoint'].split('/')[2].split(':')[1])")
curl -s "http://127.0.0.1:$port/json/list" | python3 -c "import sys,json;print(len([x for x in json.load(sys.stdin) if x['type']=='page']),'탭')"
```

#### (나) 조회 창이 화면에 보인다

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

### 2.2 CHROME_OPEN_FAILED / 아시아나 조회가 전부 BROWSER_ERROR

증상: 아시아나 조회가 한 건도 성공하지 않고 전부 `BROWSER_ERROR`. 화면에는 이유가 없다.

```bash
tail -20 data/local/award-worker.log
# [award-browser] search/asiana-club: Error: CHROME_OPEN_FAILED
```

원인: **같은 프로필을 물고 있는 유령 Chrome.** Chrome은 한 프로필에 두 번째 인스턴스를
띄우려 하면 기존 인스턴스에 요청을 넘기고 **즉시 종료한다.** 워커가 강제 종료되면(예:
`pkill`) 정리 없이 그런 인스턴스가 남고, 그 뒤로는 모든 조회가 실패한다. 실측 사례에서
**1일 5시간째 떠 있던** headless Chrome이 범인이었다.

현재는 세 겹으로 막는다:
1. 워커 stderr를 `data/local/award-worker.log`에 남긴다(예전엔 버렸다)
2. 살아 있는 인스턴스가 있으면 죽이지 않고 **재사용**한다(`local-debug-endpoint.json`)
3. 재사용도 안 되는 유령은 Chrome의 `SingletonLock`에서 pid를 읽어 정리한다
   — 단, `ps`로 **그 pid가 정말 이 프로필의 Chrome인지 확인한 뒤에만**(pid 재사용 오인 방지)

수동 확인:
```bash
ps -eo pid,etime,command | grep -- "--user-data-dir=.*korean-air-mileage" | grep -v grep | grep -v "type="
```

### 2.3 조회가 끝나지 않는다

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

**이 코드는 원인이 둘이다. 먼저 어느 쪽인지 가린다:**

```bash
AWARD_DEBUG=1 <조회 실행>   # STRUCTURE_CHANGED 직전에 본문 앞부분을 찍는다
```

본문에 `Loading`이 보이면 (가), 도착지 후보가 0개면 (나)다.

#### (가) 결과 표가 아직 그려지지 않았다 — 가장 흔함

조회는 성공해 `RedemptionInternationalFlightsSelect.do`까지 갔는데, 항공편 표가
**별도 요청으로 나중에 채워진다.** 고정 시간만 기다리고 빈 표를 읽으면 행이 0개가 되고,
그것이 `STRUCTURE_CHANGED`로 올라온다 — 마치 페이지 구조가 바뀐 것처럼 보이지만 아니다.

2명 조회가 1명보다 느려서 유독 2명일 때만 실패하는 것처럼 보이기도 했다(실제 사례).

현재는 표가 채워질 때까지(최대 40초) 기다린다. 항공편이 없는 날은 안내 문구를 보고
`empty`로 구분한다 — **행 0개를 무조건 "자리 없음"으로 읽으면 안 된다.** 진짜 매진과
구별이 안 되기 때문이다.

> 교훈: `waitForTimeout(고정값)`으로 서버 응답을 기다리지 말 것. 실제 조건을 기다릴 것.

#### (나) 도착지 자동완성이 연결되지 않았다

**아시아나는 `navigator.webdriver === true`이면 도착지 자동완성을 아예 연결하지 않는다.**

Playwright가 직접 띄운 브라우저(`chromium.launch()`)는 이 값이 항상 true라서,
출발지는 입력되는데 도착지 후보가 0개로 나온다. 다음이 전부 실패했다:

- 10초 대기 / `change`+`blur` 이벤트 / `Tab` / 도착칸 클릭 / 키 입력
- `$('#txtArrivalAirport1').autocomplete('search', …)` → `cannot call methods on autocomplete prior to initialization`

해결: **Chrome을 직접 spawn하고 CDP로 붙는다.** 그러면 `webdriver=false`가 된다.
`src/sas/native-chrome.ts`의 `openNativeChrome(profile, {headless:true, userAgent:NATIVE_USER_AGENT})`.

두 조건이 **모두** 필요하다: `webdriver=false` + 정상 UA.

### 3.3 아시아나 예매 화면이 사라졌다

**아시아나 결제 화면에는 1~2분짜리 세션 타이머가 있다.** 화면에 `남은 시간 N분 N초`가
뜨고, 만료되면 입력한 내용이 전부 날아간 채 첫 화면으로 돌아간다. 실측 시 **갓 연 화면이
1분 12초** 남아 있었다.

- 살리는 법: 화면의 **`세션 연장`** 버튼
- 다시 여는 법: 예매를 다시 누르면 13초 만에 같은 상태로 돌아온다(공제·탑승자 포함)

**하지 말 것:** 보안문자를 넣지 않은 채 `공제 및 탑승자 입력 완료`를 강제로 클릭.
페이지가 *"보안을 위해 아래 캡차 인증을 진행 해 주시기 바랍니다"* 라고 막는데 이를 무시하고
JS로 밀어넣으면 *"고객님의 요청 사항을 온라인에서 처리해드리기 어렵습니다"* 가 뜨면서
**세션이 즉시 끊긴다**(실제로 그렇게 날렸다). 순서는 보안문자 → 입력 완료 → 결제다.

### 3.4 특정 노선만 실패한다

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

## 8. 실시간 확인 · 9시 대기

### 8.1 "실시간 확인 못함"으로만 나온다

실시간 확인은 **항공사 로그인이 필요**하다. 공개 달력과 달리 비로그인으로는 불가능하다.

```bash
curl -s -X POST http://127.0.0.1:8765/api/awards/confirm-login \
  -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:8765" \
  -H "Sec-Fetch-Site: same-origin" -d '{"program":"korean-air"}'
# {"browser": {"state": "ready", "authenticated": true}} 여야 한다
```

`login_required`이면 화면의 **"대한항공 로그인·예약 열기"**로 조회용 Chrome에서 로그인한다.

코드 `AMBIGUOUS_CABIN`이면 발견 1건에 등급이 둘 담긴 것이다. 버그이며
[ARCHITECTURE §9.3](AWARD_SCAN_ARCHITECTURE.md#93-등급은-반드시-하나씩)을 본다.

> 확인하지 못한 것을 "매진"으로 바꾸지 않는 것이 원칙이다. `unchecked`는 결과에 남는다.

### 8.2 9시 예매 대기가 끊겼다

`프로그램이 다시 시작되어 예매 대기가 끊겼어요`

대기는 메모리에서 돌기 때문에 **프로그램이 재시작되면 끊긴다.** 다시 신청해야 한다.
9시 전에 서버를 만지지 않는 것이 최선이다.

### 8.3 9시에 자리를 놓쳤다

원인 순서대로 확인한다.

1. **로그인 만료** — 대기 중 10분마다 확인하고 텔레그램으로 알린다. 그 알림을 놓쳤는지 본다.
2. **맥이 잠들었거나 꺼짐** — 9시에 켜져 있어야 한다. 절전 설정을 확인한다.
3. **준비 실패** — 로그에 `미리 준비하지 못했어요`가 있으면 폼 구조가 바뀐 것이다.
4. **정말 경쟁에서 밀림** — `9시 이후 15분 동안 … 찾지 못했어요`. 장거리 인기 노선은
   실제로 몇 분 안에 나간다.

속도는 이미 한계에 가깝다. 실측 분해:

```
0.7초  클릭 → 요청 전송
2.7초  대한항공 서버 응답   ← 우리가 줄일 수 없는 부분
0.1초  화면 렌더링
```

폼을 미리 채워 9.4초 → 3.5초로 줄인 상태다. 서버 응답을 직접 읽어도 0.1초밖에 못 줄인다.

---

## 9. 되풀이하지 말 것

| 하지 말 것 | 이유 |
|---|---|
| 9시 직전에 서버 재시작 | 예매 대기가 끊긴다 |
| 결제 버튼까지 자동화 | 마일리지·현금이 실제로 나가고 되돌리기 어렵다 |
| 확인 실패를 "매진"으로 처리 | 있는 자리를 없다고 보고하게 된다 |
| 코드 고치고 서버 재시작 안 하기 | 구 코드가 계속 돌아 "안 고쳐졌다"는 오해를 만든다 |
| 모르는 날짜 칸을 "좌석 없음"으로 처리 | 있는 좌석을 없다고 보고하게 된다 |
| 조회 실패를 "좌석 없음"으로 처리 | 위와 같음. 실패는 실패로 남긴다 |
| 아시아나를 빠르게 연속 조회 | 즉시 차단된다. 20초 간격 유지 |
| 한 항공사 차단으로 전체 중단 | 대한항공과 아시아나는 독립적으로 처리한다 |
| 테스트 데이터를 저장소에 남기기 | 사용자가 실제 신청으로 오해한다 |
| 실패 코드를 하나로 뭉치기 | 53건 실패가 전부 `COLLECTION_FAILED`라 진단 불가했다 |
| 에러 출력을 `DEVNULL`로 버리기 | `BROWSER_ERROR`만 남아 원인 추적에 몇 시간을 썼다 |
| 서버 응답을 `waitForTimeout(고정값)`으로 기다리기 | 빠르면 낭비, 느리면 빈 화면을 읽는다. 실제 조건을 기다릴 것 |
| 항공사가 막는 클릭을 JS로 강제 실행 | 아시아나가 캡차 경고를 띄웠는데 밀어넣었더니 세션이 끊겼다 |
| 보안문자(CAPTCHA)를 대신 입력하려 시도 | 하지 않는다. 사용자가 직접 입력한다 |
| 아시아나 결제 화면을 미리 띄워놓고 대기 | 세션이 1~2분이라 먼저 죽는다. 자리가 열린 뒤 빠르게 도달할 것 |
| 가족 회원번호·계정번호를 저장소에 넣기 | 개인정보다. `data/`(git 제외)에만 둔다 |
