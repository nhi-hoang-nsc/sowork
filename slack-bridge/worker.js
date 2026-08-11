// slack-bridge/worker.js — Cloudflare Worker làm cầu nối Slack -> GitHub Actions + SoWork API.
// Slash command: /sowork run | stop | stats | status | help
//
// XÁC THỰC SLACK (một trong hai):
//   SLACK_SIGNING_SECRET     : nếu Slack App ký request
//   SLACK_VERIFICATION_TOKEN : nếu Slash Command kiểu cũ (không ký)
//   ALLOWED_CHANNEL_IDS      : (tùy chọn) chỉ cho chạy trong các channel này
//
// NHIỀU NGƯỜI DÙNG (khuyến nghị) — đặt 1 biến JSON:
//   USERS_JSON = {
//     "U_SLACK_ID_1": { "apiKey":"...", "refreshToken":"...", "repo":"owner/repo", "ghToken":"github_pat_...", "groupId":"..." },
//     "U_SLACK_ID_2": { ... }
//   }
//   -> mỗi Slack user chạy trên repo & phiên SoWork của CHÍNH họ. "groupId" tùy chọn (mặc định office NSC).
//
// MỘT NGƯỜI (nếu KHÔNG đặt USERS_JSON): dùng các biến rời
//   SOWORK_API_KEY, SOWORK_REFRESH_TOKEN, GH_REPO, GH_TOKEN, WORKFLOW_FILE?, GH_REF?, SOWORK_GROUP_ID?,
//   ALLOWED_SLACK_USER_IDS? (giới hạn ai được dùng)

const TZ = 'Asia/Ho_Chi_Minh';

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      // Luôn trả 200 kèm lý do lỗi để Slack HIỂN THỊ (thay vì "did not respond")
      return json({ response_type: 'ephemeral', text: `❌ Bridge lỗi: ${(err && err.message) || err}` });
    }
  }
};

async function route(request, env, ctx) {
    if (request.method !== 'POST') return new Response('SoWork Slack bridge OK', { status: 200 });

    const raw = await request.text();
    const params = new URLSearchParams(raw);

    // 1) Xác thực: có header ký -> verify HMAC (Slack App);
    //    không có header ký -> Slash Command kiểu cũ -> so Verification Token trong body.
    if (request.headers.get('X-Slack-Signature')) {
      if (!env.SLACK_SIGNING_SECRET) {
        return json({ response_type: 'ephemeral', text: '⚙️ Có chữ ký nhưng chưa đặt SLACK_SIGNING_SECRET trong Worker.' });
      }
      const v = await verifySlack(request, raw, env.SLACK_SIGNING_SECRET);
      if (!v.ok) {
        return json({ response_type: 'ephemeral', text: `🚫 Chữ ký không khớp — lý do: ${v.reason}\n${v.debug || ''}` });
      }
    } else {
      // Không có chữ ký -> dùng Verification Token
      const expected = (env.SLACK_VERIFICATION_TOKEN || '').trim();
      const token = params.get('token');
      if (!expected) {
        return json({ response_type: 'ephemeral', text: '⚙️ Slash command này không gửi chữ ký (kiểu cũ). Hãy đặt biến SLACK_VERIFICATION_TOKEN trong Worker (lấy ở trang cấu hình Slash Command hoặc Basic Information → Verification Token).' });
      }
      if (!token || token !== expected) {
        const mask = s => s ? `${s.slice(0, 4)}…${s.slice(-2)}(${s.length})` : '(trống)';
        return json({ response_type: 'ephemeral', text: `🚫 Verification token không khớp.\nSlack gửi: ${mask(token)}\nWorker có: ${mask(expected)}\n→ Copy đúng "Slack gửi" vào SLACK_VERIFICATION_TOKEN.` });
      }
    }
    const text = (params.get('text') || '').trim().toLowerCase();
    const responseUrl = params.get('response_url');
    const userId = params.get('user_id');
    const channelId = params.get('channel_id');
    const sub = text.split(/\s+/)[0] || 'help';

    // Giới hạn theo CHANNEL: nếu đặt ALLOWED_CHANNEL_IDS thì chỉ chạy trong các channel này.
    // Dùng 1 channel RIÊNG TƯ -> chỉ thành viên channel mới gõ được -> hiệu quả "chỉ người trong channel".
    const chAllow = (env.ALLOWED_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (chAllow.length && !chAllow.includes(channelId)) {
      return json({ response_type: 'ephemeral', text: '🚫 Lệnh này chỉ dùng được trong channel được cấp phép.' });
    }

    // Lấy cấu hình theo NGƯỜI (multi-user). Xem getUserConfig ở cuối file.
    const cfg = getUserConfig(env, userId);

    // Chẩn đoán: /sowork whoami -> xem Worker nhận diện bạn thế nào (che token)
    if (sub === 'whoami') {
      let mode = 'single-user (KHÔNG có USERS_JSON) → ai cũng nhận cấu hình của chủ';
      if (env.USERS_JSON) {
        try { const u = JSON.parse(env.USERS_JSON); mode = `multi-user, ${Object.keys(u).length} người; bạn ${u[userId] ? 'CÓ' : 'KHÔNG'} trong danh sách`; }
        catch { mode = '⚠️ USERS_JSON SAI CÚ PHÁP (JSON lỗi) → Worker bỏ qua'; }
      }
      const mask = s => s ? `${String(s).slice(0, 6)}…(${String(s).length})` : '(trống)';
      const cfgInfo = cfg ? `repo=${cfg.repo || '(none)'}, groupId=${cfg.groupId || '(mặc định)'}, refreshToken=${mask(cfg.refreshToken)}` : '(không khớp ai → sẽ bị từ chối)';
      // Gọi thật để biết refreshToken này thuộc TÀI KHOẢN SoWork nào
      let acct = '(không kiểm tra được)';
      if (cfg && cfg.apiKey && cfg.refreshToken) {
        try { const a = await soworkAuth(cfg); acct = `${a.userName} (uid ${String(a.userId).slice(0, 8)}…)`; }
        catch (e) { acct = 'lỗi: ' + (e.message || e); }
      }
      return json({ response_type: 'ephemeral', text: `🔎 *whoami*\nuser_id: \`${userId}\`\nMode: ${mode}\nCấu hình: ${cfgInfo}\n👉 Tài khoản SoWork của token: *${acct}*` });
    }

    if (!cfg || !cfg.apiKey || !cfg.refreshToken) {
      return json({ response_type: 'ephemeral', text: '🚫 Bạn chưa được cấu hình để dùng lệnh này (chưa có trong USERS_JSON).' });
    }

    if (sub === 'help' || !['run', 'stop', 'stats', 'status'].includes(sub)) {
      return json({
        response_type: 'ephemeral',
        text: '*SoWork bridge* — lệnh:\n• `/sowork run` — khởi động keepalive\n• `/sowork stop` — dừng phiên đang chạy\n• `/sowork stats` — xem thời gian online hôm nay + trạng thái\n• `/sowork status` — chỉ xem trạng thái hiện tại'
      });
    }

    // Xử lý bất đồng bộ rồi trả kết quả qua response_url (tránh timeout 3s của Slack)
    ctx.waitUntil(
      handle(sub, cfg)
        .then(msg => postSlack(responseUrl, msg))
        .catch(err => postSlack(responseUrl, `❌ Lỗi: ${(err && err.message) || err}`))
    );
    return json({ response_type: 'ephemeral', text: '⏳ Đang xử lý...' });
}

// Trả cấu hình của 1 Slack user. Multi-user: USERS_JSON = { "<slackUserId>": {apiKey, refreshToken, repo, ghToken, groupId?, workflow?, ref?} }.
// Nếu KHÔNG đặt USERS_JSON -> chế độ 1 người (chủ), dùng các biến rời.
function getUserConfig(env, slackUserId) {
  if (env.USERS_JSON) {
    let users = null;
    try { users = JSON.parse(env.USERS_JSON); } catch { return null; }
    return users[slackUserId] || null; // chỉ ai có trong map mới dùng được
  }
  // Chế độ 1 người: có thể giới hạn bằng ALLOWED_SLACK_USER_IDS
  const allow = (env.ALLOWED_SLACK_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(slackUserId)) return null;
  return {
    apiKey: env.SOWORK_API_KEY, refreshToken: env.SOWORK_REFRESH_TOKEN,
    repo: env.GH_REPO, ghToken: env.GH_TOKEN,
    groupId: env.SOWORK_GROUP_ID, workflow: env.WORKFLOW_FILE, ref: env.GH_REF
  };
}

async function handle(sub, cfg) {
  if (sub === 'run') return await ghRun(cfg);
  if (sub === 'stop') return await ghStop(cfg);
  if (sub === 'stats') return await soworkReport(cfg, true);
  if (sub === 'status') return await soworkReport(cfg, false);
}

/* ---------------- GitHub Actions ---------------- */
function ghHeaders(cfg) {
  return {
    'Authorization': `Bearer ${cfg.ghToken}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sowork-slack-bridge'
  };
}
async function ghRun(cfg) {
  if (!cfg.repo || !cfg.ghToken) return '⚙️ Chưa cấu hình repo/ghToken cho bạn (trong USERS_JSON).';
  const wf = cfg.workflow || 'sowork.yml';
  const ref = cfg.ref || 'main';
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/actions/workflows/${wf}/dispatches`, {
    method: 'POST', headers: { ...ghHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref })
  });
  if (res.status === 204) return '▶️ Đã khởi động keepalive. Chờ ~1 phút để vào văn phòng (bạn sẽ nhận Slack "đã VÀO văn phòng").';
  return `❌ Không khởi động được (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`;
}
async function ghStop(cfg) {
  if (!cfg.repo || !cfg.ghToken) return '⚙️ Chưa cấu hình repo/ghToken cho bạn (trong USERS_JSON).';
  const wf = cfg.workflow || 'sowork.yml';
  let ids = [];
  for (const st of ['in_progress', 'queued']) {
    const res = await fetch(`https://api.github.com/repos/${cfg.repo}/actions/workflows/${wf}/runs?status=${st}&per_page=20`, { headers: ghHeaders(cfg) });
    if (res.ok) { const j = await res.json(); (j.workflow_runs || []).forEach(r => ids.push(r.id)); }
  }
  ids = [...new Set(ids)];
  if (ids.length === 0) return 'ℹ️ Không có phiên keepalive nào đang chạy.';
  let cancelled = 0;
  for (const id of ids) {
    const res = await fetch(`https://api.github.com/repos/${cfg.repo}/actions/runs/${id}/cancel`, { method: 'POST', headers: ghHeaders(cfg) });
    if (res.status === 202) cancelled++;
  }
  return `⏹️ Đã gửi lệnh dừng cho ${cancelled}/${ids.length} phiên đang chạy.`;
}

/* ---------------- SoWork API ---------------- */
async function soworkAuth(cfg) {
  const apiKey = cfg.apiKey, refreshToken = cfg.refreshToken;
  if (!apiKey || !refreshToken) throw new Error('Thiếu apiKey / refreshToken (kiểm tra USERS_JSON).');
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
  });
  const j = await r.json();
  if (!j.id_token) throw new Error('PHIÊN HẾT HẠN — cần chạy lại capture-session.js + cập nhật refreshToken.');
  let p = j.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  p += '==='.slice((p.length + 3) % 4); // padding base64
  const claims = JSON.parse(atob(p));
  return { idToken: j.id_token, userId: j.user_id || claims.user_id, userName: claims.name || claims.user_id };
}
function fmtDurSec(sec) { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`; }

async function soworkReport(cfg, withTime) {
  const groupId = cfg.groupId || '5yBGdkKFdacSqo4bWb2j';
  const { idToken, userId, userName } = await soworkAuth(cfg);
  const auth = { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' };

  // Trạng thái hiện tại
  let statusLine = '❓ không rõ';
  try {
    const rooms = await (await fetch('https://api.sowork.com/api/v1/gaia/rooms', { method: 'POST', headers: auth, body: JSON.stringify({ groupId }) })).json();
    const online = new Set();
    Object.values(rooms.roomDefinitionMap || {}).forEach(rd => (rd.rooms || []).forEach(rm => (rm.userIds || []).forEach(u => online.add(u))));
    const meeting = new Set(((await (await fetch('https://api.sowork.com/api/v1/reports/getInMeetingUserIds', { method: 'POST', headers: auth, body: JSON.stringify({ groupId }) })).json()).userIds) || []);
    if (!online.has(userId)) statusLine = '⚪ Offline';
    else if (meeting.has(userId)) statusLine = '🎥 Online — đang họp';
    else statusLine = '🟢 Online — trong văn phòng';
    statusLine += ` _(${online.size} người đang online)_`;
  } catch (e) { statusLine = '❓ ' + (e.message || e); }

  if (!withTime) return `*SoWork — ${userName}*\nTrạng thái ngay bây giờ: ${statusLine}`;

  // Thời gian hôm nay (analytics/user-working-hours)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const wk = await (await fetch(`https://api.sowork.com/api/v1/analytics/user-working-hours?groupId=${groupId}&userId=${userId}&fromDate=${today}&timezone=${encodeURIComponent('Asia/Saigon')}`, { headers: { 'Authorization': `Bearer ${idToken}` } })).json();
  const d = (wk.days || []).find(x => x.date === today) || {};
  const office = d.totalSeconds || 0, away = d.awaySeconds || 0, onlineSec = Math.max(0, office - away);
  return [
    `*SoWork — ${userName}* (hôm nay ${today})`,
    `Trạng thái: ${statusLine}`,
    `🏢 Trong văn phòng: *${fmtDurSec(office)}*`,
    `🟢 Đang online: ${fmtDurSec(onlineSec)}`,
    `💤 Away: ${fmtDurSec(away)}`
  ].join('\n');
}

/* ---------------- Slack helpers ---------------- */
function json(obj) { return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } }); }
async function postSlack(responseUrl, text) {
  if (!responseUrl) return;
  await fetch(responseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', text }) });
}
async function verifySlack(request, rawBody, signingSecret) {
  if (!signingSecret) return { ok: false, reason: 'thiếu SLACK_SIGNING_SECRET' };
  signingSecret = signingSecret.trim(); // bỏ khoảng trắng/xuống dòng lỡ dính khi dán
  const ts = request.headers.get('X-Slack-Request-Timestamp');
  const sig = request.headers.get('X-Slack-Signature');
  if (!ts || !sig) {
    const names = [...request.headers.keys()].join(', ');
    return { ok: false, reason: 'thiếu header X-Slack-*', debug: `Header nhận được: ${names}` };
  }
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (age > 300) return { ok: false, reason: `timestamp quá cũ (${Math.round(age)}s) — lệch giờ?` };
  const base = `v0:${ts}:${rawBody}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  const mine = `v0=${hex}`;
  let diff = mine.length === sig.length ? 0 : 1;
  for (let i = 0; i < Math.min(mine.length, sig.length); i++) diff |= mine.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff === 0) return { ok: true };
  const debug = `len(secret)=${signingSecret.length}, body=${rawBody.length}b, mine=${mine.slice(0, 12)}…, slack=${sig.slice(0, 12)}…`;
  return { ok: false, reason: 'HMAC không trùng (sai Signing Secret hoặc sai app)', debug };
}
