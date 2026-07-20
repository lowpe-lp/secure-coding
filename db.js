// db.js - SQLite 스키마 및 초기화 (Node 22 내장 node:sqlite 사용)
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const os = require('os');
// DB_PATH 환경변수 우선(배포 시 영구 디스크 경로 지정용)
// Windows 경로 길이 제한(260자) 회피: 경로가 길면 홈 폴더에 DB 저장
let dbPath = process.env.DB_PATH || path.join(__dirname, 'marketplace.db');
if (dbPath.length > 230) {
  dbPath = path.join(os.homedir(), 'marketplace.db');
  console.log('DB 저장 위치:', dbPath);
}
const db = new DatabaseSync(dbPath);
try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* WAL 미지원 파일시스템이면 기본 저널 모드 사용 */ }
db.exec('PRAGMA foreign_keys = ON');
// better-sqlite3 호환 transaction 헬퍼
db.transaction = fn => (...args) => {
  db.exec('BEGIN');
  try { const r = fn(...args); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,            -- 아이디 중복 불가
  password_hash TEXT NOT NULL,
  bio           TEXT DEFAULT '',
  phone         TEXT UNIQUE,                     -- 계정당 하나
  verified      INTEGER NOT NULL DEFAULT 0,      -- 휴대폰 인증 여부
  status        TEXT NOT NULL DEFAULT 'active',  -- active/dormant/suspended
  hidden        INTEGER NOT NULL DEFAULT 0,      -- 신고 누적 자동 숨김(검토 대기)
  role          TEXT NOT NULL DEFAULT 'user',    -- user/admin
  region        TEXT,                            -- 활동 지역(동 단위)
  lat REAL, lng REAL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS wallets (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
);
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  price       INTEGER NOT NULL CHECK (price >= 0),
  image_url   TEXT DEFAULT '',
  category    TEXT DEFAULT '기타',
  seller_id   INTEGER NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'selling',   -- selling/reserved/sold
  hidden      INTEGER NOT NULL DEFAULT 0,        -- 신고 누적 자동 숨김(검토 대기)
  region      TEXT, lat REAL, lng REAL,          -- 판매자 활동 지역 스냅샷
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS product_status_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,                     -- charge/transfer
  sender_id   INTEGER REFERENCES users(id),      -- 충전이면 NULL
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  product_id  INTEGER REFERENCES products(id),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  status      TEXT NOT NULL DEFAULT 'confirmed', -- pending(에스크로)/confirmed/cancelled
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  settled_at  TEXT
);
CREATE TABLE IF NOT EXISTS chat_rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  user_a     INTEGER NOT NULL REFERENCES users(id),  -- 구매 희망자
  user_b     INTEGER NOT NULL REFERENCES users(id),  -- 판매자
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(product_id, user_a, user_b)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id   INTEGER NOT NULL REFERENCES chat_rooms(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  content   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL,                    -- user/product
  target_id   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending/confirmed/rejected
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(reporter_id, target_type, target_id)   -- 동일 대상 중복 신고 방지
);
`);

// 관리자 계정 시드 (admin / admin1234)
const admin = db.prepare("SELECT id FROM users WHERE role='admin'").get();
if (!admin) {
  const info = db.prepare(
    "INSERT INTO users (username, password_hash, role, verified, region) VALUES (?,?,?,1,'본사')"
  ).run('admin', bcrypt.hashSync('admin1234', 10), 'admin');
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?,0)').run(info.lastInsertRowid);
  console.log('관리자 계정 생성: admin / admin1234');
}
module.exports = db;
