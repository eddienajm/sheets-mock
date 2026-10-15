// Checks the game against PRINCIPLES.md: each fixture is a worked example
// from the 12 October mock and the notes made on it.
//   node test/principles.test.js

const assert = require('assert');
const E = require('../js/engine.js');
const Sc = require('../js/scenario.js');
const { Game } = require('../js/game.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: got ${a}, want ${b}`);
const has = (texts, re, msg) => assert.ok(texts.some(t => re.test(t)), `${msg}: no step matches ${re}\n     ${texts.join('\n     ')}`);

// The night's opening board, with one question on it.
function oneBeat(beat, pre) {
  const s = Sc.replay1012();
  if (pre) Sc.applyOps(s.board, pre);
  return { ...s, beats: [beat] };
}
// A seed where the market trades the given side of your market.
function playUntilHit(session, bid, ask, side) {
  for (let seed = 1; seed < 500; seed++) {
    const g = new Game(session, { seed });
    g.submitMarket(bid, ask);
    if (g.hit && g.hit.side === side) return g;
  }
  throw new Error('no seed trades the ' + side);
}
const texts = j => j.steps.map(s => s.text);
const whys = j => j.steps.map(s => s.why || '');

check('P1 theo from the board: call 8/10, stock 100/101 → put 8.5', () => {
  const g = new Game(oneBeat({ type: 'make', target: 'P100', size: 25 }), { seed: 1 });
  near(E.theo(g.model, 'C100'), 9, 'call');
  near(E.theo(g.model, 'P100'), 8.5, 'put');
});

check('P3/A2/A3 bought 25 100 put at 7: sold the future at 101, no arb, buy 13, call break-even 8, offer 9 for +1', () => {
  const g = playUntilHit(oneBeat({ type: 'make', target: 'P100', size: 25 }), 7, 10, 'bid');
  const lv = g.levels(g.fills[0]);
  near(lv.be, 8, 'call break-even');
  g.trade('S', 'buy', 13);
  const j = g.finish();
  const t = texts(j);
  has(t, /Theo 8\.5: \+1\.5 a lot/, 'edge vs theo');
  has(t, /sold the future at 100 \+ 8 − 7 = 101\. Stock offered at 101: no arb/, 'synthetic future');
  has(t, /buy 13 stock to be delta flat/, 'hedge');
  has(t, /offer the 100 call above 8, say 9 \(\+1 a lot/, 'lean');
  assert.ok(!t.some(x => /sell it back|buy it back/i.test(x)), 'no "sell it back on the board" step');
  // The next question is the partner, with the room's market pulled.
  g.next();
  assert.strictEqual(g.beat.target, 'C100');
  assert.ok(!g.board.quotes.C100, 'room call market pulled');
});

check('A3 follow-up: offering the call at 8.5 against the 7 put beats break-even 8', () => {
  const g = playUntilHit(oneBeat({ type: 'make', target: 'P100', size: 25 }), 7, 10, 'bid');
  g.trade('S', 'buy', 13); g.finish(); g.next();
  g.submitMarket(6, 8.5);
  if (g.phase !== 'judge') { if (g.hit && g.hit.side === 'ask') g.trade('S', 'buy', 12); g.finish(); }
  const v = g.judged.verdict.map(x => x[1]);
  assert.ok(v.some(x => /8\.5 offer beats break-even 8: \+0\.5 a lot/.test(x)), v.join(' | '));
  // Your market is the market in the call now, struck or not.
  const top = g.top('C100');
  assert.ok(top.ask && top.ask.mine && top.ask.price === 8.5, 'your 8.5 offer still shows: ' + JSON.stringify(top));
});

check('P2/A3/M4 sold 25 120 put at 24.5: call at 4.5, crossing 4 is +0.5, bidding 3.5 is +1', () => {
  const g = playUntilHit(oneBeat({ type: 'make', target: 'P120', size: 25 }), 21.5, 24.5, 'ask');
  const lv = g.levels(g.fills[0]);
  near(lv.be, 4.5, 'call break-even');
  near(lv.edge(4), 0.5, 'crossing the 4 offer');
  near(lv.edge(3.5), 1, 'bid 3.5 filled');
  g.trade('S', 'sell', 23);
  const p = g.post('C120', 'buy', 3.5, 25);
  assert.ok(p.posted, 'a 3.5 bid inside 3/4 rests: ' + JSON.stringify(p));
  const j = g.finish();
  has(texts(j), /bought the future at 120 \+ 4 − 24\.5 = 99\.5\. Stock bid at 100: \+0\.5 a lot/, 'synthetic');
  has(texts(j), /bid the 120 call at 3\.5: \+1 a lot if it trades, against \+0\.5 crossing now/, 'lean beats crossing');
  has(whys(j), /selling the 120 call at 24\.5 \+ 100 − 120 = 4\.5/, 'put as call plus stock');
  assert.ok(j.verdict.some(v => v[0] === 'good' && /3\.5 bid in the 120 call: \+1 a lot/.test(v[1])), j.verdict.map(v => v[1]).join(' | '));
  // No follow-up: you are already leaning in the partner.
  g.next();
  assert.ok(!(g.beat && g.beat.followUp), 'no follow-up after leaning');
});

check('A3 a lean that fills completes the pair: long future at 99 against stock sold at 100', () => {
  const g = playUntilHit(oneBeat({ type: 'make', target: 'P120', size: 25 }), 21.5, 24.5, 'ask');
  g.trade('S', 'sell', 23);
  g.post('C120', 'buy', 3.5, 25);
  g.finish();
  // The market sells you the call on your bid.
  g.next();
  g.n++; g.fills = []; g.posts = []; g.actions = [];
  const tr = g.hitMine('C120', 'bid', 25);
  g.startBeat({ type: 'react', target: 'C120', hit: g.hit, hitTrade: tr });
  const j0 = g.fillSteps(tr, g.afterHit.board);
  const t = j0.steps.map(s => s.text);
  has(t, /With the 120 put you sold at 24\.5, that's a long future at 120 \+ 3\.5 − 24\.5 = 99\. Your stock sold at 100: \+1 a lot/, 'pair');
  has(t, /Sell 2 more stock to hedge to delta flat/, 'the rest of the hedge');
  g.trade('S', 'sell', 2);
  const j = g.finish();
  assert.ok(j.verdict.some(v => /Book flat/.test(v[1])), j.verdict.map(v => v[1]).join(' | '));
});

check('P4 straddle at stock 102/103: theo 9 + 6.5 = 15.5; board buys it back at 18', () => {
  const s = oneBeat({ type: 'opp', size: 25, pre: [{ op: 'set', id: 'V100', bid: 18, ask: null, conductor: true }], askAfter: 'V100' },
    [{ op: 'stock', bid: 102, ask: 103 }]);
  const g = new Game(s, { seed: 1 });
  near(E.theo(g.model, 'C100'), 9, 'call');
  near(E.theo(g.model, 'P100'), 6.5, 'put');
  near(E.theo(g.model, 'V100'), 15.5, 'straddle');
  near(E.implied(g.board, 'V100').ask, 18, 'board straddle offer');
  // Pass on the order, then the market question comes.
  g.wrapUp();
  assert.strictEqual(g.phase, 'ask');
  assert.strictEqual(g.question(), "What's your market in the 100 straddle?");
  g.submitMarket(15, 17);
  if (g.phase !== 'judge') g.finish();
  has(whys(g.judged), /call plus a put: 9 \+ 6\.5 = 15\.5/, 'straddle = call + put');
  has(texts(g.judged), /Nothing in it/, '18 has nothing in it');
});

check('P6 box: 110/120 call spread 2/3 makes the put spread 7/8', () => {
  const s = oneBeat({ type: 'make', target: 'PS110/120', size: 25 }, [{ op: 'set', id: 'CS110/120', bid: 2, ask: 3 }]);
  const g = new Game(s, { seed: 1 });
  const imp = E.implied(g.board, 'PS110/120');
  near(imp.bid, 7, 'put spread bid'); near(imp.ask, 8, 'put spread offer');
});

check('P7 fly: never below 0, call fly = put fly', () => {
  for (let seed = 1; seed < 60; seed++) {
    const g = new Game(Sc.genSession(seed, { fly: true }), { seed });
    const k = g.board.strikes;
    for (let i = 0; i < 3; i++) assert.ok(E.theo(g.model, `FLY${k[i]}/${k[i + 1]}/${k[i + 2]}`) >= -1e-9, 'fly ≥ 0');
  }
  const v = E.vec('FLY90/100/110');
  near(v.c, 0, 'no cash in a fly');
});

check('P8 a stock move moves each option by its delta', () => {
  const m = new Game(oneBeat({ type: 'make', target: 'P100', size: 25 }), { seed: 1 }).model;
  const m2 = E.shiftModel(m, m.S + 1);
  for (const k of m.strikes) {
    near(E.theo(m2, 'C' + k) - E.theo(m, 'C' + k), m.cd[k], 'call ' + k);
    near(E.theo(m2, 'P' + k) - E.theo(m, 'P' + k), m.cd[k] - 1, 'put ' + k);
  }
});

check('M3 stock 1 → 3 wide: 50 delta needs 0.5 a side, 95 delta about 1', () => {
  const s = oneBeat({ type: 'make', targets: ['P100', 'C80'], size: 25, noTrade: true, widen: 1, restoreStock: true });
  const g = new Game(s, { seed: 1 });
  assert.strictEqual(g.board.quotes.S.ask - g.board.quotes.S.bid, 3);
  const std = g.beat.std;
  g.submitMarket(std.P100.bid - 0.5, std.P100.ask + 0.5);
  g.submitMarket(std.C80.bid - 1, std.C80.ask + 1);
  const v = g.judged.verdict.map(x => x[0] + ' ' + x[1]);
  assert.ok(v.every(x => x.startsWith('good')), v.join(' | '));
  has(texts(g.judged), /80 call: 95 delta, so about 0\.95 more a side/, '95 delta');
  has(texts(g.judged), /100 put: 50 delta, so about 0\.5 more a side/, '50 delta');
  // The same widening on both is wrong.
  const g2 = new Game(s, { seed: 1 });
  g2.submitMarket(std.P100.bid - 0.5, std.P100.ask + 0.5);
  g2.submitMarket(std.C80.bid - 0.5, std.C80.ask + 0.5);
  assert.ok(g2.judged.verdict.some(x => x[0] === 'bad' && /80 call/.test(x[1])), g2.judged.verdict.map(x => x[1]).join(' | '));
});

check('S1 stale board: rank by edge × size net of the hedge', () => {
  const s = oneBeat({ type: 'pick', move: 2 });
  const g = new Game(s, { seed: 1 });
  const c = g.candidates();
  assert.ok(c.length > 3);
  for (let i = 1; i < c.length; i++) assert.ok(c[i - 1].v >= c[i].v - 1e-9, 'sorted by value');
  const b = c[0];
  near(b.e, (b.side === 'buy' ? b.T - b.price : b.price - b.T) - b.d * 0.5, 'edge net of hedge');
  // Calls are cheap after a rally: the best trade buys something.
  assert.strictEqual(b.side, 'buy');
  g.trade(b.id, 'buy', b.size);
  const n = Math.round(-E.positionDelta(g.model, g.beatTrades));
  if (n) g.trade('S', n > 0 ? 'buy' : 'sell', Math.abs(n));
  const j = g.finish();
  assert.ok(j.verdict[0][0] === 'good', j.verdict.map(v => v[1]).join(' | '));
});

check('G3 your market replaces the room\'s; a traded-out side stays struck at 0', () => {
  const g = playUntilHit(oneBeat({ type: 'make', target: 'P100', size: 25 }), 7, 10, 'bid');
  const top = g.top('P100');
  assert.ok(top.bid.mine && top.bid.gone && top.bid.price === 7, JSON.stringify(top));
});

check('G4 language: no "lock", "square", "board buys it from you" anywhere', () => {
  const bad = /\block|\bsquare|board buys it/i;
  for (let seed = 1; seed < 40; seed++) {
    const cfg = { pcp: 1, straddle: 1, spreads: 1, box: 1, fly: 1, width: 1, move: 1 };
    const g = new Game(seed % 2 ? Sc.genSession(seed, cfg) : Sc.replay1012(), { seed });
    for (let guard = 0; guard < 60 && !g.done; guard++) {
      if (g.phase === 'ask') {
        const T = E.theo(g.model, g.beat.target);
        const r = g.submitMarket(Math.max(0, E.floorT(T - 1)), E.ceilT(T + 1));
        if (r.more) continue;
      }
      if (g.phase === 'pick') { const c = g.candidates()[0]; if (c) g.trade(c.id, c.side, c.size); }
      if (g.phase === 'hedge' || g.phase === 'opp' || g.phase === 'pick') { if (g.wrapUp()) {} }
      if (g.phase === 'judge') {
        const all = [...g.judged.steps.map(s => s.text + ' ' + (s.why || '')), ...g.judged.verdict.map(v => v[1])];
        for (const t of all) assert.ok(!bad.test(t), 'seed ' + seed + ': ' + t);
        g.next();
      }
    }
  }
});

check('V1 option-equivalent vega: top strike 1, wings 0.1, 0.05 steps; night\'s board 0.1 / 0.65 / 1 / 0.5 / 0.1', () => {
  const r = Sc.replay1012().board;
  assert.deepStrictEqual(E.vegaTable(r.strikes, r.cd), { 80: 0.1, 90: 0.65, 100: 1, 110: 0.5, 120: 0.1 });
  for (let seed = 1; seed < 300; seed++) {
    const b = Sc.genSession(seed, { pcp: true }).board, t = E.vegaTable(b.strikes, b.cd), vs = b.strikes.map(k => t[k]);
    assert.strictEqual(Math.max(...vs), 1, 'top is 1');
    for (const v of vs) near(Math.round(v * 20), v * 20, '0.05 steps');
    const ends = [vs[0], vs[vs.length - 1]].filter(v => v !== 1);
    for (const v of ends) near(v, 0.1, 'wing');
  }
  const m = { strikes: [100, 110], cd: { 100: 0.5, 110: 0.2 } };
  near(E.vega(m, 'BOX100/110'), 0, 'box');
  near(E.vega(m, 'V100'), 2, 'straddle');
  near(E.vega(m, 'P100'), E.vega(m, 'C100'), 'call = put');
});

check('F1 market buys 50 vega: ATM call and put up 1, wings by their vega, no arb, your quotes stay', () => {
  for (const seed of [3, 8, 21, 40]) {
    const sess = Sc.genSession(seed, { pcp: true, flow: true });
    sess.flowDir = 1;
    const g = new Game(sess, { seed });
    const ks = g.board.strikes, cd = g.board.cd;
    const atm = ks.find(k => E.vegaTable(ks, cd)[k] === 1);
    const before = {}; for (const k of ks) before[k] = [E.theo(g.model, 'C' + k), E.theo(g.model, 'P' + k)];
    const box = E.theo(g.model, `BOX${ks[1]}/${ks[2]}`);
    g.board.mine['C' + ks[4]] = { bid: 1, ask: 2, bidSize: 10, askSize: 10 };
    g.flow.vega = 50;
    g.next();
    if (!g.flowNews) throw new Error('no re-mark news');
    for (const k of ks) {
      const dc = E.theo(g.model, 'C' + k) - before[k][0], dp = E.theo(g.model, 'P' + k) - before[k][1];
      near(dc, dp, `parity at ${k}`);
      // By its vega, rounded to the tick; a tick less where a fly needed trimming.
      const want = E.round(E.vegaTable(ks, cd)[k]);
      assert.ok(Math.abs(dc - want) <= E.TICK + 1e-9, `strike ${k} moved ${dc}, its vega says ${want}`);
    }
    near(E.theo(g.model, 'C' + atm) - before[atm][0], 1, 'ATM up 1');
    near(E.theo(g.model, `BOX${ks[1]}/${ks[2]}`), box, 'box unchanged');
    assert.ok(E.bestArb(Sc.roomBoard(g.board)).value < 1e-6, 'no arb on the room board');
    assert.deepStrictEqual([g.board.mine['C' + ks[4]].bid, g.board.mine['C' + ks[4]].ask], [1, 2], 'your quote stays');
  }
});

check('F1/G8 flow orders go the session\'s way about 80% of the time', () => {
  let withFlow = 0, all = 0;
  for (let seed = 1; seed < 400; seed++) {
    const sess = Sc.genSession(seed, { pcp: true, straddle: true, spreads: true, flow: true });
    const m = { strikes: sess.board.strikes, cd: sess.board.cd };
    for (const b of sess.beats) {
      if (!b.gen) continue;
      const v = E.vega(m, b.gen.id);
      if (Math.abs(v) <= 0.05) continue;
      all++;
      if (v * sess.flowDir * (b.gen.side === 'bid' ? 1 : -1) > 0) withFlow++;
    }
  }
  const share = withFlow / all;
  assert.ok(share > 0.72 && share < 0.88, `share with the flow ${share.toFixed(2)} of ${all}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
