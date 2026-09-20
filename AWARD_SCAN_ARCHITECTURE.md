# 마일리지 좌석 스캔 · 시스템 해부

> 이 저장소에 **추가된 기능**의 구조 문서. 원본 앱(단일 노선 조회)은 `README.md`를 본다.
> 증상별 대응은 [TROUBLESHOOTING_AWARD_SCAN.md](TROUBLESHOOTING_AWARD_SCAN.md),
> 외부 자원은 [AWARD_SCAN_INTELLIGENCE.md](AWARD_SCAN_INTELLIGENCE.md).

---

## 0. 무엇을 만들었나

원본은 "노선 하나 + 달 하나"를 조회하는 도구였다. 여기에 다섯을 얹었다.

1. **여러 노선 일괄 스캔** — 지역 단위로 골라 한 번에 훑는다 (화면)
2. **상시 알림 신청** — 조건을 등록하면 GitHub이 매시간 대신 조회하고 텔레그램으로 알린다
3. **일등석 분리 표시** — 비즈니스와 다른 종류의 발견으로 취급한다
4. **실시간 재확인** ([§9](#9-실시간-재확인)) — 공개 달력에서 찾은 날짜를 항공사 예매
   시스템에 다시 물어, 이미 팔린 것을 결과에서 뺀다
5. **9시 예매 대기** ([§10](#10-9시-예매-대기-오픈런)) — 좌석이 열리는 오전 9시에 맞춰
   대기하다가 좌석 선택까지 끝낸 예매 화면을 띄운다

핵심 설계 원칙 하나: **모르는 것을 "없음"으로 바꾸지 않는다.** 조회 실패, 예약 미오픈,
미취항은 각각 다른 상태이며 어느 것도 "좌석 없음"이 아니다.

그리고 **결제는 하지 않는다.** 자동화는 좌석 선택에서 멈춘다. 마일리지가 차감되고
현금이 청구되는 마지막 버튼은 사람이 누른다.

---

## 1. 전체 그림

```
┌─────────────────────── 내 맥 ───────────────────────┐
│                                                     │
│  브라우저 127.0.0.1:8765                            │
│   ├ 단일 노선 조회   (원본 기능)                     │
│   ├ 비즈니스 이상 타기  business-scan-ui.js          │
│   └ 자동 알림 신청      watches-ui.js                │
│            │                                        │
│            ▼                                        │
│  local_app.py  (표준 라이브러리만, 루프백 전용)      │
│   ├ BusinessScanService   여러 노선 순차 조회        │
│   ├ validate_watch        신청 검증·저장             │
│   └ sync_watches_to_github  git add/commit/push     │
│            │                                        │
│            ├─ 대한항공 ─▶ scripts/local-collect.ts  │
│            │              └ src/collector.ts        │
│            │                 headless Chrome        │
│            └─ 아시아나 ─▶ scripts/award-browser.ts  │
│                           └ src/partners/asiana.ts  │
│                              native Chrome + CDP    │
└─────────────────────────────────────────────────────┘
                     │ config/watches.json (git push)
                     ▼
┌──────────────── GitHub Actions ─────────────────────┐
│  business-scan.yml   09:00 KST 집중 + 매시간         │
│   └ scripts/business-scan.ts                        │
│       ├ 대한항공  ✅ 동작                            │
│       ├ 아시아나  ⛔ IP 차단 → CI에서 건너뜀         │
│       ├ public-data/business-hits.json 갱신·커밋     │
│       └ 새 좌석 발견 시 → 텔레그램                   │
└─────────────────────────────────────────────────────┘
```

---

## 2. 데이터 모델

### 2.1 AwardDate — 하루치 상태 (`src/types.ts`)

```ts
{
  date: '2027-09-15',
  operatingStatus: 'OPERATED' | 'NOT_OPERATED',
  availabilityType: 'PUBLIC_INDICATOR' | 'NOT_YET_OPEN',
  availableSeatCount: null,          // 공개 화면은 잔여 수를 주지 않는다
  economyAward:  boolean | null,     // null = 모름
  premiumAward:  boolean | null,
  prestigeAward: boolean | null,     // 비즈니스
  firstAward:        boolean | null, // 항상 null (아래 2.2)
  firstAwardOrUpgrade: boolean,      // 일등석 판단은 이 값으로
  …Upgrade 계열
}
```

**세 가지 "없음"을 구분한다:**

| 의미 | 표현 |
|---|---|
| 좌석이 없다고 항공사가 공개 | `prestigeAward: false`, `PUBLIC_INDICATOR` |
| 그날 운항 자체가 없다 | `operatingStatus: 'NOT_OPERATED'` |
| 아직 예약이 안 열렸다 | `availabilityType: 'NOT_YET_OPEN'`, 등급 `null` |
| 조회에 실패했다 | 그 달을 저장하지 않음 (이전 결과 유지) |

### 2.2 일등석이 `null`인 이유

대한항공 공개 달력의 필터 항목은 6개다:

```
일반석 보너스 / 프리미엄석 보너스 / 프리미엄석 좌석승급
프레스티지석 보너스 / 프레스티지석 좌석승급
일등석 보너스/좌석승급          ← 하나로 묶여 있다
```

비즈니스는 보너스와 승급이 분리돼 있어 구분되지만, **일등석은 항공사가 묶어서 공개한다.**
따라서 `firstAward`(보너스인가?)는 알 수 없어 항상 `null`이고,
`firstAwardOrUpgrade`만 `true`가 된다. 화면과 알림도 "보너스 또는 좌석승급"으로 표기한다.

### 2.3 Watch — 알림 신청 (`config/watches.json`)

```json
{
  "id": "12자리 hex",
  "label": "파리 겨울휴가",
  "origins": ["ICN"],
  "destinations": ["CDG"],
  "regions": ["유럽"],            
  "startDate": "2026-12-20",
  "endDate": "2027-01-10",
  "programs": ["korean-air", "asiana-club"],
  "enabled": true,
  "updatedAt": "ISO8601"
}
```

`regions`는 `config/award-routes.json`의 공항 목록으로 펼쳐진다.
**날짜는 월이 아니라 일 단위**이며, 스캔은 월 단위로 조회한 뒤 이 범위로 거른다.

### 2.4 Hit — 발견 기록 (`public-data/business-hits.json`)

```json
{ "watchId": "…", "program": "korean-air", "cabin": "prestige" | "first",
  "origin": "ICN", "destination": "SFO", "destinationName": "샌프란시스코",
  "date": "2027-08-03", "sourceUpdatedAt": "…", "collectedAt": "…" }
```

신규 판정 키: `program-cabin-origin-destination-date`.
등급이 키에 포함되므로 같은 날 비즈니스·일등석이 각각 따로 알림된다.

---

## 3. 조회 경로 3종

| 경로 | 쓰는 곳 | 브라우저 | 창 |
|---|---|---|---|
| `local-collect.ts` | 로컬 단일·일괄 조회 | Playwright headless + UA 교체 | 없음 |
| `award-browser.ts` (아시아나) | 로컬 일괄 조회 | native Chrome `--headless=new` + CDP | 없음 |
| `business-scan.ts` | GitHub Actions | 위 둘을 직접 호출 | 없음 |

### 3.1 대한항공 — 왜 UA를 바꾸는가

대한항공 엣지는 UA에 `HeadlessChrome`이 있으면 `ERR_HTTP2_PROTOCOL_ERROR`로 끊는다.
headless 자체를 막는 게 아니다. 실측 결과:

| 조건 | 결과 |
|---|---|
| headless 기본 | ❌ HTTP2 오류 |
| headless + 정상 UA | ✅ 성공 |
| headless + `--disable-http2` | ❌ 타임아웃 |
| headed | ✅ 성공 (창이 뜸) |

→ `src/collector.ts`가 `headless === true`일 때만 UA를 덮어쓴다.

### 3.2 아시아나 — 왜 Chrome을 직접 띄우는가

두 개의 독립된 방어를 동시에 넘어야 한다.

1. **UA 검사** — 대한항공과 동일
2. **`navigator.webdriver` 검사** — true이면 도착지 자동완성을 초기화하지 않는다

Playwright가 띄운 브라우저는 2번을 우회할 수 없다. 그래서 Chrome을 `spawn`하고
`chromium.connectOverCDP()`로 붙는다(`src/sas/native-chrome.ts`).

```ts
openNativeChrome(profile, { headless: true, userAgent: NATIVE_USER_AGENT })
// → --headless=new --user-agent=… --remote-debugging-port=…
// → navigator.webdriver === false
```

**주의: 이렇게 띄운 Chrome은 CDP 연결을 닫아도 살아 있다.** 반드시 반환된 `close()`를
호출해야 `child.kill()`까지 간다. 안 그러면 Node가 종료되지 않는다.

또한 아시아나 폼은 느린 입력을 요구한다(`src/partners/asiana.ts`):
- 공항 코드는 글자당 140ms
- 단계마다 1.2초 정착 대기
- 도착칸 자동완성은 최대 6회 재클릭
- 조회 간 20초 간격 (`ASIANA_REQUEST_INTERVAL`)

---

## 4. 상수와 그 근거

| 상수 | 값 | 위치 | 근거 |
|---|---|---|---|
| 예약 가능 범위 | **360일** | `collector.ts`, `local_app.py` | 매일 09:00에 360일 뒤가 열린다 |
| 월 포함 규칙 | **시작일 기준** | 동일 | 항공사가 1일만 열려도 월을 연다 |
| 캐시 수명 | 12시간 | `CACHE_SECONDS` | 원본 설계 |
| 아시아나 간격 | 20초 | `ASIANA_REQUEST_INTERVAL` | 연속 요청 시 차단 실측 |
| 대한항공 간격 | 4초 | `business-scan.ts` `interval` | 보수적 기본값 |
| 스캔 상한 | 2000건 | `BUSINESS_SCAN_MAX_LEGS` | 폭주 방지용 (실질 무제한) |
| 텔레그램 분할 | 3800자 | `TELEGRAM_LIMIT` | API 상한 4096자 |
| 폴링 허용 실패 | 8회 | `pollFailures` | 서버 재시작을 견디는 값 |
| 실행 주기 | 00:02·12·22·40 UTC + 매시 17분 | `business-scan.yml` | 09:00 KST 오픈에 맞춤 |
| 9시 대기 상수 | [§10.2](#102-상수-releasewatchservice) 참조 | `ReleaseWatchService` | |

### 4.1 월 포함 규칙을 바꾼 이유

과거: "한 달 **전체**가 359일 안에 들어와야 조회 가능" → 2027년 9월이 빠졌다.
현재: "그 달 **1일**이 360일 안이면 조회 가능" → 항공사 화면과 일치한다.

360일인 이유: 매일 09:00에 그날부터 360일 뒤가 열린다. 실측으로 9/20에 2027-09-15가
열렸고(=+360일) 2027-09-16은 미오픈이었다. 359로 두면 **그날 막 열린 날짜가 달의
첫날일 때 그 달 전체가 하루 늦게** 보인다.

대신 월 후반부는 아직 안 열려 있을 수 있고, 그 날들은 `NOT_YET_OPEN`으로 기록된다.
실측(2027-09 ICN→NRT): 30일 중 14일 공개, 16일 미오픈.

---

## 5. 서비스 계층 (`local_app.py`)

### 5.1 BusinessScanService

`SearchService`의 `lock`/`active`/`restricted`를 **공유**한다. 수동 단일 조회와
일괄 스캔이 동시에 돌지 않게 하기 위함이다.

```
start(raw)
 └ validate_business_scan_request  →  origins × destinations × months 조합 생성
 └ 스레드 시작
     for leg in legs:
       for program in programs:
         ├ 취소 요청? → StopIteration
         ├ 미취항 기록에 있나? → 건너뜀
         ├ 이 프로그램이 차단됐나? → 건너뜀
         ├ 조회 (대한항공: 캐시 확인 후 수집 / 아시아나: 20초 간격)
         └ 실패 시
             ├ ROUTE_UNAVAILABLE → 미취항으로 영구 기록
             ├ 접속제한 + 아시아나 → 그 프로그램만 중단
             └ 접속제한 + 대한항공 → 전체 중단
```

**중요: 실패한 구간은 이전 결과를 유지한다.** 조회 실패를 "좌석이 사라졌다"로
바꾸지 않기 위해서다.

### 5.2 알림 신청 저장 → GitHub 반영

```
POST /api/watches/save    → config/watches.json 에 기록 (로컬만)
GET  /api/watches         → 목록 + 동기화 상태(pendingChanges/unpushedCommits)
POST /api/watches/sync    → git add → commit → pull --rebase → push
```

**로컬 저장과 GitHub 반영은 별개 단계다.** 화면이 이 사실을 경고 박스로 명시한다.
`watches_sync_state()`가 `git status --porcelain`과 `rev-list origin/main..HEAD`로
미반영 여부를 판정한다.

### 5.3 API 목록 (추가분)

| 메서드 | 경로 | 용도 |
|---|---|---|
| POST | `/api/business-scan` | 일괄 스캔 시작 |
| GET | `/api/business-scan/jobs/{id}` | 진행 상황·중간 결과 |
| POST | `/api/business-scan/cancel` | 중단 |
| GET | `/api/watches` | 신청 목록 + 동기화 상태 |
| POST | `/api/watches/save` | 추가·수정 |
| POST | `/api/watches/delete` | 삭제 |
| POST | `/api/watches/sync` | GitHub 반영 |
| GET | `/api/watches/cloud` | 클라우드 실행 상태 (gh CLI) |
| GET | `/api/flight-hours` | 비행시간 표 |

---

## 6. 화면 (`local_web/`)

### 6.1 탭 구성

| 탭 | 파일 | 특징 |
|---|---|---|
| 단일 노선 조회 | `index.html` 내장 | 원본. 날짜 선택 → 대한항공 자동 입력 |
| 비즈니스 이상 타기 | `business-scan-ui.js` | 지역 단위, 실시간 결과 누적, 중단 가능 |
| 자동 알림 신청 | `watches-ui.js` | 신청 CRUD + GitHub 반영 + 클라우드 상태 |

### 6.2 비즈니스 탭의 선택 흐름

```
여정 방향 ─┬ 출국: 출발=한국 공항 체크, 목적지=지역
           └ 귀국: 출발=지역,          목적지=ICN 고정
   ↓
지역 선택 → 공항 코드로 펼침 (클라이언트에서)
   ↓
비행시간 필터 (0/6/8/10시간) → 짧은 노선 제거
   ↓  ※ 비행시간을 모르는 공항은 남긴다 (모름 ≠ 짧음)
조합 수·예상 시간 계산 → 표시
```

비행시간 기준은 `config/flight-hours.json`(인천 기준 어림값, 104개 공항).
**실제 시각표가 아니라 노선 선별용 근사치**다.

### 6.3 결과 표시

- 노선 × 등급 단위로 패널 분리 (일등석은 금색 강조 + 안내문)
- 조회 중에는 **최근 발견 순**, 끝나면 **건수 순** 정렬
- 각 패널에 확인 시각 표시
- 카운터 단위는 "개" (날짜 개수이지 기간이 아니므로)

---

## 7. 클라우드 스캔 (`scripts/business-scan.ts`)

### 7.1 신청이 없을 때

`config/watches.json`이 비어 있으면 `config/business-watch.json`의
기본 관심 노선(유럽·미주 9곳)으로 대체 실행한다.

### 7.2 결과 저장 전략

스캔은 수십 분 걸리고 그 사이 `main`이 움직인다. rebase는 충돌하므로
**실행 결과를 최신 main 위에 다시 얹는다**:

```bash
git fetch origin main && git reset --soft origin/main
git add public-data/business-hits.json && git commit && git push origin HEAD:main
```

이 파일에 한해서는 실행 결과가 최신이므로 덮어쓰기가 옳다.

### 7.3 텔레그램 발송

- 노선·등급별로 묶고, 날짜는 월별로 접는다 → `11월: 1, 3, 5, 12일`
- 3800자 단위 분할, 줄 중간에서 끊지 않는다
- 429(속도 제한) 시 `retry_after`만큼 대기 후 재시도
- 실측: 1,218건 → 메시지 2개, 누락 0

---

## 8. 검증 기록

| 항목 | 결과 | 시점 |
|---|---|---|
| 대한항공 headless 수집 | ICN→NRT 11월 30일 중 비즈니스 27일 / 6초 | 2026-09-19 |
| 아시아나 headless 수집 | ICN→NRT 11월 30건 / 13초, 창 0개 | 2026-09-19 |
| 귀국편 | NRT→ICN 11월 26건 | 2026-09-19 |
| 2027-09 확장 | 30일 중 공개 14 / 미오픈 16, 미오픈은 `null` | 2026-09-19 |
| 파서 수정 효과 | 클라우드 실패 53건 → 11건 | 2026-09-19 |
| 일등석 분리 | 패널 2개 분리 + 안내문 (합성 데이터) | 2026-09-19 |
| 폴링 복구 | 통신 차단 후 복구 시 검색 유지 | 2026-09-19 |
| 아시아나 클라우드 | `ACCESS_RESTRICTED` (IP 차단 확정) | 2026-09-19 |
| 테스트 | JS 108 / Python 113 통과 | 2026-09-19 |

| 실시간 재확인 (대한항공) | ICN→LHR 2027-09-14 달력엔 있으나 **매진** 확인 | 2026-09-20 |
| 실시간 재확인 (아시아나) | ICN→NRT 11/01 `OZ102 22,500마일` 등 확인 | 2026-09-20 |
| 등급 분리 | 같은 날 비즈니스 매진 / 일등석 12만 마일 각각 판정 | 2026-09-20 |
| 결제 직전 도달 | ICN→NRT 2027-08-05 KE703 **32,500마일 + 90,000원** | 2026-09-20 |
| 미리 채우기 효과 | 9.4초 → **3.5초** | 2026-09-20 |
| 병렬 발사 | 한산할 때 3.2초(1탭) vs 3.3초(3탭) — 이득은 편차에서 | 2026-09-20 |
| 9시 대기 전 과정 | T-90초 준비 → 정각 발사 → 좌석 선택까지 성공 | 2026-09-20 |
| 로그인 판정 | 로그인 상태 `true` + 실제 조회 4편 (일치) | 2026-09-20 |

**아직 확인 못한 것**

- 일등석이 실제로 **예약 가능한** 경우를 만나지 못했다. 관측된 일등석은 모두 매진이거나
  12만 마일 표시뿐이었고, 화면 렌더링은 합성 데이터로 검증했다.
- **실제 9시 상황에서 돌려본 적이 없다.** 지금까지의 측정은 전부 한산한 시간대이며,
  병렬 발사의 이득은 9시에만 드러난다. 첫 실전이 곧 첫 검증이다.
- 결제 버튼은 눌러본 적이 없다. 의도된 것이다.

---

## 9. 실시간 재확인

공개 달력은 **하루 한 번**(대한항공 23:00, 아시아나 07:00) 만들어지는 스냅샷이다.
그 사이에 팔린 자리는 달력에 남아 있고, 예매 화면에는 없다. 실제로 그런 일이 있었다:
ICN→LHR 2027-09-14가 달력엔 비즈니스로 표시됐지만 예매 시스템에선 `프레스티지석 매진`,
남은 건 일등석 12만 마일뿐이었다.

그래서 달력으로 **찾고**, 항공사 예매 검색으로 **확인한다**.

| | 대한항공 | 아시아나 |
|---|---|---|
| 모듈 | `src/partners/korean-air-award.ts` | `src/partners/asiana-award.ts` |
| 로그인 | 필수 | 필수 |
| 등급 선택 | **없음** (결과에 전 등급이 가격/매진으로 나옴) | **필수** (안 고르면 경고창) |
| 제출 | `항공편 검색` 한 번 | 조회 → **안내 레이어의 확인** 두 번 |
| 잔여 판정 | `label[for^="flight-bonus"]`의 `52,500 마일` / `매진` | `td.business_area`의 `매진` 여부 |

### 9.1 언제 검증하나

한 노선(leg)을 훑을 때마다 **그 자리에서** 검증한다. 전부 훑은 뒤 한꺼번에 하면,
긴 스캔이 도는 내내 화면에 이미 팔린 자리가 남아 있게 된다.

### 9.2 판정 3종

| `live` | 뜻 | 화면 |
|---|---|---|
| `available` | 지금 예약 가능 | 편명·마일 표시, 초록 강조 |
| `gone` | 달력엔 있으나 매진 | **결과에서 제외**, 하단에 건수만 |
| `unchecked` | 확인 실패(로그인·차단·모호) | 남겨두고 "확인 못함" |

`unchecked`를 `gone`으로 바꾸지 않는 것이 요점이다. 확인하지 못한 것과 없는 것은 다르다.

### 9.3 등급은 반드시 하나씩

같은 날 비즈니스와 일등석이 둘 다 뜨면 **발견 2건**으로 나눈다. 한 건에 두 등급을 담았더니
검증이 일등석으로만 돌고 그 답(12만 마일 가능)이 비즈니스 칸에도 표시됐다. 지금은
등급이 하나가 아닌 발견은 검증하지 않고 `AMBIGUOUS_CABIN`으로 남긴다.
회귀 테스트: `tests/test_local_app.py::LiveVerificationCabinTests`.

---

## 10. 9시 예매 대기 (오픈런)

대한항공은 **매일 09:00 KST에 360일 뒤 날짜**를 연다. 장거리 인기 노선은 몇 분 안에
나가므로, 9시에 조회를 *시작*하면 이미 늦다.

### 10.1 시간표

```
T-90초   탭 3개에 폼을 미리 채운다 (공항·날짜까지, 제출은 안 함) — 약 15초
T-75초   준비 완료, 정각까지 1초 단위로 대기
T-0초    3개 동시 발사 → 가장 먼저 자리를 찾은 탭 채택, 나머지 폐기
         → 좌석(운임) 선택까지 수행하고 정지
```

왜 90초인가: 탭 3개 준비에 15초가 걸린다. 20초 전에 깨우면 9시에 아직 폼을 채우고 있다.

왜 병렬인가: 9시엔 응답 시간이 들쭉날쭉해진다. 한 탭이 8초여도 다른 탭이 3초면 3초에
끝난다. **평균이 아니라 편차를 줄이는 장치**다. 한산할 때 측정하면 1탭과 차이가 없다
(3.2초 vs 3.3초) — 그게 정상이다.

재시도는 탭 1개만 다시 채운다(6초). 그땐 경쟁이 줄었고 빨리 다시 쏘는 게 중요하다.

### 10.2 상수 (`ReleaseWatchService`)

| 상수 | 값 | 근거 |
|---|---|---|
| `RELEASE_HOUR` / `RELEASE_WINDOW_DAYS` | 9 / 360 | 실측: 9/20에 2027-09-15 오픈 |
| `LEAD_SECONDS` | 90 | 탭 3개 준비 15초 + 여유 |
| `ARMED_TABS` / `RETRY_TABS` | 3 / 1 | 위 |
| `POLL_SECONDS` | 3 | 자리가 늦게 열릴 때 재시도 간격 |
| `GIVE_UP_SECONDS` | 900 | 9시 이후 15분이면 승부가 끝난다 |
| `LOGIN_CHECK_SECONDS` | 600 | 세션 만료를 9시 전에 알기 위해 |

### 10.3 로그인 감시

9시에 로그인이 풀려 있으면 속도는 아무 의미가 없다. 대기 중 **10분마다** 세션을 확인하고,
풀리면 화면과 **텔레그램으로 즉시** 알린다.

판정 방법이 한 번 틀렸던 자리다. "로그아웃 링크가 보이는가"로 봤더니 그 링크가 메뉴 안에
숨은 레이아웃에서 멀쩡한 세션을 만료로 보고했다. 지금은 **로그인 페이지로 튕기는지**로
판단하고, 그 리다이렉트가 **6초 뒤에** 일어나므로 9초까지 기다린다. 성급히 답하면
만료된 세션을 정상으로 보고하게 되는데, 그쪽이 더 나쁜 실수다.

### 10.4 어디서 멈추나

좌석(운임) 선택까지다. 그 다음은 승객 정보(여권 영문 성명·생년월일)와 결제인데,
예약 후 성명 변경이 불가하고 마일리지·현금이 실제로 나가는 단계다. 사람이 한다.

실측 도달 화면: `ICN→NRT 2027-08-05 KE703 프레스티지석 · 32,500마일 + 90,000원`

### 10.5 로컬 전용인 이유

실시간 확인에 항공사 로그인이 필요하고, 그 로그인은 이 맥의 조회용 Chrome에만 있다.
클라우드에는 로그인이 없고 아시아나는 IP까지 막는다. **9시에 맥이 켜져 있어야 한다.**

대기 중 프로그램이 재시작되면 대기는 끊긴다. 저장된 상태를 `interrupted`로 바꿔
화면에 알린다 — 조용히 놓치는 것보다 낫다.

---
