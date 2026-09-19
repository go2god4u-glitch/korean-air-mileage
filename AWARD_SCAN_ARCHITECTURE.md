# 마일리지 좌석 스캔 · 시스템 해부

> 이 저장소에 **추가된 기능**의 구조 문서. 원본 앱(단일 노선 조회)은 `README.md`를 본다.
> 증상별 대응은 [TROUBLESHOOTING_AWARD_SCAN.md](TROUBLESHOOTING_AWARD_SCAN.md),
> 외부 자원은 [AWARD_SCAN_INTELLIGENCE.md](AWARD_SCAN_INTELLIGENCE.md).

---

## 0. 무엇을 만들었나

원본은 "노선 하나 + 달 하나"를 조회하는 도구였다. 여기에 셋을 얹었다.

1. **여러 노선 일괄 스캔** — 지역 단위로 골라 한 번에 훑는다 (화면)
2. **상시 알림 신청** — 조건을 등록하면 GitHub이 매시간 대신 조회하고 텔레그램으로 알린다
3. **일등석 분리 표시** — 비즈니스와 다른 종류의 발견으로 취급한다

핵심 설계 원칙 하나: **모르는 것을 "없음"으로 바꾸지 않는다.** 조회 실패, 예약 미오픈,
미취항은 각각 다른 상태이며 어느 것도 "좌석 없음"이 아니다.

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
│  business-scan.yml   매시간 17분                     │
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
| 예약 가능 범위 | 359일 | `collector.ts`, `local_app.py` | 대한항공 공개 범위 |
| 월 포함 규칙 | **시작일 기준** | 동일 | 항공사가 1일만 열려도 월을 연다 |
| 캐시 수명 | 12시간 | `CACHE_SECONDS` | 원본 설계 |
| 아시아나 간격 | 20초 | `ASIANA_REQUEST_INTERVAL` | 연속 요청 시 차단 실측 |
| 대한항공 간격 | 4초 | `business-scan.ts` `interval` | 보수적 기본값 |
| 스캔 상한 | 2000건 | `BUSINESS_SCAN_MAX_LEGS` | 폭주 방지용 (실질 무제한) |
| 텔레그램 분할 | 3800자 | `TELEGRAM_LIMIT` | API 상한 4096자 |
| 폴링 허용 실패 | 8회 | `pollFailures` | 서버 재시작을 견디는 값 |
| 실행 주기 | 매시 17분 | `business-scan.yml` | 정시 혼잡 회피 |

### 4.1 월 포함 규칙을 바꾼 이유

과거: "한 달 **전체**가 359일 안에 들어와야 조회 가능" → 2027년 9월이 빠졌다.
현재: "그 달 **1일**이 359일 안이면 조회 가능" → 항공사 화면과 일치한다.

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

**아직 확인 못한 것**: 일등석 표시가 실제로 뜬 노선을 만나지 못했다
(JFK·LAX·CDG 여러 달 조회 시 비즈니스조차 0건). 합성 데이터로만 검증했다.
