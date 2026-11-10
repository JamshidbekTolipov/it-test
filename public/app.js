(() => {
  const $ = s => document.querySelector(s);
  const screens = { welcome: $('#welcome'), test: $('#test'), result: $('#result') };
  const LETTERS = ['A', 'B', 'C', 'D'];

  let questions = [];
  let answers = {};      // { savolIndeksi: variantIndeksi }
  let cur = 0;
  let endAt = 0;         // performance.now() asosida tugash vaqti
  let timerId = null;
  let finishing = false;

  // Logotip topilmasa — matn ko'rsatiladi
  $('#logo').addEventListener('error', () => {
    $('#logo').hidden = true;
    $('#logoText').hidden = false;
  });

  function show(name) {
    Object.entries(screens).forEach(([k, el]) => (el.hidden = k !== name));
    $('#timer').hidden = name !== 'test';
    window.scrollTo(0, 0);
  }

  async function api(url, body) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Xatolik yuz berdi. Qayta urinib ko\'ring.');
    return data;
  }

  /* ---------- Boshlash ---------- */
  $('#startForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#startError');
    err.hidden = true;
    $('#startBtn').disabled = true;
    try {
      await api('/api/start', {
        firstName: $('#firstName').value,
        lastName: $('#lastName').value
      });
      await load();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      $('#startBtn').disabled = false;
    }
  });

  async function load() {
    const d = await api('/api/test');
    if (d.finished) return showResult(d.result);
    questions = d.questions;
    answers = {};
    Object.entries(d.answers || {}).forEach(([k, v]) => (answers[Number(k)] = v));
    endAt = performance.now() + d.remaining;
    $('#studentName').textContent = d.name;
    const firstEmpty = questions.findIndex((_, i) => answers[i] === undefined);
    cur = firstEmpty === -1 ? 0 : firstEmpty;
    buildTiles();
    render();
    show('test');
    startTimer();
  }

  /* ---------- Taymer ---------- */
  function startTimer() {
    clearInterval(timerId);
    tick();
    timerId = setInterval(tick, 250);
  }
  function tick() {
    const left = Math.max(0, endAt - performance.now());
    const s = Math.ceil(left / 1000);
    $('#timeText').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const t = $('#timer');
    t.classList.toggle('danger', s <= 60);
    t.classList.toggle('warn', s > 60 && s <= 180);
    if (left <= 0) finish(true);
  }

  /* ---------- Savollarni ko'rsatish ---------- */
  function buildTiles() {
    const box = $('#tiles');
    box.innerHTML = '';
    questions.forEach((_, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      b.textContent = i + 1;
      b.setAttribute('aria-label', `${i + 1}-savol`);
      b.addEventListener('click', () => { cur = i; render(); });
      box.appendChild(b);
    });
  }

  function render() {
    const q = questions[cur];
    $('#qCount').textContent = `Savol ${cur + 1} / ${questions.length}`;
    $('#qText').textContent = q.text;

    const box = $('#options');
    box.innerHTML = '';
    q.options.forEach((text, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt' + (answers[cur] === i ? ' selected' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', answers[cur] === i ? 'true' : 'false');
      const letter = document.createElement('span');
      letter.className = 'letter';
      letter.textContent = LETTERS[i];
      const label = document.createElement('span');
      label.textContent = text;
      b.append(letter, label);
      b.addEventListener('click', () => choose(i));
      box.appendChild(b);
    });

    const done = Object.keys(answers).length;
    $('#barFill').style.width = `${(done / questions.length) * 100}%`;
    $('#answeredInfo').textContent = `Javob berilgan: ${done} / ${questions.length}`;
    $('#prevBtn').disabled = cur === 0;
    $('#nextBtn').disabled = cur === questions.length - 1;
    [...$('#tiles').children].forEach((t, i) => {
      t.classList.toggle('done', answers[i] !== undefined);
      t.classList.toggle('current', i === cur);
    });
  }

  function choose(i) {
    answers[cur] = i;
    render();
    // sahifa yangilansa yo'qolmasligi uchun serverga ham saqlaymiz
    api('/api/answer', { pos: cur, choice: i }).then(r => { if (r.finished) load(); }).catch(() => {});
  }

  $('#prevBtn').addEventListener('click', () => { if (cur > 0) { cur--; render(); } });
  $('#nextBtn').addEventListener('click', () => { if (cur < questions.length - 1) { cur++; render(); } });
  $('#finishBtn').addEventListener('click', () => finish(false));

  document.addEventListener('keydown', e => {
    if (screens.test.hidden || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight') $('#nextBtn').click();
    else if (e.key === 'ArrowLeft') $('#prevBtn').click();
    else {
      const idx = LETTERS.indexOf(e.key.toUpperCase());
      const num = ['1', '2', '3', '4'].indexOf(e.key);
      const pick = idx !== -1 ? idx : num;
      if (pick !== -1 && pick < questions[cur].options.length) choose(pick);
    }
  });

  /* ---------- Yakunlash ---------- */
  async function finish(auto) {
    if (finishing) return;
    if (!auto) {
      const left = questions.length - Object.keys(answers).length;
      const msg = left > 0
        ? `${left} ta savolga javob berilmagan. Testni yakunlaysizmi?`
        : 'Testni yakunlaysizmi?';
      if (!confirm(msg)) return;
    }
    finishing = true;
    clearInterval(timerId);
    try {
      const d = await api('/api/finish', { answers });
      showResult(d.result);
    } catch (ex) {
      finishing = false;
      alert(ex.message);
      if (auto) setTimeout(() => finish(true), 1500);
      else startTimer();
    }
  }

  /* ---------- Natija ---------- */
  function showResult(r) {
    clearInterval(timerId);
    $('#resName').textContent = r.name;
    $('#resScore').textContent = r.score;
    $('#resOf').textContent = `${r.total} ta savoldan to'g'ri`;
    $('#resPercent').textContent = `${r.percent}%`;
    $('#resMsg').textContent =
      r.percent >= 90 ? "Ajoyib natija!" :
      r.percent >= 70 ? "Yaxshi natija." :
      r.percent >= 50 ? "Qoniqarli. Mavzularni takrorlang." :
                        "Mavzularni qayta o'rganib chiqing.";
    const box = $('#resTiles');
    box.innerHTML = '';
    r.review.forEach((ok, i) => {
      const t = document.createElement('div');
      t.className = 'tile ' + (ok ? 'ok' : 'bad');
      t.textContent = i + 1;
      t.title = ok ? "To'g'ri" : "Noto'g'ri";
      box.appendChild(t);
    });
    const m = Math.floor(r.seconds / 60), s = r.seconds % 60;
    $('#resTime').textContent = `Sarflangan vaqt: ${m} daqiqa ${s} soniya`;
    show('result');
  }

  /* ---------- Sahifa ochilganda ---------- */
  api('/api/test').then(d => {
    if (d.finished) showResult(d.result);
    else load();
  }).catch(() => show('welcome'));
})();
