#!/bin/sh
# 작전일지 — 성문 앞까지
#
# 아시아나의 마지막 문에는 보안문자가 걸려 있다. 하여 이 칼은 문을 부수지 않고
# 문 앞까지만 간다: 운임을 고르고, 어머니의 마일리지를 공제로 걸고, 탑승자를
# 본인과 배우자로 세워 결제 화면을 띄워 놓는 데서 멈춘다.
# 보안문자와 결제하기는 사람의 손이다. 그것이 이 성문의 천장이다.
#
# 쓰임:
#   scripts/asiana-book.sh                      # 기본값 ICN NRT (날짜는 필수)
#   scripts/asiana-book.sh 2027-07-07
#   scripts/asiana-book.sh 2027-07-07 ICN NRT 2
#
# 인자: [날짜 YYYY-MM-DD] [출발] [도착] [인원]
set -e
ROOT=/Users/kimtaehyoung/coding/korean-air-mileage
cd "$ROOT"

DATE=${1:?날짜가 필요합니다 (예: 2027-07-07)}
ORIGIN=${2:-ICN}
DEST=${3:-NRT}
ADULTS=${4:-2}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
CMDS="$WORK/cmds.txt"
OUT="$WORK/out.jsonl"
: > "$CMDS"

# award-browser 는 줄 단위 JSON 명령을 stdin 으로 받는다. tail -f 로 stdin 을
# 열어 둔 채 명령을 한 줄씩 흘려 넣는다 — 파이프가 닫히면 브라우저도 닫히므로.
tail -f "$CMDS" | ./node_modules/.bin/tsx scripts/award-browser.ts > "$OUT" 2>"$WORK/err.log" &
DRIVER=$!
sleep 3

# 로그인은 조회용 Chrome 프로파일(data/partner-chrome-profile)에 한 번 해두면 이어진다.
printf '%s\n' '{"id":"login","action":"confirm-login","program":"asiana-club"}' >> "$CMDS"
i=0; while [ $i -lt 40 ]; do grep -q '"id":"login"' "$OUT" 2>/dev/null && break; sleep 1; i=$((i+1)); done
LOGIN=$(grep '"id":"login"' "$OUT" | tail -1)
echo "로그인 상태: $LOGIN"
case "$LOGIN" in
  *'"authenticated":true'*) ;;
  *) echo "!! 아시아나 로그인이 풀렸습니다. 열린 Chrome 창에서 로그인한 뒤 다시 실행하세요."
     kill $DRIVER 2>/dev/null; exit 2;;
esac

# 공제(어머니)·탑승(본인+배우자) 회원번호는 저장소에 없다. data/local 에서만 읽는다.
python3 -c "
import json,sys
s=json.load(open('data/local/asiana-booking.json'))
q={'origin':'$ORIGIN','destination':'$DEST','date':'$DATE','cabin':'business','adults':$ADULTS,
   'booking':{'deductFrom':s['deductFrom'],'boarding':s['boarding']}}
print(json.dumps({'id':'book','action':'book','program':'asiana-club','query':q},ensure_ascii=False))
" >> "$CMDS"

echo "$ORIGIN→$DEST $DATE 비즈니스 ${ADULTS}명 — 결제화면까지 모는 중 (최대 3분)..."
i=0; while [ $i -lt 180 ]; do grep -q '"id":"book"' "$OUT" 2>/dev/null && break; sleep 1; i=$((i+1)); done
RESULT=$(grep '"id":"book"' "$OUT" | tail -1)

if [ -z "$RESULT" ]; then
  echo "!! 3분 안에 응답이 없었습니다. Chrome 창을 직접 확인하세요."
  tail -5 "$WORK/err.log"
  exit 3
fi

echo "$RESULT" | python3 -c "
import json,sys
r=json.load(sys.stdin)['result']
print('상태      :', r.get('status'), r.get('code') or '')
print('결제화면  :', '도달' if r.get('held') else '실패 — '+str(r.get('holdFailure') or ''))
for f in r.get('flights') or []:
    print('  편      :', f.get('flightNumber'), f.get('departureTime'),
          f.get('mileage') or '', f.get('totalAmount') or '')
print()
print('보안문자와 결제하기는 Chrome 창에서 직접 하세요. (1인 요금 표기 주의 — 실제 청구는 인원수만큼)')
"
# 결제 화면을 띄운 Chrome 을 살려 둔다. 드라이버를 죽이면 창도 함께 닫힌다.
echo "(Chrome 창은 열어 둡니다. 다 쓰면 창을 닫으세요.)"
wait $DRIVER
