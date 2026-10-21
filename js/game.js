// Game state and judging. No DOM, so a whole session can be played in node.
//
// One running book. The session follows an agenda (five questions from the
// components picked at the start, or the 12 October night), and between
// agenda questions the market reacts to what is on the board and in your
// book:
//
//   - your quotes stay up at your levels until you change them; a side that
//     trades out shows struck at 0. Quoting an instrument replaces the room's
//     market in it: one market per instrument, as on a whiteboard;
//   - the market trades your quotes as an aggressor: half the time it knows
//     theo and only hits a side that is out of line, half the time it is
//     clueless (G1);
//   - when a fill leaves you holding an option, the next question asks for
//     your market in its partner, so you can lean for the exit (A3).
//
// Explanations are built from PRINCIPLES.md, not from the case in hand: the
// synthetic future (P3) for any strike, delta hedging (A2), break-even and
// leaning (A3), edge x size (O2, S1). Each step is one line; the framework
// behind it is in `why`.

(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const E = isNode ? require('./engine.js') : root.Engine;
  const Sc = isNode ? require('./scenario.js') : root.Scenario;
  const fmtP = Sc.fmtP;

  const clone = o => JSON.parse(JSON.stringify(o, (k, v) => (v instanceof Set ? undefined : v)));
  // Three places: a penny board's straddle halves to 4.025.
  const n2 = x => {
    const r = Math.round(x * 1000) / 1000;
    return (Object.is(r, -0) ? 0 : r).toString();
  };
  const signed = x => (x > 0 ? '+' : '') + n2(x);
  const isOption = id => /^[CP]\d/.test(id);
  const partnerOf = id => (id[0] === 'C' ? 'P' : 'C') + id.slice(1);
  const strikeOf = id => +id.slice(1);

  // A bid at or below nothing is no bid at all.
  const posBid = imp => (imp.bid != null && imp.bid <= 1e-9 ? { ...imp, bid: null, bidRoute: null } : imp);

  // The pluses and minuses a structure puts on the strikes (P12).
  function signsOf(id) {
    const i = E.parse(id);
    switch (i.kind) {
      case 'V': return `+${i.k} call +${i.k} put`;
      case 'CS': return `+${i.k1} call −${i.k2} call`;
      case 'PS': return `+${i.k2} put −${i.k1} put`;
      case 'BOX': return `+${i.k1} call −${i.k2} call +${i.k2} put −${i.k1} put`;
      case 'FLY': return `+${i.k1} −2 × ${i.k2} +${i.k3}`;
      default: return '';
    }
  }

  // What a set of option trades adds up to, if it is one structure: its id,
  // how many, and the price paid (A7).
  function structureOf(trades, strikes) {
    const opt = trades.filter(t => t.id !== 'S');
    if (new Set(opt.map(t => t.id)).size < 2) return null;
    const pos = E.position(opt);
    const ids = [];
    for (let a = 0; a < strikes.length; a++) {
      ids.push('V' + strikes[a]);
      for (let b = a + 1; b < strikes.length; b++) ids.push(`CS${strikes[a]}/${strikes[b]}`, `PS${strikes[a]}/${strikes[b]}`, `BOX${strikes[a]}/${strikes[b]}`);
      if (a + 2 < strikes.length) ids.push(`FLY${strikes[a]}/${strikes[a + 1]}/${strikes[a + 2]}`);
    }
    for (const id of ids) {
      const v = E.vec(id), keys = new Set([...Object.keys(v.w), ...Object.keys(pos.w)]);
      const k0 = Object.keys(v.w)[0], q = (pos.w[k0] || 0) / v.w[k0];
      if (Math.abs(q) < 1e-9) continue;
      if ([...keys].every(k => Math.abs((pos.w[k] || 0) - q * (v.w[k] || 0)) < 1e-7)) {
        return { id, qty: q, price: v.c - (pos.cash + pos.c) / q };
      }
    }
    return null;
  }
  const sz = (q, s) => (q && q[s] != null ? q[s + 'Size'] ?? 100 : 0);

  // Best bid and offer for an instrument across the room and your quotes.
  // At the same price your quote shows: it is your level on the board.
  function topOf(quotes, mine, id) {
    const r = quotes[id], m = mine[id];
    const side = s => {
      const rp = r && r[s] != null && sz(r, s) > 0 ? r[s] : null;
      const mp = m && m[s] != null && m[s + 'Size'] > 0 ? m[s] : null;
      const better = s === 'bid' ? (a, b) => a >= b : (a, b) => a <= b;
      if (mp != null && (rp == null || better(mp, rp))) return { price: mp, size: m[s + 'Size'], mine: true };
      if (rp != null) return { price: rp, size: sz(r, s), mine: false, order: !!r.conductor, stale: !!r.stale };
      if (m && m[s] != null) return { price: m[s], size: 0, mine: true, gone: true };
      return null;
    };
    return { bid: side('bid'), ask: side('ask') };
  }

  class Game {
    // opts.seed makes the market's coin flips repeatable (tests).
    constructor(session, opts = {}) {
      this.session = session;
      E.setTick(session.board.tick);
      this.sc = Sc.scaleOf(session.board);
      this.R = Sc.rng(opts.seed ?? (Date.now() & 0x7fffffff));
      this.board = clone(session.board);
      this.board.mine = {};
      this.board.changed = new Set();
      for (const q of Object.values(this.board.quotes)) { q.bidFull = q.bidSize; q.askFull = q.askSize; }
      this.agenda = clone(session.beats);
      this.ai = -1;              // agenda position
      this.queue = [];           // follow-ups waiting to be asked
      this.trades = [];          // the whole session's book
      this.results = [];
      this.history = [];         // finished questions, for looking back
      this.model = Sc.deriveModel(this.board, null);
      this.n = 0;                // beats played
      this.beat = null;
      this.posts = [];
      this.aggr = { gap: 0, total: 0 };
      // Option-equivalent vega in the trade list, and the flow narrative: the
      // market keeps buying (or selling) vol, and every `per` vega it trades
      // the room re-marks the board by `shift` at the money (F1).
      const cfg = session.cfg || {};
      this.showVega = !!(opts.vega || cfg.vega || cfg.flow);
      this.flow = cfg.flow && session.flowDir ? { dir: session.flowDir, vega: 0, steps: 0, per: 50 * this.sc.L, shift: 2 * this.sc.U } : null;
      this.next();
    }

    get done() { return this.phase === 'done'; }
    get beatTrades() { return this.trades.filter(t => t.beat === this.n); }
    get questionNo() { return Math.min(this.ai + 1, this.agenda.length); }

    // ---------- moving through the session ----------

    next() {
      this.board.changed = new Set();
      this.flowNews = null;
      this.flowIds = new Set();
      if (this.beat) this.closeBeat();
      this.lastPosts = this.posts;
      this.hit = null;
      this.fills = [];
      this.posts = [];
      this.actions = [];
      this.nagged = false;
      this.judged = null;
      this.marketEval = null;
      this.oppStart = null;
      this.oppEvents = null;
      this.n++;

      // 1. A follow-up the last beat set up.
      if (this.queue.length) return this.startBeat(this.queue.shift());
      // 2. The market trades one of your standing quotes.
      if (this.ai >= 0 && this.marketAggression()) return;
      // 3. The next question on the agenda. The room refills its sizes.
      this.ai++;
      this.aggr.gap = 0;
      if (this.ai >= this.agenda.length) { this.phase = 'done'; this.beat = null; return; }
      for (const q of Object.values(this.board.quotes)) {
        if (q.conductor) continue;
        if (q.bid != null) q.bidSize = q.bidFull ?? 100;
        if (q.ask != null) q.askSize = q.askFull ?? 100;
      }
      this.startBeat(this.agenda[this.ai]);
    }

    startBeat(beat) {
      this.beat = beat;
      // A follow-up pulls the room's market in the exit option: your market
      // will be the market there.
      for (const o of beat.pre || []) {
        if (o.op === 'pull' && this.board.quotes[o.id]) {
          delete this.board.quotes[o.id];
          this.board.changed.add(o.id);
        }
      }
      if (beat.followUp) beat.pre = beat.pre.filter(o => o.op !== 'pull');
      this.mineBefore = clone(this.board.mine);
      if (beat.widen) this.widthTargets(beat);
      this.model = Sc.prepareBeat(this.board, beat, this.model);
      if (beat.targets) { beat.ti = 0; beat.target = beat.targets[0]; beat.quotes = {}; }
      this.start = { board: clone(this.board), model: clone(this.model) };
      if (beat.type === 'react') {
        this.hit = beat.hit;
        this.fills = [beat.hitTrade];
        this.afterHit = { board: clone(this.board) };
        this.phase = 'hedge';
      } else if (beat.type === 'pick') {
        this.phase = 'pick';
      } else {
        this.phase = beat.type === 'make' ? 'ask' : 'opp';
      }
    }

    // The stock widens: ask you to update markets you already show, where
    // you have them, with deltas far enough apart to compare (M3).
    widthTargets(beat) {
      const d = id => Math.abs(E.delta(this.model, id));
      const own = Object.entries(this.board.mine)
        .filter(([id, q]) => isOption(id) && q.bid != null && q.ask != null)
        .map(([id]) => id).sort((a, b) => Math.abs(d(a) - 0.5) - Math.abs(d(b) - 0.5));
      if (!own.length) return;
      const first = own[0];
      const pool = [...own.slice(1), ...beat.targets].filter(t => t !== first);
      const second = pool.sort((a, b) => Math.abs(d(b) - d(first)) - Math.abs(d(a) - d(first)))[0];
      if (second && Math.abs(d(second) - d(first)) >= 0.25) beat.targets = [first, second];
    }

    closeBeat() {
      Sc.clearConductor(this.board);
      const b = this.beat;
      // A market the room settles on (or the market posts) after a question
      // replaces yours there.
      if (b.type === 'make' && b.after) {
        let q = b.after;
        if (q === 'room') q = Sc.quoteAround(E.theo(this.model, b.target), 2 * this.sc.U);
        Sc.applyOps(this.board, [{ op: 'set', id: b.target, bid: q.bid, ask: q.ask, bidSize: b.size ?? 100 * this.sc.L, askSize: b.size ?? 100 * this.sc.L }]);
        delete this.board.mine[b.target];
      }
      if (b.restoreStock && b.stockBefore) {
        Sc.applyOps(this.board, [{ op: 'stock', bid: b.stockBefore.bid, ask: b.stockBefore.ask }]);
      }
      if (b.type === 'pick') {
        // The room re-marks its stale quotes by delta.
        for (const [id, q] of Object.entries(this.board.quotes)) {
          if (!q.stale) continue;
          const sh = E.round(E.delta(this.model, id) * b.move), t = E.TICK;
          if (q.bid != null) q.bid = q.bid + sh >= t ? E.round(q.bid + sh) : null;
          if (q.ask != null) q.ask = E.round(Math.max(q.ask + sh, t));
          delete q.stale;
          if (q.bid == null && q.ask == null) delete this.board.quotes[id];
        }
      }
      this.applyFlow();
      this.model = Sc.deriveModel(this.board, this.model);
    }

    // ---------- the flow narrative (F1) ----------

    // Vega the market bought on a trade it was the other side of.
    recordFlow(tr) {
      if (!this.flow || !tr) return;
      tr.flowV = (tr.side === 'sell' ? 1 : -1) * tr.qty * E.vega(this.model, tr.id);
      this.flow.vega += tr.flowV;
    }

    // Once the market's net flow reaches another `per` vega its way (the 20%
    // going against it nets off), the room re-marks: each
    // strike moves by its vega times the shift, call and put alike, so
    // parity, spreads and boxes all stay in line. Your quotes don't move.
    applyFlow() {
      const f = this.flow;
      if (!f) return;
      const target = Math.floor(Math.max(0, f.vega * f.dir) / f.per + 1e-9);
      while (f.steps < target) {
        f.steps++;
        const sk = this.reMark(f.dir * f.shift);
        const ve = E.vegaTable(this.board.strikes, this.board.cd);
        const atm = this.board.strikes.find(k => ve[k] === 1);
        this.flowNews = `The market has ${f.dir > 0 ? 'bought' : 'sold'} ${n2(Math.abs(f.vega))} vega so far. The room re-marks the board ${f.dir > 0 ? 'up' : 'down'}: ${fmtP(Math.abs(sk[atm]))} at the money, each strike by its vega.`;
      }
    }
    reMark(step) {
      const b = this.board, sk = {};
      const ve = E.vegaTable(b.strikes, b.cd);
      for (const k of b.strikes) sk[k] = E.round(ve[k] * step);
      // A linear step can overshoot a narrow fly: vol up takes the middle
      // strike up more than the wings. Trim shifts until every fly stays
      // >= 0 and every call spread inside 0..gap (P5, P7).
      const ks = b.strikes, C = k => E.callTheo(this.model, k) + sk[k];
      for (let i = 0; i < 20; i++) {
        let bad = false;
        for (let j = 1; j < ks.length - 1; j++) {
          if (C(ks[j - 1]) - 2 * C(ks[j]) + C(ks[j + 1]) < -1e-9) {
            // The top-vega strike always moves the full step: lift the
            // neighbour that moved least instead.
            if (ve[ks[j]] === 1) { const nb = Math.abs(sk[ks[j - 1]]) <= Math.abs(sk[ks[j + 1]]) ? ks[j - 1] : ks[j + 1]; sk[nb] += Math.sign(step) * E.TICK; }
            else sk[ks[j]] -= Math.sign(step) * E.TICK;
            bad = true;
          }
        }
        for (let j = 1; j < ks.length; j++) {
          const cs = C(ks[j - 1]) - C(ks[j]);
          if (cs < -1e-9) { sk[ks[j]] -= E.TICK; bad = true; }
          else if (cs > ks[j] - ks[j - 1] + 1e-9) { sk[ks[j - 1]] -= E.TICK; bad = true; }
        }
        if (!bad) break;
      }
      const shiftOf = id => { const { w } = E.vec(id); let x = 0; for (const [key, q] of Object.entries(w)) if (key !== 'S') x += q * sk[+key.slice(1)]; return x; };
      for (const [id, q] of Object.entries(b.quotes)) {
        if (id === 'S' || q.conductor) continue;
        const sh = shiftOf(id);
        if (!sh) continue;
        const t = E.TICK;
        if (q.bid != null) q.bid = q.bid + sh >= t ? E.round(q.bid + sh) : null;
        if (q.ask != null) q.ask = E.round(Math.max(q.ask + sh, q.bid != null ? q.bid + t : t));
        if (q.bid == null && q.ask == null) delete b.quotes[id];
        this.flowIds.add(id);
        b.changed.add(id);
      }
      // Rounding to the tick must not leave an arb on the room's board.
      for (let i = 0; i < 4; i++) {
        const arb = E.bestArb(Sc.roomBoard(b));
        if (arb.value < 1e-6) break;
        for (const r of arb.route) {
          const q = b.quotes[r.id];
          if (!q || r.id === 'S') continue;
          const t = E.TICK;
          if (r.side === 'buy' && q.ask != null) q.ask = E.round(q.ask + t);
          if (r.side === 'sell' && q.bid != null) q.bid = q.bid - t >= t ? E.round(q.bid - t) : null;
        }
      }
      for (const k of b.strikes) this.model.ext[k] = Math.max(0, this.model.ext[k] + sk[k]);
      return sk;
    }
    flowWhy() {
      const f = this.flow;
      if (!f || !f.steps) return '';
      return ` The market has been a persistent ${f.dir > 0 ? 'buyer' : 'seller'} of vol (${n2(Math.abs(f.vega))} vega so far): every ${f.per} vega, fair value moves ${f.dir > 0 ? 'up' : 'down'} ${f.shift} at the money and each other strike by its vega, call and put alike. Your own prices should move with it.`;
    }

    // Between questions, the market may trade one of your standing quotes:
    // more likely just after you posted one. Informed (half the time): the
    // side furthest through theo, if any. Clueless: any side, favouring what
    // you just posted. At most once between agenda questions.
    marketAggression() {
      if (this.session.noAggression) return false;
      if (this.aggr.gap >= (this.flow ? 2 : 1) || this.aggr.total >= (this.flow ? 8 : 4)) return false;
      let sides = [];
      for (const [id, q] of Object.entries(this.board.mine)) {
        const T = E.theo(this.model, id);
        if (q.bid != null && q.bidSize > 0) sides.push({ id, side: 'bid', size: q.bidSize, off: q.bid - T });
        if (q.ask != null && q.askSize > 0) sides.push({ id, side: 'ask', size: q.askSize, off: T - q.ask });
      }
      // Flow comes more often, and 80% of it goes the session's way: a
      // buyer of vol lifts offers that buy vega, a seller hits bids.
      if (this.flow) {
        const dir = this.R.chance(0.8) ? this.flow.dir : -this.flow.dir;
        sides = sides.filter(s => E.vega(this.model, s.id) * dir * (s.side === 'ask' ? 1 : -1) > 0.05);
      }
      if (!sides.length) return false;
      const fresh = sides.filter(s => (this.lastPosts || []).some(p => p.id === s.id && (p.side === 'buy') === (s.side === 'bid')));
      if (!this.R.chance(this.flow ? 0.65 : fresh.length ? 0.7 : 0.35)) return false;
      let pick = null;
      if (this.R.chance(0.5)) {
        pick = sides.filter(s => s.off > 1e-9).sort((a, b) => b.off - a.off)[0] || null;
      } else {
        pick = this.R.pick(fresh.length ? fresh : sides);
      }
      if (!pick) return false;
      const qty = Math.min(pick.size, this.R.pick(this.flow ? [25, 50, 50] : [10, 20, 25, 25, 50]) * this.sc.L);
      this.aggr.gap++; this.aggr.total++;
      const tr = this.hitMine(pick.id, pick.side, qty);
      this.startBeat({ type: 'react', target: pick.id, hit: this.hit, hitTrade: tr });
      return true;
    }

    // The market trades your quote. side is the side of YOUR quote it hits.
    hitMine(id, side, qty) {
      const q = this.board.mine[id];
      const tr = { id, side: side === 'bid' ? 'buy' : 'sell', qty, price: q[side], who: 'market', fromMarket: true, beat: this.n };
      this.trades.push(tr);
      this.fills.push(tr);
      this.recordFlow(tr);
      q[side + 'Size'] -= qty;
      this.hit = { id, side, qty, price: q[side], conductor: side === 'bid' ? 'sell' : 'buy' };
      return tr;
    }

    // ---------- make a market ----------

    // bidQty/askQty are the sizes you show; blank means the question's size.
    submitMarket(bid, ask, bidQty, askQty) {
      const b = this.beat;
      if (!(bid >= 0) || !(ask > bid)) return { error: 'Enter a bid below your offer, e.g. 7.5 / 9.5.' };
      for (const q of [bidQty, askQty]) if (q != null && !(q > 0)) return { error: 'Sizes must be positive, or leave them blank.' };
      const t = b.target;
      const T = E.theo(this.model, t);
      const D = E.delta(this.model, t);
      const imp = E.implied(this.board, t);
      const ev = { id: t, bid, ask, T, D, imp };
      ev.arbBid = imp.ask != null && bid > imp.ask + 1e-9;
      ev.arbAsk = imp.bid != null && ask < imp.bid - 1e-9;
      ev.containsTheo = bid <= T + 1e-9 && ask >= T - 1e-9;
      this.marketEval = ev;

      // Your market goes up on the board and is the market there now.
      if (this.board.quotes[t] && !this.board.quotes[t].conductor) delete this.board.quotes[t];
      this.board.mine[t] = { bid, ask, bidSize: bidQty ?? b.size, askSize: askQty ?? b.size };
      this.board.changed.add(t);

      if (b.targets) {
        b.quotes[t] = ev;
        if (b.ti < b.targets.length - 1) { b.ti++; b.target = b.targets[b.ti]; return { ev, more: true }; }
        this.finish();
        return { ev };
      }

      // The market's response. A crossed market always gets traded. Then,
      // informed: hit whichever side is through theo. Clueless: trade a side
      // most of the time.
      let side = null;
      const offBid = bid - T, offAsk = T - ask;
      // How much each side of your market lays off for on the board (M1).
      const layBid = imp.bid != null ? imp.bid - bid : -Infinity, layAsk = imp.ask != null ? ask - imp.ask : -Infinity;
      if (ev.arbBid || ev.arbAsk) side = ev.arbBid ? 'bid' : 'ask';
      else if (b.noTrade || b.conductor === 'none') side = null;
      // The conductor of a scripted night trades the side it traded then.
      else if (b.conductor === 'buy' || b.conductor === 'sell') side = b.conductor === 'buy' ? 'ask' : 'bid';
      // C2: trade a good market, the side that lays off at a profit, and
      // see whether the arb gets done. A market with nothing in it is left.
      else if (b.conductor === 'good') side = Math.max(layBid, layAsk) > 1e-9 ? (layAsk >= layBid ? 'ask' : 'bid') : null;
      else if (this.R.chance(0.5)) side = offBid > 1e-9 || offAsk > 1e-9 ? (offBid >= offAsk ? 'bid' : 'ask') : null;
      else if (this.R.chance(0.75)) {
        const v = E.vega(this.model, t);
        const dir = this.flow && (this.R.chance(0.8) ? this.flow.dir : -this.flow.dir);
        side = this.flow && Math.abs(v) > 0.05 ? (v * dir > 0 ? 'ask' : 'bid') : this.R.chance(0.5) ? 'bid' : 'ask';
      }
      if (side) {
        const mq = this.board.mine[t];
        this.hitMine(t, side, Math.min(b.size, mq[side + 'Size']));
        this.afterHit = { board: clone(this.board) };
        this.phase = 'hedge';
      } else if (this.beatTrades.length) {
        this.phase = 'hedge';
      } else {
        this.finish();
      }
      return { ev, trade: side ? this.trades[this.trades.length - 1] : null };
    }

    // ---------- trading and posting ----------

    // Lift an offer or hit a bid of the room's. side is yours: 'buy' lifts.
    trade(qid, side, qty) {
      const q = this.board.quotes[qid];
      if (!q) return { error: 'Nothing quoted there.' };
      const s = side === 'buy' ? 'ask' : 'bid';
      const px = q[s], avail = sz(q, s);
      if (px == null || avail <= 0) return { error: `No ${side === 'buy' ? 'offer' : 'bid'} in the ${E.label(qid)}.` };
      if (!(qty > 0)) return { error: 'Enter a quantity.' };
      if (qty > avail + 1e-9) return { error: `Only ${n2(avail)} there.` };
      if (this.phase === 'pick' && qid !== 'S' && this.beatTrades.some(t => t.id !== 'S')) return { error: 'One trade only.' };
      q[s + 'Size'] = avail - qty;
      const tr = { id: qid, side, qty, price: px, who: 'board', beat: this.n };
      this.trades.push(tr);
      // Trading with the market's own order is flow too.
      if (q.conductor) this.recordFlow(tr);
      this.actions.push({ kind: 'trade', tr });
      if (this.phase === 'pick' && qid !== 'S') this.phase = 'hedge';
      return { trade: tr };
    }

    // Rest a bid ('buy') or an offer ('sell') of your own. A price that
    // reaches the room's is a trade instead: the caller should trade.
    post(id, side, price, qty) {
      if (!(price > 0)) return { error: 'Enter a price.' };
      if (!(qty > 0)) return { error: 'Enter a quantity.' };
      const s = side === 'buy' ? 'bid' : 'ask', o = side === 'buy' ? 'ask' : 'bid';
      const r = this.board.quotes[id];
      if (r && r[o] != null && sz(r, o) > 0 && (side === 'buy' ? price >= r[o] : price <= r[o])) return { cross: true, price: r[o] };
      const m = this.board.mine[id] || { bid: null, ask: null, bidSize: 0, askSize: 0 };
      if (m[o] != null && m[o + 'Size'] > 0 && (side === 'buy' ? price >= m[o] : price <= m[o])) {
        return { error: `That ${side === 'buy' ? 'bid' : 'offer'} crosses your own ${side === 'buy' ? 'offer' : 'bid'}.` };
      }
      this.actions.push({ kind: 'post', id, prev: this.board.mine[id] ? { ...this.board.mine[id] } : null });
      this.board.mine[id] = { ...m, [s]: price, [s + 'Size']: qty };
      this.posts.push({ id, side, price, qty });
      return { posted: true };
    }

    // Take one side of your quote down.
    pull(id, s) {
      const m = this.board.mine[id];
      if (!m) return;
      this.actions.push({ kind: 'post', id, prev: { ...m } });
      m[s] = null; m[s + 'Size'] = 0;
      if (m.bid == null && m.ask == null) delete this.board.mine[id];
    }

    canUndo() { return this.actions && this.actions.length > 0; }
    undo() {
      const a = this.actions && this.actions.pop();
      if (!a) return;
      if (a.kind === 'trade') {
        const t = a.tr;
        this.trades.splice(this.trades.indexOf(t), 1);
        if (this.flow && t.flowV) this.flow.vega -= t.flowV;
        const q = this.board.quotes[t.id];
        const s = t.side === 'buy' ? 'ask' : 'bid';
        if (q) { q[s] = t.price; q[s + 'Size'] = (q[s + 'Size'] || 0) + t.qty; }
        if (this.beat.type === 'pick' && !this.beatTrades.some(x => x.id !== 'S')) this.phase = 'pick';
      } else {
        if (a.prev) this.board.mine[a.id] = a.prev; else delete this.board.mine[a.id];
        const i = this.posts.map(p => p.id).lastIndexOf(a.id);
        if (i >= 0) this.posts.splice(i, 1);
      }
    }

    // Pass on a walked price: the market moves to the next level.
    canStep() {
      const b = this.beat;
      return !!(b && b.walk && b.stepIdx < b.walk.steps.length - 1 && !this.beatTrades.length);
    }
    pass() {
      if (!this.canStep()) return this.wrapUp();
      this.beat.stepIdx++;
      Sc.applyStep(this.board, this.beat);
      this.start = { board: clone(this.board), model: clone(this.model) };
      return null;
    }

    // Done with an order on the board: on to your market in it, if the
    // question asks for one (O5), else judge.
    wrapUp() {
      const b = this.beat;
      if (this.phase === 'opp' && b.askAfter && !b.asked) {
        b.asked = true;
        b.orderTrades = this.beatTrades.length;
        this.oppStart = this.start;
        this.oppEvents = this.events();
        // The order comes off; your market is the market in it now.
        delete this.board.quotes[b.askAfter];
        b.target = b.askAfter;
        this.board.changed = new Set([b.askAfter]);
        this.phase = 'ask';
        return null;
      }
      return this.finish();
    }

    finish() {
      const b = this.beat;
      this.judged = b.type === 'pick' ? this.judgePick()
        : b.targets ? this.judgeWidth()
        : b.type === 'opp' ? this.judgeOpp()
        : this.judgeHit();
      this.results.push(this.judged);
      this.phase = 'judge';
      this.queueFollowUp();
      this.history.push({
        n: this.n, q: this.questionNo, title: this.judged.title, judged: this.judged,
        quotes: this.explainQuotes(), mine: clone(this.board.mine), hit: this.hit && { ...this.hit },
        trades: clone(this.trades), target: b.target || null,
      });
      return this.judged;
    }

    // Holding a single option: the next question is your market in its
    // partner, with the room's quote pulled, so you can lean for the exit.
    // Skipped if you are flat, or already quoting the partner yourself.
    queueFollowUp() {
      const b = this.beat, h = this.hit;
      // C4: once a market the conductor traded is laid off, ask for it again.
      if (this.session.chain && b.type === 'make' && !b.followUp && !b.refresh && h && h.id === b.target && this.status().flat) {
        this.queue.push({ type: 'make', target: b.target, size: b.size, conductor: 'good', refresh: true, pre: [{ op: 'pull', id: b.target }] });
        return;
      }
      if (!h || !isOption(h.id) || b.followUp || b.type === 'pick') return;
      if (this.status().flat) return;
      const fill = this.fills[0];
      if (!fill || !isOption(fill.id)) return;
      const exit = partnerOf(fill.id);
      if (this.posts.some(p => p.id === exit)) return;
      // Already paired off against the partner: nothing to lean for.
      if (this.trades.some(t => t !== fill && t.id === exit)) return;
      const lv = this.levels(fill);
      if (!lv || !(lv.be > 0)) return;
      this.queue.push({ type: 'make', target: exit, size: fill.qty,
        followUp: { from: this.n, fill, exitSide: lv.partnerSide, be: lv.be },
        pre: [{ op: 'pull', id: exit }] });
    }

    // ---------- what is on the board ----------

    top(id, quotes = this.board.quotes, mine = this.board.mine) { return topOf(quotes, mine, id); }

    question() {
      const b = this.beat;
      if (!b) return '';
      if (b.type === 'pick') return 'Which one trade?';
      if (b.type === 'make' || this.phase === 'ask') {
        const was = b.widen && this.mineBefore[b.target];
        if (was && was.bid != null && was.ask != null) return `${b.ti > 0 ? 'And your' : 'Update your'} market in the ${E.label(b.target)}: you were ${fmtP(was.bid)} / ${fmtP(was.ask)}.`;
        if (b.targets && b.ti > 0) return `And your market in the ${E.label(b.target)}?`;
        return `What's your market in the ${E.label(b.target)}?`;
      }
      return 'What do you do?';
    }

    // Everything that changed on the board for this beat, as short statements.
    events() {
      const out = [];
      const ch = this.board.changed ? [...this.board.changed] : [];
      const b = this.beat;
      if (b && b.type === 'pick') return [b.say];
      if (this.flowNews) out.push(this.flowNews);
      for (const qid of ch) {
        if (this.flowIds && this.flowIds.has(qid) && !(b && b.followUp && qid === b.target)) continue;
        if (b && this.phase === 'ask' && qid === b.target && !b.followUp && !b.asked) continue;
        if (b && b.asked && qid === b.target) { out.push(`The order's gone.`); continue; }
        if (this.board.mine[qid] && !this.board.quotes[qid] && !(b && b.followUp && qid === b.target)) continue;
        const q = this.board.quotes[qid];
        const name = E.label(qid);
        if (!q) { out.push(`The ${name} market is gone.`); continue; }
        if (qid === 'S') { out.push(`Stock now ${fmtP(q.bid)} / ${fmtP(q.ask)}${b && b.widen ? `: ${fmtP(q.ask - q.bid)} wide` : ''}.`); continue; }
        if (q.conductor) {
          const o = q.orig && q.orig !== 'none' ? q.orig : {};
          if (q.bid != null && q.bid !== o.bid) out.push(`Bid ${fmtP(q.bid)} in the ${name}, ${n2(q.bidSize)} lots.`);
          if (q.ask != null && q.ask !== o.ask) out.push(`Offer ${fmtP(q.ask)} in the ${name}, ${n2(q.askSize)} lots.`);
          continue;
        }
        if (q.bid != null && q.ask != null) out.push(`The ${name} is now ${fmtP(q.bid)} / ${fmtP(q.ask)}.`);
        else if (q.bid != null) out.push(`The ${name} is now ${fmtP(q.bid)} bid, no offer.`);
        else out.push(`The ${name} is now offered at ${fmtP(q.ask)}, no bid.`);
      }
      return out;
    }

    beatTitle() {
      const b = this.beat;
      if (b.type === 'react') return `The market ${this.hit.conductor === 'sell' ? 'sold you' : 'bought'} ${n2(this.hit.qty)} ${E.label(this.hit.id)} at ${fmtP(this.hit.price)}`;
      if (b.type === 'pick') return `Stock ${b.move > 0 ? 'up' : 'down'} ${fmtP(Math.abs(b.move))}: one trade on a stale board`;
      if (b.targets) return `Stock ${fmtP(2 * b.widen + (b.stockBefore.ask - b.stockBefore.bid))} wide: ${b.targets.map(t => E.label(t)).join(' and ')}`;
      if (b.type === 'make') return `Market in the ${E.label(b.target)}${b.followUp ? ' (to get out)' : ''}`;
      const ev = (this.oppEvents || this.events());
      return ev.length ? ev.join(' ') : 'Opportunity';
    }

    // The board the explanation points at: as it was when the beat started.
    explainQuotes() { return clone((this.oppStart || this.start).board.quotes); }

    // ---------- the book ----------

    status(trades = this.trades) {
      const pos = E.position(trades);
      const d = E.positionDelta(this.model, trades);
      const pnl = trades.reduce((a, t) => a + E.edge(this.model, t), 0);
      return { pos, delta: d, pnl, flat: E.isFlat(pos), holdings: E.holdings(trades) };
    }

    netVega(trades = this.trades) {
      return trades.reduce((a, t) => a + (t.side === 'buy' ? 1 : -1) * t.qty * E.vega(this.model, t.id), 0);
    }

    // Is the book still carrying delta the player should have hedged?
    unhedged() {
      if (!this.beatTrades.length) return false;
      const st = this.status();
      if (st.flat) return false;
      const first = this.beatTrades.find(x => x.id !== 'S');
      const gross = first ? Math.abs(first.qty * E.delta(this.model, first.id)) : 0;
      return Math.abs(st.delta) > Math.max(1, 0.1 * gross);
    }

    // ---------- the synthetic future (P3) ----------
    //
    // A fill in an option at strike K pairs with its partner: bought put +
    // sold call is a short future at K + C - P; bought call + sold put is a
    // long one. The stock closes it. Returns the partner side you need, the
    // stock side, and the break-even partner price against the stock.
    levels(fill, S = this.start.board.quotes.S) {
      if (!isOption(fill.id)) return null;
      const K = strikeOf(fill.id), isCall = fill.id[0] === 'C', bought = fill.side === 'buy';
      const longFut = isCall === bought;                // long call or short put
      const partnerSide = bought ? 'sell' : 'buy';
      const stockSide = longFut ? 'sell' : 'buy';
      const s = longFut ? S.bid : S.ask;
      // F = K + C - P equals s at break-even.
      const be = isCall ? K + fill.price - s : s - K + fill.price;
      const fut = py => (isCall ? K + fill.price - py : K + py - fill.price);
      const edge = py => (longFut ? s - fut(py) : fut(py) - s);
      return { K, isCall, longFut, partner: partnerOf(fill.id), partnerSide, stockSide, s, be, fut, edge };
    }

    // "K + C − P" written out with the numbers.
    futText(K, c, p) { return `${K} + ${fmtP(c)} − ${fmtP(p)} = ${fmtP(K + c - p)}`; }

    // ---------- explanations (E1-E5 in PRINCIPLES.md) ----------
    //
    // Short and specific: one line that prices the instrument from the
    // board, then the trade that happened and what it lets you do. A "why"
    // is a sentence or two about this case.

    whySynth(K) {
      return `A call bought and a put sold at ${K} is a future bought at ${K} + C − P; the reverse is one sold. Compare it with the stock.`;
    }
    whyHedge(fill) {
      const d = E.delta(this.model, fill.id), S = this.start.board.quotes.S, half = (S.ask - S.bid) / 2;
      const sh = (fill.side === 'buy' ? 1 : -1) * fill.qty * d;
      return `${n2(fill.qty)} × ${signed(d)} delta is ${signed(Math.round(sh))} shares.${half > 0 ? ` Crossing the stock costs ${n2(Math.abs(d))} × ${n2(half)} = ${n2(Math.abs(d) * half)} a lot.` : ''}`;
    }
    whyLean(fill, lv) {
      return `Break-even is the ${E.label(lv.partner)} price where ${lv.K} + C − P equals the stock you hedged with (${fmtP(lv.s)}). Any ${lv.partnerSide === 'sell' ? 'offer above' : 'bid below'} it arbs you to flat if it trades.`;
    }
    whyTheo(id) {
      const inst = E.parse(id);
      const w = {
        C: 'A call and a put on one strike carry the same extrinsic value: P = C − S + K.',
        P: 'A call and a put on one strike carry the same extrinsic value: P = C − S + K.',
        V: inst.kind === 'V' ? `Call plus put: ${n2(E.callTheo(this.model, inst.k))} + ${n2(E.putTheo(this.model, inst.k))} = ${n2(E.theo(this.model, id))}.${Math.abs(this.model.S - inst.k) < 1e-9 ? ' At the money they are the same, so it is twice either.' : ''}` : '',
        CS: `${signsOf(id)}: buying a call spread buys the lower strike and sells the upper. It is worth between 0 and the gap.`,
        PS: `${signsOf(id)}: buying a put spread buys the upper strike and sells the lower, the opposite diagonal from a call spread. With the call spread it makes a box worth the gap.`,
        BOX: 'Call spread plus put spread on the same strikes pays the gap, whatever happens.',
        FLY: `${signsOf(id)}: the lower spread less the upper. A put fly and a call fly are the same.`,
      }[inst.kind] || '';
      return w + this.flowWhy();
    }
    whyRoute(id, route) {
      const ids = (route || []).map(r => r.id);
      if (isOption(id) && ids.includes(partnerOf(id))) return this.whySynth(E.parse(id).k);
      if (/^V/.test(id) && ids.includes('S')) return 'A put is a call less a share plus K, so two calls and a share sold make the straddle.';
      if (ids.some(x => /^(CS|PS|BOX)/.test(x)) && /^(CS|PS)/.test(id)) return 'Call spread + put spread is a box worth the gap, so a sold call spread is arbed by selling the put spread too.';
      return this.whyTheo(id);
    }

    // "100 call 3.8 / 3.98", "90 put 0.7 bid".
    quoteText(quotes, id) {
      const q = quotes[id];
      if (!q) return '';
      if (q.bid != null && q.ask != null) return `${E.label(id)} ${fmtP(q.bid)} / ${fmtP(q.ask)}`;
      return q.bid != null ? `${E.label(id)} ${fmtP(q.bid)} bid` : `${E.label(id)} offered ${fmtP(q.ask)}`;
    }

    // The relationship that prices `id` off the legs the board used.
    ruleFor(id, used) {
      const inst = E.parse(id), has = re => used.some(x => re.test(x));
      if (inst.kind === 'C' || inst.kind === 'P') {
        if (used.includes(partnerOf(id))) return `Same extrinsic as the ${E.label(partnerOf(id))}`;
        const sp = used.filter(x => /^(CS|PS|V|FLY)/.test(x));
        return sp.length ? `Through the ${sp.map(x => E.label(x)).join(' and ')}` : 'From the board';
      }
      if (inst.kind === 'V') {
        const atm = Math.abs(this.model.S - inst.k) < 1e-9;
        if (atm && used.includes('C' + inst.k) && !used.includes('P' + inst.k)) return 'At the money, twice the call';
        if (atm && used.includes('P' + inst.k) && !used.includes('C' + inst.k)) return 'At the money, twice the put';
        return 'Call plus put';
      }
      if (inst.kind === 'CS') return has(/^(PS|BOX)/) ? `Box: ${inst.k2 - inst.k1} less the put spread` : 'Lower call less upper call';
      if (inst.kind === 'PS') return has(/^(CS|BOX)/) ? `Box: ${inst.k2 - inst.k1} less the call spread` : 'Upper put less lower put';
      if (inst.kind === 'FLY') return signsOf(id);
      if (inst.kind === 'BOX') return 'Call spread plus put spread';
      return 'From the board';
    }

    // E1: one line pricing `id` from the board as the question started.
    priceStep(id) {
      const room = Sc.roomBoard(this.start.board), T = E.theo(this.model, id);
      const imp = posBid(E.implied(room, id));
      const mark = { id, side: null, act: 'you', note: `theo ${n2(T)}` };
      const routes = [...(imp.bidRoute || []), ...(imp.askRoute || [])];
      const used = [...new Set(routes.map(r => r.id))].filter(x => x !== id);
      const S = room.quotes.S, choice = S && S.bid === S.ask;
      const ks = new Set(this.legsOf(id).map(x => x.slice(1)));
      // A straddle at a strike the structure needs stands in for that leg:
      // "100 put 4.025 / 4.075 from the straddle".
      const legs = [];
      let viaV = false;
      for (const x of used.filter(x => x !== 'S').sort((p, q) => (parseFloat(p.replace(/^\D+/, '')) - parseFloat(q.replace(/^\D+/, ''))))) {
        const k = x.slice(1);
        const leg = /^[CPV]\d/.test(x) && !isOption(id) && !/^V/.test(id) && ks.has(k) ? this.legsOf(id).find(l => l.slice(1) === k) : null;
        if (leg && leg !== x) {
          if (legs.some(t => t.startsWith(E.label(leg) + ' '))) continue;
          const li = posBid(E.implied(room, leg));
          const m = li.bid != null && li.ask != null ? `${fmtP(li.bid)} / ${fmtP(li.ask)}` : li.bid != null ? `${fmtP(li.bid)} bid` : li.ask != null ? `offered ${fmtP(li.ask)}` : null;
          if (m) { legs.push(`${E.label(leg)} ${m} from the ${/^V/.test(x) ? 'straddle' : x[0] === 'C' ? 'call' : 'put'}`); viaV = true; continue; }
        }
        const t = this.quoteText(room.quotes, x);
        if (t) legs.push(t);
      }
      // The stock matters to parity; on a choice stock behind a straddle it is just the conversion.
      if (used.includes('S') && S && !(choice && viaV && !isOption(id))) legs.push(`stock ${choice ? fmtP(S.bid) : `${fmtP(S.bid)} / ${fmtP(S.ask)}`}`);
      const mkt = imp.bid != null && imp.ask != null ? `${fmtP(imp.bid)} / ${fmtP(imp.ask)}` : imp.bid != null ? `${fmtP(imp.bid)} bid` : imp.ask != null ? `offered ${fmtP(imp.ask)}` : null;
      if (!mkt) return { text: `Nothing on the board prices it: theo ${n2(T)}.`, why: this.whyTheo(id), marks: [mark] };
      const rule = this.ruleFor(id, used);
      return { text: `${rule}: ${legs.join(', ')} → ${E.label(id)} ${mkt}, theo ${n2(T)}.`,
        why: /^Through/.test(rule) ? `A spread plus its other leg rebuilds the option: the ${E.label(id)} is the ${used.filter(x => /^(PS|CS)/.test(x)).map(x => E.label(x)).join(' and ')} plus the leg next to it.` : this.whyTheo(id),
        marks: [mark, ...used.filter(x => x !== 'S').map(x => ({ id: x, side: null, act: 'ref', note: '' }))] };
    }
    theoStep(t) { return this.priceStep(t); }

    // The options a structure is made of, in the kind it is quoted in.
    legsOf(id) {
      const i = E.parse(id);
      switch (i.kind) {
        case 'CS': return ['C' + i.k1, 'C' + i.k2];
        case 'PS': return ['P' + i.k2, 'P' + i.k1];
        case 'FLY': { const t = this.start.board.quotes['P' + i.k1] || this.start.board.quotes['P' + i.k3] ? 'P' : 'C'; return [t + i.k1, t + i.k2, t + i.k3]; }
        case 'BOX': return ['C' + i.k1, 'C' + i.k2, 'P' + i.k2, 'P' + i.k1];
        default: return [id];
      }
    }

    // E2: where to lean to get out, for any fill with no arb.
    leanText(fill) {
      const id = fill.id, inst = E.parse(id), bought = fill.side === 'buy', p = fill.price;
      if (inst.kind === 'V') {
        const S = this.model.S, e = (p - Math.abs(S - inst.k)) / 2;
        const c = e + Math.max(S - inst.k, 0), pu = e + Math.max(inst.k - S, 0);
        const legs = Math.abs(c - pu) < 1e-9 ? `the ${inst.k} call or put ${bought ? 'down' : 'up'} to ${fmtP(c)}` : `the ${inst.k} call ${bought ? 'down' : 'up'} to ${fmtP(c)} or the put to ${fmtP(pu)}`;
        return `${bought ? 'Offer above' : 'Bid below'} ${fmtP(p)} to get out: the straddle, or ${legs}.`;
      }
      return `${bought ? 'Offer it above' : 'Bid it below'} ${fmtP(p)} to get out.`;
    }

    // ---------- the story of a fill (A1-A5, E2) ----------
    fillSteps(fill, board) {
      const m = this.model, id = fill.id, q = fill.qty, bought = fill.side === 'buy';
      const T = E.theo(m, id), e = bought ? T - fill.price : fill.price - T;
      const steps = [], out = { steps, bestLock: 0, lv: null };
      const head = `You ${bought ? 'bought' : 'sold'} ${n2(q)} ${E.label(id)} at ${fmtP(fill.price)}, theo ${n2(T)}: ${signed(e)} a lot.`;
      const hitMark = { id, side: bought ? 'bid' : 'ask', act: 'you', note: `${bought ? 'bought' : 'sold'} ${n2(q)}` };
      const best = E.bestLayoff(board, E.position([fill]));
      out.bestLock = best ? best.locked : 0;
      const delta = (bought ? 1 : -1) * q * E.delta(m, id);
      const hedgeN = Math.round(Math.abs(delta)), hedgeSide = delta > 0 ? 'sell' : 'buy';
      const hedgeMark = { id: 'S', side: hedgeSide === 'buy' ? 'ask' : 'bid', act: hedgeSide, note: `${hedgeSide} ${hedgeN}` };
      const hedge = hedgeN ? `${hedgeSide === 'buy' ? 'Buy' : 'Sell'} ${hedgeN} stock to be delta flat` : '';

      if (!isOption(id)) {
        const imp = posBid(E.implied(Sc.roomBoard(board), id));
        const back = bought ? imp.bid : imp.ask;
        const short = `You ${bought ? 'bought' : 'sold'} ${n2(q)} ${E.label(id)} at ${fmtP(fill.price)}.`;
        const inst = E.parse(id), boxP = inst.kind === 'CS' ? `PS${inst.k1}/${inst.k2}` : inst.kind === 'PS' ? `CS${inst.k1}/${inst.k2}` : null;
        const viaBox = best && best.route.length === 1 && best.route[0].id === boxP;
        if (viaBox) {
          const r = best.route[0], gap = inst.k2 - inst.k1, per = best.locked / q;
          steps.push({ text: `${short} ${r.side === 'sell' ? 'Sell' : 'Buy'} the ${E.label(boxP)} at ${fmtP(r.price)} too: that's ${bought ? 'a long' : 'a short'} box, ${bought ? `${gap} − ${fmtP(fill.price)} − ${fmtP(r.price)}` : `${fmtP(fill.price)} + ${fmtP(r.price)} − ${gap}`} = ${signed(per)} a lot. Arb to flat: ${signed(best.locked)}.`,
            why: this.whyRoute(id, best.route), marks: [hitMark, ...routeMarks(best.route, q)] });
          return out;
        }
        if (best && best.locked > 1e-6) {
          steps.push({ text: `${short} ${bought ? 'Sell' : 'Buy'} it back on the board: ${routeShort(best.route, q)}. Arb to flat: ${signed(best.locked)}.`,
            why: this.whyRoute(id, best.route), marks: [hitMark, ...routeMarks(best.route, q)] });
          return out;
        }
        const ed = back != null ? (bought ? back - fill.price : fill.price - back) : null;
        steps.push({ text: `${head} ${back == null ? 'No arb on the board: hold it.' : `${bought ? 'Selling' : 'Buying'} it back on the board at ${fmtP(back)} ${ed < -1e-9 ? `loses ${n2(-ed)} a lot` : 'has nothing in it'}: hold it.`}`,
          why: /^(CS|PS)/.test(id) ? `Spreads between close strikes hold their value through a session. Worth ${n2(T)}, it is a hold even when arbing out loses a little.` : '',
          marks: [hitMark] });
        const vWhy = /^V/.test(id) ? (() => { const k = E.parse(id).k, e = (fill.price - Math.abs(this.model.S - k)) / 2;
          return `${bought ? 'Buying' : 'Selling'} the straddle at ${fmtP(fill.price)} ${bought ? 'buys' : 'sells'} ${fmtP(e)} of extrinsic in each leg. A vol level is an extrinsic level: ${bought ? 'selling' : 'buying'} the call or the put back ${bought ? 'above' : 'below'} it ${bought ? 'sells' : 'buys'} that vol back at a profit.`; })() : '';
        steps.push({ text: `${hedge ? hedge + ', and ' + this.leanText(fill).toLowerCase() : this.leanText(fill)}`, why: [hedge ? this.whyHedge(fill) : '', vWhy].filter(Boolean).join(' '), marks: hedgeN ? [hedgeMark] : [] });
        return out;
      }

      const lv = this.levels(fill);
      out.lv = lv;
      const P = lv.partner, K = lv.K;
      const cp = (px, py) => (lv.isCall ? [px, py] : [py, px]);

      // Completes a synthetic with the partner already in the book.
      const earlier = this.trades.filter(t => t !== fill && t.id === P);
      const net = earlier.reduce((a, t) => a + (t.side === 'buy' ? t.qty : -t.qty), 0);
      const want = bought ? -1 : 1;
      if (net * want > 1e-9) {
        const legs = earlier.filter(t => (t.side === 'buy' ? 1 : -1) === want);
        const py = legs.reduce((a, t) => a + t.price * t.qty, 0) / legs.reduce((a, t) => a + t.qty, 0);
        const stock = this.trades.filter(t => t.id === 'S' && t.side === lv.stockSide && t.beat < this.n);
        const sPx = stock.length ? stock.reduce((a, t) => a + t.price * t.qty, 0) / stock.reduce((a, t) => a + t.qty, 0) : lv.s;
        const [c, p] = cp(fill.price, py);
        const ed = lv.longFut ? sPx - (K + c - p) : (K + c - p) - sPx;
        const before = this.trades.filter(t => t.beat < this.n || t === fill);
        const n = Math.round(-E.positionDelta(this.model, before));
        steps.push({ text: `${head} With the ${E.label(P)} you ${want > 0 ? 'bought' : 'sold'} at ${fmtP(py)}, that's ${lv.longFut ? 'a long' : 'a short'} future at ${this.futText(K, c, p)} against stock ${lv.stockSide === 'sell' ? 'sold' : 'bought'} at ${fmtP(sPx)}: ${signed(ed)} a lot.${n ? ` ${n > 0 ? 'Buy' : 'Sell'} ${Math.abs(n)} more stock to hedge to delta flat.` : ''}`,
          why: this.whySynth(K), marks: [hitMark, ...(n ? [{ id: 'S', side: n > 0 ? 'ask' : 'bid', act: n > 0 ? 'buy' : 'sell', note: `${n > 0 ? 'buy' : 'sell'} ${Math.abs(n)}` }] : [])] });
        out.paired = true;
        return out;
      }

      // Against the board: the partner and the stock (P3).
      const pq = board.quotes[P];
      const ps = lv.partnerSide === 'sell' ? 'bid' : 'ask';
      const py = pq && pq[ps] != null && sz(pq, ps) > 0 ? pq[ps] : null;
      const pT = E.theo(m, P);
      let lean = lv.partnerSide === 'sell' ? E.ceilT(pT) : E.floorT(pT);
      if (lv.partnerSide === 'sell' ? lean <= lv.be : lean >= lv.be) lean = lv.partnerSide === 'sell' ? lv.be + E.TICK : lv.be - E.TICK;
      const leanEdge = lv.partnerSide === 'sell' ? lean - lv.be : lv.be - lean;
      out.lean = { id: P, side: lv.partnerSide, price: lean, edge: leanEdge };
      const leanMark = { id: P, side: py != null ? ps : null, act: 'you', note: `break-even ${fmtP(lv.be)}` };
      const futLine = py != null ? (() => {
        const [c, p] = cp(fill.price, py), ed = lv.edge(py);
        return ` ${lv.partnerSide === 'sell' ? 'Sell' : 'Buy'} the ${E.label(P)} at ${fmtP(py)} against it and you've ${lv.longFut ? 'bought' : 'sold'} the future at ${this.futText(K, c, p)}. Stock ${lv.longFut ? 'bid' : 'offered'} at ${fmtP(lv.s)}: ${ed > 1e-9 ? `${signed(ed)} a lot.` : ed < -1e-9 ? `that loses ${n2(-ed)} a lot.` : 'no arb.'}`;
      })() : '';
      const futMarks = py != null ? [{ id: P, side: ps, act: lv.partnerSide, note: `${lv.partnerSide} ${fmtP(py)}` }, { id: 'S', side: lv.stockSide === 'buy' ? 'ask' : 'bid', act: lv.stockSide, note: `${lv.stockSide} ${fmtP(lv.s)}` }] : [];
      const leanLine = `${lv.partnerSide === 'sell' ? 'offer' : 'bid'} the ${E.label(P)} at ${fmtP(lean)}: ${signed(leanEdge)} a lot if it trades`;
      if (best && best.locked > 1e-6) {
        steps.push({ text: `You ${bought ? 'bought' : 'sold'} ${n2(q)} ${E.label(id)} at ${fmtP(fill.price)}.${futLine} Arb to flat for all ${n2(q)}: ${signed(best.locked)}.`,
          why: this.whySynth(K), marks: [hitMark, ...routeMarks(best.route, q)] });
        // A resting price can beat crossing (A3); say so only when it does.
        if (leanEdge > best.locked / q + 1e-9) steps.push({ text: `Or ${hedge ? hedge.toLowerCase() + ' and ' : ''}${leanLine}, against ${signed(best.locked / q)} crossing now.`,
          why: `${this.whyLean(fill, lv)} ${this.whyPartner(fill, lv)}`, marks: [leanMark, ...(hedgeN ? [hedgeMark] : [])] });
        return out;
      }
      steps.push({ text: `${head}${futLine || ' No arb on the board.'}`, why: `${this.whySynth(K)} ${py != null ? this.whyPartner(fill, lv) : ''}`.trim(), marks: [hitMark, ...futMarks] });
      if (!(lv.be > 0)) {
        if (hedge) steps.push({ text: `Hold it: ${hedge.toLowerCase()}.`, why: this.whyHedge(fill), marks: [hedgeMark] });
        return out;
      }
      steps.push({ text: `Hold it: ${hedge ? hedge.toLowerCase() + ', then ' : ''}${lv.partnerSide === 'sell' ? 'offer' : 'bid'} the ${E.label(P)} ${lv.partnerSide === 'sell' ? 'above' : 'below'} ${fmtP(lv.be)}, say ${fmtP(lean)} (${signed(leanEdge)} a lot if it trades).`,
        why: `${hedge ? this.whyHedge(fill) + ' ' : ''}${this.whyLean(fill, lv)}`, marks: [leanMark, ...(hedgeN ? [hedgeMark] : [])] });
      return out;
    }
    whyPartner(fill, lv) {
      const K = lv.K, p = fill.price, s = lv.s, v = fill.side === 'buy' ? 'buying' : 'selling';
      return fill.id[0] === 'P'
        ? `${v[0].toUpperCase() + v.slice(1)} the ${K} put at ${fmtP(p)} with stock at ${fmtP(s)} is ${v} the ${K} call at ${fmtP(p)} + ${fmtP(s)} − ${K} = ${fmtP(p + s - K)}.`
        : `${v[0].toUpperCase() + v.slice(1)} the ${K} call at ${fmtP(p)} with stock at ${fmtP(s)} is ${v} the ${K} put at ${fmtP(p)} − ${fmtP(s)} + ${K} = ${fmtP(p - s + K)}.`;
    }

    // Your resting prices this beat, against break-even (A3).
    leanVerdicts(lv, fill) {
      const out = [];
      for (const p of this.posts) {
        if (lv && p.id === lv.partner && p.side === lv.partnerSide) {
          const ed = lv.partnerSide === 'sell' ? p.price - lv.be : lv.be - p.price;
          out.push(ed > 1e-9 ? ['good', `Your ${fmtP(p.price)} ${p.side === 'buy' ? 'bid' : 'offer'} in the ${E.label(p.id)}: ${signed(ed)} a lot if it trades.`]
            : ['bad', `Your ${fmtP(p.price)} ${p.side === 'buy' ? 'bid' : 'offer'} in the ${E.label(p.id)} is through break-even ${fmtP(lv.be)}.`]);
        } else if (fill && p.id === fill.id && (p.side === 'buy') === (fill.side === 'buy')) {
          const worse = fill.side === 'buy' ? p.price > fill.price : p.price < fill.price;
          if (worse) out.push(['warn', `You're ${fill.side === 'buy' ? 'long' : 'short'} the ${E.label(fill.id)}: ${fill.side === 'buy' ? 'bidding higher' : 'offering lower'} adds to it at a worse price.`]);
        }
      }
      return out;
    }

    // A7: trades that add up to one structure, held, are a position, not an arb.
    positionVerdict() {
      const own = this.beatTrades.filter(t => t.who === 'board');
      if (!own.length || this.status().flat) return null;
      const st = structureOf(own, this.board.strikes);
      if (!st) return null;
      const long = st.qty > 0, imp = E.implied(Sc.roomBoard(this.board), st.id);
      const back = long ? imp.bid : imp.ask;
      if (back == null) return ['warn', `That's ${long ? 'long' : 'short'} the ${E.label(st.id)} at ${fmtP(st.price)}: a position, not an arb.`];
      const ed = long ? back - st.price : st.price - back;
      return ed > 1e-9 ? ['warn', `That's ${long ? 'long' : 'short'} the ${E.label(st.id)} at ${fmtP(st.price)}, and the board ${long ? 'buys' : 'sells'} it back at ${fmtP(back)}: finish the arb.`]
        : ['bad', `That's ${long ? 'long' : 'short'} the ${E.label(st.id)} at ${fmtP(st.price)}: a position, not an arb. The board ${long ? 'buys it back' : 'sells it back'} at ${fmtP(back)}.`];
    }

    // M6: after the market buys (or sells) at one strike, the strike next to
    // it should go the same way.
    sympathyVerdict(ev) {
      if (!ev || !/^[CPV]\d/.test(ev.id)) return null;
      const k = +ev.id.replace(/^[CPV]/, ''), gap = this.board.spacing;
      const last = [...this.trades].reverse().find(t => t.fromMarket && t.beat < this.n && /^[CPV]\d/.test(t.id));
      if (!last || Math.abs(+last.id.replace(/^[CPV]/, '') - k) !== gap) return null;
      const bought = last.side === 'sell', m = (ev.bid + ev.ask) / 2;
      if (bought ? m >= ev.T - E.TICK / 2 : m <= ev.T + E.TICK / 2) return null;
      return ['warn', `The market just ${bought ? 'bought' : 'sold'} the ${E.label(last.id)}: that's ${bought ? 'buying' : 'selling'} vol. Lean the ${E.label(ev.id)} the same way, ${bought ? 'up' : 'down'}, not ${bought ? 'down' : 'up'}.`];
    }

    // E4: one line, only for money or a mistake.
    bookVerdict(first, st, book) {
      const gross = first ? Math.abs(first.qty * E.delta(this.model, first.id)) : 0;
      const ok = Math.abs(book.delta) <= Math.max(1, 0.1 * gross);
      if (book.flat) return book.pnl > 1e-9 ? ['good', `Book flat: ${signed(book.pnl)}.`] : book.pnl < -1e-9 ? ['bad', `Book flat, but at ${signed(book.pnl)}.`] : null;
      if (st.flat) return st.pnl > 1e-9 ? ['good', `Arbed to flat: ${signed(st.pnl)}.`] : st.pnl < -1e-9 ? ['bad', `Flat, but at ${signed(st.pnl)}.`] : null;
      return ok ? null : ['bad', `Delta not hedged: ${signed(Math.round(book.delta))} shares in the book.`];
    }

    // ---------- judging ----------

    // Your market against the board (M1, M2, M3), E3: once a side has
    // traded, the other side isn't judged for being armable.
    quoteVerdict(ev, traded = false) {
      const ib = ev.imp.bid, ia = ev.imp.ask, tk = E.TICK;
      if (ev.arbBid) return ['bad', `Your ${fmtP(ev.bid)} bid is above the board's ${fmtP(ia)} offer: you can be arbed.`];
      if (ev.arbAsk) return ['bad', `Your ${fmtP(ev.ask)} offer is below the board's ${fmtP(ib)} bid: you can be arbed.`];
      if (!ev.containsTheo) return ['bad', `Your ${fmtP(ev.bid)} / ${fmtP(ev.ask)} doesn't contain theo ${n2(ev.T)}.`];
      if (traded) return null;
      if (ib != null && ev.bid >= ib - 1e-9) return ['warn', `Your ${fmtP(ev.bid)} bid is ${ev.bid > ib + 1e-9 ? 'inside' : 'on'} the board's ${fmtP(ib)}: if it's hit, you can only ${ev.bid > ib + 1e-9 ? 'lose' : 'scratch'}. Bid ${fmtP(Math.max(0, ib - tk))}.`];
      if (ia != null && ev.ask <= ia + 1e-9) return ['warn', `Your ${fmtP(ev.ask)} offer is ${ev.ask < ia - 1e-9 ? 'inside' : 'on'} the board's ${fmtP(ia)}: if it's lifted, you can only ${ev.ask < ia - 1e-9 ? 'lose' : 'scratch'}. Offer ${fmtP(ia + tk)}.`];
      const S = this.start.board.quotes.S, half = (S.ask - S.bid) / 2, cost = Math.abs(ev.D) * half;
      const thin = Math.min(ev.T - ev.bid, ev.ask - ev.T);
      if (isOption(ev.id) && thin < cost - 1e-9) return ['warn', `${n2(thin)} of edge on one side doesn't pay the hedge: ${n2(Math.abs(ev.D))} delta × ${n2(half)} = ${n2(cost)} a lot.`];
      return null;
    }

    // A make-a-market question (including a follow-up), or the market
    // trading one of your standing quotes. Told from what actually traded.
    judgeHit() {
      const b = this.beat, ev = this.marketEval, t = b.target;
      const steps = [], verdict = [];
      const add = v => { if (v) verdict.push(v); };
      const fu = b.followUp, fill = this.fills[0];

      if (fu && ev) {
        const f = fu.fill, lv = this.levels(f);
        const ys = fu.exitSide === 'sell' ? 'ask' : 'bid', yp = ev[ys];
        steps.push({ text: `You're ${f.side === 'buy' ? 'long' : 'short'} the ${E.label(f.id)} from ${fmtP(f.price)}: the ${E.label(t)} breaks even at ${fmtP(lv.be)}. ${fu.exitSide === 'sell' ? 'Offer above' : 'Bid below'} it.`,
          why: this.whyLean(f, lv), marks: [{ id: t, side: ys, act: 'you', note: `break-even ${fmtP(lv.be)}` }] });
        const ed = fu.exitSide === 'sell' ? yp - lv.be : lv.be - yp;
        add(ed > 1e-9 ? ['good', `Your ${fmtP(yp)} ${ys === 'ask' ? 'offer' : 'bid'} beats break-even ${fmtP(lv.be)}: ${signed(ed)} a lot if it trades.`]
          : ['bad', `Your ${fmtP(yp)} ${ys === 'ask' ? 'offer' : 'bid'} doesn't beat break-even ${fmtP(lv.be)}.`]);
      } else if (ev) {
        steps.push(this.priceStep(t));
        add(this.quoteVerdict(ev, !!fill));
        add(this.sympathyVerdict(ev));
      }

      const res = { type: b.type === 'react' ? 'react' : 'make', title: this.beatTitle(), verdict, steps, pnl: 0, bestLock: 0 };
      const mine = this.beatTrades;
      const st = this.status(mine), book = this.status();
      res.pnl = st.pnl;
      if (!fill) return res;
      const story = this.fillSteps(fill, this.afterHit.board);
      steps.push(...story.steps);
      res.bestLock = story.bestLock;
      verdict.push(...this.leanVerdicts(story.lv, fill));
      if (story.bestLock > 1e-6 && !st.flat && !book.flat && !this.posts.length) add(['warn', `There was an arb: ${signed(story.bestLock)} to flat on the board.`]);
      add(this.positionVerdict() || this.bookVerdict(fill, st, book));
      res.flat = book.flat;
      return res;
    }

    judgeOpp() {
      const b = this.beat, o = b.order;
      const sb = (this.oppStart || this.start).board;
      const best = E.bestArb(sb);
      const orderTrades = b.asked ? this.beatTrades.slice(0, b.orderTrades) : this.beatTrades;
      const st = this.status(orderTrades), book = this.status();
      const steps = [], verdict = [];
      const add = v => { if (v) verdict.push(v); };
      if (o) best.route.sort((x, y) => (y.id === o.id) - (x.id === o.id));
      const unit = best.route.length ? best.route[0].qty : 1;
      let impIds = null;
      if (o) {
        const imp = E.implied(sb, o.id);
        const other = o.side === 'bid' ? imp.ask : imp.bid, route = o.side === 'bid' ? imp.askRoute : imp.bidRoute;
        impIds = (route || []).map(r => r.id).sort().join();
        // O1: a bid is a chance to sell, an offer a chance to buy. In a
        // straddle or an option that is vol: sell it to the bid, buy the
        // same extrinsic back cheaper through the legs.
        const vol = /^[VCP]\d/.test(o.id), bid = o.side === 'bid';
        const legsTxt = route ? routeShort(route) : '';
        const lead = bid
          ? `${E.label(o.id)} bid ${fmtP(o.price)}: ${vol ? 'vol is bid, so sell it to them' : 'sell it to them'}`
          : `${E.label(o.id)} offered at ${fmtP(o.price)}: ${vol ? 'vol is offered, so buy it from them' : 'buy it from them'}`;
        steps.push({ text: other == null ? `${lead}, if the board gave an arb. It doesn't.`
          : `${lead}, and ${bid ? 'buy' : 'sell'} it back ${bid ? 'cheaper' : 'higher'} on the board: ${legsTxt} = ${fmtP(other)}.`,
          why: other == null ? '' : /^V/.test(o.id) && Math.abs(this.model.S - E.parse(o.id).k) < 1e-9
            ? `At the money the call and the put carry the same extrinsic, so a call at ${fmtP(other / 2)} is the straddle at ${fmtP(other)}. ${bid ? 'Selling' : 'Buying'} it at ${fmtP(o.price)} and ${bid ? 'buying' : 'selling'} it back at ${fmtP(other)} ${bid ? 'sells vol higher than you buy it' : 'buys vol lower than you sell it'}.`
            : this.whyRoute(o.id, route),
          marks: [{ id: o.id, side: o.side, act: 'ref', note: `${o.side === 'bid' ? 'bid' : 'offer'} ${fmtP(o.price)}` }, ...(route ? routeMarks(route) : [])] });
      }
      if (best.value > 1e-6) {
        const legs = best.route.filter(r => !o || r.id !== o.id);
        const same = o && legs.map(r => r.id).sort().join() === impIds;
        const thin = o && b.size > unit + 1e-9 ? legs.filter(r => r.id !== 'S').sort((x, y) => x.qty - y.qty)[0] : null;
        const thinSide = thin ? (thin.side === 'buy' ? 'offer' : 'bid') : '';
        steps.push({ text: `${o ? `Do it ${n2(unit)} times${thin ? `, as many as the ${E.label(thin.id)} ${thinSide} allows` : ''}` : 'There is an arb'}${same ? '' : `: ${routeShort(best.route, unit)}`}. Arb to flat: ${signed(best.value / unit)} a lot, ${signed(best.value)}.${thin ? ` Take the ${E.label(thin.id)} first: the ${E.label(o.id)} ${o.side} has ${n2(b.size)} to ${o.side === 'bid' ? 'sell into' : 'buy from'}.` : ''}`,
          why: thin ? 'Trade the scarce leg first and keep the size as your exit. If the order is being pushed one way, that is the side to be on.' : '', marks: routeMarks(best.route, unit) });
      } else {
        steps.push({ text: o ? 'Nothing in it.' : 'Nothing on the board to arb.', why: o ? 'An order is worth taking only if the board does the other side for less.' : '', marks: o ? [{ id: o.id, side: o.side, act: 'bad', note: 'no edge' }] : [] });
      }
      const res = { type: 'opp', title: this.beatTitle(), steps, verdict, pnl: st.pnl, best: best.value };
      const traded = orderTrades.length > 0;
      if (best.value <= 1e-6) {
        if (traded && !(st.flat && st.pnl > -1e-6)) add(['bad', `Nothing there: ${signed(st.pnl)} at theo.`]);
      } else if (!traded) {
        add(['bad', `Missed: ${signed(best.value)} was there.`]);
      } else if (st.flat) {
        add(st.pnl / best.value > 0.98 ? ['good', `Arbed to flat: ${signed(st.pnl)}.`]
          : st.pnl > 0 ? ['warn', `Arbed to flat: ${signed(st.pnl)} of ${signed(best.value)}. Check the size and the legs.`]
          : ['bad', `Flat, but at ${signed(st.pnl)}.`]);
      } else {
        // Traded the order but not the way out (or the reverse): say which.
        const tookOrder = o && orderTrades.some(t => t.id === o.id);
        const legs = best.route.filter(r => !o || r.id !== o.id);
        const legTxt = routeShort(legs, unit);
        if (tookOrder) add(['bad', `You ${o.side === 'bid' ? 'sold the' : 'bought the'} ${E.label(o.id)} ${o.side === 'bid' ? 'to the bid' : 'from the offer'} but didn't ${o.side === 'bid' ? 'buy it back' : 'sell it back'} on the board (${legTxt}): the arb was ${signed(best.value)}.`]);
        else if (o) add(['bad', `You traded the board but not the ${E.label(o.id)} ${o.side === 'bid' ? 'bid' : 'offer'}: the arb was ${signed(best.value)}.`]);
        else add(['bad', `Not arbed to flat: ${signed(best.value)} was there.`]);
      }
      add(this.positionVerdict());
      // Then your own market in it (O5).
      if (b.asked && this.marketEval) {
        const ev = this.marketEval, fill = this.fills[0];
        steps.push({ text: `Your ${fmtP(ev.bid)} / ${fmtP(ev.ask)} in the ${E.label(ev.id)}: the board makes it ${ev.imp.bid != null ? fmtP(ev.imp.bid) : '–'} / ${ev.imp.ask != null ? fmtP(ev.imp.ask) : '–'}, theo ${n2(ev.T)}.`,
          why: this.whyTheo(ev.id), marks: [{ id: ev.id, side: null, act: 'you', note: `theo ${n2(ev.T)}` }] });
        add(this.quoteVerdict(ev, !!fill));
        if (fill) {
          const story = this.fillSteps(fill, this.afterHit.board);
          steps.push(...story.steps);
          add(this.bookVerdict(fill, this.status(this.beatTrades), book));
        }
      }
      return res;
    }

    // The stock widened: how much wider your markets got, against delta (M3).
    judgeWidth() {
      const b = this.beat, steps = [], verdict = [];
      const S = this.start.board.quotes.S;
      const rows = b.targets.map(t => {
        const ev = b.quotes[t], d = Math.abs(E.delta(this.model, t)), need = d * b.widen;
        const mb = this.mineBefore[t];
        const base = mb && mb.bid != null && mb.ask != null ? mb : b.std[t];
        const wb = base ? base.bid - ev.bid : null, wa = base ? ev.ask - base.ask : null;
        return { t, ev, d, need, base, mb: base === mb, wb, wa };
      });
      steps.push({ text: `Stock ${fmtP(S.bid)} / ${fmtP(S.ask)}: half its spread is up ${fmtP(b.widen)}, so hedging costs |delta| × ${fmtP(b.widen)} more a lot.`,
        why: this.whyHedgeWidth(), marks: [{ id: 'S', side: null, act: 'ref', note: `${fmtP(S.ask - S.bid)} wide` }] });
      for (const r of rows) {
        const was = r.base ? `${r.mb ? 'your' : 'the room\'s standard'} ${fmtP(r.base.bid)} / ${fmtP(r.base.ask)}` : '';
        steps.push({ text: `${E.label(r.t)}: ${Math.round(r.d * 100)} delta, so about ${n2(r.need)} more a side. ${r.base ? `From ${was} you went to ${fmtP(r.ev.bid)} / ${fmtP(r.ev.ask)}: ${signed(r.wb)} / ${signed(r.wa)}.` : ''}`,
          why: this.whyTheo(r.t), marks: [{ id: r.t, side: null, act: 'you', note: `+${n2(r.need)} a side` }] });
        const q = this.quoteVerdict(r.ev);
        if (q && q[0] === 'bad') verdict.push([q[0], `${E.label(r.t)}: ${q[1]}`]);
        else if (r.base) {
          const lo = Math.min(r.wb, r.wa);
          verdict.push(lo >= r.need - this.sc.U / 2 - 1e-9 ? ['good', `${E.label(r.t)}: widened ${n2(r.wb)} / ${n2(r.wa)}, enough for ${Math.round(r.d * 100)} delta.`]
            : ['bad', `${E.label(r.t)}: widened ${n2(r.wb)} / ${n2(r.wa)}, but ${Math.round(r.d * 100)} delta needs about ${n2(r.need)} a side.`]);
        }
      }
      const [a, c] = rows;
      if (a && c && a.base && c.base) {
        const hi = a.d > c.d ? a : c, lo = a.d > c.d ? c : a;
        // Where the deltas call for different widening, the bigger delta
        // must widen more; where they round the same, at least as much.
        const same = E.round(hi.need) === E.round(lo.need);
        const right = same ? (hi.wb + hi.wa) >= (lo.wb + lo.wa) - 1e-9 : (hi.wb + hi.wa) > (lo.wb + lo.wa) + 1e-9;
        verdict.push(right ? ['good', `The ${E.label(hi.t)} widened ${same ? 'at least as much as' : 'more than'} the ${E.label(lo.t)}: right, it carries more stock.`]
          : ['bad', `The ${E.label(hi.t)} (${Math.round(hi.d * 100)} delta) should widen more than the ${E.label(lo.t)} (${Math.round(lo.d * 100)} delta).`]);
      }
      return { type: 'width', title: this.beatTitle(), verdict, steps, pnl: 0 };
    }
    whyHedgeWidth() {
      return 'Hedging a fill costs |delta| × half the stock spread a lot, so when the stock widens each side needs about |delta| × the rise more edge.';
    }

    // One trade on a stale board: the most edge x size, net of hedge (S1).
    candidates() {
      const sb = this.start.board, S = sb.quotes.S, half = (S.ask - S.bid) / 2;
      const out = [];
      for (const [id, q] of Object.entries(sb.quotes)) {
        if (id === 'S') continue;
        const T = E.theo(this.model, id), d = Math.abs(E.delta(this.model, id)), hc = d * half;
        if (q.ask != null && sz(q, 'ask') > 0) out.push({ id, side: 'buy', qs: 'ask', price: q.ask, size: sz(q, 'ask'), T, d, hc, e: T - q.ask - hc });
        if (q.bid != null && sz(q, 'bid') > 0) out.push({ id, side: 'sell', qs: 'bid', price: q.bid, size: sz(q, 'bid'), T, d, hc, e: q.bid - T - hc });
      }
      for (const c of out) c.v = c.e * c.size;
      return out.sort((a, b) => b.v - a.v);
    }

    judgePick() {
      const b = this.beat, steps = [], verdict = [];
      const cands = this.candidates(), best = cands[0];
      const top3 = cands.filter(c => c.v > 1e-9).slice(0, 3);
      steps.push({ text: `Stock ${b.move > 0 ? 'up' : 'down'} ${fmtP(Math.abs(b.move))}: each option should have moved by its delta. ${b.move > 0 ? 'Calls are now cheap, puts rich.' : 'Calls are now rich, puts cheap.'}`,
        why: 'A call moves by its delta times the move, a put by (call delta − 1) times it. A quote that didn\'t move is worth its edge, less the hedge, times its size.',
        marks: top3.map(c => ({ id: c.id, side: c.qs, act: c.side, note: `${signed(c.e)} × ${n2(c.size)}` })) });
      if (best && best.v > 1e-9) steps.push({ text: `Best: ${best.side} ${n2(best.size)} × ${E.label(best.id)} at ${fmtP(best.price)}. Theo ${n2(best.T)}, hedge ${n2(best.hc)}: ${signed(best.e)} a lot × ${n2(best.size)} = ${signed(best.v)}.`,
        why: 'Edge × size, not edge alone: a smaller edge on a bigger size can be worth more.', marks: [{ id: best.id, side: best.qs, act: best.side, note: `${best.side} ${n2(best.size)}` }] });
      const tr = this.beatTrades.filter(t => t.id !== 'S')[0];
      if (!tr) { if (best && best.v > 1e-9) verdict.push(['bad', `No trade: ${signed(best.v)} was there.`]); }
      else {
        const c = cands.find(x => x.id === tr.id && x.side === tr.side) || { e: 0, hc: 0 };
        const v = c.e * tr.qty;
        verdict.push(best && v >= best.v * 0.98 - 1e-9 ? ['good', `Your ${tr.side === 'buy' ? 'buy' : 'sale'} of ${n2(tr.qty)} × ${E.label(tr.id)}: ${signed(v)}, the most there was.`]
          : v > 1e-9 ? ['warn', `Your ${tr.side === 'buy' ? 'buy' : 'sale'} of ${n2(tr.qty)} × ${E.label(tr.id)}: ${signed(v)}. The ${E.label(best.id)} was worth ${signed(best.v)}.`]
          : ['bad', `Your ${tr.side === 'buy' ? 'buy' : 'sale'} of ${n2(tr.qty)} × ${E.label(tr.id)}: ${signed(v)} after the hedge.`]);
        const d = -E.positionDelta(this.model, [tr]), n = Math.round(Math.abs(d));
        if (n) steps.push({ text: `Then hedge: ${d > 0 ? 'buy' : 'sell'} ${n} stock to be delta flat.`, why: this.whyHedge(tr),
          marks: [{ id: 'S', side: d > 0 ? 'ask' : 'bid', act: d > 0 ? 'buy' : 'sell', note: `${d > 0 ? 'buy' : 'sell'} ${n}` }] });
        const bv = this.bookVerdict(tr, this.status(this.beatTrades), this.status());
        if (bv) verdict.push(bv);
      }
      return { type: 'pick', title: this.beatTitle(), verdict, steps, pnl: this.status(this.beatTrades).pnl, best: best ? best.v : 0 };
    }

    totals() {
      const pnl = this.results.reduce((a, r) => a + (r.pnl || 0), 0);
      const missed = this.results.filter(r => r.type === 'opp' && r.best > 1e-6 && Math.abs(r.pnl) < 1e-6).length;
      const unhedged = this.results.filter(r => r.verdict.some(v => v[0] === 'bad' && /hedged/i.test(v[1]))).length;
      return { pnl, missed, unhedged, beats: this.results.length, book: this.status(), vega: this.netVega() };
    }
  }

  // Options first, the stock hedge last.
  const ordered = route => [...(route || [])].sort((a, b) => (a.id === 'S') - (b.id === 'S'));

  // "sell the 100 call at 8, buy stock at 101", per `unit` lots.
  function routeShort(route, unit = 1) {
    if (!route || !route.length) return '';
    return ordered(route).map(r => {
      const q = r.qty / unit;
      return `${r.side} ${Math.abs(q - 1) < 1e-6 ? '' : n2(q) + ' × '}${E.label(r.id)} at ${fmtP(r.price)}`;
    }).join(', ');
  }

  // Board marks for a route: the side you trade, tagged "buy 101".
  function routeMarks(route, unit = 1) {
    return ordered(route).map(r => {
      const q = r.qty / unit;
      return { id: r.id, side: r.side === 'buy' ? 'ask' : 'bid', act: r.side, note: `${r.side} ${Math.abs(q - 1) < 1e-6 ? '' : n2(q) + ' × '}${fmtP(r.price)}` };
    });
  }

  const api = { Game, topOf, routeShort, n2, signed };
  if (isNode) module.exports = api;
  else root.GameCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
