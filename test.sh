#!/bin/bash
# 통합 테스트: 서버 기동 → 전체 시나리오 → 종료
cd "$(dirname "$0")"
export DB_PATH=/sessions/wizardly-blissful-darwin/app/test.db
rm -f /sessions/wizardly-blissful-darwin/app/test.db*
node server.js > /tmp/server.log 2>&1 &
SRV=$!
sleep 2
B=http://localhost:3000
J() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$2',''))" <<< "$1"; }
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1 : $2"; }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "got=$2 want=$3"; }

echo "── 1. 회원가입/로그인"
R=$(curl -s -X POST $B/api/users/signup -H 'Content-Type: application/json' -d '{"username":"alice","password":"pass1234"}')
check "alice 가입" "$(J "$R" username)" "alice"
R=$(curl -s -X POST $B/api/users/signup -H 'Content-Type: application/json' -d '{"username":"alice","password":"pass1234"}')
check "아이디 중복 거부" "$(J "$R" error)" "이미 사용 중인 아이디입니다."
R=$(curl -s -X POST $B/api/users/signup -H 'Content-Type: application/json' -d '{"username":"bobby","password":"pass1234"}')
curl -s -X POST $B/api/users/signup -H 'Content-Type: application/json' -d '{"username":"carol","password":"pass1234"}' > /dev/null
curl -s -X POST $B/api/users/signup -H 'Content-Type: application/json' -d '{"username":"dave","password":"pass1234"}' > /dev/null
R=$(curl -s -X POST $B/api/users/signup -H 'Content-Type: application/json' -d '{"username":"x","password":"pass1234"}')
check "잘못된 아이디 형식 거부" "$(J "$R" error)" "아이디는 영문/숫자 4~20자입니다."
for u in alice bobby carol dave; do
  curl -s -c /tmp/$u.ck -X POST $B/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$u\",\"password\":\"pass1234\"}" > /dev/null
done
curl -s -c /tmp/admin.ck -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' > /dev/null
R=$(curl -s -b /tmp/alice.ck $B/api/users/me)
check "세션 로그인" "$(J "$R" username)" "alice"

echo "── 2. 미인증 거래 차단 / 휴대폰 인증"
R=$(curl -s -b /tmp/alice.ck -X POST $B/api/products -H 'Content-Type: application/json' -d '{"name":"아이패드","price":10000}')
check "미인증 판매 차단" "$(J "$R" error)" "휴대폰 본인 인증 후 거래할 수 있습니다."
i=1
for u in alice bobby carol dave; do
  R=$(curl -s -b /tmp/$u.ck -X POST $B/api/users/me/phone/request -H 'Content-Type: application/json' -d "{\"phone\":\"0101234567$i\"}")
  CODE=$(J "$R" demoCode)
  curl -s -b /tmp/$u.ck -X POST $B/api/users/me/phone/verify -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}" > /dev/null
  i=$((i+1))
done
R=$(curl -s -b /tmp/alice.ck $B/api/users/me)
check "휴대폰 인증 완료" "$(J "$R" verified)" "True"
R=$(curl -s -b /tmp/bobby.ck -X POST $B/api/users/me/phone/request -H 'Content-Type: application/json' -d '{"phone":"01012345671"}')
check "번호 중복 연결 차단" "$(J "$R" error)" "이미 다른 계정에 연결된 번호입니다."

echo "── 3. 위치 인증 / 상품 등록 / 검색"
curl -s -b /tmp/alice.ck -X POST $B/api/users/me/location -H 'Content-Type: application/json' -d '{"lat":37.4979,"lng":127.0276,"region":"역삼동"}' > /dev/null
curl -s -b /tmp/bobby.ck   -X POST $B/api/users/me/location -H 'Content-Type: application/json' -d '{"lat":37.5013,"lng":127.0396,"region":"삼성동"}' > /dev/null
curl -s -b /tmp/carol.ck -X POST $B/api/users/me/location -H 'Content-Type: application/json' -d '{"lat":37.5665,"lng":126.9780,"region":"태평로"}' > /dev/null
R=$(curl -s -b /tmp/alice.ck -X POST $B/api/products -H 'Content-Type: application/json' -d '{"name":"아이패드 프로","price":10000,"category":"디지털기기","description":"상태 좋아요"}')
P1=$(J "$R" productId)
check "상품 등록" "$([ -n "$P1" ] && echo yes)" "yes"
curl -s -b /tmp/carol.ck -X POST $B/api/products -H 'Content-Type: application/json' -d '{"name":"사기 의심 노트북","price":5000,"category":"디지털기기"}' > /dev/null
P2=2
R=$(curl -s -G $B/api/products --data-urlencode "keyword=아이패드")
check "키워드 검색" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)))" <<< "$R")" "1"
R=$(curl -s "$B/api/products?min=6000")
check "가격 필터" "$(python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['name'] if len(d)==1 else 'x')" <<< "$R")" "아이패드 프로"
R=$(curl -s -b /tmp/bobby.ck "$B/api/products?nearby=1")
check "5km 반경 필터(삼성동 bobby→역삼동 상품만)" "$(python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d)==1 and d[0]['region']=='역삼동')" <<< "$R")" "True"
R=$(curl -s "$B/api/products")
check "좌표 비노출(동 단위만)" "$(python3 -c "import sys,json;d=json.load(sys.stdin);print('lat' in d[0])" <<< "$R")" "False"

echo "── 4. 지갑/에스크로"
R=$(curl -s -b /tmp/bobby.ck -X POST $B/api/products/$P1/purchase)
check "잔액 부족 차단" "$(J "$R" error)" "잔액이 부족합니다."
curl -s -b /tmp/bobby.ck -X POST $B/api/wallet/charge -H 'Content-Type: application/json' -d '{"amount":15000}' > /dev/null
R=$(curl -s -b /tmp/bobby.ck $B/api/wallet)
check "충전" "$(J "$R" balance)" "15000"
R=$(curl -s -b /tmp/bobby.ck -X POST $B/api/products/$P1/purchase)
T1=$(J "$R" transactionId)
check "구매(에스크로 시작)" "$([ -n "$T1" ] && echo yes)" "yes"
R=$(curl -s -b /tmp/bobby.ck $B/api/wallet)
check "구매자 잔액 차감" "$(J "$R" balance)" "5000"
check "에스크로 보관액" "$(J "$R" escrowHold)" "10000"
R=$(curl -s -b /tmp/alice.ck $B/api/wallet)
check "판매자 아직 미정산" "$(J "$R" balance)" "0"
R=$(curl -s $B/api/products/$P1)
check "상품 자동 예약중" "$(J "$R" status)" "reserved"
R=$(curl -s -b /tmp/carol.ck -X POST $B/api/products/$P1/purchase)
check "중복 구매 차단" "$(J "$R" error)" "이미 거래가 진행 중인 상품입니다."
R=$(curl -s -b /tmp/alice.ck -X POST $B/api/transactions/$T1/confirm)
check "타인 구매확정 차단" "$(J "$R" error)" "구매자만 확정할 수 있습니다."
curl -s -b /tmp/bobby.ck -X POST $B/api/transactions/$T1/confirm > /dev/null
R=$(curl -s -b /tmp/alice.ck $B/api/wallet)
check "구매확정 → 판매자 정산" "$(J "$R" balance)" "10000"
R=$(curl -s $B/api/products/$P1)
check "상품 판매완료 전환" "$(J "$R" status)" "sold"
R=$(curl -s -G $B/api/products --data-urlencode "keyword=아이패드")
check "판매완료 검색 노출 유지" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)))" <<< "$R")" "1"

echo "── 5. 채팅"
R=$(curl -s -b /tmp/bobby.ck -X POST $B/api/chat/rooms -H 'Content-Type: application/json' -d "{\"productId\":$P2}")
ROOM=$(J "$R" roomId)
check "채팅방 생성" "$([ -n "$ROOM" ] && echo yes)" "yes"
R=$(curl -s -b /tmp/dave.ck $B/api/chat/rooms/$ROOM/messages)
check "타인 채팅방 접근 차단" "$(J "$R" error)" "접근 권한이 없습니다."

echo "── 6. 신고 → 자동 숨김 → 관리자 검토"
for u in alice bobby dave; do
  R=$(curl -s -b /tmp/$u.ck -X POST $B/api/reports -H 'Content-Type: application/json' -d "{\"targetType\":\"product\",\"targetId\":$P2,\"reason\":\"사기 의심\"}")
done
check "3회 신고 → 자동 숨김" "$(J "$R" autoHidden)" "True"
R=$(curl -s -G $B/api/products --data-urlencode "keyword=노트북")
check "숨김 상품 목록 제외" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)))" <<< "$R")" "0"
R=$(curl -s -b /tmp/alice.ck $B/api/admin/reports)
check "일반 유저 관리자 API 차단" "$(J "$R" error)" "관리자 권한이 필요합니다."
RID=$(curl -s -b /tmp/admin.ck "$B/api/admin/reports?status=pending" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
curl -s -b /tmp/admin.ck -X POST $B/api/admin/reports/$RID/reject > /dev/null
R=$(curl -s -G $B/api/products --data-urlencode "keyword=노트북")
check "기각 → 블라인드 해제" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)))" <<< "$R")" "1"
R=$(curl -s -b /tmp/admin.ck -X PATCH $B/api/admin/users/4 -H 'Content-Type: application/json' -d '{"status":"suspended"}')
R=$(curl -s -c /tmp/carol2.ck -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"username":"carol","password":"pass1234"}')
check "정지 계정 로그인 차단" "$(J "$R" error)" "정지된 계정입니다."

echo ""
echo "결과: ${PASS} 통과 / ${FAIL} 실패"
kill $SRV 2>/dev/null
