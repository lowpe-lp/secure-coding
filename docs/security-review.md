# 보안 점검 보고서

대상: 중고거래 플랫폼 (server.js, db.js, public/)
점검일: 2026-07-21
점검 방식: 소스 코드 정적 분석 + `npm audit`

## 총평

핵심 거래 로직(에스크로, 인증/인가, 잔액 정합성)은 견고하게 짜여 있고, **SQL 인젝션은 발견되지 않았습니다** — 모든 쿼리가 파라미터 바인딩(`?`)을 사용합니다. 의존성도 `npm audit` 기준 알려진 취약점 0건입니다.

다만 **저장형 XSS(Stored XSS)** 가 여러 화면에 걸쳐 존재하고, CSRF 방어와 로그인 무차별 대입 방어가 없습니다. 실서비스(특히 인터넷 공개) 전에 High 항목은 반드시 고쳐야 합니다.

## 심각도 요약

| # | 항목 | 심각도 | 위치 |
|---|---|---|---|
| 1 | 저장형 XSS (사용자 입력이 `innerHTML`로 무이스케이프 렌더링) | **High** | 프론트 다수 |
| 2 | CSRF 방어 부재 + 세션 쿠키 `SameSite`/`Secure` 미설정 | **High** | server.js 세션 설정 |
| 3 | 로그인 무차별 대입(brute-force) 방어 부재 | Medium | `/api/auth/login` |
| 4 | `image_url` 미검증 → CSS/링크 인젝션, 외부 리소스 로딩 | Medium | 상품 등록/렌더 |
| 5 | 입력 길이 제한 부재 (상품명·설명·신고사유·bio) | Low | 여러 엔드포인트 |
| 6 | 보안 헤더(helmet) 부재 | Low | server.js |
| 7 | 자동 숨김된(hidden) 유저 프로필이 여전히 조회 가능 | Low | `/api/users/:id` |

## 상세

### 1. 저장형 XSS — High

사용자가 입력한 값(상품명, 상품 설명, 소개글, 신고 사유, 지역명, 채팅 상품명 등)이 `innerHTML` 템플릿 문자열에 그대로 삽입됩니다. 공격자가 상품명을 `<img src=x onerror=alert(document.cookie)>` 로 등록하면, 그 상품을 보는 모든 사용자(관리자 포함)의 브라우저에서 스크립트가 실행됩니다. 세션 탈취, 관리자 권한 도용으로 이어질 수 있습니다.

대표 위치:

- `index.html` 상품 목록: `${p.name}`, `${p.region}`, `${p.seller}`
- `product.html`: 판매자 메타(`${p.seller}`), 에스크로 구매자명(`${pend.sender_name}`)
- `profile.html`: 판매 상품 `${p.name}`
- `chat.html`: `${r.product_name}`, `${r.last_message}` (그리고 `onclick` 속성에 상품명 삽입 — 작은따옴표만 치환해 우회 가능)
- `admin.html`: 신고 사유 `${r.reason}`, 상품명, 판매자명, 지역 등 — 관리자 화면이라 피해가 가장 큼

참고: `username`은 서버에서 `^[a-zA-Z0-9]{4,20}$`로 강제되어 안전하고, 채팅 메시지 본문(`chat.html`의 `div.textContent = m.content`)과 상품 상세의 이름/설명(`textContent`)은 이미 안전하게 처리돼 있습니다. 즉 패턴은 이미 있으나 `innerHTML` 경로에서만 누락된 상태입니다.

**해결**: 공통 이스케이프 헬퍼를 만들어 `innerHTML`에 들어가는 모든 사용자 값에 적용.

```js
// app.js 등 공통 위치
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
// 사용 예: `${esc(p.name)}`, `${esc(r.reason)}`
```

### 2. CSRF + 쿠키 속성 — High

세션 쿠키에 `sameSite`, `secure` 속성이 없고, 상태 변경 API(구매, 충전, 상품 삭제, 관리자 제재 등)에 CSRF 토큰이 없습니다. 로그인된 사용자가 악성 사이트를 방문하면 그 사이트가 사용자 몰래 `POST /api/wallet/charge`, `POST /api/products/:id/purchase` 등을 호출할 수 있습니다.

**해결(최소 조치)**: 쿠키에 `sameSite: 'lax'` 설정 — 대부분의 교차 사이트 POST를 차단합니다. HTTPS 배포 시 `secure: true`도 함께.

```js
cookie: {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 1000 * 60 * 60 * 24
}
```

더 강한 방어가 필요하면 `csrf`/`csurf` 토큰 도입.

### 3. 로그인 무차별 대입 — Medium

`/api/auth/login`에 시도 횟수 제한이 없어 자동화 도구로 비밀번호를 무제한 추측할 수 있습니다.

**해결**: `express-rate-limit`로 IP·계정당 로그인 시도 제한(예: 15분에 10회).

```js
const rateLimit = require('express-rate-limit');
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 10 }));
```

### 4. image_url 미검증 — Medium

`image_url`을 형식 검증 없이 저장하고 `background-image:url('...')` 및 `href`에 삽입합니다. `javascript:` 스킴이나 CSS 인젝션, 외부 추적 픽셀 로딩이 가능합니다.

**해결**: 등록 시 `http(s)://`로 시작하는 URL만 허용하도록 서버에서 검증.

### 5. 입력 길이 제한 — Low

상품명·설명·소개글·신고사유에 최대 길이 제한이 없어 대용량 페이로드로 DB를 부풀리거나 UI를 깨뜨릴 수 있습니다. 서버에서 `.length` 상한 검증 권장.

### 6. 보안 헤더 부재 — Low

`helmet` 미적용. CSP를 설정하면 XSS의 2차 방어선이 됩니다. `app.use(require('helmet')())` 한 줄로 상당수 헤더가 적용됩니다(단, 인라인 스크립트/스타일이 많아 CSP는 튜닝 필요).

### 7. hidden 유저 프로필 조회 — Low

`/api/users/:id`는 `hidden` 여부를 확인하지 않아, 신고 누적으로 자동 숨김된 유저의 프로필이 계속 열립니다. 정책에 따라 숨김 유저는 404 처리 검토.

## 잘 되어 있는 점

- 모든 SQL이 파라미터 바인딩 → SQL 인젝션 없음
- 비밀번호 `bcrypt` 해싱(cost 10), 평문 저장 없음
- 인가 체크 일관적: 소유자/관리자 검증(`seller_id !== req.user.id`), 채팅방 참여자 검증, `requireAdmin`
- 잔액 변경과 거래 기록이 단일 트랜잭션으로 원자적 처리
- 잔액 차감에 `balance>=?` 조건 → 경합 상황에서도 음수 잔액 방지
- 세션 비밀키·관리자 비밀번호 환경변수화 완료
- 채팅 메시지·상품 상세는 `textContent`로 안전하게 출력

## 권장 조치 순서

먼저 1·2번(High)을 처리하고, 인터넷 공개 서비스라면 3·4번까지 함께 적용하는 것을 권합니다.
