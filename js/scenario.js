// The conductor. Builds a board, then a sequence of beats shaped like the
// 12 October sheets mock: make a market from parity, get traded on, lay it
// off; then react to what the conductor writes on the board.
//
// Theo always comes from the board itself, never from a hidden model: each
// strike's extrinsic is the quoted option's mid less its intrinsic at the
// stock mid. That is how the room priced it. When the conductor moves the
// stock and leaves the options alone, the extrinsic re-derives from the stale
// quotes, exactly as on the night (call 8/10 with stock 102/103 makes the
// 100 put worth 9 - 102.5 + 100 = 6.5).

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { round, floorT, ceilT } = E;

  // ---------- seeded randomness, so a session number replays ----------
  function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      pick: arr => arr[Math.floor(next() * arr.length)],
      chance: p => next() < p,
    };
  }

  // ---------- model from board ----------

  function mid(q) {
    if (!q || q.bid == null || q.ask == null) return null;
    return (q.bid + q.ask) / 2;
  }

  // The board as the room has it: conductor orders replaced by whatever was
  // there before them, and stale quotes (left behind by a stock move) out.
  // Theo never moves because the market posts a price.
  function roomBoard(board) {
    const quotes = {};
    for (const [qid, q] of Object.entries(board.quotes)) {
      if (q.mine || q.stale) continue;
      if (!q.conductor) quotes[qid] = q;
      else if (q.orig && q.orig !== 'none') quotes[qid] = q.orig;
    }
    return { ...board, quotes };
  }

  // Rebuild S and each strike's extrinsic from the board. A strike's call is
  // worth the mid of the tightest market the board makes in it: its own
  // quote, or one built from the put and the stock, the call spreads, or the
  // box. That is the room's reasoning: a widened 120 call (1/5) does not
  // move theo when the 110/120 call spread is 2/3. A strike with nothing
  // two-sided on it moves with the stock by its delta (P8).
  function deriveModel(board, prev) {
    const room = roomBoard(board);
    const S = mid(room.quotes.S) ?? mid(board.quotes.S);
    const base = prev ? E.shiftModel(prev, S) : null;
    const ext = { ...(base ? base.ext : board.ext0 || {}) };
    const lo = {}, hi = {};
    for (const k of board.strikes) {
      const id = 'C' + k;
      const q = room.quotes[id] || {};
      const imp = E.implied(room, id, { cap: 2 });
      const bids = [q.bid, imp.bid].filter(x => x != null);
      const asks = [q.ask, imp.ask].filter(x => x != null);
      if (!bids.length || !asks.length) continue;
      lo[k] = Math.max(...bids); hi[k] = Math.min(...asks);
      const c = (lo[k] + hi[k]) / 2;
      ext[k] = Math.max(c - Math.max(S - k, 0), 0);
    }
    return { S, strikes: board.strikes, ext: arbFree(board.strikes, S, ext, lo, hi), cd: board.cd };
  }

  // Each strike's mid, taken on its own, can bend the call curve the wrong
  // way by a rounding tick: a fly priced below nothing. Pull the curve back
  // to one with no arb in it (falling, convex, each spread inside its strike
  // gap, every call at least intrinsic), keeping each strike inside its own
  // market where it can.
  function arbFree(ks, S, ext, lo, hi) {
    const n = ks.length, intr = k => Math.max(S - k, 0);
    const C0 = ks.map(k => intr(k) + (ext[k] ?? 0));
    const eps = 1e-9;
    const w = j => (ks[j + 1] - ks[j]) / (ks[j + 1] - ks[j - 1]);
    const clean = C => {
      for (let j = 1; j < n - 1; j++) if (C[j] > w(j) * C[j - 1] + (1 - w(j)) * C[j + 1] + 1e-7) return false;
      for (let j = 1; j < n; j++) if (C[j] > C[j - 1] + 1e-7 || C[j - 1] - C[j] > ks[j] - ks[j - 1] + 1e-7) return false;
      return ks.every((k, j) => C[j] >= intr(k) - 1e-7);
    };
    const run = (L, H) => {
      const C = [...C0];
      for (let it = 0; it < 2000; it++) {
        let moved = false;
        for (let j = 1; j < n - 1; j++) {
          // Convex in strike: C[j] <= w C[j-1] + (1 - w) C[j+1].
          const w1 = w(j), w2 = 1 - w1, cap = w1 * C[j - 1] + w2 * C[j + 1];
          if (C[j] <= cap + eps) continue;
          const to = Math.max(cap, L[j]);
          if (C[j] - to > eps) { C[j] = to; moved = true; }
          if (C[j] > cap + eps) {
            // The middle can't come down further: lift the wings.
            const need = C[j] - cap;
            const up = (i, wi) => { const d = Math.min(H[i] - C[i], need / wi / 2 + eps); if (d > eps) { C[i] += d; moved = true; } };
            up(j - 1, w1); up(j + 1, w2);
          }
        }
        for (let j = 1; j < n; j++) {
          if (C[j] > C[j - 1] + eps) { C[j] = C[j - 1]; moved = true; }
          if (C[j - 1] - C[j] > ks[j] - ks[j - 1] + eps) { C[j] = C[j - 1] - (ks[j] - ks[j - 1]); moved = true; }
        }
        for (let j = 0; j < n; j++) if (C[j] < intr(ks[j]) - eps) { C[j] = intr(ks[j]); moved = true; }
        if (!moved) break;
      }
      return C;
    };
    // Inside each strike's own market where that can be done; if the
    // markets themselves won't allow a clean curve, without them.
    let C = run(ks.map(k => (lo[k] != null ? lo[k] : -Infinity)), ks.map(k => (hi[k] != null ? hi[k] : Infinity)));
    if (!clean(C)) C = run(ks.map(() => -Infinity), ks.map(() => Infinity));
    const out = {};
    ks.forEach((k, j) => { out[k] = Math.max(C[j] - intr(k), 0); });
    return out;
  }

  // ---------- board generation ----------

  function quoteAround(t, width) {
    return { bid: Math.max(0, floorT(t - width / 2)), ask: ceilT(t + width / 2) };
  }

  // A fresh board: strike gap, stock width, sizes and which side of each
  // strike is quoted all vary, so the first question is not always the same.
  function genBoard(R) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const spacing = R.pick([5, 10, 10]);
      const k0 = spacing * R.int(Math.ceil((spacing === 5 ? 40 : 80) / spacing), Math.floor((spacing === 5 ? 100 : 160) / spacing));
      const strikes = [-2, -1, 0, 1, 2].map(i => k0 + i * spacing);
      const sw = R.pick([0.5, 1, 1, 1, 2]);
      const sBid = k0 + R.int(-Math.floor(spacing / 4), Math.floor(spacing / 4)) - (sw === 2 ? 0.5 : 0);
      const S = sBid + sw / 2;
      // One standard deviation of about two strike gaps, as on the night
      // (stock 100, strikes 10 apart, at-the-money extrinsic 8.5).
      const sdT = spacing * (2.0 + R.next() * 0.8) / S;
      const ext = {}, cd = {};
      let ok = true;
      for (const k of strikes) {
        const bs = E.bsCall(S, k, sdT, 1);
        ext[k] = Math.max(0.5, round(bs.price - Math.max(S - k, 0)));
        cd[k] = Math.min(0.99, Math.max(0.01, round(bs.delta, 0.05)));
      }
      // Sanity: calls fall with strike, spreads inside the strike gap,
      // butterflies non-negative.
      const ct = strikes.map(k => Math.max(S - k, 0) + ext[k]);
      for (let i = 1; i < ct.length; i++) {
        if (!(ct[i] < ct[i - 1]) || ct[i - 1] - ct[i] >= spacing) ok = false;
        if (i > 1 && ct[i - 2] - 2 * ct[i - 1] + ct[i] < 0) ok = false;
      }
      if (!ok) continue;

      const sSize = R.pick([200, 500, 500, 1000]);
      const quotes = { S: { bid: sBid, ask: sBid + sw, bidSize: sSize, askSize: sSize } };
      for (const k of strikes) {
        // Mostly the out-of-the-money side, as on the night; sometimes the
        // in-the-money one, so the parity question runs both ways.
        const otm = k >= S ? 'C' : 'P';
        const atm = Math.abs(k - S) < spacing / 2;
        const kind = atm ? R.pick(['C', 'P']) : R.chance(0.25) ? (otm === 'C' ? 'P' : 'C') : otm;
        const t = kind === 'C' ? ct[strikes.indexOf(k)] : Math.max(k - S, 0) + ext[k];
        const width = atm ? 2 : R.pick([1, 1, 2]);
        const q = quoteAround(t, width);
        if (q.bid < 0.5) { ok = false; break; }
        const size = R.pick([20, 50, 100, 100, 200]);
        quotes[kind + k] = { ...q, bidSize: size, askSize: size };
      }
      if (!ok) continue;
      const board = { strikes, spacing, cd, ext0: ext, quotes, notes: [] };
      if (E.bestArb(board).value > 1e-6) continue;
      return board;
    }
    throw new Error('could not build a clean board');
  }

  // ---------- beats ----------
  //
  // A beat is plain data, so the 12 October replay can be written by hand:
  //   { type: 'make', target, size, after?, pre?, askAfter? }
  //   { type: 'make', targets: [a, b], noTrade, widen }   (stock widens)
  //   { type: 'opp',  pre: [ops], size, gen?|walk?, askAfter? }
  //   { type: 'pick', pre: [{ op: 'stock', stale: true }] } (stale book)
  // pre ops:  { op: 'stock', bid, ask, stale? }
  //           { op: 'set', id, bid, ask, bidSize, askSize, conductor? }
  //           { op: 'erase', id, side?: 'bid'|'ask' }
  //           { op: 'note', text }

  function applyOps(board, ops) {
    for (const o of ops || []) {
      if (o.op === 'stock') {
        board.quotes.S = { ...board.quotes.S, bid: o.bid, ask: o.ask };
        mark(board, 'S');
      } else if (o.op === 'set') {
        const q = board.quotes[o.id] || {};
        // A conductor order sits on top of whatever the room had there, and
        // comes off again at the end of the beat.
        const orig = o.conductor && !q.conductor ? (board.quotes[o.id] ? { ...q } : 'none') : q.orig;
        const bidSize = o.bidSize ?? q.bidFull ?? q.bidSize ?? 100;
        const askSize = o.askSize ?? q.askFull ?? q.askSize ?? 100;
        board.quotes[o.id] = {
          orig,
          bid: 'bid' in o ? o.bid : q.bid ?? null,
          ask: 'ask' in o ? o.ask : q.ask ?? null,
          bidSize, askSize, bidFull: bidSize, askFull: askSize,
          conductor: o.conductor ?? q.conductor,
        };
        mark(board, o.id);
      } else if (o.op === 'erase') {
        const q = board.quotes[o.id];
        if (!q) continue;
        if (!o.side) delete board.quotes[o.id];
        else {
          q[o.side] = null;
          if (q.bid == null && q.ask == null) delete board.quotes[o.id];
        }
        mark(board, o.id);
      } else if (o.op === 'note') {
        board.notes.push(o.text);
      }
    }
  }
  function clearConductor(board) {
    for (const [qid, q] of Object.entries(board.quotes)) {
      if (!q.conductor) continue;
      if (q.orig === 'none' || !q.orig) delete board.quotes[qid];
      else board.quotes[qid] = { ...q.orig };
    }
  }
  function mark(board, qid) { (board.changed = board.changed || new Set()).add(qid); }

  // Price a conductor order that is `edge` through what the rest of the board
  // implies. edge 0 is the trap: it looks big but there is nothing in it.
  // With `own`, the instrument's own quote counts too: a bid through its
  // offer is the plainest level to go through.
  function orderThrough(board, qid, side, edge, own) {
    const imp = E.implied(board, qid);
    const q = own ? board.quotes[qid] || {} : {};
    if (side === 'bid') {
      const asks = [imp.ask, q.ask].filter(x => x != null);
      if (!asks.length) return null;
      return { op: 'set', id: qid, bid: ceilT(Math.min(...asks)) + edge, ask: null, conductor: true };
    }
    const bids = [imp.bid, q.bid].filter(x => x != null);
    if (!bids.length) return null;
    const p = floorT(Math.max(...bids)) - edge;
    return p > 0 ? { op: 'set', id: qid, bid: null, ask: p, conductor: true } : null;
  }

  // ---------- session generator ----------
  //
  // Five questions drawn from the components ticked on the start screen.
  // Follow-ups and the market's reactions come in between, from the book.

  const COMPONENTS = ['pcp', 'straddle', 'spreads', 'box', 'fly', 'width', 'move'];
  const QUESTIONS = 5;

  function genSession(seed, cfg = { pcp: true }) {
    const R = rng(seed);
    const board = genBoard(R);
    const { strikes, spacing } = board;
    const sMid = mid(board.quotes.S);
    const atmK = strikes.reduce((a, k) => Math.abs(k - sMid) < Math.abs(a - sMid) ? k : a, strikes[0]);
    const lot = () => R.pick([10, 20, 25, 25, 30, 50]);
    // When the market posts liquidity, half the time it is priced right
    // (nothing in it) and half the time it gives something away.
    const postEdge = () => (R.chance(0.5) ? 0 : R.pick([0.5, 1]));
    const used = new Set();
    const quoted = id => !!board.quotes[id];
    const partner = id => (id[0] === 'C' ? 'P' : 'C') + id.slice(1);
    // The unquoted option at each strike: the one parity prices.
    const unquoted = strikes.map(k => (quoted('C' + k) ? 'P' : 'C') + k);
    const fresh = ids => { const f = ids.filter(i => !used.has(i)); return f.length ? f : ids; };
    const take = id => { used.add(id); return id; };
    const adj = () => { const i = R.int(0, strikes.length - 2); return [strikes[i], strikes[i + 1]]; };
    // Flow narrative: the market is a persistent buyer (or seller) of vol,
    // so its orders sit on the side that buys (or sells) vega.
    const flowDir = cfg.flow ? (R.chance(0.5) ? 1 : -1) : 0;
    const pickSide = (id, odds = ['bid', 'ask']) => {
      const v = E.vega({ strikes: board.strikes, cd: board.cd }, id);
      if (!flowDir || Math.abs(v) < 0.05) return R.pick(odds);
      // 80% of it goes the session's way, 20% against.
      const dir = R.chance(0.8) ? flowDir : -flowDir;
      return v * dir > 0 ? 'bid' : 'ask';
    };

    const B = {
      pcp: [
        // Parity: the unquoted option from its partner and the stock. Any
        // strike: at the money, deep in, or out.
        () => { const t = take(R.pick(fresh(unquoted))); return { type: 'make', target: t, size: lot() }; },
        () => { const t = take(R.pick(fresh(unquoted))); return { type: 'make', target: t, size: lot() }; },
        // An order in the unquoted option, priced off its partner.
        () => {
          const t = take(R.pick(fresh(unquoted)));
          const side = pickSide(t), size = lot();
          return { type: 'opp', size, lesson: 'through', gen: { id: t, side, edge: postEdge() },
            say: side === 'bid' ? `I'll pay up for the ${E.label(t)}.` : `I'm a seller of the ${E.label(t)}.` };
        },
        // A price walked toward and then through break-even, on a deep
        // option whose lay-off leg is thinner than the order.
        () => {
          const wd = flowDir && R.chance(0.8) ? flowDir : -flowDir;
          const deep = flowDir ? (wd > 0 ? 'C' + strikes[0] : 'P' + strikes[4]) : R.chance(0.5) ? 'P' + strikes[4] : 'C' + strikes[0];
          const part = partner(deep);
          const side = deep[0] === 'P' ? 'ask' : 'bid';
          return { type: 'opp', lesson: 'walk',
            pre: quoted(part) ? [{ op: 'thin', id: part, side: side === 'ask' ? 'bid' : 'ask', size: 50 }] : [],
            walkGen: { id: deep, side, edges: [-1, -0.5, 0.5], size: 100, lastSize: 100 },
            say: side === 'ask' ? `I'm a seller of the ${E.label(deep)}.` : `I'm a buyer of the ${E.label(deep)}.` };
        },
      ],
      straddle: [
        // An order in the straddle, then your market in it (O5).
        () => {
          const size = R.pick([20, 25, 40, 50]), side = pickSide('V' + atmK, ['bid', 'bid', 'ask']);
          const thinLeg = R.chance(0.5) ? [{ op: 'thin', id: (quoted('C' + atmK) ? 'C' : 'P') + atmK, side: side === 'bid' ? 'ask' : 'bid', size: size / 2 }] : [];
          return { type: 'opp', size, lesson: 'straddle', pre: thinLeg, askAfter: 'V' + atmK,
            gen: { id: 'V' + atmK, side, edge: postEdge() },
            say: side === 'bid' ? `I'll bid for the ${atmK} straddle.` : `I'll offer the ${atmK} straddle.` };
        },
        // Pull a quote and bid the straddle: the route changes (O4).
        () => {
          const leg = quoted('C' + atmK) ? 'C' + atmK : 'P' + atmK;
          const side = pickSide('V' + atmK, ['bid']);
          return { type: 'opp', size: lot(), lesson: 'remove',
            pre: [{ op: 'erase', id: leg, side: side === 'bid' ? 'ask' : 'bid' }],
            gen: { id: 'V' + atmK, side, edge: postEdge() },
            say: side === 'bid' ? `The ${E.label(leg)} offer's gone. I'll bid the straddle.` : `The ${E.label(leg)} bid's gone. I'll offer the straddle.` };
        },
        () => ({ type: 'make', target: take('V' + R.pick([atmK, atmK, strikes[1], strikes[3]])), size: lot() }),
      ],
      spreads: [
        () => { const [a, b] = adj(); return { type: 'make', target: take(`${R.pick(['CS', 'PS'])}${a}/${b}`), size: lot() }; },
        () => {
          const [a, b] = adj(), id = `${R.pick(['CS', 'PS'])}${a}/${b}`, side = pickSide(id);
          return { type: 'opp', size: lot(), lesson: 'through', askAfter: id, gen: { id, side, edge: postEdge() },
            say: side === 'bid' ? `I'll bid for the ${E.label(id)}.` : `I'll offer the ${E.label(id)}.` };
        },
      ],
      box: [
        // A tight spread on one side makes the other side's spread (P6).
        () => {
          const [a, b] = adj(), cs = R.chance(0.5);
          const shown = `${cs ? 'CS' : 'PS'}${a}/${b}`, ask = `${cs ? 'PS' : 'CS'}${a}/${b}`;
          return { type: 'make', target: take(ask), size: lot(), pre: [{ op: 'roomMarket', id: shown, width: R.pick([0.5, 1]) }] };
        },
        // A wide call, a tight call spread and a tight put: the put order
        // is priced through the box.
        () => {
          const [a, b] = adj();
          return { type: 'opp', size: lot(), lesson: 'box',
            pre: [
              { op: 'widen', id: 'C' + b, by: 1.5 },
              { op: 'roomMarket', id: `CS${a}/${b}`, width: 0.5 },
              { op: 'roomMarket', id: 'P' + a, width: 0.5 },
            ],
            gen: { id: 'P' + b, side: pickSide('P' + b), edge: postEdge() },
            say: `The ${b} calls are wide now. Here's an order in the ${b} put.` };
        },
      ],
      fly: [
        () => { const i = R.int(0, 2); return { type: 'make', target: take(`FLY${strikes[i]}/${strikes[i + 1]}/${strikes[i + 2]}`), size: lot() }; },
        () => {
          const i = R.int(0, 2), id = `FLY${strikes[i]}/${strikes[i + 1]}/${strikes[i + 2]}`, side = pickSide(id);
          return { type: 'opp', size: lot(), lesson: 'fly', askAfter: id,
            pre: [
              { op: 'roomMarket', id: `CS${strikes[i]}/${strikes[i + 1]}`, width: 0.5 },
              { op: 'roomMarket', id: `CS${strikes[i + 1]}/${strikes[i + 2]}`, width: 0.5 },
            ],
            gen: { id, side, edge: postEdge() },
            say: side === 'bid' ? `I'll bid for the ${E.label(id)}.` : `I'll offer the ${E.label(id)}.` };
        },
      ],
      // The stock widens: re-quote a ~50 delta option and a deep one (M3).
      width: [
        () => {
          const atmT = unquoted[strikes.indexOf(atmK)];
          const deep = unquoted[R.pick([0, 4])];
          return { type: 'make', targets: [atmT, deep], size: lot(), noTrade: true, widen: 1, restoreStock: true };
        },
      ],
      // The stock moves and the resting book doesn't: one trade (S1).
      move: [
        () => ({ type: 'pick', move: R.pick([-2, -1, 1, 2]) * (spacing >= 10 ? 1 : 0.5), restoreStock: false }),
      ],
    };

    const on = COMPONENTS.filter(c => cfg[c]);
    if (!on.length) on.push('pcp');
    const core = on.filter(c => c !== 'width' && c !== 'move');
    const pool = core.length ? core : ['pcp'];
    // More components than questions: parity stays (everything builds on
    // it), the rest are drawn at random.
    let picks = on.length > QUESTIONS
      ? (on.includes('pcp') ? ['pcp', ...shuffle(R, on.filter(c => c !== 'pcp')).slice(0, QUESTIONS - 1)] : shuffle(R, on).slice(0, QUESTIONS))
      : [...on];
    while (picks.length < QUESTIONS) picks.push(R.pick(pool));
    picks.sort((a, b) => COMPONENTS.indexOf(a) - COMPONENTS.indexOf(b));
    // A parity question first when parity is on: everything else builds on it.
    const beats = [];
    const left = {};
    for (const c of picks) {
      left[c] = left[c] && left[c].length ? left[c] : shuffle(R, B[c].map((_, i) => i));
      const beat = B[c][left[c].shift()]();
      beat.component = c;
      beats.push(beat);
    }
    return { seed, board, beats, title: 'Session ' + seed, cfg, flowDir };
  }

  function shuffle(R, arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // ---------- the 12 October replay ----------
  //
  // Numbers from the board photographs. Where the notes and the board
  // disagree the board wins; see README.md for the flagged points.

  function replay1012() {
    const board = {
      strikes: [80, 90, 100, 110, 120], spacing: 10,
      cd: { 80: 0.95, 90: 0.8, 100: 0.5, 110: 0.2, 120: 0.1 },
      quotes: {
        S: { bid: 100, ask: 101, bidSize: 500, askSize: 500 },
        C100: { bid: 8, ask: 10, bidSize: 100, askSize: 100 },
        C110: { bid: 5, ask: 6, bidSize: 100, askSize: 100 },
        C120: { bid: 3, ask: 4, bidSize: 100, askSize: 100 },
        P80: { bid: 2, ask: 3, bidSize: 100, askSize: 100 },
        P90: { bid: 4, ask: 6, bidSize: 100, askSize: 100 },
      },
      notes: [],
    };
    const beats = [
      { type: 'make', target: 'P100', size: 25, conductorSide: 'sell',
        say: "What's your market in the 100 put?" },
      { type: 'make', target: 'C80', size: 25, conductorSide: 'buy',
        say: 'Make me a market in the 80 call.' },
      { type: 'make', target: 'P120', size: 25, conductorSide: 'none',
        say: 'Get a market in the 120 put. Same process again.' },
      { type: 'opp', lesson: 'walk',
        pre: [{ op: 'thin', id: 'C120', side: 'bid', size: 50 }],
        walk: { id: 'P120', side: 'ask', steps: [
          { price: 23, size: 100, say: "I'll be at 23, in 100 lots. Any interest?" },
          { price: 22.5, size: 100, say: "I'm at 22.5." },
          { price: 21.5, size: 100, say: "I'll sell 21.5s." },
        ] },
        say: '' },
      { type: 'make', target: 'P100', size: 25,
        pre: [{ op: 'stock', bid: 102, ask: 103 }],
        say: "Stock's 102 at 103 now. Market in the 100 put?" },
      { type: 'opp', size: 25, pre: [{ op: 'set', id: 'V100', bid: 18, ask: null, conductor: true }],
        say: 'I bid 18 for the 100 straddle.', lesson: 'straddle', askAfter: 'V100' },
      { type: 'opp', size: 25,
        pre: [{ op: 'set', id: 'P100', bid: 7, ask: null }, { op: 'set', id: 'V100', bid: 18.5, ask: null, conductor: true }],
        say: "Forget 6/8 in the put: all we know is there's a 7 bid out there somewhere. I'm 18.5 bid for the straddle.", lesson: 'remove' },
      { type: 'make', target: 'CS110/120', size: 25, conductorSide: 'none',
        pre: [{ op: 'erase', id: 'V100' }],
        say: "Market in the 110/120 call spread. I want it armable: if I trade with you, you can trade straight out on screen and make money." },
      { type: 'opp', size: 25, lesson: 'through',
        pre: [
          { op: 'set', id: 'CS110/120', bid: 3, ask: null, conductor: true },
          { op: 'set', id: 'C110', ask: 5.5, conductor: true },
        ],
        say: "I'm 3 bid on the call spread. I'm also offering the 110 call at 5.5." },
      { type: 'opp', size: 25, lesson: 'through',
        pre: [{ op: 'set', id: 'CS110/120', bid: 4, ask: null, conductor: true }],
        say: "I'm 4 bid on that call spread now. The 110s are 20 delta, the 120s 10 delta." },
      { type: 'make', target: 'P110', size: 25, conductorSide: 'none', after: { bid: 14, ask: 14.5 },
        pre: [{ op: 'stock', bid: 100, ask: 101 }],
        say: 'Futures back down to 100 at 101. Market in the 110 puts?' },
      { type: 'make', target: 'P120', size: 25, conductorSide: 'none',
        pre: [
          { op: 'set', id: 'C120', bid: 1, ask: 5 },
          { op: 'set', id: 'CS110/120', bid: 2, ask: 3 },
        ],
        say: "I'm 14 at 14.5 in the 110 puts. The 120 calls are 1 at 5, the call spread is 2 at 3. Your best market in the 120 puts?" },
      { type: 'opp', size: 25, lesson: 'box',
        pre: [{ op: 'set', id: 'P120', bid: 23.5, ask: null, conductor: true }],
        say: "I'm 23.5 bid for the 120 puts." },
      { type: 'make', target: 'PS110/120', size: 25, conductorSide: 'none', after: { bid: 7, ask: 8 },
        say: "You're 2 at 3 in the call spread. What are you in the 110/120 put spread?" },
      { type: 'opp', size: 25, lesson: 'box',
        pre: [{ op: 'set', id: 'P120', bid: 24, ask: null, conductor: true }],
        say: "Say that put spread, 7 bid at 8, is a real market. I'm 24 bid for the 120 puts. Where's the money?" },
    ];
    return { seed: '12oct', board, beats, title: 'Replay: 12 October' };
  }

  // Resolve the generator-only ops ('gen', 'widen', 'roomMarket') against the
  // live board, just before a beat is shown, so prices follow whatever the
  // board looks like by then.
  function prepareBeat(board, beat, model) {
    const S0 = board.quotes.S;
    if (beat.type === 'pick') {
      // The stock moves and the resting quotes stay where they were. Theo
      // moves by delta (P8); the room's quotes are stale until it re-marks.
      // Grow the move until the best stale quote is worth at least half a
      // tick a lot after the hedge: there has to be something to find.
      let mv = beat.move;
      const best = d => {
        const m = E.shiftModel(model, mid(S0) + d), half = (S0.ask - S0.bid) / 2;
        let b = -Infinity;
        for (const [id, q] of Object.entries(board.quotes)) {
          if (id === 'S') continue;
          const T = E.theo(m, id), hc = Math.abs(E.delta(m, id)) * half;
          if (q.ask != null) b = Math.max(b, T - q.ask - hc);
          if (q.bid != null) b = Math.max(b, q.bid - T - hc);
        }
        return b;
      };
      for (let i = 0; i < 6 && best(mv) < 0.5; i++) mv += Math.sign(mv) * (board.spacing >= 10 ? 1 : 0.5);
      beat.move = mv;
      applyOps(board, [{ op: 'stock', bid: S0.bid + mv, ask: S0.ask + mv }]);
      for (const [id, q] of Object.entries(board.quotes)) if (id !== 'S') q.stale = true;
      beat.say = `Stock's ${mv > 0 ? 'up' : 'down'} ${fmtP(Math.abs(mv))}: now ${fmtP(S0.bid + mv)} / ${fmtP(S0.ask + mv)}. Nothing else on the board has moved. You get one trade: which?`;
      const m = E.shiftModel(model, mid(board.quotes.S));
      return { ...m, ext: arbFree(m.strikes, m.S, m.ext, {}, {}) };
    }
    if (beat.widen) {
      // Before the stock widens: the room's standard market in each target,
      // the yardstick for how much wider yours should get (M3).
      beat.stockBefore = { bid: S0.bid, ask: S0.ask };
      beat.std = {};
      for (const t of beat.targets) {
        const imp = E.implied(roomBoard(board), t);
        if (imp.bid != null && imp.ask != null) beat.std[t] = { bid: imp.bid - 0.5, ask: imp.ask + 0.5 };
      }
      applyOps(board, [{ op: 'stock', bid: S0.bid - beat.widen, ask: S0.ask + beat.widen }]);
      return deriveModel(board, model);
    }
    const pre = beat.pre || [];
    // Stock moves land first, so anything priced 'from the room' prices off
    // the new stock.
    applyOps(board, pre.filter(o => o.op === 'stock'));
    let m = deriveModel(board, model);
    for (const o of pre) {
      if (o.op === 'stock') continue;
      if (o.op === 'widen') {
        const q = board.quotes[o.id];
        // Only the sides that are there: a pulled offer stays pulled.
        if (q) applyOps(board, [{ op: 'set', id: o.id, bid: q.bid != null ? Math.max(0.5, floorT(q.bid - o.by)) : null, ask: q.ask != null ? ceilT(q.ask + o.by) : null }]);
      } else if (o.op === 'thin') {
        const q = board.quotes[o.id];
        if (q && q[o.side] != null) q[o.side + 'Size'] = o.size;
      } else if (o.op === 'roomMarket') {
        const q = quoteAround(E.theo(m, o.id), o.width * 2);
        applyOps(board, [{ op: 'set', id: o.id, bid: q.bid, ask: q.ask }]);
      } else {
        applyOps(board, [o]);
      }
      m = deriveModel(board, m);
    }
    if (beat.walkGen) {
      // The conductor walks a price toward and then through break-even:
      // the room should wait until it is worth having.
      const w = beat.walkGen;
      const imp = E.implied(board, w.id);
      const be = w.side === 'ask' ? imp.bid : imp.ask;
      if (be != null) {
        beat.walk = {
          id: w.id, side: w.side,
          steps: w.edges.map((e, i) => {
            const price = w.side === 'ask' ? floorT(be) - e : ceilT(be) + e;
            const size = i === w.edges.length - 1 ? w.lastSize : w.size;
            return { price, size, say: `I'll ${w.side === 'ask' ? 'offer' : 'bid'} ${fmtP(price)} in the ${E.label(w.id)}, ${size} lots.` };
          }).filter(st => st.price > 0),
        };
      }
    }
    if (beat.walk) {
      beat.stepIdx = 0;
      beat.baseSay = beat.baseSay || beat.say || '';
      applyStep(board, beat);
    } else if (beat.gen) {
      const g = beat.gen;
      const side = g.side === 'bid' ? 'bid' : 'ask';
      const keep = g.keepOther ? board.quotes[g.id] : null;
      const op = orderThrough(board, g.id, side, g.edge, g.keepOther);
      if (op) {
        if (keep) {
          // Through a level on a quoted option: replace only that side.
          op.bid = side === 'bid' ? op.bid : keep.bid;
          op.ask = side === 'ask' ? op.ask : keep.ask;
          op.bidSize = keep.bidSize; op.askSize = keep.askSize;
        }
        op[side + 'Size'] = beat.size;
        applyOps(board, [op]);
        beat.order = { id: g.id, side, price: op[side] };
        beat.say = beat.say.replace(/\.$/, '') + `: ${side === 'bid' ? 'I bid' : 'I offer'} ${fmtP(op[side])} for ${beat.size}.`;
      }
    } else {
      // Hand-written beats carry their conductor order in pre.
      for (const o of pre.filter(p => p.op === 'set' && p.conductor)) {
        const side = 'bid' in o && o.bid != null ? 'bid' : 'ask';
        board.quotes[o.id][side + 'Size'] = beat.size;
        beat.order = { id: o.id, side, price: o[side] };
      }
    }
    // The model keeps the extrinsic of the stale quotes; a conductor order
    // never moves theo.
    return m;
  }

  function applyStep(board, beat) {
    const w = beat.walk, st = w.steps[beat.stepIdx];
    const q = board.quotes[w.id];
    const op = { op: 'set', id: w.id, conductor: true, [w.side]: st.price, [w.side + 'Size']: st.size };
    if (!q) op[w.side === 'ask' ? 'bid' : 'ask'] = null;
    applyOps(board, [op]);
    beat.order = { id: w.id, side: w.side, price: st.price };
    beat.size = st.size;
    beat.say = (beat.stepIdx === 0 && beat.baseSay ? beat.baseSay + ' ' : '') + st.say;
  }

  function fmtP(x) {
    if (x == null) return '';
    const r = Math.round(x * 100) / 100;
    return String(Object.is(r, -0) ? 0 : r);
  }

  const api = { COMPONENTS, QUESTIONS, applyStep, roomBoard, clearConductor, rng, mid, deriveModel, genBoard, genSession, replay1012, prepareBeat, applyOps, quoteAround, fmtP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scenario = api;
})(typeof window !== 'undefined' ? window : globalThis);
