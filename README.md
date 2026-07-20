# 중고거래 플랫폼

개발 요청서 기반 구현: 에스크로 안전결제 · 휴대폰 본인 인증 · 위치 기반 필터링 · 1:1 채팅 · 신고/관리자 검토 시스템

## 실행 방법

```bash
npm install   # express, express-session, socket.io, bcryptjs (DB는 Node 22 내장 SQLite)
npm start     # http://localhost:3000
```

Node.js 22 이상 필요. 관리자 계정: `admin / admin1234`

## 테스트

```bash
bash test.sh   # 통합 테스트 31건 (회원→인증→상품→에스크로→채팅→신고→관리자)
```

## 구조

| 파일 | 역할 |
|---|---|
| `server.js` | 전체 REST API + socket.io 채팅 |
| `db.js` | SQLite 스키마 7테이블 (users/wallets/products/transactions/chat_rooms/chat_messages/reports) |
| `public/` | 웹 페이지 11개 (요청서의 구현 목록 + 관리자 대시보드) |

## 핵심 비즈니스 로직 구현 위치

- **에스크로**: `server.js`의 `/api/products/:id/purchase`(대금 보관) → `/api/transactions/:id/confirm`(정산) → `/cancel`(환불). 잔액 변경+기록은 단일 DB 트랜잭션.
- **휴대폰 인증**: `/api/users/me/phone/*`. 데모라 인증번호를 응답에 포함 — 실서비스에서는 SMS 발송으로 교체(`demoCode` 제거).
- **위치 기반**: 가입자 GPS 좌표 저장, 조회 시 하버사인 공식으로 5km 필터. API 응답에는 좌표를 빼고 동 단위 지역명만 노출.
- **신고/제재**: 동일 대상 신고 3건 누적 시 자동 숨김 → 관리자가 `/admin.html`에서 제재 확정(유저 정지/상품 숨김 유지) 또는 기각(블라인드 해제).
- **판매 완료 상품**: 검색에는 노출, 프론트에서 구매/채팅 버튼만 비활성화.

## 실서비스 전 교체 필요 항목

세션 secret 환경변수화, SMS 본인 인증 연동(예: 쿨SMS), 이미지 업로드(현재 URL 입력), 좌표→행정동 변환(카카오 로컬 API), HTTPS, DB를 MySQL/PostgreSQL로 이전.
