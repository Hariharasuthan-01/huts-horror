// HUTS DEVELOPERS - multiplayer server (authoritative: rooms, maze, items, monster, lives, ammo, victory)
const { WebSocketServer } = require('ws');
const http = require('http'), fs = require('fs'), path = require('path');
const PUB = path.join(__dirname, '..', 'client'), MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const httpServer = http.createServer((req, res) => { // serves the game client too, so one command runs everything
  const f = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const p = path.normalize(path.join(PUB, f));
  if (!p.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' }); res.end(d); });
});
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(process.env.PORT || 8080);
const N = 31, CS = 3, rooms = {};
const rnd = s => () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const w2c = v => Math.floor(v / CS), c2w = c => (c + .5) * CS;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function gen(seed) {
  const r = rnd(seed), g = Array.from({ length: N }, () => Array(N).fill(1)), st = [[1, 1]];
  g[1][1] = 0;
  while (st.length) {
    const [x, y] = st[st.length - 1];
    const d = DIRS.map(([a, b]) => [a * 2, b * 2]).sort(() => r() - .5)
      .filter(([dx, dy]) => { const a = x + dx, b = y + dy; return a > 0 && b > 0 && a < N - 1 && b < N - 1 && g[b][a]; });
    if (!d.length) { st.pop(); continue; }
    const [dx, dy] = d[0]; g[y + dy / 2][x + dx / 2] = 0; g[y + dy][x + dx] = 0; st.push([x + dx, y + dy]);
  }
  for (let i = 0; i < 45; i++) { // extra loops = alternate routes
    const x = 1 + Math.floor(r() * (N - 2)), y = 1 + Math.floor(r() * (N - 2));
    if (g[y][x] && (x % 2) !== (y % 2)) g[y][x] = 0;
  }
  return g;
}
const solid = (g, x, z) => { const a = w2c(x), b = w2c(z); return a < 0 || b < 0 || a >= N || b >= N || g[b][a] === 1; };
function los(g, a, b) {
  const d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(d / .5);
  for (let i = 1; i < n; i++) if (solid(g, a.x + (b.x - a.x) * i / n, a.z + (b.z - a.z) * i / n)) return false;
  return true;
}
function bfsStep(g, from, to) {
  const k = (x, y) => y * N + x, prev = new Map([[k(...from), null]]), q = [from];
  while (q.length) {
    const [x, y] = q.shift(); if (x === to[0] && y === to[1]) break;
    for (const [dx, dy] of DIRS) { const a = x + dx, b = y + dy; if (a < 0 || b < 0 || a >= N || b >= N || g[b][a] || prev.has(k(a, b))) continue; prev.set(k(a, b), [x, y]); q.push([a, b]); }
  }
  let c = to; if (!prev.has(k(...c))) return from;
  for (;;) { const p = prev.get(k(...c)); if (!p || (p[0] === from[0] && p[1] === from[1])) return c; c = p; }
}
function rndN(g, c, prev) {
  let o = DIRS.map(([dx, dy]) => [c[0] + dx, c[1] + dy]).filter(([a, b]) => a >= 0 && b >= 0 && a < N && b < N && !g[b][a]);
  const f = o.filter(a => !(a[0] === prev[0] && a[1] === prev[1])); if (f.length) o = f;
  return o[Math.floor(Math.random() * o.length)];
}
function world() {
  const g = gen(Math.random() * 1e9 | 0), open = [];
  for (let y = 1; y < N; y += 2) for (let x = 1; x < N; x += 2) open.push([x, y]);
  const far = open.filter(([x, y]) => x + y > 14).sort(() => Math.random() - .5), pk = [];
  for (const c of far) { if (pk.every(p => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) > 8)) pk.push(c); if (pk.length === 4) break; }
  while (pk.length < 4) pk.push(far[pk.length]);
  const items = ['blue', 'red', 'gun', 'exit'].map((id, i) => ({ id, x: c2w(pk[i][0]), z: c2w(pk[i][1]), got: false }));
  const s = [N - 2, N - 2];
  return { g, items, keys: { blue: false, red: false }, mapUsed: false,
    m: { x: c2w(s[0]), z: c2w(s[1]), ry: 0, cell: s.slice(), tgt: s.slice(), st: 'patrol', t: 0, last: null } };
}
const newP = ws => ({ ws, conn: true, ready: false, skip: false, lives: 3, x: 1.5, z: 1.5, ry: 0, cr: 0, fl: 1, sp: 0, mv: 0, gun: 0, ammo: 0, res: 0, inv: 0, esc: false });
const send = (p, o) => p && p.conn && p.ws.readyState === 1 && p.ws.send(JSON.stringify(o));
const all = (r, o) => r.players.forEach(p => send(p, o));
const ev = (r, o) => all(r, { t: 'ev', ...o });
function code() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c; do { c = Array.from({ length: 6 }, () => A[Math.random() * A.length | 0]).join(''); } while (rooms[c]); return c; }
const lobbyInfo = r => ({ t: 'lobby', players: r.players.map(p => p && { conn: p.conn, ready: p.ready }) });
function startPayload(r, i) { return { t: 'start', idx: i, grid: r.w.g, lives: r.players[i].lives }; }
function startPlay(r) {
  r.phase = 'play';
  r.players.forEach((p, i) => { p.x = 1.5 + i * .8; p.z = 1.5; send(p, startPayload(r, i)); });
}

wss.on('connection', ws => {
  let room = null, me = -1;
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.t === 'create') {
      const c = code(); room = rooms[c] = { c, players: [newP(ws), null], phase: 'lobby', w: world() }; me = 0;
      send(room.players[0], { t: 'created', code: c, idx: 0 }); return;
    }
    if (d.t === 'join') {
      const r = rooms[String(d.code || '').toUpperCase().trim()];
      if (!r) return ws.send(JSON.stringify({ t: 'err', m: 'INVALID TEAM CODE' }));
      let i = !r.players[1] ? 1 : (!r.players[0].conn ? 0 : (!r.players[1].conn ? 1 : -1));
      if (i < 0) return ws.send(JSON.stringify({ t: 'err', m: 'TEAM FULL' }));
      const old = r.players[i], np = newP(ws);
      if (old) Object.assign(np, old, { ws, conn: true }); // reconnect: keep state
      r.players[i] = np; room = r; me = i;
      send(np, { t: 'joined', code: r.c, idx: i });
      all(r, lobbyInfo(r)); all(r, { t: 'rc', idx: i });
      if (r.phase === 'play') send(np, startPayload(r, i));
      else if (r.phase === 'mapphase') send(np, { t: 'phase', p: 'mapphase' });
      return;
    }
    if (!room) return;
    const r = room, p = r.players[me], w = r.w;
    if (d.t === 'ready' && r.phase === 'lobby') {
      p.ready = !p.ready; all(r, lobbyInfo(r));
      if (r.players[0] && r.players[1] && r.players.every(q => q.conn && q.ready)) {
        all(r, { t: 'phase', p: 'getready' });
        setTimeout(() => { if (r.phase === 'lobby') { r.phase = 'mapphase'; all(r, { t: 'phase', p: 'mapphase' }); } }, 2500);
      }
    } else if (d.t === 'map' && r.phase === 'mapphase' && !w.mapUsed) {
      w.mapUsed = true; r.phase = 'mapview';
      send(p, { t: 'map', grid: w.g, items: w.items.map(i => ({ id: i.id, x: w2c(i.x), z: w2c(i.z) })), secs: 10 });
      send(r.players[1 - me], { t: 'studying' });
      setTimeout(() => { all(r, { t: 'mapclosed' }); startPlay(r); }, 10500);
    } else if (d.t === 'nomap' && r.phase === 'mapphase') {
      p.skip = true; if (r.players.every(q => q && q.skip)) startPlay(r);
    } else if (r.phase !== 'play') return;
    else if (d.t === 'p') {
      if (p.lives < 1 || p.esc) return;
      const x = +d.x, z = +d.z; if (!isFinite(x) || !isFinite(z) || Math.hypot(x - p.x, z - p.z) > 3 || solid(w.g, x, z)) return send(p, { t: 'tp', x: p.x, z: p.z });
      Object.assign(p, { x, z, ry: +d.ry || 0, cr: d.cr ? 1 : 0, fl: d.fl ? 1 : 0, sp: d.sp ? 1 : 0, mv: d.mv ? 1 : 0 });
    } else if (d.t === 'use' && p.lives > 0 && !p.esc) {
      const it = w.items.find(i => !i.got && Math.hypot(i.x - p.x, i.z - p.z) < 2.6); if (!it) return;
      if ((it.id === 'blue' && me !== 0) || (it.id === 'red' && me !== 1)) return;
      if (it.id === 'blue' || it.id === 'red') {
        it.got = true; w.keys[it.id] = true; ev(r, { m: it.id.toUpperCase() + ' KEY FOUND', s: 'key' });
        if (w.keys.blue && w.keys.red) ev(r, { m: 'BOTH KEYS FOUND - EXIT UNLOCKED', s: 'key' });
      } else if (it.id === 'gun') { it.got = true; p.gun = 1; p.ammo = 6; p.res = 6; send(p, { t: 'ev', m: 'GUN ACQUIRED', s: 'key' }); }
      else if (it.id === 'exit') {
        if (!(w.keys.blue && w.keys.red)) return send(p, { t: 'ev', m: 'EXIT LOCKED - BOTH KEYS NEEDED' });
        p.esc = true; ev(r, { m: 'PLAYER ' + (me + 1) + ' REACHED THE EXIT', s: 'door' });
        if (r.players.every(q => q && q.esc)) end(r, true);
      }
    } else if (d.t === 'shoot' && p.gun && p.ammo > 0 && p.lives > 0) {
      p.ammo--; ev(r, { s: 'shot', by: me });
      const m = w.m, dx = m.x - p.x, dz = m.z - p.z, dist = Math.hypot(dx, dz);
      if (dist < 20 && (dx * -Math.sin(p.ry) + dz * -Math.cos(p.ry)) / dist > .96 && los(w.g, p, m)) { m.st = 'stun'; m.t = 6; m.last = null; ev(r, { s: 'hit', m: 'MONSTER STUNNED' }); }
    } else if (d.t === 'reload' && p.gun && p.res > 0 && p.ammo < 6) {
      const n = Math.min(6 - p.ammo, p.res); p.ammo += n; p.res -= n; send(p, { t: 'ev', s: 'reload' });
    } else if (d.t === 'give') {
      const o = r.players[1 - me];
      if (o && p.lives > 1 && o.lives === 0) { p.lives--; o.lives = 1; o.x = p.x; o.z = p.z; send(o, { t: 'tp', x: p.x, z: p.z }); ev(r, { m: 'PLAYER ' + (me + 1) + ' GAVE 1 LIFE', s: 'key' }); }
    } else if (d.t === 'again') {
      /* handled via end state */
    }
  });
  ws.on('close', () => {
    if (!room) return; const p = room.players[me]; if (!p || p.ws !== ws) return;
    p.conn = false; all(room, { t: 'dc', idx: me }); all(room, lobbyInfo(room));
    setTimeout(() => { if (room.players.every(q => !q || !q.conn)) delete rooms[room.c]; }, 120000);
  });
});

function end(r, win) {
  if (r.phase === 'over') return; r.phase = 'over'; all(r, { t: 'end', win });
  setTimeout(() => { // reset room so same team can play again
    r.w = world(); r.phase = 'lobby';
    r.players = r.players.map(p => p && Object.assign(newP(p.ws), { conn: p.conn }));
    all(r, { t: 'reset' }); all(r, lobbyInfo(r));
  }, 6000);
}

function hit(r, p, i) {
  p.lives--; p.inv = 3; p.x = 1.5 + i * .8; p.z = 1.5;
  const m = r.w.m; m.st = 'recover'; m.t = 4; m.last = null;
  ev(r, { s: 'hit', hurt: i, m: 'PLAYER ' + (i + 1) + ' CAUGHT' }); send(p, { t: 'tp', x: p.x, z: p.z });
  if (r.players.every(q => q && q.lives < 1)) end(r, false);
}
function tickMonster(r, dt) {
  const m = r.w.m, g = r.w.g, ps = r.players.map((p, i) => [p, i]).filter(([p]) => p && p.conn && p.lives > 0 && !p.esc);
  if (m.st === 'stun' || m.st === 'recover') { m.t -= dt; if (m.t <= 0) { m.st = 'search'; m.t = 6; } return; }
  let seenP = null, bd = 1e9;
  for (const [p] of ps) {
    const d = Math.hypot(p.x - m.x, p.z - m.z), noise = p.sp && p.mv ? 15 : p.cr ? 2.5 : p.mv ? 6 : 2;
    const seen = d < (p.fl ? 12 : 7) && los(g, m, p);
    if ((seen || (d < noise)) && d < bd) { bd = d; seenP = p; }
  }
  if (seenP) { if (m.st !== 'chase') ev(r, { s: 'chase' }); m.st = 'chase'; m.last = [w2c(seenP.x), w2c(seenP.z)]; m.t = 5; }
  else if (m.st === 'chase') { m.t -= dt; if (m.t <= 0) { m.st = 'search'; m.t = 7; } }
  else if (m.st === 'search') { m.t -= dt; if (m.t <= 0) { m.st = 'patrol'; m.last = null; } }
  if (m.st === 'patrol' && Math.random() < .004) { m.st = 'idle'; m.t = 2 + Math.random() * 2; }
  if (m.st === 'idle') { m.t -= dt; if (m.t <= 0) m.st = 'patrol'; return; }
  const sp = m.st === 'chase' ? 3.7 : m.st === 'search' ? 2.3 : 1.7, tx = c2w(m.tgt[0]), tz = c2w(m.tgt[1]);
  const dx = tx - m.x, dz = tz - m.z, d = Math.hypot(dx, dz), s = sp * dt;
  if (d <= s) {
    m.x = tx; m.z = tz; const prev = m.cell; m.cell = m.tgt; let nx;
    if (m.last && m.st !== 'patrol') { nx = bfsStep(g, m.cell, m.last); if (nx[0] === m.cell[0] && nx[1] === m.cell[1]) { m.last = null; nx = rndN(g, m.cell, prev); } }
    else nx = rndN(g, m.cell, prev);
    m.tgt = nx;
  } else { m.x += dx / d * s; m.z += dz / d * s; m.ry = Math.atan2(dx, dz); }
  for (const [p, i] of ps) if (p.inv <= 0 && Math.hypot(p.x - m.x, p.z - m.z) < 1.3) { hit(r, p, i); break; }
}
setInterval(() => {
  for (const r of Object.values(rooms)) {
    if (r.phase !== 'play') continue;
    r.players.forEach(p => { if (p && p.inv > 0) p.inv -= .1; });
    if (r.players.every(p => p && p.conn)) tickMonster(r, .1); // monster pauses while a player is away
    const m = r.w.m, pl = r.players.map(p => ({ x: p.x, z: p.z, ry: p.ry, cr: p.cr, fl: p.fl, l: p.lives, e: p.esc ? 1 : 0, c: p.conn ? 1 : 0 }));
    r.players.forEach((p, i) => send(p, {
      t: 's', pl, me: { g: p.gun, a: p.ammo, r: p.res, inv: p.inv > 0 ? 1 : 0 },
      m: { x: m.x, z: m.z, ry: m.ry, st: m.st }, k: [r.w.keys.blue, r.w.keys.red],
      it: r.w.items.filter(it => !it.got && Math.hypot(it.x - p.x, it.z - p.z) < 14).map(it => [it.id, it.x, it.z])
    }));
  }
}, 100);
console.log('HUTS server on', process.env.PORT || 8080);
