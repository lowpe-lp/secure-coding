// server.js - 중고거래 플랫폼 백엔드
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const http = require('http');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

const REPORT_THRESHOLD = 3;   // 자동 숨김 기준 신고 횟수
const RADIUS_KM = 5;          // 위치 필터 기본 반경

app.use(express.json());
const sessionMw = session({
  secret: 'marketplace-secret', resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 }
});
app.use(sessionMw);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 헬퍼 ----------
const getUser = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const publicUser = u => u && ({ id: u.id, username: u.username, bio: u.bio, region: u.region, verified: !!u.verified, status: u.status, role: u.role, created_at: u.created_at });

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const u = getUser(req.session.userId);
  if (!u || u.status === 'suspended') return res.status(403).json({ error: '이용이 제한된 계정입니다.' });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  requireLogin(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    next();
  });
}
function requireVerified(req, res, next) {
  if (!req.user.verified) return res.status(403).json({ error: '휴대폰 본인 인증 후 거래할 수 있습니다.' });
  if (req.user.status !== 'active' || req.user.hidden) return res.status(403).json({ error: '검토 중이거나 제한된 계정은 거래할 수 없습니다.' });
  next();
}
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- 회원/인증 ----------
app.get('/api/users/check', (req, res) => {
  const { username } = req.query;
  const exists = db.prepare('SELECT 1 FROM users WHERE username=?').get(username);
  res.json({ available: !exists });
});

app.post('/api/users/signup', (req, res) => {
  const { username, password, bio } = req.body || {};
  if (!/^[a-zA-Z0-9]{4,20}$/.test(username || '')) return res.status(400).json({ error: '아이디는 영문/숫자 4~20자입니다.' });
  if (!/^(?=.*[a-zA-Z])(?=.*\d).{8,}$/.test(password || '')) return res.status(400).json({ error: '비밀번호는 8자 이상, 영문+숫자를 포함해야 합니다.' });
  try {
    const tx = db.transaction(() => {
      const info = db.prepare('INSERT INTO users (username, password_hash, bio) VALUES (?,?,?)')
        .run(username, bcrypt.hashSync(password, 10), bio || '');
      db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?,0)').run(info.lastInsertRowid);
      return info.lastInsertRowid;
    });
    const id = tx();
    res.status(201).json({ userId: id, username });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    res.status(500).json({ error: '회원가입에 실패했습니다.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  if (u.status === 'suspended') return res.status(403).json({ error: '정지된 계정입니다.' });
  req.session.userId = u.id;
  res.json({ userId: u.id, username: u.username, role: u.role });
});

app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.status(204).end()));

app.get('/api/users/me', requireLogin, (req, res) => {
  const w = db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(req.user.id);
  res.json({ ...publicUser(req.user), phone: req.user.phone, balance: w.balance });
});

app.patch('/api/users/me', requireLogin, (req, res) => {
  db.prepare('UPDATE users SET bio=? WHERE id=?').run(req.body.bio || '', req.user.id);
  res.json({ ok: true });
});

app.patch('/api/users/me/password', requireLogin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(currentPassword || '', req.user.password_hash))
    return res.status(403).json({ error: '현재 비밀번호가 일치하지 않습니다.' });
  if (!/^(?=.*[a-zA-Z])(?=.*\d).{8,}$/.test(newPassword || ''))
    return res.status(400).json({ error: '비밀번호는 8자 이상, 영문+숫자를 포함해야 합니다.' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ ok: true });
});

// 휴대폰 본인 인증 (데모: 실제 SMS 대신 코드를 응답으로 반환)
app.post('/api/users/me/phone/request', requireLogin, (req, res) => {
  const { phone } = req.body || {};
  if (!/^01[0-9]{8,9}$/.test(phone || '')) return res.status(400).json({ error: '휴대폰 번호 형식이 올바르지 않습니다.' });
  const taken = db.prepare('SELECT 1 FROM users WHERE phone=? AND id!=?').get(phone, req.user.id);
  if (taken) return res.status(409).json({ error: '이미 다른 계정에 연결된 번호입니다.' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  req.session.phoneVerify = { phone, code };
  res.json({ ok: true, demoCode: code }); // 실서비스에서는 SMS 발송, demoCode 제거
});

app.post('/api/users/me/phone/verify', requireLogin, (req, res) => {
  const pv = req.session.phoneVerify;
  if (!pv || pv.code !== (req.body.code || '')) return res.status(400).json({ error: '인증번호가 올바르지 않습니다.' });
  db.prepare('UPDATE users SET phone=?, verified=1 WHERE id=?').run(pv.phone, req.user.id);
  delete req.session.phoneVerify;
  res.json({ ok: true });
});

// 활동 지역 인증 (GPS 좌표 → 동 단위 지역명)
app.post('/api/users/me/location', requireLogin, (req, res) => {
  const { lat, lng, region } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !region)
    return res.status(400).json({ error: '위치 정보가 올바르지 않습니다.' });
  db.prepare('UPDATE users SET lat=?, lng=?, region=? WHERE id=?').run(lat, lng, region, req.user.id);
  res.json({ ok: true, region });
});

app.get('/api/users/:id', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  const products = db.prepare("SELECT id, name, price, status, image_url FROM products WHERE seller_id=? AND hidden=0 ORDER BY created_at DESC").all(u.id);
  res.json({ ...publicUser(u), products });
});

// ---------- 상품 ----------
app.post('/api/products', requireLogin, requireVerified, (req, res) => {
  const { name, description, price, category, image_url } = req.body || {};
  if (!name || !(price >= 0)) return res.status(400).json({ error: '상품명과 가격은 필수입니다.' });
  const u = req.user;
  const info = db.prepare(`INSERT INTO products (name, description, price, category, image_url, seller_id, region, lat, lng)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(name, description || '', Math.floor(price), category || '기타', image_url || '', u.id, u.region, u.lat, u.lng);
  db.prepare('INSERT INTO product_status_logs (product_id, status) VALUES (?,?)').run(info.lastInsertRowid, 'selling');
  res.status(201).json({ productId: info.lastInsertRowid });
});

app.get('/api/products', (req, res) => {
  const { keyword, category, min, max, sort, nearby } = req.query;
  let sql = `SELECT p.id, p.name, p.price, p.image_url, p.category, p.status, p.region, p.lat, p.lng, p.created_at, u.username AS seller
             FROM products p JOIN users u ON u.id = p.seller_id
             WHERE p.hidden=0 AND u.hidden=0 AND u.status='active'`;
  const args = [];
  if (keyword)  { sql += ' AND (p.name LIKE ? OR p.description LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`); }
  if (category) { sql += ' AND p.category=?'; args.push(category); }
  if (min)      { sql += ' AND p.price>=?'; args.push(+min); }
  if (max)      { sql += ' AND p.price<=?'; args.push(+max); }
  sql += sort === 'price_asc' ? ' ORDER BY p.price ASC' : sort === 'price_desc' ? ' ORDER BY p.price DESC' : ' ORDER BY p.created_at DESC';
  let rows = db.prepare(sql).all(...args);
  // 판매 완료 상품도 노출됨(시세 파악용) — 구매/채팅 버튼만 프론트에서 비활성화
  if (nearby === '1' && req.session.userId) {
    const me = getUser(req.session.userId);
    if (me && me.lat != null) rows = rows.filter(p => p.lat != null && haversineKm(me.lat, me.lng, p.lat, p.lng) <= RADIUS_KM);
  }
  res.json(rows.map(({ lat, lng, ...r }) => r)); // 좌표는 노출하지 않음(동 단위 지역명만)
});

app.get('/api/products/:id', (req, res) => {
  const p = db.prepare(`SELECT p.*, u.username AS seller, u.region AS seller_region FROM products p JOIN users u ON u.id=p.seller_id WHERE p.id=?`).get(req.params.id);
  if (!p || p.hidden) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
  const logs = db.prepare('SELECT status, created_at FROM product_status_logs WHERE product_id=? ORDER BY id').all(p.id);
  const { lat, lng, ...rest } = p;
  res.json({ ...rest, statusLogs: logs });
});

app.patch('/api/products/:id', requireLogin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
  if (p.seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다.' });
  const { name, description, price, category, image_url, status } = req.body || {};
  if (status && !['selling', 'reserved', 'sold'].includes(status)) return res.status(400).json({ error: '잘못된 상태입니다.' });
  db.prepare(`UPDATE products SET name=COALESCE(?,name), description=COALESCE(?,description), price=COALESCE(?,price),
    category=COALESCE(?,category), image_url=COALESCE(?,image_url), status=COALESCE(?,status) WHERE id=?`)
    .run(name ?? null, description ?? null, price ?? null, category ?? null, image_url ?? null, status ?? null, p.id);
  if (status && status !== p.status) db.prepare('INSERT INTO product_status_logs (product_id, status) VALUES (?,?)').run(p.id, status);
  res.json({ ok: true });
});

app.delete('/api/products/:id', requireLogin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
  if (p.seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다.' });
  db.prepare('UPDATE products SET hidden=1, status=?, name=name WHERE id=?').run(p.status, p.id); // soft delete
  res.json({ ok: true });
});

// ---------- 지갑 / 에스크로 ----------
app.get('/api/wallet', requireLogin, (req, res) => {
  const w = db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(req.user.id);
  const escrow = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE sender_id=? AND status='pending'").get(req.user.id);
  res.json({ balance: w.balance, escrowHold: escrow.s });
});

app.post('/api/wallet/charge', requireLogin, (req, res) => {
  const amount = Math.floor(req.body.amount || 0);
  if (!(amount > 0)) return res.status(400).json({ error: '충전 금액이 올바르지 않습니다.' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE wallets SET balance=balance+? WHERE user_id=?').run(amount, req.user.id);
    db.prepare("INSERT INTO transactions (type, receiver_id, amount, status, settled_at) VALUES ('charge', ?, ?, 'confirmed', datetime('now','localtime'))").run(req.user.id, amount);
  });
  tx();
  res.json({ ok: true });
});

// 구매 → 에스크로: 구매자 잔액 차감, 대금은 시스템 보관(pending)
app.post('/api/products/:id/purchase', requireLogin, requireVerified, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p || p.hidden) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
  if (p.seller_id === req.user.id) return res.status(400).json({ error: '자신의 상품은 구매할 수 없습니다.' });
  if (p.status === 'sold') return res.status(400).json({ error: '이미 판매 완료된 상품입니다.' });
  const dup = db.prepare("SELECT 1 FROM transactions WHERE product_id=? AND status='pending'").get(p.id);
  if (dup) return res.status(409).json({ error: '이미 거래가 진행 중인 상품입니다.' });
  try {
    const tx = db.transaction(() => {
      const r = db.prepare('UPDATE wallets SET balance=balance-? WHERE user_id=? AND balance>=?').run(p.price, req.user.id, p.price);
      if (r.changes === 0) throw new Error('INSUFFICIENT');
      const info = db.prepare("INSERT INTO transactions (type, sender_id, receiver_id, product_id, amount, status) VALUES ('transfer', ?, ?, ?, ?, 'pending')")
        .run(req.user.id, p.seller_id, p.id, p.price);
      db.prepare("UPDATE products SET status='reserved' WHERE id=?").run(p.id);
      db.prepare("INSERT INTO product_status_logs (product_id, status) VALUES (?, 'reserved')").run(p.id);
      return info.lastInsertRowid;
    });
    res.status(201).json({ transactionId: tx(), message: '결제 대금이 안전하게 보관 중입니다. 물건 수령 후 구매 확정을 눌러주세요.' });
  } catch (e) {
    if (e.message === 'INSUFFICIENT') return res.status(400).json({ error: '잔액이 부족합니다.' });
    res.status(500).json({ error: '구매 처리에 실패했습니다.' });
  }
});

// 구매 확정 → 판매자 지갑으로 정산
app.post('/api/transactions/:id/confirm', requireLogin, (req, res) => {
  const t = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!t || t.status !== 'pending') return res.status(404).json({ error: '진행 중인 거래가 없습니다.' });
  if (t.sender_id !== req.user.id) return res.status(403).json({ error: '구매자만 확정할 수 있습니다.' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE wallets SET balance=balance+? WHERE user_id=?').run(t.amount, t.receiver_id);
    db.prepare("UPDATE transactions SET status='confirmed', settled_at=datetime('now','localtime') WHERE id=?").run(t.id);
    db.prepare("UPDATE products SET status='sold' WHERE id=?").run(t.product_id);
    db.prepare("INSERT INTO product_status_logs (product_id, status) VALUES (?, 'sold')").run(t.product_id);
  });
  tx();
  res.json({ ok: true, message: '구매가 확정되어 판매자에게 정산되었습니다.' });
});

// 거래 취소(환불): 판매자 또는 관리자
app.post('/api/transactions/:id/cancel', requireLogin, (req, res) => {
  const t = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!t || t.status !== 'pending') return res.status(404).json({ error: '진행 중인 거래가 없습니다.' });
  if (t.receiver_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: '판매자 또는 관리자만 취소할 수 있습니다.' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE wallets SET balance=balance+? WHERE user_id=?').run(t.amount, t.sender_id);
    db.prepare("UPDATE transactions SET status='cancelled', settled_at=datetime('now','localtime') WHERE id=?").run(t.id);
    db.prepare("UPDATE products SET status='selling' WHERE id=?").run(t.product_id);
    db.prepare("INSERT INTO product_status_logs (product_id, status) VALUES (?, 'selling')").run(t.product_id);
  });
  tx();
  res.json({ ok: true, message: '거래가 취소되어 구매자에게 환불되었습니다.' });
});

app.get('/api/transactions', requireLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, p.name AS product_name, s.username AS sender_name, r.username AS receiver_name
    FROM transactions t
    LEFT JOIN products p ON p.id=t.product_id
    LEFT JOIN users s ON s.id=t.sender_id
    JOIN users r ON r.id=t.receiver_id
    WHERE t.sender_id=? OR t.receiver_id=? ORDER BY t.id DESC`).all(req.user.id, req.user.id);
  res.json(rows);
});

// ---------- 채팅 ----------
app.post('/api/chat/rooms', requireLogin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.body.productId);
  if (!p || p.hidden) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
  if (p.seller_id === req.user.id) return res.status(400).json({ error: '자신의 상품에는 채팅을 시작할 수 없습니다.' });
  if (p.status === 'sold') return res.status(400).json({ error: '판매 완료된 상품입니다.' });
  let room = db.prepare('SELECT * FROM chat_rooms WHERE product_id=? AND user_a=? AND user_b=?').get(p.id, req.user.id, p.seller_id);
  if (!room) {
    const info = db.prepare('INSERT INTO chat_rooms (product_id, user_a, user_b) VALUES (?,?,?)').run(p.id, req.user.id, p.seller_id);
    room = { id: info.lastInsertRowid };
  }
  res.json({ roomId: room.id });
});

app.get('/api/chat/rooms', requireLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.product_id, p.name AS product_name, p.status AS product_status,
           ua.username AS buyer, ub.username AS seller,
           (SELECT content FROM chat_messages WHERE room_id=r.id ORDER BY id DESC LIMIT 1) AS last_message
    FROM chat_rooms r JOIN products p ON p.id=r.product_id
    JOIN users ua ON ua.id=r.user_a JOIN users ub ON ub.id=r.user_b
    WHERE r.user_a=? OR r.user_b=? ORDER BY r.id DESC`).all(req.user.id, req.user.id);
  res.json(rows);
});

app.get('/api/chat/rooms/:id/messages', requireLogin, (req, res) => {
  const room = db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(req.params.id);
  if (!room || (room.user_a !== req.user.id && room.user_b !== req.user.id))
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  const msgs = db.prepare(`SELECT m.*, u.username FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE room_id=? ORDER BY m.id`).all(room.id);
  res.json(msgs);
});

io.engine.use(sessionMw);
io.on('connection', socket => {
  const sess = socket.request.session;
  if (!sess || !sess.userId) return socket.disconnect();
  socket.on('join', roomId => {
    const room = db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(roomId);
    if (room && (room.user_a === sess.userId || room.user_b === sess.userId)) socket.join('room:' + roomId);
  });
  socket.on('message', ({ roomId, content }) => {
    if (!content || !content.trim()) return;
    const room = db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(roomId);
    if (!room || (room.user_a !== sess.userId && room.user_b !== sess.userId)) return;
    const u = getUser(sess.userId);
    const info = db.prepare('INSERT INTO chat_messages (room_id, sender_id, content) VALUES (?,?,?)').run(roomId, sess.userId, content.trim());
    const msg = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(info.lastInsertRowid);
    io.to('room:' + roomId).emit('message', { ...msg, username: u.username });
  });
});

// ---------- 신고 / 자동 숨김 ----------
app.post('/api/reports', requireLogin, (req, res) => {
  const { targetType, targetId, reason } = req.body || {};
  if (!['user', 'product'].includes(targetType) || !targetId || !reason)
    return res.status(400).json({ error: '신고 대상과 사유를 입력해주세요.' });
  const target = targetType === 'user' ? getUser(targetId) : db.prepare('SELECT * FROM products WHERE id=?').get(targetId);
  if (!target) return res.status(404).json({ error: '신고 대상을 찾을 수 없습니다.' });
  try {
    db.prepare('INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?,?,?,?)')
      .run(req.user.id, targetType, targetId, reason);
  } catch (e) {
    return res.status(409).json({ error: '이미 신고한 대상입니다.' });
  }
  // 일정 횟수 이상 → 즉시 제재 아님, 숨김 처리 후 관리자 검토 대기
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM reports WHERE target_type=? AND target_id=? AND status='pending'").get(targetType, targetId).c;
  let autoHidden = false;
  if (cnt >= REPORT_THRESHOLD) {
    if (targetType === 'product') db.prepare('UPDATE products SET hidden=1 WHERE id=?').run(targetId);
    else db.prepare("UPDATE users SET hidden=1 WHERE id=? AND role!='admin'").run(targetId);
    autoHidden = true;
  }
  res.status(201).json({ ok: true, autoHidden });
});

// ---------- 관리자 ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, phone, verified, status, hidden, role, region, created_at FROM users ORDER BY id').all());
});
app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { status, hidden } = req.body || {};
  if (status && !['active', 'dormant', 'suspended'].includes(status)) return res.status(400).json({ error: '잘못된 상태입니다.' });
  db.prepare('UPDATE users SET status=COALESCE(?,status), hidden=COALESCE(?,hidden) WHERE id=? AND role!=?')
    .run(status ?? null, hidden ?? null, req.params.id, 'admin');
  res.json({ ok: true });
});
app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT p.*, u.username AS seller FROM products p JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC').all());
});
app.patch('/api/admin/products/:id', requireAdmin, (req, res) => {
  const { hidden } = req.body || {};
  db.prepare('UPDATE products SET hidden=? WHERE id=?').run(hidden ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT t.*, p.name AS product_name, s.username AS sender_name, r.username AS receiver_name
    FROM transactions t LEFT JOIN products p ON p.id=t.product_id
    LEFT JOIN users s ON s.id=t.sender_id JOIN users r ON r.id=t.receiver_id ORDER BY t.id DESC`).all());
});
app.get('/api/admin/reports', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT r.*, u.username AS reporter FROM reports r JOIN users u ON u.id=r.reporter_id
    WHERE r.status=COALESCE(?, r.status) ORDER BY r.id DESC`).all(req.query.status || null));
});
// 검토 확정: 상품→삭제(숨김 유지), 유저→정지 / 기각: 블라인드 해제
app.post('/api/admin/reports/:id/:action', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: '검토 대기 중인 신고가 아닙니다.' });
  const action = req.params.action;
  if (!['confirm', 'reject'].includes(action)) return res.status(400).json({ error: '잘못된 요청입니다.' });
  const tx = db.transaction(() => {
    const newStatus = action === 'confirm' ? 'confirmed' : 'rejected';
    db.prepare('UPDATE reports SET status=? WHERE target_type=? AND target_id=? AND status=?')
      .run(newStatus, r.target_type, r.target_id, 'pending'); // 동일 대상 신고 일괄 처리
    if (action === 'confirm') {
      if (r.target_type === 'product') db.prepare('UPDATE products SET hidden=1 WHERE id=?').run(r.target_id);
      else db.prepare("UPDATE users SET status='suspended', hidden=1 WHERE id=? AND role!='admin'").run(r.target_id);
    } else {
      if (r.target_type === 'product') db.prepare('UPDATE products SET hidden=0 WHERE id=?').run(r.target_id);
      else db.prepare("UPDATE users SET hidden=0 WHERE id=? AND role!='admin'").run(r.target_id);
    }
  });
  tx();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`중고거래 플랫폼 서버 실행: http://localhost:${PORT}`));
