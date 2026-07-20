// 공통 헬퍼
async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(data.error || '요청 실패');
  return data;
}
function show(el, text, type = 'err') {
  const box = document.getElementById(el);
  if (box) { box.textContent = text; box.className = 'msg ' + type; }
}
function fmt(n) { return Number(n).toLocaleString('ko-KR') + '원'; }
const STATUS_KO = { selling: '판매중', reserved: '예약중', sold: '판매완료',
  pending: '보류중(에스크로)', confirmed: '확정', cancelled: '취소',
  active: '정상', dormant: '휴면', suspended: '정지' };

function esc(s) {
return String(s ?? '').replace(/[&<>"']/g, c =>
({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

async function renderNav() {
  let me = null;
  try { me = await api('/api/users/me'); } catch {}
  const nav = document.createElement('nav');
  nav.innerHTML = `
    <a class="logo" href="/">🥕 중고마켓</a>
    <a href="/">상품</a>
    ${me ? `<a href="/product_new.html">판매하기</a><a href="/chat.html">채팅</a><a href="/wallet.html">지갑</a><a href="/mypage.html">마이페이지</a>` : ''}
    ${me && me.role === 'admin' ? `<a href="/admin.html" style="color:#dc2626">관리자</a>` : ''}
    <span class="spacer"></span>
    ${me ? `<span class="muted">${me.username}님${me.verified ? ' ✅' : ' (미인증)'}</span><a href="#" id="logoutBtn">로그아웃</a>`
         : `<a href="/login.html">로그인</a><a href="/signup.html">회원가입</a>`}`;
  document.body.prepend(nav);
  const lb = document.getElementById('logoutBtn');
  if (lb) lb.onclick = async e => { e.preventDefault(); await api('/api/auth/logout', 'POST'); location.href = '/'; };
  return me;
}


