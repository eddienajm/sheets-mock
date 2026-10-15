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
  const n2 = x => {
    const r = Math.round(x * 100) / 100;
    return (Object.is(r, -0) ? 0 : r).toString();
  };
  const signed = x => (x > 0 ? '+' : '') + n2(x);
  const isOption = id => /^[CP]\d/.test(id);
  const partnerOf = id => (id[0] === 'C' ? 'P' : 'C') + id.slice(1);
  const strikeOf = id => +id.slice(1);
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
      this.flow = cfg.flow && session.flowDir ? { dir: session.flowDir, vega: 0, steps: 0, per: 50, shift: 1 } : null;
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
        if (q === 'room') q = Sc.quoteAround(E.theo(this.model, b.target), 1);
        Sc.applyOps(this.board, [{ op: 'set', id: b.target, bid: q.bid, ask: q.ask, bidSize: 100, askSize: 100 }]);
        delete this.board.mine[b.target];
      }
      if (b.restoreStock && b.stockBefore) {
        Sc.applyOps(this.board, [{ op: 'stock', bid: b.stockBefore.bid, ask: b.stockBefore.ask }]);
      }
      if (b.type === 'pick') {
        // The room re-marks its stale quotes by delta.
        for (const [id, q] of Object.entries(this.board.quotes)) {
          if (!q.stale) continue;
          const sh = E.round(E.delta(this.model, id) * b.move);
          if (q.bid != null) q.bid = q.bid + sh >= 0.5 ? q.bid + sh : null;
          if (q.ask != null) q.ask = Math.max(q.ask + sh, 0.5);
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
        if (q.bid != null) q.bid = q.bid + sh >= 0.5 ? q.bid + sh : null;
        if (q.ask != null) q.ask = Math.max(q.ask + sh, q.bid != null ? q.bid + 0.5 : 0.5);
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
          if (r.side === 'buy' && q.ask != null) q.ask += 0.5;
          if (r.side === 'sell' && q.bid != null) q.bid = q.bid - 0.5 >= 0.5 ? q.bid - 0.5 : null;
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
      const qty = Math.min(pick.size, this.R.pick(this.flow ? [25, 50, 50] : [10, 20, 25, 25, 50]));
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
      if (ev.arbBid || ev.arbAsk) side = ev.arbBid ? 'bid' : 'ask';
      else if (b.noTrade) side = null;
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

    // ---------- the frameworks behind each step ----------

    whySynth(K) {
      return `A call and a put on the same strike make a future. Long the call and short the put pays S − ${K} at expiry, whatever happens: a future bought at ${K} + C − P. Long the put and short the call is that future sold. So add up K + C − P and compare it with the stock: sell the future above the stock offer, or buy it below the stock bid, and you are flat with the difference.`;
    }
    whyPartner(fill, lv) {
      const K = lv.K, p = fill.price, s = lv.s;
      const v = fill.side === 'buy' ? 'buying' : 'selling';
      return fill.id[0] === 'P'
        ? `Another way to see it, P = C − S + K: ${v} the ${K} put at ${fmtP(p)} with the stock at ${fmtP(s)} is ${v} the ${K} call at ${fmtP(p)} + ${fmtP(s)} − ${K} = ${fmtP(p + s - K)}.`
        : `Another way to see it, C = P + S − K: ${v} the ${K} call at ${fmtP(p)} with the stock at ${fmtP(s)} is ${v} the ${K} put at ${fmtP(p)} − ${fmtP(s)} + ${K} = ${fmtP(p - s + K)}.`;
    }
    whyHedge(fill) {
      const d = E.delta(this.model, fill.id), sg = fill.side === 'buy' ? 1 : -1;
      const S = this.start.board.quotes.S, half = (S.ask - S.bid) / 2;
      const sh = sg * fill.qty * d;
      return `Delta is how many shares one option moves like. ${n2(fill.qty)} ${E.label(fill.id)} at ${signed(d)} is ${signed(Math.round(sh * 10) / 10)} shares, so ${sh > 0 ? 'sell' : 'buy'} ${Math.round(Math.abs(sh))} stock to be delta flat. Crossing the stock costs |delta| × half its spread a lot: ${n2(Math.abs(d))} × ${n2(half)} = ${n2(Math.abs(d) * half)}. Deep in-the-money options are nearly a full share, so they need more edge than out-of-the-money ones. On a round trip through parity the first leg carries most of the hedge, and the partner only the rest.`;
    }
    whyLean(fill, lv) {
      const long = fill.side === 'buy';
      return `You're ${long ? 'long' : 'short'} the ${E.label(fill.id)}: you want ${long ? 'buyers' : 'sellers'} now, not more ${long ? 'sellers' : 'buyers'}, so move both sides ${long ? 'down' : 'up'}. The ${E.label(lv.partner)} breaks even at ${fmtP(lv.be)}, the price where ${lv.K} + C − P equals the stock you hedge with (${fmtP(lv.s)}). Any ${lv.partnerSide === 'sell' ? 'offer above' : 'bid below'} it arbs you to flat when it trades. Resting a price inside the board can earn more than crossing it.`;
    }
    whyTheo(id) {
      const m = this.model, inst = E.parse(id), T = E.theo(m, id);
      const S = m.S;
      if (inst.kind === 'C' || inst.kind === 'P') {
        const other = partnerOf(id), oq = this.start.board.quotes[other];
        const sp = E.split(m, inst);
        let src = '';
        if (oq && oq.bid != null && oq.ask != null && !oq.conductor && !oq.stale) {
          src = `The ${E.label(other)} is ${fmtP(oq.bid)} / ${fmtP(oq.ask)}, mid ${n2((oq.bid + oq.ask) / 2)}, with stock mid ${n2(S)}. `;
        }
        const pc = inst.kind === 'P' ? `P = C − S + K = ${n2(E.callTheo(m, inst.k))} − ${n2(S)} + ${inst.k}` : `C = P + S − K = ${n2(E.putTheo(m, inst.k))} + ${n2(S)} − ${inst.k}`;
        return `${src}Theo comes from the board, through parity: ${pc} = ${n2(T)}. That is ${sp.intrinsic ? `${n2(sp.intrinsic)} intrinsic and ` : ''}${n2(sp.extrinsic)} extrinsic; the call and put on a strike share the same extrinsic.${this.flowWhy()}`;
      }
      if (inst.kind === 'V') {
        const c = E.callTheo(m, inst.k), p = E.putTheo(m, inst.k);
        return `A straddle is a call plus a put: ${n2(c)} + ${n2(p)} = ${n2(T)}. Since P = C − S + K it is also two calls, less a share, plus K: 2 × ${n2(c)} − ${n2(S)} + ${inst.k} = ${n2(T)}. That is why buying two calls and selling stock is the same trade as buying the straddle.`;
      }
      if (inst.kind === 'CS') return `A call spread is the lower call less the upper: ${n2(E.callTheo(m, inst.k1))} − ${n2(E.callTheo(m, inst.k2))} = ${n2(T)}. It is worth between 0 and the strike gap, ${inst.k2 - inst.k1}.`;
      if (inst.kind === 'PS') return `A put spread is the upper put less the lower: ${n2(E.putTheo(m, inst.k2))} − ${n2(E.putTheo(m, inst.k1))} = ${n2(T)}. With the call spread it makes a box worth the strike gap, so it is also ${inst.k2 - inst.k1} less the call spread.`;
      if (inst.kind === 'BOX') return `A box is a call spread plus a put spread and pays the strike gap, ${inst.k2 - inst.k1}, whatever happens.`;
      if (inst.kind === 'FLY') return `A fly is the lower call spread less the upper one: ${n2(E.callTheo(m, inst.k1))} − 2 × ${n2(E.callTheo(m, inst.k2))} + ${n2(E.callTheo(m, inst.k3))} = ${n2(T)}. It can never be worth less than 0 or more than the wing, ${inst.k2 - inst.k1}; the call fly and the put fly are the same thing.`;
      return `Theo ${n2(T)}.`;
    }
    // Which framework a board route uses.
    whyRoute(id, route) {
      const inst = E.parse(id);
      const ids = (route || []).map(r => r.id);
      if (isOption(id) && ids.includes(partnerOf(id))) return this.whySynth(inst.k);
      if (inst.kind === 'V' || inst.kind === 'FLY') return this.whyTheo(id);
      if (ids.some(x => /^(CS|PS|BOX)/.test(x)) || inst.kind === 'PS' || inst.kind === 'CS') return 'Call spread + put spread on the same strikes is a box, worth the strike gap. So a put spread is the gap less the call spread, a put is a put spread plus the lower put, and so on: every leg can be rebuilt from the others.';
      return this.whySynth(inst.k ?? '');
    }

    theoStep(t) {
      const T = E.theo(this.model, t);
      return { text: `Theo ${n2(T)}.`, why: this.whyTheo(t), marks: [{ id: t, side: null, act: 'you', note: `theo ${n2(T)}` }] };
    }

    // ---------- the story of a fill (A1-A4) ----------
    //
    // Told from the trade that happened. For a single option: edge against
    // theo; does it pair with something already in the book; if not, the
    // synthetic future against the board (arb or not); hedge; lean.
    fillSteps(fill, board) {
      const m = this.model, id = fill.id, q = fill.qty, bought = fill.side === 'buy';
      const T = E.theo(m, id), e = bought ? T - fill.price : fill.price - T;
      const steps = [];
      const hitMark = { id, side: bought ? 'bid' : 'ask', act: 'you', note: `${bought ? 'bought' : 'sold'} ${n2(q)}` };
      steps.push({ text: `You ${bought ? 'bought' : 'sold'} ${n2(q)} ${E.label(id)} at ${fmtP(fill.price)}. Theo ${n2(T)}: ${signed(e)} a lot.`,
        why: this.whyTheo(id), marks: [hitMark] });
      const out = { steps, bestLock: 0, lv: null };
      if (!isOption(id)) return this.genericFill(fill, board, out);

      const lv = this.levels(fill);
      out.lv = lv;
      const P = lv.partner, K = lv.K;
      const cp = (px, py) => (lv.isCall ? [px, py] : [py, px]);

      // Does it complete a synthetic with something already in the book?
      const earlier = this.trades.filter(t => t !== fill && t.id === P);
      const net = earlier.reduce((a, t) => a + (t.side === 'buy' ? t.qty : -t.qty), 0);
      const want = bought ? -1 : 1;
      if (net * want > 1e-9) {
        const legs = earlier.filter(t => (t.side === 'buy' ? 1 : -1) === want);
        const py = legs.reduce((a, t) => a + t.price * t.qty, 0) / legs.reduce((a, t) => a + t.qty, 0);
        const stock = this.trades.filter(t => t.id === 'S' && t.side === lv.stockSide && t.beat < this.n);
        const sPx = stock.length ? stock.reduce((a, t) => a + t.price * t.qty, 0) / stock.reduce((a, t) => a + t.qty, 0) : lv.s;
        const [c, p] = cp(fill.price, py);
        const F = K + c - p;
        const ed = lv.longFut ? sPx - F : F - sPx;
        steps.push({ text: `With the ${E.label(P)} you ${want > 0 ? 'bought' : 'sold'} at ${fmtP(py)}, that's ${lv.longFut ? 'a long' : 'a short'} future at ${this.futText(K, c, p)}. Your stock ${lv.stockSide === 'sell' ? 'sold' : 'bought'} at ${fmtP(sPx)}: ${signed(ed)} a lot.`,
          why: this.whySynth(K), marks: [hitMark, { id: 'S', side: null, act: 'ref', note: `${lv.stockSide === 'sell' ? 'sold' : 'bought'} ${fmtP(sPx)}` }] });
        out.paired = true;
        // Stock still to trade, from the book before this beat's own trades.
        const before = this.trades.filter(t => t.beat < this.n || t === fill);
        const n = Math.round(-E.positionDelta(this.model, before));
        steps.push({ text: n ? `${n > 0 ? 'Buy' : 'Sell'} ${Math.abs(n)} more stock to hedge to delta flat, and the pair is done.` : 'Your stock already covers it: delta flat.',
          why: this.whyHedge(fill), marks: n ? [{ id: 'S', side: n > 0 ? 'ask' : 'bid', act: n > 0 ? 'buy' : 'sell', note: `${n > 0 ? 'buy' : 'sell'} ${Math.abs(n)}` }] : [] });
        return out;
      }

      // Against the board: the partner and the stock.
      const pq = board.quotes[P];
      const ps = lv.partnerSide === 'sell' ? 'bid' : 'ask';
      const py = pq && pq[ps] != null && sz(pq, ps) > 0 ? pq[ps] : null;
      const best = E.bestLayoff(board, E.position([fill]));
      out.bestLock = best ? best.locked : 0;
      if (py != null) {
        const [c, p] = cp(fill.price, py);
        const ed = lv.edge(py);
        steps.push({
          text: `${lv.partnerSide === 'sell' ? 'Sell' : 'Buy'} the ${E.label(P)} at ${fmtP(py)} against it and you've ${lv.longFut ? 'bought' : 'sold'} the future at ${this.futText(K, c, p)}. Stock ${lv.longFut ? 'bid' : 'offered'} at ${fmtP(lv.s)}: ${ed > 1e-9 ? `${signed(ed)} a lot.` : ed < -1e-9 ? `that loses ${n2(-ed)} a lot.` : 'no arb.'}`,
          why: `${this.whySynth(K)} ${this.whyPartner(fill, lv)}`,
          marks: [hitMark, { id: P, side: ps, act: lv.partnerSide, note: `${lv.partnerSide} ${fmtP(py)}` }, { id: 'S', side: lv.stockSide === 'buy' ? 'ask' : 'bid', act: lv.stockSide, note: `${lv.stockSide} ${fmtP(lv.s)}` }] });
      }
      const hedgeN = Math.round(Math.abs(q * E.delta(m, id)));
      const hedgeSide = (bought ? 1 : -1) * E.delta(m, id) > 0 ? 'sell' : 'buy';
      const hedgeMark = { id: 'S', side: hedgeSide === 'buy' ? 'ask' : 'bid', act: hedgeSide, note: `${hedgeSide} ${hedgeN}` };
      // A resting price in the partner: its theo, or a tick through
      // break-even if theo doesn't beat it.
      const pT = E.theo(m, P);
      let lean = lv.partnerSide === 'sell' ? E.ceilT(pT) : E.floorT(pT);
      if (lv.partnerSide === 'sell' ? lean <= lv.be : lean >= lv.be) lean = lv.partnerSide === 'sell' ? lv.be + E.TICK : lv.be - E.TICK;
      const leanEdge = lv.partnerSide === 'sell' ? lean - lv.be : lv.be - lean;
      const leanMark = { id: P, side: py != null ? ps : null, act: 'you', note: `break-even ${fmtP(lv.be)}` };
      out.lean = { id: P, side: lv.partnerSide, price: lean, edge: leanEdge };
      if (best && best.locked > 1e-6) {
        steps.push({ text: `That's an arb. Do it for all ${n2(q)}: ${routeShort(best.route, q)}. Arb to flat, ${signed(best.locked)}.`,
          why: this.whySynth(K), marks: routeMarks(best.route, q) });
        steps.push({ text: `Or hedge the delta (${hedgeSide} ${hedgeN} stock) and ${lv.partnerSide === 'sell' ? 'offer' : 'bid'} the ${E.label(P)} at ${fmtP(lean)}: ${signed(leanEdge)} a lot if it trades, against ${signed(best.locked / q)} crossing now.`,
          why: `${this.whyLean(fill, lv)} ${this.whyHedge(fill)}`, marks: [leanMark, hedgeMark] });
      } else {
        steps.push({ text: `No arb, so hold it outright and hedge the delta: ${hedgeSide} ${hedgeN} stock to be delta flat.`,
          why: this.whyHedge(fill), marks: [hitMark, hedgeMark] });
        steps.push({ text: `Then lean to get out: ${lv.partnerSide === 'sell' ? 'offer' : 'bid'} the ${E.label(P)} ${lv.partnerSide === 'sell' ? 'above' : 'below'} ${fmtP(lv.be)}, say ${fmtP(lean)} (${signed(leanEdge)} a lot if it trades), and ${bought ? 'drop your bid' : 'lift your offer'} in the ${E.label(id)}.`,
          why: this.whyLean(fill, lv), marks: [leanMark] });
      }
      return out;
    }

    // A fill in a structure: lay it off on the board, or hold and hedge.
    genericFill(fill, board, out) {
      const bought = fill.side === 'buy', id = fill.id, q = fill.qty;
      const imp = E.implied(board, id);
      const px = bought ? imp.bid : imp.ask, route = bought ? imp.bidRoute : imp.askRoute;
      if (px != null) {
        const ed = bought ? px - fill.price : fill.price - px;
        out.steps.push({ text: `${bought ? 'Sell' : 'Buy'} it back on the board: ${routeShort(route)} = ${fmtP(px)}. ${ed > 1e-9 ? `${signed(ed)} a lot.` : ed < -1e-9 ? `That loses ${n2(-ed)} a lot.` : 'No edge.'}`,
          why: this.whyRoute(id, route), marks: routeMarks(route) });
      }
      const best = E.bestLayoff(board, E.position([fill]));
      out.bestLock = best ? best.locked : 0;
      if (best && best.locked > 1e-6) {
        out.steps.push({ text: `Do it for all ${n2(q)}: arb to flat, ${signed(best.locked)}.`, why: this.whyRoute(id, best.route), marks: routeMarks(best.route, q) });
      } else {
        const need = -E.positionDelta(this.model, [fill]);
        const n = Math.round(Math.abs(need));
        out.steps.push({ text: `No arb, so hold it outright and hedge the delta: ${need > 0 ? 'buy' : 'sell'} ${n} stock to be delta flat.`,
          why: `The ${E.label(id)} has a delta of ${signed(E.delta(this.model, id))} a lot. ${this.whyTheo(id)}`,
          marks: n ? [{ id: 'S', side: need > 0 ? 'ask' : 'bid', act: need > 0 ? 'buy' : 'sell', note: `${need > 0 ? 'buy' : 'sell'} ${n}` }] : [] });
      }
      return out;
    }

    // Your resting prices this beat, judged against break-even (A3).
    leanVerdicts(lv, fill) {
      const out = [];
      for (const p of this.posts) {
        if (lv && p.id === lv.partner && p.side === lv.partnerSide) {
          const ed = lv.partnerSide === 'sell' ? p.price - lv.be : lv.be - p.price;
          out.push(ed > 1e-9 ? ['good', `Your ${fmtP(p.price)} ${p.side === 'buy' ? 'bid' : 'offer'} in the ${E.label(p.id)}: ${signed(ed)} a lot if it trades (break-even ${fmtP(lv.be)}).`]
            : ['bad', `Your ${fmtP(p.price)} ${p.side === 'buy' ? 'bid' : 'offer'} in the ${E.label(p.id)} doesn't beat break-even ${fmtP(lv.be)}.`]);
        } else if (fill && p.id === fill.id && (p.side === 'buy') === (fill.side === 'buy')) {
          const worse = fill.side === 'buy' ? p.price > fill.price : p.price < fill.price;
          if (worse) out.push(['warn', `You're ${fill.side === 'buy' ? 'long' : 'short'} the ${E.label(fill.id)}: ${fill.side === 'buy' ? 'bidding higher' : 'offering lower'} adds to it at a worse price.`]);
        }
      }
      return out;
    }

    bookVerdict(first, st, book) {
      const gross = first ? Math.abs(first.qty * E.delta(this.model, first.id)) : 0;
      const ok = Math.abs(book.delta) <= Math.max(1, 0.1 * gross);
      return book.flat ? ['good', `Book flat: ${signed(book.pnl)}.`]
        : st.flat ? ['good', `Arbed to flat: ${signed(st.pnl)}.`]
        : ok ? ['good', `Held outright, delta-hedged: ${signed(st.pnl)} at theo.`]
        : ['bad', `Delta not hedged: ${signed(Math.round(book.delta))} shares in the book.`];
    }

    // ---------- judging ----------

    // Your market against the board (M1, M2, M3).
    quoteVerdict(ev) {
      const ib = ev.imp.bid, ia = ev.imp.ask;
      if (ev.arbBid || ev.arbAsk) return ['bad', `Your ${fmtP(ev.bid)} / ${fmtP(ev.ask)} crosses the board: you can be arbed.`];
      if (!ev.containsTheo) return ['bad', `Your ${fmtP(ev.bid)} / ${fmtP(ev.ask)} doesn't contain theo ${n2(ev.T)}.`];
      if (ib != null && ev.bid >= ib - 1e-9) return ['warn', `Your ${fmtP(ev.bid)} bid is ${ev.bid > ib + 1e-9 ? 'inside' : 'on'} the board's ${fmtP(ib)}: if it's hit you can't lay it off. Bid ${fmtP(Math.max(0, ib - 0.5))}.`];
      if (ia != null && ev.ask <= ia + 1e-9) return ['warn', `Your ${fmtP(ev.ask)} offer is ${ev.ask < ia - 1e-9 ? 'inside' : 'on'} the board's ${fmtP(ia)}: if it's lifted you can't lay it off. Offer ${fmtP(ia + 0.5)}.`];
      const S = this.start.board.quotes.S, half = (S.ask - S.bid) / 2, cost = Math.abs(ev.D) * half;
      const thin = Math.min(ev.T - ev.bid, ev.ask - ev.T);
      if (isOption(ev.id) && thin < cost - 1e-9) return ['warn', `${n2(thin)} of edge on one side doesn't cover the hedge: ${n2(Math.abs(ev.D))} delta × ${n2(half)} = ${n2(cost)} a lot.`];
      return ['good', 'Good market: armable and around theo.'];
    }

    // A make-a-market question (including a follow-up), or the market
    // trading one of your standing quotes. Told from what actually traded.
    judgeHit() {
      const b = this.beat, ev = this.marketEval, t = b.target;
      const steps = [], verdict = [];
      const fu = b.followUp;

      if (fu && ev) {
        const f = fu.fill, lv = this.levels(f);
        const ys = fu.exitSide === 'sell' ? 'ask' : 'bid', yp = ev[ys];
        const leg = lv.isCall ? `${lv.K} + ${fmtP(f.price)} − P` : `${lv.K} + C − ${fmtP(f.price)}`;
        steps.push({ text: `You ${f.side === 'buy' ? 'bought' : 'sold'} ${n2(f.qty)} ${E.label(f.id)} at ${fmtP(f.price)}. ${fu.exitSide === 'sell' ? 'Selling' : 'Buying'} the ${E.label(t)} makes ${lv.longFut ? 'a long' : 'a short'} future at ${leg}; against stock at ${fmtP(lv.s)}, break-even is ${fmtP(lv.be)}.`,
          why: `${this.whySynth(lv.K)} ${this.whyLean(f, lv)}`,
          marks: [{ id: t, side: ys, act: 'you', note: `break-even ${fmtP(lv.be)}` }, { id: 'S', side: lv.stockSide === 'buy' ? 'ask' : 'bid', act: 'ref', note: fmtP(lv.s) }] });
        const ed = fu.exitSide === 'sell' ? yp - lv.be : lv.be - yp;
        verdict.push(ed > 1e-9 ? ['good', `Your ${fmtP(yp)} ${ys === 'ask' ? 'offer' : 'bid'} beats break-even ${fmtP(lv.be)}: ${signed(ed)} a lot if it trades.`]
          : ['bad', `Your ${fmtP(yp)} ${ys === 'ask' ? 'offer' : 'bid'} doesn't beat break-even ${fmtP(lv.be)}.`]);
      } else if (ev) {
        steps.push(this.theoStep(t));
        verdict.push(this.quoteVerdict(ev));
      }

      const res = { type: b.type === 'react' ? 'react' : 'make', title: this.beatTitle(), verdict, steps, pnl: 0, bestLock: 0 };
      const mine = this.beatTrades;
      const st = this.status(mine), book = this.status();
      res.pnl = st.pnl;
      const fill = this.fills[0];
      if (!fill) {
        if (!mine.length) verdict.push(['good', 'No trade.']);
        return res;
      }
      const story = this.fillSteps(fill, this.afterHit.board);
      steps.push(...story.steps);
      res.bestLock = story.bestLock;
      verdict.push(...this.leanVerdicts(story.lv, fill));
      if (story.bestLock > 1e-6 && !st.flat && !book.flat && !this.posts.length) verdict.push(['warn', `There was an arb: ${signed(story.bestLock)} to flat on the board.`]);
      verdict.push(this.bookVerdict(fill, st, book));
      res.flat = book.flat;
      return res;
    }

    judgeOpp() {
      const b = this.beat, o = b.order;
      const sb = (this.oppStart || this.start).board;
      const best = E.bestArb(sb);
      const orderTrades = b.asked ? this.beatTrades.slice(0, b.orderTrades) : this.beatTrades;
      const st = this.status(orderTrades), book = this.status();
      const steps = [];
      if (o) {
        const imp = E.implied(sb, o.id);
        const other = o.side === 'bid' ? imp.ask : imp.bid, route = o.side === 'bid' ? imp.askRoute : imp.bidRoute;
        const T = E.theo(this.model, o.id);
        steps.push({ text: `${o.side === 'bid' ? 'Bid' : 'Offer'} ${fmtP(o.price)} in the ${E.label(o.id)}. Theo ${n2(T)}.`, why: this.whyTheo(o.id),
          marks: [{ id: o.id, side: o.side, act: 'ref', note: `${o.side === 'bid' ? 'bid' : 'offer'} ${fmtP(o.price)}` }] });
        if (other != null) steps.push({ text: `The same thing on the board: ${routeShort(route)} = ${fmtP(other)}.`, why: this.whyRoute(o.id, route),
          marks: [{ id: o.id, side: o.side, act: 'ref', note: `vs ${fmtP(other)}` }, ...routeMarks(route)] });
      }
      if (o) best.route.sort((x, y) => (y.id === o.id) - (x.id === o.id));
      const unit = best.route.length ? best.route[0].qty : 1;
      if (best.value > 1e-6) steps.push({ text: `Trade both, ${n2(unit)} lots: ${routeShort(best.route, unit)}. Arb to flat: ${signed(best.value)}.`,
        why: `Edge × size: take all the board lets you lay off, which is the thinnest leg. ${o ? this.whyRoute(o.id, best.route) : ''}`, marks: routeMarks(best.route, unit) });
      else steps.push({ text: 'Nothing in it: the order pays no more than the board.', why: 'An order is only worth taking if you can do the opposite on the board for less. At the board\'s own level, all you get is the risk.', marks: o ? [{ id: o.id, side: o.side, act: 'bad', note: 'no edge' }] : [] });
      const res = { type: 'opp', title: this.beatTitle(), steps, verdict: [], pnl: st.pnl, best: best.value };
      const traded = orderTrades.length > 0;
      if (best.value <= 1e-6) {
        res.verdict.push(!traded ? ['good', 'Right to leave it.']
          : st.flat && st.pnl > -1e-6 ? ['good', 'Flat, nothing lost.']
          : ['bad', `Nothing there: ${signed(st.pnl)} at theo.`]);
      } else if (!traded) {
        res.verdict.push(['bad', `Missed: ${signed(best.value)} was there.`]);
      } else if (st.flat) {
        res.verdict.push(st.pnl / best.value > 0.98 ? ['good', `Arbed to flat: ${signed(st.pnl)}, the full amount.`]
          : st.pnl > 0 ? ['warn', `Arbed to flat: ${signed(st.pnl)} of ${signed(best.value)}. Check the size and the legs.`]
          : ['bad', `Flat, but at ${signed(st.pnl)}.`]);
      } else {
        res.verdict.push(Math.abs(book.delta) <= 1 ? ['warn', `Held outright, delta-hedged, not arbed to flat: ${signed(st.pnl)} at theo.`]
          : ['bad', `Delta not hedged: ${signed(Math.round(book.delta))} shares in the book.`]);
      }
      // Then your own market in it (O5).
      if (b.asked && this.marketEval) {
        const ev = this.marketEval;
        steps.push({ text: `Your ${fmtP(ev.bid)} / ${fmtP(ev.ask)} in the ${E.label(ev.id)}: theo ${n2(ev.T)}, and the board makes it ${ev.imp.bid != null ? fmtP(ev.imp.bid) : '–'} / ${ev.imp.ask != null ? fmtP(ev.imp.ask) : '–'}.`,
          why: this.whyTheo(ev.id), marks: [{ id: ev.id, side: null, act: 'you', note: `theo ${n2(ev.T)}` }] });
        res.verdict.push(this.quoteVerdict(ev));
        const fill = this.fills[0];
        if (fill) {
          const story = this.fillSteps(fill, this.afterHit.board);
          steps.push(...story.steps);
          res.verdict.push(this.bookVerdict(fill, this.status(this.beatTrades), book));
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
        if (q[0] === 'bad') verdict.push([q[0], `${E.label(r.t)}: ${q[1]}`]);
        else if (r.base) {
          const lo = Math.min(r.wb, r.wa);
          verdict.push(lo >= r.need - 0.25 - 1e-9 ? ['good', `${E.label(r.t)}: widened ${n2(r.wb)} / ${n2(r.wa)}, enough for ${Math.round(r.d * 100)} delta.`]
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
      return 'Every trade on your quote gets hedged by crossing the stock, which costs |delta| × half the stock spread a lot. When the stock widens, that cost rises in proportion to delta: a 95-delta option carries nearly a full share and needs nearly the full rise on each side, a 50-delta one about half, a 5-delta one almost nothing.';
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
        why: 'When the stock moves and nothing else changes, a call moves by its delta times the move and a put by (call delta − 1) times it. Quotes that didn\'t move are stale. Each one\'s edge is theo less the price, less the hedge (|delta| × half the stock spread); what it is worth is that edge times the size showing. Deep in-the-money options move most.',
        marks: top3.map(c => ({ id: c.id, side: c.qs, act: c.side, note: `${signed(c.e)} × ${n2(c.size)}` })) });
      if (best && best.v > 1e-9) steps.push({ text: `Best: ${best.side} ${n2(best.size)} × ${E.label(best.id)} at ${fmtP(best.price)}. Theo ${n2(best.T)}, hedge ${n2(best.hc)}: ${signed(best.e)} a lot × ${n2(best.size)} = ${signed(best.v)}.`,
        why: 'Edge × size, not edge alone: a smaller edge on a bigger size can be worth more.', marks: [{ id: best.id, side: best.qs, act: best.side, note: `${best.side} ${n2(best.size)}` }] });
      const tr = this.beatTrades.filter(t => t.id !== 'S')[0];
      if (!tr) verdict.push(best && best.v > 1e-9 ? ['bad', `No trade: ${signed(best.v)} was there.`] : ['good', 'No trade.']);
      else {
        const c = cands.find(x => x.id === tr.id && x.side === tr.side) || { e: 0, hc: 0 };
        const v = c.e * tr.qty;
        verdict.push(best && v >= best.v * 0.98 - 1e-9 ? ['good', `Your ${tr.side === 'buy' ? 'buy' : 'sale'} of ${n2(tr.qty)} × ${E.label(tr.id)}: ${signed(v)}, the most there was.`]
          : v > 1e-9 ? ['warn', `Your ${tr.side === 'buy' ? 'buy' : 'sale'} of ${n2(tr.qty)} × ${E.label(tr.id)}: ${signed(v)}. The ${E.label(best.id)} was worth ${signed(best.v)}.`]
          : ['bad', `Your ${tr.side === 'buy' ? 'buy' : 'sale'} of ${n2(tr.qty)} × ${E.label(tr.id)}: ${signed(v)} after the hedge.`]);
        const d = -E.positionDelta(this.model, [tr]), n = Math.round(Math.abs(d));
        if (n) steps.push({ text: `Then hedge: ${d > 0 ? 'buy' : 'sell'} ${n} stock to be delta flat.`, why: this.whyHedge(tr),
          marks: [{ id: 'S', side: d > 0 ? 'ask' : 'bid', act: d > 0 ? 'buy' : 'sell', note: `${d > 0 ? 'buy' : 'sell'} ${n}` }] });
        verdict.push(this.bookVerdict(tr, this.status(this.beatTrades), this.status()));
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
