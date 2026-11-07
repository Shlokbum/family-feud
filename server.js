// Family Feud party server: holds the game state and pushes it live to the
// TV board (/board) and the host phone (/host) over Server-Sent Events.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, '.game-state.json');
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const byId = new Map(QUESTIONS.map(q => [q.id, q]));

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return 'localhost';
}
const HOST_URL = process.env.HOST_URL || `http://${lanIp()}:${PORT}/host`;

// ---------- state ----------

function fresh() {
  return {
    phase: 'setup',            // setup | pick | round | gameover | fm-setup | fm
    teams: [{ name: 'Team 1', score: 0 }, { name: 'Team 2', score: 0 }],
    totalRounds: 5,
    fastMoney: true,
    round: 0,
    used: [],
    q: null,                   // current question
    revealed: [],              // per answer: null | 'play' (scored) | 'end' (shown after round)
    stage: null,               // faceoff | play | steal | done
    buzzed: null,
    faceoff: null,             // { first, picks: [idx | -1 | null, ...], winner }
    control: null,
    strikes: 0,
    pot: 0,
    roundWinner: null,
    awarded: 0,
    fm: null,
    blank: false,
    showQr: false,             // big "scan to host" QR on the TV
    seq: 0,
    event: null,               // { seq, types: [...] } – drives board sounds/animations
  };
}

let state = fresh();
try { state = { ...fresh(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
let history = [];

function emit(s, ...types) { s.seq += 1; s.event = { seq: s.seq, types }; }
function unusedIds(s, type, exclude = []) {
  return QUESTIONS.filter(q => !s.used.includes(q.id) && !exclude.includes(q.id) && (!type || type === 'all' || q.type === type)).map(q => q.id);
}
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function award(s, team) {
  s.teams[team].score += s.pot;
  s.roundWinner = team;
  s.awarded = s.pot;
  s.stage = 'done';
}

function startQuestion(s, id) {
  const q = byId.get(id);
  if (!q) return;
  s.used.push(id);
  s.q = q;
  s.phase = 'round';
  s.stage = 'faceoff';
  s.revealed = q.answers.map(() => null);
  s.strikes = 0; s.pot = 0; s.control = null; s.buzzed = null; s.faceoff = null; s.roundWinner = null; s.awarded = 0;
  emit(s, 'newq');
}

// Face-off: the team that buzzed answers first. The top answer wins outright;
// otherwise the other team answers and the higher-ranked answer wins.
function faceoffAnswering(f) {
  if (!f || f.winner !== null) return null;
  if (f.picks[f.first] === null) return f.first;
  if (f.picks[1 - f.first] === null) return 1 - f.first;
  return null;
}

function faceoffAnswer(s, pick) {
  const f = s.faceoff, team = faceoffAnswering(f);
  if (team === null) return;
  f.picks[team] = pick;
  if (team === f.first) { if (pick === 0) f.winner = team; return; }
  const a = f.picks[f.first];
  if (a === -1 && pick === -1) return; // both missed: buzz again
  f.winner = pick !== -1 && (a === -1 || pick < a) ? team : f.first;
}

function fmTotal(fm, includeP1 = true) {
  const sum = list => list.reduce((t, a) => t + (a ? a.pts : 0), 0);
  return (includeP1 ? sum(fm.ans[0]) : 0) + sum(fm.ans[1]);
}

function timerLeft(t) {
  return t.endsAt ? Math.max(0, (t.endsAt - Date.now()) / 1000) : t.left;
}

const actions = {
  setup(s, a) {
    const keep = { seq: s.seq };
    Object.assign(s, fresh(), keep);
    s.teams = [0, 1].map(i => ({ name: String(a.teams?.[i] || `Team ${i + 1}`).slice(0, 30), score: 0 }));
    s.totalRounds = Math.max(1, Math.min(35, Number(a.rounds) || 5));
    s.fastMoney = a.fastMoney !== false;
    s.phase = 'pick';
    s.round = 1;
    emit(s, 'newq');
  },
  pick(s, a) { if (s.phase === 'pick') startQuestion(s, Number(a.id)); },
  random(s, a) {
    if (s.phase !== 'pick') return;
    const ids = unusedIds(s, a.category);
    if (ids.length) startQuestion(s, rand(ids));
  },
  buzz(s, a) {
    if (s.stage !== 'faceoff') return;
    // Only start a face-off when none is in progress (or both teams missed).
    const f = s.faceoff;
    const fresh = !f || (f.picks[0] === null && f.picks[1] === null) || (f.winner === null && faceoffAnswering(f) === null);
    if (!fresh) return;
    s.buzzed = a.team;
    s.faceoff = { first: a.team, picks: [null, null], winner: null };
    emit(s, 'buzz');
  },
  wrong(s) {
    if (s.stage !== 'faceoff') return;
    faceoffAnswer(s, -1);
    emit(s, 'x1', ...(s.faceoff?.winner != null ? ['fowin'] : []));
  },
  foRestart(s) {
    if (s.stage !== 'faceoff') return;
    s.faceoff = null; s.buzzed = null;
    emit(s, 'flip');
  },
  decide(s, a) {
    const w = s.faceoff?.winner;
    if (s.stage !== 'faceoff' || w == null) return;
    s.control = a.choice === 'pass' ? 1 - w : w;
    s.stage = 'play';
    emit(s, 'control');
  },
  control(s, a) {
    if (s.stage !== 'faceoff') return;
    s.control = a.team;
    s.stage = 'play';
    emit(s, 'control');
  },
  reveal(s, a) {
    const i = Number(a.i);
    if (!s.q || s.revealed[i] !== null || i < 0 || i >= s.q.answers.length) return;
    const pts = s.q.answers[i][1];
    if (s.stage === 'done') { s.revealed[i] = 'end'; emit(s, 'flip'); return; }
    if (s.stage === 'faceoff' && faceoffAnswering(s.faceoff) === null) return; // pick who buzzed first
    s.revealed[i] = 'play';
    s.pot += pts;
    if (s.stage === 'steal') { award(s, 1 - s.control); emit(s, 'ding', 'roundwin'); return; }
    if (s.stage === 'play' && s.revealed.every(r => r !== null)) { award(s, s.control); emit(s, 'ding', 'roundwin'); return; }
    if (s.stage === 'faceoff') {
      faceoffAnswer(s, i);
      if (s.faceoff?.winner != null) { emit(s, 'ding', 'fowin'); return; }
    }
    emit(s, 'ding');
  },
  revealAll(s) {
    if (s.stage !== 'done') return;
    s.revealed = s.revealed.map(r => r ?? 'end');
    emit(s, 'flip');
  },
  strike(s) {
    if (s.stage !== 'play') return;
    s.strikes += 1;
    if (s.strikes >= 3) { s.stage = 'steal'; emit(s, 'strike', 'steal'); }
    else emit(s, 'strike');
  },
  stealFail(s) {
    if (s.stage !== 'steal') return;
    award(s, s.control);
    emit(s, 'x1', 'roundwin');
  },
  endRound(s, a) {
    if (s.phase !== 'round' || s.stage === 'done') return;
    if (a.team === 0 || a.team === 1) { award(s, a.team); emit(s, 'roundwin'); }
    else { s.stage = 'done'; s.roundWinner = null; s.awarded = 0; emit(s, 'flip'); }
  },
  next(s) {
    if (s.phase !== 'round' || s.stage !== 'done') return;
    if (s.round >= s.totalRounds) { s.phase = 'gameover'; emit(s, 'gamewin'); return; }
    s.round += 1;
    s.phase = 'pick';
    s.q = null; s.stage = null;
    emit(s, 'newq');
  },
  endGame(s) { s.phase = 'gameover'; s.stage = null; emit(s, 'gamewin'); },
  adjust(s, a) {
    const t = s.teams[a.team];
    if (t) t.score = Math.max(0, t.score + Number(a.delta || 0));
  },
  setRounds(s, a) {
    const n = a.rounds !== undefined ? Number(a.rounds) : s.totalRounds + Number(a.delta || 0);
    s.totalRounds = Math.max(Math.max(1, s.round), Math.min(35, n));
  },
  blank(s) { s.blank = !s.blank; },
  qr(s) { s.showQr = !s.showQr; },
  reset(s) { const seq = s.seq; Object.assign(s, fresh(), { seq }); },

  // ---------- Fast Money ----------
  fmSetup(s) {
    const a = s.teams[0].score, b = s.teams[1].score;
    const ids = [];
    for (let k = 0; k < 5; k++) { const pool = unusedIds(s, 'all', ids); ids.push(pool.length ? rand(pool) : QUESTIONS[k].id); }
    s.fm = { team: b > a ? 1 : 0, ids, names: ['', ''] };
    s.phase = 'fm-setup';
    emit(s, 'newq');
  },
  fmTeam(s, a) { if (s.fm && s.phase === 'fm-setup') s.fm.team = a.team; },
  fmReroll(s, a) {
    if (!s.fm || s.phase !== 'fm-setup') return;
    const pool = unusedIds(s, 'all', s.fm.ids);
    if (pool.length) s.fm.ids[a.k] = rand(pool);
  },
  fmStart(s, a) {
    if (!s.fm) return;
    s.fm.names = [0, 1].map(i => String(a.names?.[i] || `Player ${i + 1}`).slice(0, 24));
    s.fm.questions = s.fm.ids.map(id => byId.get(id));
    s.used.push(...s.fm.ids);
    s.fm.player = 1;
    s.fm.idx = 0;
    s.fm.ans = [[null, null, null, null, null], [null, null, null, null, null]];
    s.fm.showP1 = true;
    s.fm.done = false;
    s.fm.timer = { dur: 20, left: 20, endsAt: null };
    s.phase = 'fm';
    emit(s, 'newq');
  },
  fmTimer(s, a) {
    const t = s.fm?.timer;
    if (!t) return;
    if (a.run && !t.endsAt && t.left > 0) t.endsAt = Date.now() + t.left * 1000;
    if (!a.run && t.endsAt) { t.left = timerLeft(t); t.endsAt = null; }
    if (a.reset) { t.left = t.dur; t.endsAt = null; }
  },
  fmAnswer(s, a) {
    const fm = s.fm;
    if (!fm || s.phase !== 'fm' || fm.idx >= 5) return;
    const q = fm.questions[fm.idx];
    let rec;
    if (a.kind === 'match') rec = { text: q.answers[a.i][0], pts: q.answers[a.i][1] };
    else if (a.kind === 'none') rec = { text: String(a.text || 'No match'), pts: 0 };
    else rec = { text: 'PASS', pts: 0 };
    fm.ans[fm.player - 1][fm.idx] = rec;
    fm.idx += 1;
    if (fm.idx >= 5 && fm.timer.endsAt) { fm.timer.left = timerLeft(fm.timer); fm.timer.endsAt = null; }
    if (fm.player === 2 && fm.idx >= 5 && fm.showP1) finishFm(s, rec.pts ? 'ding' : 'x1');
    else emit(s, rec.pts ? 'ding' : (a.kind === 'none' ? 'x1' : 'flip'));
  },
  fmDup(s) { if (s.phase === 'fm') emit(s, 'dup'); },
  fmNext(s) {
    const fm = s.fm;
    if (!fm || fm.player !== 1 || fm.idx < 5) return;
    fm.player = 2; fm.idx = 0; fm.showP1 = false;
    fm.timer = { dur: 25, left: 25, endsAt: null };
    emit(s, 'newq');
  },
  fmRevealP1(s) {
    const fm = s.fm;
    if (!fm || fm.player !== 2 || fm.showP1) return;
    fm.showP1 = true;
    if (fm.idx >= 5) finishFm(s, 'ding'); else emit(s, 'ding');
  },
  fmExit(s) { s.phase = 'gameover'; emit(s, 'flip'); },
};

function finishFm(s, sound) {
  s.fm.done = true;
  emit(s, sound, fmTotal(s.fm) >= 200 ? 'fmwin' : 'fmlose');
}

const NO_UNDO = new Set(['fmTimer', 'blank', 'qr']);

function dispatch(a) {
  if (a.type === 'undo') {
    const prev = history.pop();
    if (prev) { const seq = state.seq; state = prev; state.seq = seq; state.event = null; }
    return;
  }
  const fn = actions[a.type];
  if (!fn) return;
  const before = JSON.stringify(state);
  fn(state, a);
  if (!NO_UNDO.has(a.type) && JSON.stringify(state) !== before) {
    history.push(JSON.parse(before));
    if (history.length > 100) history.shift();
  }
}

// ---------- views ----------

function boardView(s) {
  const v = {
    phase: s.phase, teams: s.teams, totalRounds: s.totalRounds, fastMoney: s.fastMoney, round: s.round,
    stage: s.stage, buzzed: s.buzzed, foWinner: s.faceoff?.winner ?? null, foAnswering: faceoffAnswering(s.faceoff), control: s.control, strikes: s.strikes, pot: s.pot,
    roundWinner: s.roundWinner, awarded: s.awarded, blank: s.blank, showQr: s.showQr, event: s.event,
    hosts: clients.filter(c => c.role === 'host').length,
    hostUrl: HOST_URL, serverNow: Date.now(),
  };
  if (s.q) {
    v.q = {
      id: s.q.id, question: s.q.question,
      answers: s.q.answers.map((ans, i) => (s.revealed[i] ? { text: ans[0], pts: ans[1], how: s.revealed[i] } : null)),
    };
  }
  if (s.fm && s.phase === 'fm') {
    const fm = s.fm;
    v.fm = {
      team: fm.team, names: fm.names, player: fm.player, idx: fm.idx, done: fm.done, showP1: fm.showP1,
      timer: fm.timer, total: fmTotal(fm, fm.showP1),
      ans: [fm.showP1 ? fm.ans[0] : fm.ans[0].map(a => (a ? { hidden: true } : null)), fm.ans[1]],
    };
  }
  return v;
}

function hostView(s) {
  return { ...s, foAnswering: faceoffAnswering(s.faceoff), hostUrl: HOST_URL, serverNow: Date.now(), boards: clients.filter(c => c.role === 'board').length,
    canUndo: history.length > 0 };
}

// ---------- http ----------

const clients = [];

function send(c) {
  const data = c.role === 'board' ? boardView(state) : hostView(state);
  c.res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function broadcast() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
  clients.forEach(send);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const c = { res, role: url.searchParams.get('role') === 'board' ? 'board' : 'host' };
    clients.push(c);
    broadcast();
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.splice(clients.indexOf(c), 1); broadcast(); });
    return;
  }

  if (url.pathname === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { dispatch(JSON.parse(body)); broadcast(); res.writeHead(204).end(); }
      catch (e) { res.writeHead(400).end(String(e)); }
    });
    return;
  }

  if (url.pathname === '/api/questions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(QUESTIONS));
  }

  const file = { '/': 'board.html', '/board': 'board.html', '/host': 'host.html', '/qrcode.min.js': 'qrcode.min.js' }[url.pathname];
  if (!file) return res.writeHead(404).end('Not found');
  fs.readFile(path.join(PUBLIC, file), (err, buf) => {
    if (err) return res.writeHead(500).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  FAMILY FEUD is live!\n');
  console.log(`  TV board  (this laptop): http://localhost:${PORT}/board`);
  console.log(`  Host      (your phone):  ${HOST_URL}\n`);
  console.log('  Phone must be on the same Wi-Fi. Ctrl+C to stop.\n');
});
