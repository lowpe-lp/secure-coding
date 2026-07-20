# 개발 일지 — 중고거래 플랫폼 로컬 실행부터 배포까지

Claude(Cowork)와 함께 진행한 트러블슈팅 및 배포 기록. (2026-07-21)

## 1. localhost:3000 접속 문제

**증상**: `npm start` 실행 시 `Error: unable to open database file (ERR_SQLITE_ERROR, errcode 14)` 발생, 서버가 뜨지 않음.

**시도한 것들**:

- `dbPath`를 `__dirname` 기준으로 변경 → ES 모듈 아님에도 `__dirname` 미정의 오류 (당시 파일에 `import.meta` 혼용 상태)
- `import.meta.dirname` 사용 → CommonJS 프로젝트라서 `require`와 충돌
- 프로젝트가 CommonJS(`package.json`에 `"type": "module"` 없음)임을 확인하고 `__dirname`으로 통일 → 그래도 같은 오류 재발

**근본 원인**: 프로젝트가 Claude 세션 폴더 깊숙이 있어 전체 경로가 **Windows MAX_PATH(260자) 제한을 초과**. `marketplace.db`까지 붙이면 262자가 되어 SQLite가 파일을 생성하지 못함.

**해결**:

1. 임시: DB 경로가 230자를 넘으면 홈 폴더에 저장하도록 분기 처리
2. 근본: `robocopy`로 프로젝트를 `C:\Users\<user>\marketplace`로 이전 (`/XD node_modules`로 node_modules 제외 후 `npm install` 재설치 — node_modules 복사 중 특수 파일에서 무한 재시도 발생했기 때문)

```js
// db.js
let dbPath = process.env.DB_PATH || path.join(__dirname, 'marketplace.db');
if (dbPath.length > 230) {
  dbPath = path.join(os.homedir(), 'marketplace.db');
}
```

## 2. 외부 접속 (Cloudflare Tunnel)

로컬 서버를 인터넷에 공개하기 위해 cloudflared 퀵 터널 사용:

```
cloudflared tunnel --url http://localhost:3000
```

- 발급된 `https://xxx.trycloudflare.com` 주소로 어디서든 접속 가능
- **주의**: 서버 창과 터널 창이 동시에 켜져 있어야 함
  - 502 Bad Gateway → 터널은 살아있으나 로컬 서버가 죽은 상태
  - Error 1033 → cloudflared 터널 자체가 끊긴 상태
- 터널 재시작 시 주소가 새로 발급됨
- PC를 꺼놓으면 접속 불가 → 상시 서비스를 위해 클라우드 배포로 전환

## 3. GitHub 업로드 (secure-coding 저장소)

겪은 문제와 해결:

| 문제 | 원인 | 해결 |
|---|---|---|
| `Author identity unknown` | `git config --global user.name"..."` 공백 누락으로 설정 실패 | `user.name`, `user.email` 공백 넣어 재설정 |
| `Repository not found` | GitHub에 저장소 미생성 | github.com/new 에서 저장소 생성 후 push |
| `[rejected] fetch first` | 저장소 생성 시 README 자동 커밋과 충돌 | `git push -u origin main --force` |

## 4. 업로드 전 보안 점검

원칙: **비밀정보는 git 기록에 영원히 남으므로 push 전에 제거**해야 하고, 일반 취약점은 push 후 고쳐도 무방.

점검 결과 및 조치:

- 세션 비밀키 하드코딩(`'marketplace-secret'`) → `SESSION_SECRET` 환경변수로 분리, 미설정 시 부팅마다 무작위 생성
- 관리자 초기 비밀번호(`admin1234`) 하드코딩 → `ADMIN_PASSWORD` 환경변수로 분리
- 로그에 비밀번호 출력 제거
- `.gitignore` 추가: `node_modules/`, `*.db*`, `*.log`, `*.exe`, `.env`
- `package.json`에 `"engines": { "node": ">=22" }` 명시 (내장 `node:sqlite` 사용 때문)

## 5. Render 배포

1. render.com → GitHub 로그인 → New Web Service → `secure-coding` 저장소 연결
2. Build: `npm install` / Start: `npm start` / Free 플랜
3. 환경변수: `SESSION_SECRET`, `ADMIN_PASSWORD` 설정
4. 고정 주소 `https://secure-coding-xxxx.onrender.com` 발급

무료 플랜 한계: 15분 무접속 시 슬립(첫 접속 시 ~30초 지연), 임시 디스크라 재배포 시 SQLite 데이터 초기화.

## 배운 점 요약

- Windows 경로 260자 제한은 SQLite 파일 생성 실패라는 엉뚱한 형태로 나타날 수 있다
- CommonJS와 ESM(`require` vs `import.meta`)을 혼용하면 안 된다
- 터널링(로컬 공개)과 배포(상시 서비스)는 용도가 다르다
- 비밀정보는 커밋 전에 반드시 환경변수로 분리한다
