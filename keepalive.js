// keepalive.js — giữ Online trên SoWork bằng 1 phiên browser sống liên tục.
// Nguồn phiên: biến môi trường SOWORK_SESSION (JSON storageState kèm IndexedDB) trên CI,
//              hoặc file session.json khi chạy cục bộ.
//
// Cấu hình qua ENV (đều tùy chọn):
//   RUN_MINUTES       : số phút giữ browser sống trước khi thoát (mặc định 350).
//   STOP_HOUR_VN      : dừng khi giờ VN >= mốc này (mặc định 24 = nửa đêm).
//   SOWORK_GROUP_ID   : id văn phòng để kiểm tra presence (mặc định office của bạn).
//   SLACK_WEBHOOK_URL : nếu đặt -> gửi cảnh báo Slack khi mất kết nối / hết phiên / lỗi.

const { chromium } = require('playwright');
const fs = require('fs');
const zlib = require('zlib');
const { logSessionInfo } = require('./session-info');

const delay = ms => new Promise(res => setTimeout(res, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const vnNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
const vnClock = () => vnNow().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

const RUN_MINUTES = parseInt(process.env.RUN_MINUTES || '350', 10);
const STOP_HOUR_VN = parseInt(process.env.STOP_HOUR_VN || '24', 10);
// CONTINUOUS=1 -> giữ Online 24h các ngày trong tuần (T2–T6), chỉ NGHỈ Thứ 7 & Chủ Nhật (giờ VN).
// Bỏ qua mốc dừng theo giờ (STOP_HOUR_VN) và random tắt sớm; chỉ dừng khi sang cuối tuần.
const CONTINUOUS = process.env.CONTINUOUS === '1';
const GROUP_ID = process.env.SOWORK_GROUP_ID || '5yBGdkKFdacSqo4bWb2j';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_USER_ID = process.env.SLACK_USER_ID; // member ID (U...) để tag; có thể để trống
const SLACK_MENTION = SLACK_USER_ID ? `<@${SLACK_USER_ID}> ` : '';

function loadState() {
  const raw = process.env.SOWORK_SESSION;
  if (raw) {
    const s = raw.trim();
    // Ho tro ca 2 dinh dang: JSON tho, hoac base64(gzip(json)) — dung khi vuot gioi han 48KB cua secret.
    if (s.startsWith('{')) return JSON.parse(s);
    return JSON.parse(zlib.gunzipSync(Buffer.from(s, 'base64')).toString('utf8'));
  }
  if (fs.existsSync('session.json')) return JSON.parse(fs.readFileSync('session.json', 'utf8'));
  throw new Error('Không tìm thấy phiên: đặt biến SOWORK_SESSION hoặc tạo file session.json (chạy capture-session.js).');
}

async function notifySlack(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: SLACK_MENTION + text, link_names: 1 })
    });
  } catch (e) {
    console.error('[SLACK] Gui that bai:', e.message || e);
  }
}

// Làm mới ID token từ refresh token trong phiên (để gọi API kiểm tra presence).
function extractAuth(state) {
  const raw = JSON.stringify(state);
  const apiKey = (raw.match(/firebase:authUser:([^:]+):\[DEFAULT\]/) || [])[1];
  const refreshToken = (raw.match(/"k":"refreshToken","v":"([^"]+)"/) || [])[1];
  return { apiKey, refreshToken };
}
async function refreshIdToken(apiKey, refreshToken) {
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
  });
  const j = await r.json();
  return j.id_token || null;
}
async function isPresent(idToken, userId) {
  const res = await fetch('https://api.sowork.com/api/v1/gaia/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
    body: JSON.stringify({ groupId: GROUP_ID })
  });
  if (!res.ok) throw new Error('gaia/rooms HTTP ' + res.status);
  const j = await res.json();
  const set = new Set();
  Object.values(j.roomDefinitionMap || {}).forEach(rd =>
    (rd.rooms || []).forEach(rm => (rm.userIds || []).forEach(u => set.add(u))));
  return set.has(userId);
}

(async () => {
  const start = vnNow();
  console.log(`[TIME] Bat dau luc (VN): ${start.getHours()}:${String(start.getMinutes()).padStart(2, '0')}`);

  // Vào làm "muộn" ngẫu nhiên nếu đang đầu giờ sáng (7:00–7:15) — bỏ qua khi chạy 24h liên tục.
  if (!CONTINUOUS && start.getHours() === 7 && start.getMinutes() <= 15) {
    const d = rand(0, 10);
    console.log(`[RANDOM] Dau gio 7AM -> delay ${d} phut cho tu nhien...`);
    await delay(d * 60 * 1000);
  }

  const state = loadState();
  logSessionInfo(state);
  await notifySlack(`🚀 *SoWork keepalive*: bắt đầu ca giữ Online lúc ${vnClock()} (VN).`);

  // Chuẩn bị token để kiểm tra presence (nếu lấy được auth từ phiên)
  const { apiKey, refreshToken } = extractAuth(state);
  let idToken = null, userId = null, tokenAt = 0;
  if (apiKey && refreshToken) {
    idToken = await refreshIdToken(apiKey, refreshToken);
    tokenAt = Date.now();
    if (idToken) {
      try { userId = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString()).user_id; } catch {}
    } else {
      // Làm mới token thất bại -> refresh token đã bị thu hồi -> PHIÊN HẾT HẠN (chắc chắn).
      console.error('❌ PHIEN HET HAN (khong lam moi duoc token). Can chay lai capture-session.js.');
      await notifySlack(`❌ *SoWork keepalive*: PHIÊN HẾT HẠN (${vnClock()}) — refresh token bị thu hồi/hết hạn. Hãy chạy lại capture-session.js + cập nhật secret SOWORK_SESSION.`);
      process.exit(1);
    }
  }
  const canCheckPresence = !!(idToken && userId);
  if (!canCheckPresence) console.log('[WARN] Khong lay duoc token -> chi phat hien mat ket noi qua WebSocket.');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: state,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  let shuttingDown = false;
  let gaiaConnected = false;
  let gaiaClosed = false; // WS gaia hien dang dong? (reset khi reconnect)
  let lastDisconnectAlert = 0;
  let disconnectAlertSent = false;
  page.on('websocket', ws => {
    if (!/api\.sowork\.com\/gaia/.test(ws.url())) return;
    gaiaConnected = true;
    gaiaClosed = false; // co ket noi gaia moi -> coi nhu da reconnect
    ws.on('close', () => {
      if (shuttingDown) return;
      gaiaClosed = true;
      console.log(`[WS] gaia dong luc ${vnClock()}`);
      // Nếu KHÔNG kiểm tra được presence qua API thì dùng WS-close làm tín hiệu mất kết nối (có cooldown).
      if (!canCheckPresence) {
        const now = Date.now();
        if (now - lastDisconnectAlert > 5 * 60 * 1000) {
          lastDisconnectAlert = now;
          notifySlack(`⚠️ *SoWork keepalive*: mất kết nối lúc ${vnClock()} (WebSocket đóng). Có thể do phiên khác đăng nhập cùng tài khoản.`);
        }
      }
    });
  });

  const clickIfVisible = async (re, label, timeout) => {
    try {
      const el = page.getByText(re).first();
      await el.waitFor({ state: 'visible', timeout });
      await el.click();
      console.log('-> Bam:', label);
      return true;
    } catch { return false; }
  };

  try {
    console.log('Dang vao van phong ao app.sowork.com...');
    await page.goto('https://app.sowork.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    const body = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 300);
    if (/Welcome to SoWork!|Continue with Google|Continue with Microsoft|Sign in with email/i.test(body)) {
      console.error('❌ VAN O MAN HINH DANG NHAP — phien het han hoac khong hop le. Can chay lai capture-session.js.');
      await page.screenshot({ path: 'keepalive-error.png' }).catch(() => {});
      await notifySlack(`❌ *SoWork keepalive*: PHIÊN HẾT HẠN (${vnClock()}). Cần chạy lại capture-session.js + cập nhật secret SOWORK_SESSION.`);
      shuttingDown = true;
      await browser.close();
      process.exit(1);
    }

    await clickIfVisible(/continue in your browser/i, 'continue in your browser', 45000);
    await page.waitForTimeout(3000);
    await clickIfVisible(/continue without camera or microphone/i, 'continue without camera or microphone', 30000);

    for (let i = 0; i < 20 && !gaiaConnected; i++) await page.waitForTimeout(1500);
    if (gaiaConnected) {
      console.log('✅ Da ket noi real-time (gaia) — DANG ONLINE. Bat dau giu phien...');
      await notifySlack(`✅ *SoWork keepalive*: đã VÀO văn phòng — ONLINE lúc ${vnClock()} (VN).`);
    } else {
      console.log('⚠️  Chua thay ket noi gaia nhung da qua cac man cho — van tiep tuc giu phien.');
      await notifySlack(`⚠️ *SoWork keepalive*: đã qua các màn chờ nhưng CHƯA thấy kết nối real-time (${vnClock()}). Vẫn tiếp tục giữ phiên.`);
    }
    await page.screenshot({ path: 'keepalive-online.png' }).catch(() => {});

    const deadline = Date.now() + RUN_MINUTES * 60 * 1000;
    let tick = 0;
    let online = true; // trạng thái presence gần nhất
    while (Date.now() < deadline) {
      const now = vnNow();
      if (CONTINUOUS) {
        // Chạy 24h; chỉ dừng khi bước sang cuối tuần (Thứ 7 = 6, Chủ Nhật = 0) theo giờ VN.
        const day = now.getDay();
        if (day === 6 || day === 0) {
          console.log('[STOP] Cuoi tuan (VN) -> off.');
          break;
        }
      } else {
        if (now.getHours() >= STOP_HOUR_VN || (STOP_HOUR_VN === 24 && now.getHours() === 0)) {
          console.log('[STOP] Toi mat gio nghi -> off.');
          break;
        }
        if (now.getHours() === 23 && Math.random() > 0.6) {
          console.log('[RANDOM] 23PM -> off som ngau nhien.');
          break;
        }
      }

      await page.waitForTimeout(rand(45000, 90000));
      await page.mouse.move(rand(200, 1000), rand(150, 650)).catch(() => {});
      tick++;

      // Kiểm tra presence thật qua API (chính xác hơn WS). Làm mới token nếu gần hết hạn.
      if (canCheckPresence) {
        try {
          if (Date.now() - tokenAt > 50 * 60 * 1000) {
            const t = await refreshIdToken(apiKey, refreshToken);
            if (t) { idToken = t; tokenAt = Date.now(); }
            else {
              // Hết phiên giữa chừng -> báo Slack và dừng sạch (không để catch báo "LỖI" trùng).
              console.error('❌ PHIEN HET HAN giua chung (khong lam moi duoc token).');
              await notifySlack(`❌ *SoWork keepalive*: PHIÊN HẾT HẠN giữa chừng lúc ${vnClock()} — refresh token bị thu hồi/hết hạn. Hãy chạy lại capture-session.js + cập nhật secret SOWORK_SESSION.`);
              shuttingDown = true;
              await browser.close();
              process.exit(1);
            }
          }
          const present = await isPresent(idToken, userId);

          // WS phiên headless đã đóng NHƯNG API vẫn báo present
          // -> một phiên KHÁC của bạn (app laptop/điện thoại) đang giữ Online.
          // Nhường phiên: báo Slack đúng 1 lần rồi thoát sạch (exit 0).
          if (gaiaClosed && present) {
            console.log('[SELF] WS headless da dong nhung van present -> phien khac cua ban dang online. Nhuong phien va thoat.');
            await notifySlack(`👋 *SoWork keepalive*: phát hiện bạn đã ĐĂNG NHẬP ở nơi khác (app laptop/điện thoại) lúc ${vnClock()} (VN) — phiên tự động NHƯỜNG và thoát.`);
            shuttingDown = true;
            await browser.close();
            process.exit(0);
          }

          if (online && !present) {
            // vừa bị rớt
            online = false;
            const nowMs = Date.now();
            if (nowMs - lastDisconnectAlert > 5 * 60 * 1000) {
              lastDisconnectAlert = nowMs;
              disconnectAlertSent = true;
              await notifySlack(`⚠️ *SoWork keepalive*: BỊ MẤT KẾT NỐI lúc ${vnClock()} — không còn trong văn phòng. Thường do phiên khác (app trên máy/điện thoại, hoặc ca workflow trùng) đăng nhập cùng tài khoản.`);
            }
          } else if (!online && present) {
            // đã online lại — chỉ báo nếu trước đó đã gửi cảnh báo mất kết nối (tránh spam)
            online = true;
            if (disconnectAlertSent) {
              disconnectAlertSent = false;
              await notifySlack(`✅ *SoWork keepalive*: đã kết nối lại (online) lúc ${vnClock()}.`);
            }
          }
        } catch (e) {
          console.log('[PRESENCE] loi kiem tra:', e.message || e);
        }
      }

      if (tick % 10 === 0) {
        console.log(`[ALIVE] tick ${tick} — VN ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} — ${online ? 'Online' : 'MAT KET NOI'}.`);
      }
    }
    console.log('Ket thuc phien giu Online.');
    await notifySlack(`🏁 *SoWork keepalive*: THOÁT session — kết thúc ca lúc ${vnClock()} (VN).`);
  } catch (error) {
    console.error('Loi:', error.message || error);
    await page.screenshot({ path: 'keepalive-error.png' }).catch(() => {});
    await notifySlack(`❌ *SoWork keepalive*: LỖI lúc ${vnClock()}: ${(error.message || error).toString().slice(0, 300)}`);
  } finally {
    shuttingDown = true;
    await browser.close();
  }
})();
