# 마일리지 좌석 스캔 · 외부 자원과 대안

> 막혔을 때 어디를 파볼지 정리한 문서. 구조는 [AWARD_SCAN_ARCHITECTURE.md](AWARD_SCAN_ARCHITECTURE.md),
> 증상별 대응은 [TROUBLESHOOTING_AWARD_SCAN.md](TROUBLESHOOTING_AWARD_SCAN.md).

---

## 1. 이 프로젝트의 계보

| 저장소 | 관계 | 비고 |
|---|---|---|
| `we-insub/Korean_air` | **원본** (`upstream` 리모트) | 유튜브 @Mato_coder 공개. 단일 노선 조회 |
| `go2god4u-glitch/korean-air-mileage` | 현재 작업본 (`origin`) | public. Actions 무제한 |
| `shoon94parkk-del/mileway-award-monitor` | 참고 사례 | 전세계 노선 + GitHub Actions + Cloudflare |

### 1.1 mileway에서 가져온 것 / 가져오지 않은 것

**참고한 설계**
- GitHub Actions로 스케줄 수집 → 결과를 저장소에 커밋
- 지역(region) 단위 수집 순서 제어
- 실패·미조회를 "좌석 없음"으로 바꾸지 않는 원칙
- `public-data/` 아래에 공개 상태 파일을 두는 배치

**안 가져온 것과 이유**
- Cloudflare Worker 스케줄러 — 우리는 시간당 1회면 충분해서 cron으로 족하다
- Render 정적 사이트 — 결과를 웹에 공개할 이유가 없다 (개인용)
- 브라우저 2레인 병렬 — 차단 위험 대비 이득이 적다

---

## 2. 항공사별 특성 (실측)

### 2.0 좌석이 열리는 시각 (실측)

**매일 09:00 KST에 예매 범위의 마지막 날짜가 열린다.** 범위는 항공사마다 다르다
(2026-09-20 실측):

| 항공사 | 범위 | 그날 열린 마지막 날짜 |
|---|---|---|
| 대한항공 | +360일 | 2027-09-15 (09-16은 미오픈) |
| 아시아나 | +364일 | 2027-09-18 |

같은 날짜를 노린다면 **아시아나가 4일 먼저 열린다.** 장거리 인기 노선은 몇 분 안에 나간다.

로그인 후 예매 검색에서만 실제 잔여를 알 수 있다:

| | 로그인 없이 | 로그인 후 |
|---|---|---|
| 대한항공 | 공개 달력(전날 23:00 스냅샷) | 실시간 잔여 + 마일 가격 |
| 아시아나 | 공개 달력(전날 07:00 스냅샷) + 좌석 수 | 실시간 잔여 |

### 2.1 대한항공

| 항목 | 내용 |
|---|---|
| 공개 달력 URL | `koreanair.com/booking/book-and-manage/award-seat-availability` |
| 실시간 예매 URL | `koreanair.com/booking/search?bookingType=A&tripType=OW` |
| 로그인 | 공개 달력 불필요 · **실시간 예매 필수** |
| headless | ✅ 가능 (UA만 교체) |
| 데이터센터 IP | ✅ 허용 (GitHub Actions 정상) |
| 공개 범위 | 향후 **360일** (매일 09:00에 하루씩 추가) |
| 잔여 좌석 수 | 미공개 (표시 유무만) |
| 관측 API 경로 | `/api/hmp/bonusSeatView/bonusSeatView` — **관측만 하고 직접 호출하지 않는다** |
| 차단 신호 | HTTP 401/403/429, `ERR_HTTP2_PROTOCOL_ERROR` |

**일등석**: `일등석 보너스/좌석승급`이 한 마커로 묶여 나온다. 보너스인지 승급인지
공개 화면만으로는 구분 불가.

### 2.2 아시아나

| 항목 | 내용 |
|---|---|
| 공개 달력 URL | `flyasiana.com/I/KR/KO/MileageSeatSearch.do` |
| 실시간 예매 URL | `flyasiana.com/I/KR/KO/RedemptionRegistTravel.do` |
| 로그인 | 공개 달력 불필요 · **실시간 예매 필수** |
| headless | ⚠️ 조건부 — `navigator.webdriver=false` + UA 교체 **둘 다** 필요 |
| 데이터센터 IP | ⛔ **차단** (Access Denied) |
| 공개 등급 | 일반석(`X`) · 비즈니스(`I`). 일등석 없음 |
| 예약 클래스 | `P`는 승급이므로 제외한다 |
| 차단 신호 | 본문에 `Access Denied` |

**미취항 노선**은 도착지 자동완성에 아예 안 뜬다 → `ROUTE_UNAVAILABLE`로 판정 가능.

**예매 폼의 함정 두 가지** (실측으로 찾음):
1. 좌석등급을 **반드시** 골라야 한다. 안 고르면 "좌석등급을 선택해주세요" 경고창이 뜬다
   (대한항공은 반대로 등급 선택 자체가 없다).
2. `항공권 조회`는 안내 레이어를 열 뿐이고, **그 레이어의 확인**(`toFlightsSelect`)이
   실제 검색이다. 같은 이름의 네비게이션 링크를 누르면 아무 일도 안 일어난다.

**폼 DOM 지도** (2026-09-20 실측)

| 대상 | 선택자 | 메모 |
|---|---|---|
| 출발/도착 표시칸 | `#txtDepartureAirport1` / `#txtArrivalAirport1` | 한 자씩 천천히(140ms) 쳐야 자동완성이 뜬다 |
| 출발/도착 **확정값** | `#departureAirport1` / `#arrivalAirport1` | 숨은 필드. 폼이 실제로 받은 값은 여기 |
| 날짜 확정값 | `#departureDate1` | `YYYYMMDD` |
| 인원 | `#adultCount` + `button.btn_number.plus` | 텍스트칸이 아니라 스테퍼. 직접 타이핑하면 폼 상태가 1로 남는다 |
| 탑승 인원 영역 | `#after_select` | **날짜를 고르기 전까지 `hidebg` 클래스가 덮고 있어 클릭이 막힌다** |
| 운임 라디오 | `td.business_area input[type=radio]` | `opacity:0` 투명. `label[for=…]`을 눌러야 한다 |
| 운임 상세 | 위 라디오의 `data-paxfare` | JSON. `mileage` / `totalAmount` / `fuelCharge` |
| 다음 | `#express_next_btn` (또는 `#nextbtn`) | 한 번 누르면 바로 결제 화면 |

> `hidebg`는 사람을 여러 번 속인다. 날짜 없이 인원을 먼저 넣으려 하면 "버튼이 보이는데
> 클릭이 타임아웃"이 되고, 마치 봇 탐지처럼 보인다. 순서만 지키면 된다.

**`data-paxfare.totalAmount`는 1인 기준이다.** 2명으로 조회해도 같은 값(100,500)이
오고 실제 청구는 2배(KRW 201,000)였다. 화면에 총액으로 표시하면 절반을 속이는 셈이다.

**예매 화면(`RedemptionExpressBooking.do`)의 가족 마일리지 표**

| 대상 | 선택자 | 메모 |
|---|---|---|
| 공제 스위치 | `#mile_<회원번호>` | 본인 행은 `disabled`로 고정 |
| 탑승 스위치 | `#boarding_<회원번호>` | **공제가 모자라면 아예 없고 "탑승 불가"만 보인다** |
| 보안문자 | `#cnCaptchaCode` | 6자리. **`공제 및 탑승자 입력 완료`보다 먼저** 넣어야 한다 |
| 세션 | `남은 시간 N분 N초` + `세션 연장` | **1~2분.** 만료되면 첫 화면으로 튕긴다 |

순서가 정해져 있다: **공제 → 탑승 → 보안문자 → 입력 완료 → 결제.**
공제를 먼저 켜지 않으면 탑승 칸이 열리지 않는다.

**아시아나는 끝까지 자동화되지 않는다.** 보안문자가 결제 앞을 막는다. 페이지가 직접
*"보안을 위해 아래 캡차 인증을 진행 해 주시기 바랍니다"* 라고 말한다. 이를 무시하고
JS로 클릭을 밀어넣으면 *"고객님의 요청 사항을 온라인에서 처리해드리기 어렵습니다"* 와
함께 세션이 끊긴다. 대한항공에는 이 단계가 없다.

**속도 측정**: `AWARD_TIMING=1`을 켜면 단계별 소요 시간이 stderr에 찍힌다.
고정 대기를 조건 대기로 바꿔 27.7초 → 12.8초. 자세한 표는 ARCHITECTURE §10.7.

### 2.3 아직 손대지 않은 프로그램

원본 앱에는 있으나 자동 스캔에 넣지 않은 것들. 전부 **로그인 세션이 필요**하다.

| 프로그램 | 필요 조건 | 난이도 |
|---|---|---|
| SAS 유로보너스 | SAS 로그인, 날짜별 검색 | 중 (원본에 구현 있음) |
| 스카이팀 · 대한항공 | 대한항공 로그인, **왕복 필수** | 상 (가는 편 선택해야 오는 편이 보임) |
| 스타얼라이언스 · 아시아나 | 아시아나 로그인 | 중 |

자동화하려면 로그인 세션을 클라우드로 옮겨야 하는데, 이는 자격증명 보관 문제를
동반하므로 현재 범위에서 제외했다.

---

## 3. 아시아나 클라우드 차단 우회 — 검토한 선택지

**현재 결론: 우회하지 않는다.** 아시아나는 로컬에서만 조회한다.

| 방법 | 비용 | 실효성 | 판단 |
|---|---|---|---|
| Vercel 경유 | 무료~유료 | ❌ | AWS 데이터센터 IP라 동일 차단. 함수 실행시간(최대 5분)도 부족하고 Chrome 실행 불가 |
| 다른 클라우드(Cloud Run 등) | 유료 | ❌ | 같은 이유 |
| 주거용 프록시 | 월 $10~50 | ✅ 유력 | 가정용 IP를 빌려줌. 설정 필요 |
| 맥에서 launchd 예약 실행 | 무료 | ✅ | 맥이 켜져 있을 때만 |
| Tailscale Funnel 등으로 집 IP 경유 | 무료 | 🔶 | 집 네트워크를 상시 노출해야 함 |

주거용 프록시를 도입한다면 진입점은 `chromeArguments()`에 `--proxy-server=` 추가와
`openNativeChrome` 옵션 확장이다.

---

## 4. 막혔을 때 쓸 도구

### 4.1 DOM 구조가 바뀌었을 때

파서가 `EMPTY_UNVERIFIED_STATE` / `STRUCTURE_CHANGED`를 던지면 실제 DOM을 떠서 본다.

```ts
// 임시 스크립트를 프로젝트 루트에 만들고 실행 후 삭제한다
// node_modules 해석 때문에 /tmp에서는 안 된다
const html = await dialog.evaluate(el => el.outerHTML);
writeFileSync('/tmp/dump.html', html, 'utf8');
```

정상 칸과 문제 칸을 **나란히 비교**하는 것이 가장 빠르다. 지금까지 이 방법으로
"운항편 없음"과 "예약 미오픈" 두 구조를 찾아냈다.

### 4.2 봇 탐지 의심 시 확인 순서

```js
await page.evaluate(() => navigator.webdriver)   // false 여야 통과하는 사이트가 있다
await page.evaluate(() => navigator.userAgent)   // HeadlessChrome 포함 여부
```

둘 다 정상인데 막히면 **IP 문제**로 좁혀진다.

### 4.3 네트워크 레벨 관측

```ts
page.on('response', r => { if (r.status() >= 400) console.log(r.status(), r.url()); });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
```

### 4.4 최후의 수단 (미사용)

- **mitmproxy 캡처** — 앱/웹 트래픽을 직접 관찰. 단, 공개 화면 조회라는 현재 원칙을
  벗어나므로 도입 전에 이용약관을 다시 확인해야 한다.
- **API 직접 호출** — 관측된 `/api/hmp/bonusSeatView/bonusSeatView`를 재생(replay)하는 방식.
  원본 저자가 의도적으로 피했고(`OBSERVED_RESPONSE_PATH` 주석), 우리도 따른다.

---

## 5. Playwright / Chrome 실전 메모

### 5.1 세 가지 실행 방식의 차이

| 방식 | `navigator.webdriver` | 창 | 쓰는 곳 |
|---|---|---|---|
| `chromium.launch({headless:true})` | **true** | 없음 | 대한항공 |
| `chromium.launch({headless:false})` | true | 있음 | (안 씀) |
| `spawn(chrome) + connectOverCDP` | **false** | 옵션 | 아시아나 |

### 5.2 직접 띄운 Chrome의 함정

```ts
const native = await openNativeChrome(profile, {...});
await native.browser.close();   // ❌ 연결만 닫힘, 프로세스 생존 → Node 종료 불가
await native.close();           // ✅ child.kill() 포함
```

프로필 디렉터리는 **동시에 하나의 Chrome만** 쓸 수 있다. 로컬 앱과 클라우드 스캔이
각각 `asiana-local-profile` / `asiana-scan-profile`로 분리된 이유다.

### 5.3 Xvfb는 더 이상 필요 없다

한때 "headed Chrome을 가상 디스플레이에서 돌린다"는 우회를 썼으나,
UA 교체로 진짜 headless가 가능해져 제거했다. 워크플로우에 `xvfb-run`이 보이면
옛 코드다.

---

## 6. 비행시간 데이터

`config/flight-hours.json` — 인천 출발 직항 기준 **어림값**(104개 공항).

- 출처: 일반적인 운항 소요시간. 실제 시각표가 아니다
- 계절·기류·기종에 따라 30분 이상 차이날 수 있다
- 용도: 노선 선별용 필터. 예약 판단에 쓰지 않는다
- 목록에 없는 공항은 **필터에서 제외하지 않는다** (모름 ≠ 짧음)

갱신이 필요하면 이 파일만 고치면 된다. 코드 변경 불필요.

### 6.1 비즈니스 좌석 기준 (사용자 선호)

| 구간 | 의미 |
|---|---|
| 6시간 이상 | 비즈니스가 의미 있어지는 최소선 (식사 + 수면) |
| 8시간 이상 | 장거리 |
| **10시간 이상** | 최장거리. **신형 기종 배치 확률이 가장 높다** |

장거리일수록 풀플랫·직접 통로 접근 좌석이 투입되므로,
"좋은 비즈니스 좌석"을 노린다면 10시간 이상이 가장 확률이 높다.

---

## 7. 텔레그램

| 항목 | 값 |
|---|---|
| 봇 | `@test240224_bot` ("대한항공 마일리지 프리스티지") |
| 토큰/채팅ID | GitHub Secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) |
| 메시지 상한 | 4096자 (우리는 3800자로 분할) |
| 속도 제한 | 429 응답의 `parameters.retry_after` 준수 |

API 문서: https://core.telegram.org/bots/api#sendmessage

> 토큰이 노출되면 @BotFather에서 `/revoke`로 재발급하고 Secrets를 갱신한다.

---

## 8. 원본 코드 보존

`upstream` 리모트로 원본 저장소를 유지하고 있다.

```bash
git remote -v                        # upstream = we-insub/Korean_air
git show upstream/main:src/parser.ts # 원본 파일 열람
git diff upstream/main -- src/       # 우리가 바꾼 부분 전체
```

원본에서 **수정한 파일**(되돌릴 필요가 생길 수 있는 것):

| 파일 | 변경 내용 |
|---|---|
| `src/parser.ts` | "운항편 없음", "예약 미오픈" 상태 추가 |
| `src/types.ts` | `availabilityType` 확장, 등급 `null` 허용 |
| `src/collector.ts` | headless UA 교체, 월 포함 규칙 완화 |
| `src/partners/asiana.ts` | 느린 입력, 미취항 판정, 자동완성 재시도 |
| `src/sas/native-chrome.ts` | headless·UA 옵션 추가 |
| `scripts/local-collect.ts` | `--hidden` 플래그 |
| `scripts/award-browser.ts` | 아시아나 전용 headless 경로 |
| `local_app.py` | 일괄 스캔·알림 신청 서비스, 월 범위, 검증 완화 |
| `local_web/index.html` | 탭 구조, 새 화면 |
| `tests/*` | 변경된 규칙에 맞춰 갱신 |

별도 `_reference/` 백업을 두지 않은 이유: `upstream` 리모트가 원본 전체를
커밋 단위로 보존하므로 중복이다.

---

## 9. 다음에 손댈 만한 것

| 항목 | 이유 | 난이도 |
|---|---|---|
| 실패 구간 재시도 | 클라우드 실패 11건이 대부분 일시적 타임아웃 | 하 |
| 9시 대기 실전 검증 | 지금까지 측정은 전부 한산한 시간대다 | 하 |

| 아시아나 로컬 자동 실행(launchd) | 맥에서만 되는 아시아나를 주기 실행 | 하 |
| 주거용 프록시 | 아시아나를 클라우드에서도 | 중 |
| SAS·스카이팀 자동화 | 로그인 세션 필요 | 상 |
| 왕복 조합 검증 | 지금은 편도 단위. 실제 왕복 가능 여부는 별개 | 중 |
| 좌석 사라짐 알림 | 지금은 새로 생긴 것만 알린다 | 중 |
