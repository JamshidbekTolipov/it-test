const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Sozlamalar (Render > Environment bo'limida o'zgartirish mumkin) ----
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';                 // natijalar sahifasi uchun parol
const DEVICE_LOCK = process.env.DEVICE_LOCK !== 'off';         // bir kompyuterdan bir marta
const DURATION_MS = (Number(process.env.TEST_MINUTES) || 10) * 60 * 1000;
const GRACE_MS = 10 * 1000;                                    // oxirgi javoblarni yuborish uchun zaxira

const QUESTIONS = require('./questions.json');
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// ---- Oddiy fayl bazasi ----
let db = { attempts: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* birinchi ishga tushirish */ }
function save() {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  } catch (e) { console.error('Saqlashda xato:', e.message); }
}

// ---- Yordamchi funksiyalar ----
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// "Ali Valiyev" va "valiyev  ali" bir xil hisoblanadi
const normName = s => s.toLowerCase()
  .replace(/[`'’‘ʻʼ]/g, "'")
  .split(/\s+/).filter(Boolean).sort().join(' ');

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(req, res, name, val) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(val)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
}

function finalize(a) {
  if (a.finished) return a;
  let score = 0;
  const review = a.order.map((o, pos) => {
    const chosen = a.answers[pos];
    const ok = chosen !== undefined && o.opts[chosen] === QUESTIONS[o.q].answer;
    if (ok) score++;
    return ok;
  });
  a.finished = true;
  a.finishedAt = Math.min(Date.now(), a.deadline);
  a.score = score;
  a.review = review;
  save();
  return a;
}
const resultOf = a => ({
  name: `${a.firstName} ${a.lastName}`,
  score: a.score,
  total: QUESTIONS.length,
  percent: Math.round((a.score / QUESTIONS.length) * 100),
  review: a.review,
  seconds: Math.max(0, Math.round((a.finishedAt - a.startedAt) / 1000))
});
function getAttempt(req) {
  const id = cookies(req).aid;
  return id ? db.attempts[id] : null;
}

// ---- Server ----
const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Testni boshlash (yoki uzilib qolgan testni davom ettirish)
app.post('/api/start', (req, res) => {
  const c = cookies(req);
  let device = c.did;
  if (!device || !/^[a-f0-9]{32}$/.test(device)) {
    device = crypto.randomBytes(16).toString('hex');
    setCookie(req, res, 'did', device);
  }

  const firstName = String(req.body.firstName || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const lastName = String(req.body.lastName || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (firstName.length < 2 || lastName.length < 2) {
    return res.status(400).json({ error: "Ism va familiyani to'liq kiriting." });
  }

  const key = normName(`${firstName} ${lastName}`);
  const all = Object.values(db.attempts);

  const existing = all.find(a => a.key === key);
  if (existing) {
    if (existing.device !== device) {
      return res.status(409).json({ error: "Bu ism-familiya bilan test allaqachon boshlangan yoki ishlangan." });
    }
    setCookie(req, res, 'aid', existing.id);
    return res.json({ ok: true });
  }
  if (DEVICE_LOCK && all.some(a => a.device === device)) {
    return res.status(409).json({ error: "Bu kompyuterdan test allaqachon ishlangan." });
  }

  const now = Date.now();
  const attempt = {
    id: crypto.randomBytes(16).toString('hex'),
    key, firstName, lastName, device,
    startedAt: now,
    deadline: now + DURATION_MS,
    // savollar tartibi va har bir savol variantlari tartibi tasodifiy
    order: shuffle(QUESTIONS.map((_, i) => i)).map(q => ({
      q,
      opts: shuffle(QUESTIONS[q].options.map((_, i) => i))
    })),
    answers: {},
    finished: false
  };
  db.attempts[attempt.id] = attempt;
  save();
  setCookie(req, res, 'aid', attempt.id);
  res.json({ ok: true });
});

// Joriy test holati
app.get('/api/test', (req, res) => {
  const a = getAttempt(req);
  if (!a) return res.status(404).json({ error: 'Test topilmadi.' });
  if (!a.finished && Date.now() >= a.deadline) finalize(a);
  if (a.finished) return res.json({ finished: true, result: resultOf(a) });
  res.json({
    finished: false,
    name: `${a.firstName} ${a.lastName}`,
    remaining: a.deadline - Date.now(),
    questions: a.order.map(o => ({
      text: QUESTIONS[o.q].text,
      options: o.opts.map(i => QUESTIONS[o.q].options[i])
    })),
    answers: a.answers
  });
});

// Javobni saqlash (sahifa yangilansa, javoblar yo'qolmasligi uchun)
app.post('/api/answer', (req, res) => {
  const a = getAttempt(req);
  if (!a) return res.status(404).json({ error: 'Test topilmadi.' });
  if (!a.finished && Date.now() > a.deadline + GRACE_MS) finalize(a);
  if (a.finished) return res.json({ finished: true });
  const { pos, choice } = req.body;
  if (Number.isInteger(pos) && Number.isInteger(choice) && pos >= 0 && pos < a.order.length && choice >= 0 && choice < 4) {
    a.answers[pos] = choice;
    save();
  }
  res.json({ ok: true });
});

// Testni yakunlash
app.post('/api/finish', (req, res) => {
  const a = getAttempt(req);
  if (!a) return res.status(404).json({ error: 'Test topilmadi.' });
  if (!a.finished && req.body && req.body.answers && Date.now() <= a.deadline + GRACE_MS) {
    for (const [pos, choice] of Object.entries(req.body.answers)) {
      const p = Number(pos);
      if (Number.isInteger(p) && p >= 0 && p < a.order.length && Number.isInteger(choice) && choice >= 0 && choice < 4) {
        a.answers[p] = choice;
      }
    }
  }
  finalize(a);
  res.json({ finished: true, result: resultOf(a) });
});

// ---- O'qituvchi uchun natijalar (ixtiyoriy, ADMIN_KEY kerak) ----
const adminOk = req => ADMIN_KEY && req.get('x-admin-key') === ADMIN_KEY;

app.get('/api/admin/results', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Parol noto'g'ri yoki ADMIN_KEY sozlanmagan." });
  const rows = Object.values(db.attempts).map(a => {
    if (!a.finished && Date.now() >= a.deadline) finalize(a);
    return {
      id: a.id,
      name: `${a.firstName} ${a.lastName}`,
      finished: a.finished,
      score: a.finished ? a.score : null,
      total: QUESTIONS.length,
      seconds: a.finished ? Math.round((a.finishedAt - a.startedAt) / 1000) : null,
      startedAt: a.startedAt
    };
  });
  res.json({ rows });
});

// Bitta o'quvchiga qayta ishlash imkonini berish
app.post('/api/admin/reset', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ruxsat yo\'q.' });
  delete db.attempts[req.body.id];
  save();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Test sayti ishga tushdi: port ${PORT}`));
