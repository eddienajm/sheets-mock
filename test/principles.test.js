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
  has(t, /theo 8\.5: \+1\.5 a lot/, 'edge vs theo');
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
  has(t, /With the 120 put you sold at 24\.5, that's a long future at 120 \+ 3\.5 − 24\.5 = 99 against stock sold at 100: \+1 a lot/, 'pair');
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
  has(whys(g.judged), /Call plus put: 9 \+ 6\.5 = 15\.5/, 'straddle = call + put');
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
    const sess = Sc.genSession(seed, { pcp: true, flow: true, scale: 0, chain: false });
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

check('M5 choice stock: the 90 call 10.6/10.72 with stock 100 choice lays the 90 put off at 0.60/0.72 (20 Oct)', () => {
  const board = { strikes: [90, 95, 100, 105, 110], spacing: 5, notes: [], choice: true,
    quotes: { S: { bid: 100, ask: 100, bidSize: 5000, askSize: 5000 }, C90: { bid: 10.6, ask: 10.72, bidSize: 500, askSize: 500 } } };
  const imp = E.implied(board, 'P90');
  near(imp.bid, 0.6, 'put bid'); near(imp.ask, 0.72, 'put offer');
  // Buying and selling the stock at one price is no arb, and no route trades it both ways.
  assert.strictEqual(E.bestArb(board).value, 0);
  for (const side of ['askRoute', 'bidRoute']) {
    const ids = imp[side].map(r => r.id + r.side);
    assert.ok(!(ids.includes('Sbuy') && ids.includes('Ssell')), side + ' trades the stock both ways');
  }
});

check('M5 choice levels deal a stock with no spread, and never charge for the hedge', () => {
  const sess = Sc.genSession(1234, { pcp: true, choice: true });
  const S = sess.board.quotes.S;
  assert.strictEqual(S.bid, S.ask);
  const g = new Game(sess, { seed: 1 });
  const f = { id: 'C' + sess.board.strikes[2], side: 'buy', qty: 10, price: 1 };
  assert.ok(!/Crossing the stock|costs/.test(g.whyHedge(f)), 'E3: no hedge cost on a choice stock: ' + g.whyHedge(f));
  assert.ok(sess.beats.every(b => !b.widen && b.type !== 'pick'), 'no widening or stale-board beats');
});

// ---------- 20 October: choice stock, 0.01, 500 lots ----------

const Q5 = (bid, ask, size = 500) => ({ bid, ask, bidSize: size, askSize: size });
function board20(quotes) {
  E.setTick(0.01);
  return { strikes: [90, 95, 100, 105, 110], spacing: 5, notes: [], choice: true, tick: 0.01, unit: 0.05, lotScale: 20,
    quotes: { S: Q5(100, 100, 20000), ...quotes } };
}
// The night's replay, played to agenda question k with the given markets.
function replayTo(k, markets = {}) {
  const g = new Game(Sc.replay1020(), { seed: 1 });
  for (let guard = 0; guard < 80 && !(g.ai === k && g.phase === (g.beat.type === 'opp' ? 'opp' : 'ask') && !g.beat.followUp); guard++) {
    if (g.phase === 'ask') { const m = !g.beat.followUp && markets[g.ai]; const T = E.theo(g.model, g.beat.target); g.submitMarket(...(m || [E.floorT(T - 0.3), E.ceilT(T + 0.3)])); continue; }
    if (g.phase === 'hedge' || g.phase === 'opp') { g.wrapUp(); continue; }
    if (g.phase === 'judge') { g.next(); continue; }
  }
  return g;
}

check('P9 put fly 90/95/100 from mids: theo 1.1675, legs lay it off 0.905 / 1.43 (the body counts twice)', () => {
  const b = board20({ P90: Q5(0.7, 0.75), P95: Q5(1.7, 1.91), P100: Q5(4.025, 4.08) });
  const imp = E.implied(b, 'FLY90/95/100');
  near(imp.bid, 0.905, 'fly bid'); near(imp.ask, 1.43, 'fly offer');
  near((0.725 - 2 * 1.805 + 4.0525), 1.1675, 'theo from mids');
});

check('P10 straddle 8.05 / 8.15 at K = S on a choice stock makes the 100 put 4.025 / 4.075', () => {
  const imp = E.implied(board20({ V100: Q5(8.05, 8.15) }), 'P100');
  near(imp.bid, 4.025, 'put bid'); near(imp.ask, 4.075, 'put offer');
});

check('P11/A7 105/110 put spread worth 3.91; bought at 3.80, the board lays it off at 3.79: hold it', () => {
  const b = board20({ P105: Q5(6.9, 7.06), C110: Q5(0.85, 0.93) });
  near(E.theo(Sc.deriveModel(Sc.replay1020().board, null), 'PS105/110'), 3.91, 'theo on the starting board');
  near(E.implied(b, 'PS105/110').bid, 3.79, 'lay-off bid');
  const g = replayTo(10);
  assert.strictEqual(g.beat.target, 'PS105/110');
  g.submitMarket(3.8, 3.83);
  const t = texts(g.finish());
  has(t, /You bought 500 105\/110 put spread at 3\.8, theo 3\.895/, 'the conductor sells the 3.80 bid');
  has(t, /Selling it back on the board at 3\.79 loses 0\.01 a lot: hold it/, 'lay-off loses a cent: hold');
  has(t, /110 put 10\.85 \/ 10\.9 from the call/, 'the 110 put from the call, as the notes priced it');
  });

check('P12 sold the 95/100 call spread at 2.80: sell the 95/100 put spread at 2.30 too, +0.10 through the box', () => {
  const b = board20({ 'PS95/100': Q5(2.3, 2.39) });
  const lay = E.bestLayoff(b, E.position([{ id: 'CS95/100', side: 'sell', qty: 500, price: 2.8 }]));
  near(lay.locked, 50, 'locked');
  assert.ok(lay.route.some(r => r.id === 'PS95/100' && r.side === 'sell'), 'sells the put spread');
});

check('A5: bought the 95 put at 1.79, sell the 95/90 put spread 1.10 and the 90 put 0.70: +0.01 a lot', () => {
  const b = board20({ 'PS90/95': Q5(1.1, 1.2), P90: { bid: 0.7, ask: null, bidSize: 500, askSize: 0 } });
  near(E.bestLayoff(b, E.position([{ id: 'P95', side: 'buy', qty: 500, price: 1.79 }])).locked, 5, 'locked');
});

check('A5: sold the 95/90 put spread at 1.20, buy it back with the 95 put 1.85 and the 90 put 0.70 for 1.15: +0.05 a lot', () => {
  const b = board20({ P95: { bid: null, ask: 1.85, bidSize: 0, askSize: 500 }, P90: { bid: 0.7, ask: null, bidSize: 500, askSize: 0 } });
  near(E.bestLayoff(b, E.position([{ id: 'PS90/95', side: 'sell', qty: 500, price: 1.2 }])).locked, 25, 'locked');
});

check('A5: fly bid 1.25, lift the 100/95 put spread 2.39 and hit the 95/90 at 1.15: the fly for 1.24, +0.01 a lot', () => {
  const b = board20({ 'PS95/100': Q5(2.3, 2.39), 'PS90/95': Q5(1.15, 1.2) });
  near(E.implied(b, 'FLY90/95/100').ask, 1.24, 'fly offer');
});

check('A6/M1 replay: the room straddle 7.59 / 8 is one tick outside the board 7.60 / 7.96; 8.05 bid is +0.09 against two 3.98 calls', () => {
  const g = new Game(Sc.replay1020(), { seed: 1 });
  const imp = E.implied(g.board, 'V100');
  near(imp.bid, 7.6, 'board bid'); near(imp.ask, 7.96, 'board offer');
  g.submitMarket(7.6, 7.96);
  const j = g.finish();
  const t0 = texts(j);
  has(t0, /At the money, twice the call: 100 call 3\.8 \/ 3\.98, stock 100 → 100 straddle 7\.6 \/ 7\.96, theo 7\.78/, 'E1 pricing line');
  has(t0, /Bid below 7\.96 to get out: the straddle, or the 100 call or put up to 3\.98/, 'E2 lean');
  assert.ok(!j.verdict.some(([, v]) => /7\.59|lay it off|hedged/.test(v)), 'E3: the bid is not judged once the offer traded: ' + j.verdict.map(v => v[1]).join(' | '));
  assert.ok(!t0.some(x => /delta flat|hedge/i.test(x)), 'E3: no hedge line for a zero-delta straddle');
  assert.ok(t0.length <= 3, 'E1/E2: at most three steps, got ' + t0.length);
  // No trade: a bid on the board's own level only scratches (M1).
  const g0 = new Game(Sc.replay1020(), { seed: 1 }); g0.beat.conductor = 'none';
  g0.submitMarket(7.6, 8);
  assert.ok(g0.judged.verdict.some(([, v]) => /7\.6 bid is on the board's 7\.6: if it's hit, you can only scratch\. Bid 7\.59/.test(v)), g0.judged.verdict.map(v => v[1]).join(' | '));
  E.setTick(0.01);
  g.next();
  assert.strictEqual(g.beat.type, 'opp');
  const a = E.bestArb(g.board);
  near(a.value, 22.5, 'arb on 250 straddles (500 calls)');
  assert.ok(a.route.some(r => r.id === 'C100' && r.side === 'buy' && r.price === 3.98), 'buys the calls');
  assert.ok(a.route.some(r => r.id === 'V100' && r.side === 'sell' && r.price === 8.05), 'sells the straddle');
});

check('C2 replay: the conductor lifts a 0.73 offer in the 90 put (it lays off at 0.72) and leaves a market with nothing in it', () => {
  let g = replayTo(3);
  assert.strictEqual(g.beat.target, 'P90');
  g.submitMarket(0.59, 0.73);
  assert.ok(g.hit && g.hit.side === 'ask' && g.hit.price === 0.73, 'offer lifted');
  g.trade('C90', 'buy', 500); g.trade('S', 'sell', 500);
  const t = texts(g.finish());
  has(t, /long future at 90 \+ 10\.72 − 0\.73 = 99\.99 against stock sold at 100: \+0\.01 a lot/, 'synthetic future against the stock');
  g = replayTo(3);
  g.submitMarket(0.6, 0.72);
  assert.ok(!g.hit, 'nothing in 0.60 / 0.72: no trade');
});

check('G6 pennies: a penny session prices in 0.01 with 500-lot questions and 10-20 cent markets', () => {
  const sess = Sc.genSession(11, { pcp: true, straddle: true, spreads: true, choice: true, penny: true });
  assert.strictEqual(sess.board.tick, 0.01);
  for (const [id, q] of Object.entries(sess.board.quotes)) {
    if (id === 'S') continue;
    const w = Math.round((q.ask - q.bid) * 100) / 100;
    assert.ok(w >= 0.1 && w <= 0.2, `${id} is ${w} wide`);
    assert.ok(Math.abs(q.bid * 100 - Math.round(q.bid * 100)) < 1e-6, `${id} bid ${q.bid} on the penny`);
  }
  assert.ok(sess.beats.every(b => b.size == null || b.size >= 500), 'sizes in 500s');
  E.setTick(0.5);
});

check('C1 a 20 October style board shows one strike only through a spread, and asks for its neighbour, then it', () => {
  for (let seed = 1; seed < 40; seed++) {
    const sess = Sc.genSession(seed, { pcp: true, straddle: true, spreads: true, box: true, fly: true, choice: true, penny: true, chain: true });
    const th = sess.board.thin;
    assert.ok(!sess.board.quotes['C' + th.kj] && !sess.board.quotes['P' + th.kj], 'the thin strike has no option quoted');
    assert.ok(sess.board.quotes[th.spread], 'its spread is quoted');
    E.setTick(0.01);
    assert.ok(E.bestArb(sess.board).value < 1e-6, 'no arb on the starting board');
    assert.strictEqual(+sess.beats[0].target.slice(1), th.kn, 'first: the neighbour, by parity');
    assert.strictEqual(+sess.beats[1].target.slice(1), th.kj, 'then the strike the spread prices');
  }
});

check('C2 the conductor trades a market that lays off for a tick, and leaves one at the lay-off level', () => {
  const sess = Sc.genSession(7, { pcp: true, choice: true, penny: true, chain: true });
  let g = new Game(sess, { seed: 1 });
  const imp = E.implied(g.board, g.beat.target);
  g.submitMarket(E.round(imp.bid - 0.01), E.round(imp.ask + 0.01));
  assert.ok(g.hit, 'one tick outside the lay-off: traded');
  g = new Game(sess, { seed: 1 });
  g.submitMarket(E.round(imp.bid), E.round(imp.ask));
  assert.ok(!g.hit, 'at the lay-off: nothing in it, no trade');
});

check('C3 the conductor leans: the same order at the board level, then through it', () => {
  const sess = Sc.genSession(5, { pcp: true, straddle: true, choice: true, penny: true, chain: true });
  const opps = sess.beats.filter(b => b.type === 'opp' && b.gen && /^V/.test(b.gen.id) && b.lesson === 'straddle' && b.gen.edge != null).slice(0, 2);
  assert.strictEqual(opps.length, 2);
  assert.strictEqual(opps[0].gen.id, opps[1].gen.id); assert.strictEqual(opps[0].gen.side, opps[1].gen.side);
  assert.strictEqual(opps[0].gen.edge, 0); assert.ok(opps[1].gen.edge > 0, 'second order is through');
});

check('C4 once a traded market is laid off flat, the conductor asks for a refresh in it', () => {
  const sess = Sc.genSession(7, { pcp: true, choice: true, penny: true, chain: true });
  sess.beats[0].size = 500;
  const g = new Game(sess, { seed: 1 });
  const t = g.beat.target, imp = E.implied(g.board, t);
  g.submitMarket(E.round(imp.bid - 0.01), E.round(imp.ask + 0.01));
  const a = E.bestLayoff(g.board, E.position(g.fills));
  for (const r of a.route) g.trade(r.id, r.side, r.qty);
  assert.ok(g.status().flat, 'arbed to flat');
  g.finish(); g.next();
  assert.strictEqual(g.beat.target, t); assert.ok(g.beat.refresh, 'refresh asked');
  E.setTick(0.5);
});

check('M6 replay: the market lifts the 90 put; a 95 put refresh leaned down gets a warning, one leaned up does not', () => {
  const at95 = mkt => {
    const g = replayTo(3);
    g.submitMarket(0.59, 0.73);
    g.trade('C90', 'buy', 500); g.trade('S', 'sell', 500);
    g.finish(); g.next();
    assert.strictEqual(g.beat.target, 'P95');
    g.submitMarket(...mkt);
    return g.finish().verdict.map(v => v[1]);
  };
  assert.ok(at95([1.7, 1.8]).some(v => /just bought the 90 put.*Lean the 95 put the same way, up/.test(v)), 'leaned down: warned');
  assert.ok(!at95([1.8, 1.92]).some(v => /Lean the/.test(v)), 'leaned up: fine');
});

check('A7 replay: buying the 95/90 put spread at 1.20 and selling the 100/95 at 2.30 is short the fly at 1.10, not an arb', () => {
  const g = replayTo(8);
  assert.strictEqual(g.beat.type, 'opp');
  g.trade('PS90/95', 'buy', 500); g.trade('PS95/100', 'sell', 500);
  const v = g.finish().verdict.map(x => x[1]);
  assert.ok(v.some(x => /short the 90\/95\/100 fly at 1\.1: a position, not an arb/.test(x)), v.join(' | '));
});

check('P12 a put spread\'s why gives its pluses and minuses and the opposite diagonal', () => {
  const g = new Game(Sc.replay1020(), { seed: 1 });
  const w = g.whyTheo('PS95/100');
  assert.ok(/\+100 put −95 put/.test(w) && /opposite diagonal/.test(w), w);
  assert.ok(/\+90 −2 × 95 \+100/.test(g.whyTheo('FLY90/95/100')), 'fly signs');
  E.setTick(0.5);
});

check('O1 straddle bid 8.05: vol is bid, sell it to them and buy it back through the calls at 7.96; selling without the calls is called out', () => {
  const g = new Game(Sc.replay1020(), { seed: 1 });
  g.submitMarket(7.6, 7.96); g.finish(); g.next();
  g.trade('V100', 'sell', 500);
  const j = g.finish(), t = texts(j);
  has(t, /100 straddle bid 8\.05: vol is bid, so sell it to them, and buy it back cheaper on the board: buy 2 × 100 call at 3\.98, sell stock at 100 = 7\.96/, 'vol framing');
  has(whys(j), /call at 3\.98 is the straddle at 7\.96\. Selling it at 8\.05 and buying it back at 7\.96 sells vol higher than you buy it/, 'why in vol terms');
  assert.ok(j.verdict.some(([c, v]) => c === 'bad' && /sold the 100 straddle to the bid but didn't buy it back on the board .*the arb was \+22\.5/.test(v)), j.verdict.map(v => v[1]).join(' | '));
  E.setTick(0.5);
});

check('C5 every level draws its scale: 0.5 / 25s, 0.05 / 100s and 0.01 / 500s all turn up, and the chain runs at each', () => {
  for (const cfg of [{ pcp: true, choice: true }, { pcp: true, straddle: true, spreads: true, box: true, fly: true }, { pcp: true, straddle: true, width: true, move: true, flow: true }]) {
    const seen = new Set();
    for (let seed = 1; seed < 60; seed++) {
      const sess = Sc.genSession(seed, cfg), b = sess.board;
      seen.add(b.tick);
      assert.ok(sess.chain && b.thin, 'chain conductor');
      assert.strictEqual(b.lot, { 0.5: 25, 0.05: 100, 0.01: 500 }[b.tick], 'lot matches tick');
    }
    assert.deepStrictEqual([...seen].sort(), [0.01, 0.05, 0.5]);
  }
  E.setTick(0.5);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
