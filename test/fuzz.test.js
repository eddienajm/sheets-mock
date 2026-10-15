// Plays whole sessions as a sensible trader, every component mix, and checks
// they run to the end, stay short, and every explanation tag lands on a cell.
//   node test/fuzz.test.js [sessions]

const E = require('../js/engine.js');
const Sc = require('../js/scenario.js');
const { Game, topOf } = require('../js/game.js');

const N = +(process.argv[2] || 200);
const comps = Sc.COMPONENTS;
let errors = 0;
const beats = [], types = {}, long = [], flows = [];

function play(g) {
  for (let guard = 0; guard < 80 && !g.done; guard++) {
    const b = g.beat;
    if (g.phase === 'ask') {
      const T = E.theo(g.model, b.target);
      const imp = E.implied(g.board, b.target);
      let bid = E.floorT(Math.min(T - 1, imp.bid != null ? imp.bid - 0.5 : T - 1));
      let ask = E.ceilT(Math.max(T + 1, imp.ask != null ? imp.ask + 0.5 : T + 1));
      if (b.followUp) { if (b.followUp.exitSide === 'sell') ask = Math.max(ask, E.ceilT(b.followUp.be + 0.5)); else bid = Math.min(bid, E.floorT(b.followUp.be - 0.5)); }
      const r = g.submitMarket(Math.max(0, bid), ask);
      if (r.error) throw new Error(`${r.error} ${b.target} T=${T} imp=${imp.bid}/${imp.ask} fu=${b.followUp && b.followUp.be}`);
      continue;
    }
    if (g.phase === 'pick') {
      const c = g.candidates()[0];
      if (c && c.v > 0) g.trade(c.id, c.side, c.size); else { g.finish(); continue; }
    }
    if (g.phase === 'opp') {
      const a = E.bestArb(g.board);
      for (const r of a.route) {
        const q = Math.floor(r.qty);
        if (q > 0) g.trade(r.id, r.side, q);
      }
    }
    if (g.phase === 'hedge' || g.phase === 'opp') {
      // Hedge to delta flat, then sometimes lean in the partner.
      const d = Math.round(-g.status().delta);
      if (Math.abs(d) >= 1) {
        const r = g.trade('S', d > 0 ? 'buy' : 'sell', Math.abs(d));
        if (r.error) throw new Error('hedge: ' + r.error);
      }
      const f = g.fills[0];
      if (f && /^[CP]\d/.test(f.id) && g.R.chance(0.5)) {
        const lv = g.levels(f);
        const px = lv.partnerSide === 'sell' ? E.ceilT(lv.be + 0.5) : E.floorT(lv.be - 0.5);
        if (px > 0) {
          const p = g.post(lv.partner, lv.partnerSide, px, f.qty);
          if (p.cross) g.trade(lv.partner, lv.partnerSide, Math.min(f.qty, topOf(g.board.quotes, {}, lv.partner)[lv.partnerSide === 'sell' ? 'bid' : 'ask'].size));
        }
      }
      g.wrapUp();
      continue;
    }
    if (g.phase === 'judge') {
      const j = g.judged, q = g.explainQuotes();
      // Invariants: the room never leaves an arb on its own board, and no
      // fly is worth less than nothing (P7).
      const room = Sc.roomBoard({ ...g.board, quotes: q });
      const arb = E.bestArb(room).value;
      if (arb > 1e-6) throw new Error(`room board has an arb of ${arb}`);
      const ks = g.board.strikes;
      for (let x = 1; x < ks.length - 1; x++) {
        const f = E.theo(g.model, `FLY${ks[x - 1]}/${ks[x]}/${ks[x + 1]}`);
        if (f < -1e-6) throw new Error(`fly ${ks[x]} theo ${f} beat ${g.beat.type} calls ${ks.map(k => E.callTheo(g.model, k).toFixed(2)).join(' ')} S ${g.model.S} flowSteps ${g.flow && g.flow.steps}`);
      }
      for (const s of j.steps) {
        if (!s.text || /NaN|undefined|null/.test(s.text + (s.why || ''))) throw new Error('bad text: ' + s.text + ' / ' + s.why);
        for (const m of s.marks) {
          const t = topOf(q, g.board.mine, m.id);
          const ok = m.id === 'S' || (!m.side && /^[CP]\d/.test(m.id)) || (m.side ? t[m.side] : (t.bid || t.ask)) || (g.beat && g.beat.target === m.id);
          if (!ok) throw new Error(`mark on missing cell ${m.id} ${m.side} in "${s.text}"`);
        }
      }
      types[g.beat.type + (g.beat.followUp ? '+fu' : '')] = (types[g.beat.type + (g.beat.followUp ? '+fu' : '')] || 0) + 1;
      g.next();
      continue;
    }
  }
  if (!g.done) throw new Error('did not finish, stuck in ' + g.phase);
}

for (let i = 0; i < N; i++) {
  const seed = 1000 + i;
  const cfg = {};
  const CR = Sc.rng(seed * 7 + 1);
  for (const c of comps) cfg[c] = i % 7 === 0 ? c === 'pcp' : CR.chance(0.5);
  cfg.flow = CR.chance(0.4);
  try {
    const g = new Game(i % 10 === 9 ? Sc.replay1012() : Sc.genSession(seed, cfg), { seed });
    const seq = [], next = g.next.bind(g);
    g.next = () => { seq.push(g.beat.type + (g.beat.followUp ? '+fu' : '')); return next(); };
    play(g);
    beats.push(g.n - 1);
    if (i % 10 !== 9) long.push([g.n - 1, seed, seq.join(' ')]);
    if (g.flow) flows.push(g.flow.steps);
  } catch (e) {
    errors++;
    if (errors < 6) console.log('seed', seed, JSON.stringify(cfg), e.stack.split('\n').slice(0, 3).join(' | '));
  }
}
const gen = beats.filter((_, i) => i % 10 !== 9);
console.log('sessions', N, 'errors', errors);
console.log('steps per 5-question session: max', Math.max(...gen), 'mean', (gen.reduce((a, b) => a + b, 0) / gen.length).toFixed(1));
console.log('judged beats by type', types);
if (flows.length) console.log('flow sessions', flows.length, 're-marks per session', JSON.stringify(flows.reduce((h, x) => (h[x] = (h[x] || 0) + 1, h), {})));
for (const l of long.sort((a, b) => b[0] - a[0]).slice(0, 3)) console.log('longest', l.join('  '));
process.exit(errors ? 1 : 0);
