// Pricing engine for the sheets mock. No DOM: runs in the browser and in node.
//
// Every instrument is written as a vector over a basis of the stock and one
// call per strike, plus a cash constant paid at expiry. Rate is zero, so
// put-call parity is exact: P(K) = C(K) - S + K. That one identity is what
// lets a straddle be priced off two calls and the stock, or a put off a call
// spread and a lower put, and it is what the linear program below exploits.

(function (root) {
  // The tick is set per session (0.5 on 12 October, 0.01 on 20 October), so
  // it lives on the board and the game sets it here when a session starts.
  let TICK = 0.5;
  const setTick = t => { TICK = t > 0 ? t : 0.5; };
  const EPS = 1e-9;

  // Snap to the tick, cleaning up float noise (0.07 / 0.01 is 7.000000000000001).
  const clean = x => Math.round(x * 1e9) / 1e9;
  const round = (x, t = TICK) => clean(Math.round(x / t + 1e-9) * t);
  const floorT = (x, t = TICK) => clean(Math.floor(x / t + 1e-9) * t);
  const ceilT = (x, t = TICK) => clean(Math.ceil(x / t - 1e-9) * t);

  // ---------- instruments ----------

  function id(inst) {
    switch (inst.kind) {
      case 'S': return 'S';
      case 'C': case 'P': case 'V': return inst.kind + inst.k;
      case 'CS': case 'PS': case 'BOX': return inst.kind + inst.k1 + '/' + inst.k2;
      case 'FLY': return 'FLY' + inst.k1 + '/' + inst.k2 + '/' + inst.k3;
    }
    throw new Error('bad instrument ' + JSON.stringify(inst));
  }

  function parse(s) {
    if (s === 'S') return { kind: 'S' };
    let m = s.match(/^(C|P|V)(\d+(?:\.\d+)?)$/);
    if (m) return { kind: m[1], k: +m[2] };
    m = s.match(/^(CS|PS|BOX)(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (m) return { kind: m[1], k1: +m[2], k2: +m[3] };
    m = s.match(/^FLY(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (m) return { kind: 'FLY', k1: +m[1], k2: +m[2], k3: +m[3] };
    throw new Error('bad id ' + s);
  }

  function label(inst) {
    if (typeof inst === 'string') inst = parse(inst);
    switch (inst.kind) {
      case 'S': return 'stock';
      case 'C': return inst.k + ' call';
      case 'P': return inst.k + ' put';
      case 'V': return inst.k + ' straddle';
      case 'CS': return inst.k1 + '/' + inst.k2 + ' call spread';
      case 'PS': return inst.k1 + '/' + inst.k2 + ' put spread';
      case 'BOX': return inst.k1 + '/' + inst.k2 + ' box';
      case 'FLY': return inst.k1 + '/' + inst.k2 + '/' + inst.k3 + ' fly';
    }
  }

  // Short form for the board, e.g. "100V", "110/120cs".
  function shortLabel(inst) {
    if (typeof inst === 'string') inst = parse(inst);
    switch (inst.kind) {
      case 'S': return 'S';
      case 'C': return inst.k + 'c';
      case 'P': return inst.k + 'p';
      case 'V': return inst.k + 'V';
      case 'CS': return inst.k1 + '/' + inst.k2 + 'cs';
      case 'PS': return inst.k1 + '/' + inst.k2 + 'ps';
      case 'BOX': return inst.k1 + '/' + inst.k2 + ' box';
      case 'FLY': return inst.k1 + '/' + inst.k2 + '/' + inst.k3 + ' fly';
    }
  }

  // Basis vector and expiry cash. Spreads are long the first strike's call
  // (call spread) or long the second strike's put (put spread), so both are
  // worth something positive.
  function vec(inst) {
    if (typeof inst === 'string') inst = parse(inst);
    const w = {};
    const add = (k, x) => { w[k] = (w[k] || 0) + x; };
    let c = 0;
    const call = (k, q) => add('C' + k, q);
    const put = (k, q) => { add('C' + k, q); add('S', -q); c += q * k; };
    switch (inst.kind) {
      case 'S': add('S', 1); break;
      case 'C': call(inst.k, 1); break;
      case 'P': put(inst.k, 1); break;
      case 'V': call(inst.k, 1); put(inst.k, 1); break;
      case 'CS': call(inst.k1, 1); call(inst.k2, -1); break;
      case 'PS': put(inst.k2, 1); put(inst.k1, -1); break;
      case 'BOX': call(inst.k1, 1); call(inst.k2, -1); put(inst.k2, 1); put(inst.k1, -1); break;
      // Call fly; the put fly is the same thing at r = 0 with even strikes.
      case 'FLY': call(inst.k1, 1); call(inst.k2, -2); call(inst.k3, 1); break;
    }
    for (const k of Object.keys(w)) if (Math.abs(w[k]) < EPS) delete w[k];
    return { w, c };
  }

  // ---------- the hidden fair-value model ----------
  //
  // model = { S, strikes:[...], ext:{K: extrinsic}, cd:{K: call delta} }
  // Call and put on a strike carry the same extrinsic value (parity at r = 0).

  function callTheo(model, k) { return Math.max(model.S - k, 0) + model.ext[k]; }
  function putTheo(model, k) { return Math.max(k - model.S, 0) + model.ext[k]; }

  // The stock moves and nothing else is known: each call moves by its
  // delta (puts follow through parity).
  function shiftModel(model, S) {
    const ext = {};
    for (const k of model.strikes) {
      const c = callTheo(model, k) + model.cd[k] * (S - model.S);
      ext[k] = Math.max(c - Math.max(S - k, 0), 0);
    }
    return { ...model, S, ext };
  }

  function theo(model, inst) {
    const { w, c } = vec(inst);
    let v = c;
    for (const [b, q] of Object.entries(w)) v += q * (b === 'S' ? model.S : callTheo(model, +b.slice(1)));
    return v;
  }

  function delta(model, inst) {
    const { w } = vec(inst);
    let d = 0;
    for (const [b, q] of Object.entries(w)) d += q * (b === 'S' ? 1 : model.cd[+b.slice(1)]);
    return d;
  }

  // Intrinsic and extrinsic split of a single option, for explanations.
  function split(model, inst) {
    if (typeof inst === 'string') inst = parse(inst);
    const k = inst.k;
    const intr = inst.kind === 'C' ? Math.max(model.S - k, 0) : Math.max(k - model.S, 0);
    return { intrinsic: intr, extrinsic: model.ext[k] };
  }

  // ---------- Black-Scholes, only to generate believable boards ----------

  function ncdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  function bsCall(S, K, vol, T) {
    const sd = vol * Math.sqrt(T);
    const d1 = (Math.log(S / K) + 0.5 * sd * sd) / sd;
    return { price: S * ncdf(d1) - K * ncdf(d1 - sd), delta: ncdf(d1) };
  }

  // ---------- option-equivalent vega ----------
  //
  // Vega per lot, scaled so the 50 delta strike is 1. Black-Scholes vega is
  // proportional to the normal density at d1, and the call delta is N(d1),
  // so a strike's vega follows from its delta alone: exp(-d1^2 / 2) with
  // d1 = N^-1(delta). 80 and 20 delta give 0.70, 90 and 10 give 0.44,
  // 95 and 5 give 0.26. Call and put on a strike share it; stock has none.
  function invN(p) {
    let lo = -8, hi = 8;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (ncdf(m) < p) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function strikeVega(cd) {
    const x = invN(Math.min(0.99, Math.max(0.01, cd)));
    return Math.exp(-x * x / 2);
  }
  // The board's option-equivalent vega, in 0.05 steps: the strike with the
  // most vega is 1, the two wing strikes are 0.1, and the strikes between
  // keep the Black-Scholes shape on each side of the top, rescaled to fit.
  const vtCache = new Map();
  function vegaTable(strikes, cd) {
    const key = strikes.map(k => k + ':' + cd[k]).join(',');
    if (vtCache.has(key)) return vtCache.get(key);
    const n = strikes.length, raw = strikes.map(k => strikeVega(cd[k]));
    const top = raw.indexOf(Math.max(...raw));
    const out = {};
    strikes.forEach((k, i) => {
      let v = 1;
      if (i !== top) {
        const end = i < top ? 0 : n - 1, span = raw[top] - raw[end];
        v = i === end ? 0.1 : span > 1e-9 ? 0.1 + 0.9 * (raw[i] - raw[end]) / span : 1;
      }
      out[k] = Math.round(v * 20) / 20;
    });
    vtCache.set(key, out);
    return out;
  }
  function vega(model, inst) {
    const t = model.ve || vegaTable(model.strikes, model.cd);
    const { w } = vec(inst);
    let v = 0;
    for (const [b, q] of Object.entries(w)) if (b !== 'S') v += q * t[+b.slice(1)];
    return v;
  }

  // ---------- linear programming (dense two-phase simplex, Bland's rule) ----
  //
  // maximise c.x  subject to  A x = b,  0 <= x <= u.
  // Small: a board has at most a few dozen quotes.

  function simplex(c, A, b, u) {
    const n = c.length, m = A.length;
    // Rows: m equalities, then one upper-bound row per bounded variable.
    const bounded = [];
    for (let j = 0; j < n; j++) if (isFinite(u[j])) bounded.push(j);
    const rows = m + bounded.length;
    // Columns: x (n), bound slacks (bounded.length), artificials (rows).
    const nS = bounded.length, nA = rows;
    const cols = n + nS + nA;
    const T = [];
    for (let i = 0; i < m; i++) {
      const r = new Array(cols + 1).fill(0);
      const sgn = b[i] < 0 ? -1 : 1;
      for (let j = 0; j < n; j++) r[j] = sgn * A[i][j];
      r[n + nS + i] = 1;
      r[cols] = sgn * b[i];
      T.push(r);
    }
    bounded.forEach((j, s) => {
      const r = new Array(cols + 1).fill(0);
      r[j] = 1; r[n + s] = 1; r[n + nS + m + s] = 1; r[cols] = u[j];
      T.push(r);
    });
    const basis = [];
    for (let i = 0; i < rows; i++) basis.push(n + nS + i);

    function pivot(pr, pc) {
      const pv = T[pr][pc];
      for (let j = 0; j <= cols; j++) T[pr][j] /= pv;
      for (let i = 0; i < rows; i++) {
        if (i === pr) continue;
        const f = T[i][pc];
        if (Math.abs(f) < EPS) continue;
        for (let j = 0; j <= cols; j++) T[i][j] -= f * T[pr][j];
      }
      basis[pr] = pc;
    }

    function run(obj, allowed) {
      // obj: coefficients to maximise, length cols.
      for (let iter = 0; iter < 5000; iter++) {
        // Reduced costs.
        let enter = -1;
        for (let j = 0; j < cols; j++) {
          if (!allowed(j) || basis.includes(j)) continue;
          let rc = obj[j];
          for (let i = 0; i < rows; i++) rc -= obj[basis[i]] * T[i][j];
          if (rc > 1e-9) { enter = j; break; }
        }
        if (enter < 0) return 'optimal';
        let leave = -1, best = Infinity;
        for (let i = 0; i < rows; i++) {
          if (T[i][enter] > 1e-9) {
            const r = T[i][cols] / T[i][enter];
            if (r < best - 1e-12 || (Math.abs(r - best) < 1e-12 && basis[i] < basis[leave])) { best = r; leave = i; }
          }
        }
        if (leave < 0) return 'unbounded';
        pivot(leave, enter);
      }
      return 'iterations';
    }

    // Phase 1: minimise the artificials.
    const o1 = new Array(cols).fill(0);
    for (let j = n + nS; j < cols; j++) o1[j] = -1;
    run(o1, () => true);
    let infeas = 0;
    for (let i = 0; i < rows; i++) if (basis[i] >= n + nS) infeas += T[i][cols];
    if (infeas > 1e-7) return { status: 'infeasible' };
    // Drive any zero-level artificials out of the basis.
    for (let i = 0; i < rows; i++) {
      if (basis[i] < n + nS) continue;
      for (let j = 0; j < n + nS; j++) if (Math.abs(T[i][j]) > 1e-9) { pivot(i, j); break; }
    }
    // Phase 2.
    const o2 = new Array(cols).fill(0);
    for (let j = 0; j < n; j++) o2[j] = c[j];
    const st = run(o2, j => j < n + nS);
    if (st !== 'optimal') return { status: st };
    const x = new Array(n).fill(0);
    for (let i = 0; i < rows; i++) if (basis[i] < n) x[basis[i]] = T[i][cols];
    let val = 0;
    for (let j = 0; j < n; j++) val += c[j] * x[j];
    return { status: 'optimal', x, value: val };
  }

  // ---------- the board ----------
  //
  // board = { quotes: { id: { bid, ask, bidSize, askSize } } }
  // bid/ask null means that side is empty. Sizes default to 100.

  function legsOf(board, exclude = []) {
    const legs = [];
    for (const [qid, q] of Object.entries(board.quotes)) {
      // Your own quote is not liquidity you can trade against.
      if (exclude.includes(qid) || q.mine) continue;
      const v = vec(qid);
      // A side traded down to nothing is no longer there to trade.
      if (q.ask != null && (q.askSize ?? 100) > 0) legs.push({ id: qid, side: 'buy', price: q.ask, size: q.askSize ?? 100, v });
      if (q.bid != null && (q.bidSize ?? 100) > 0) legs.push({ id: qid, side: 'sell', price: q.bid, size: q.bidSize ?? 100, v });
    }
    return legs;
  }

  function basisKeys(legs, extra = []) {
    const ks = new Set();
    for (const l of legs) for (const k of Object.keys(l.v.w)) ks.add(k);
    for (const w of extra) for (const k of Object.keys(w)) ks.add(k);
    return [...ks];
  }

  // Core: choose quantities of the available legs so that the net vector
  // equals `target` (a basis vector), maximising cash at expiry. Buying a leg
  // costs its price and delivers its cash constant; selling the reverse.
  // Returns { value, route } where value is the net cash per the whole
  // package, or null if the target cannot be built from the board.
  function solve(legs, target, caps) {
    const keys = basisKeys(legs, [target]);
    const n = legs.length;
    const cvec = legs.map(l => l.side === 'buy' ? -(l.price - l.v.c) : (l.price - l.v.c));
    const A = keys.map(k => legs.map(l => (l.side === 'buy' ? 1 : -1) * (l.v.w[k] || 0)));
    const b = keys.map(k => target[k] || 0);
    const u = legs.map((l, j) => caps ? caps[j] : Infinity);
    const r = simplex(cvec, A, b, u);
    if (r.status !== 'optimal') return null;
    const route = [];
    r.x.forEach((q, j) => { if (q > 1e-7) route.push({ id: legs[j].id, side: legs[j].side, qty: q, price: legs[j].price }); });
    // A choice market (bid = offer) lets the solver buy and sell the same
    // thing for nothing. Net those out: same cash, a route you would trade.
    for (const a of route) {
      const b = route.find(x => x !== a && x.id === a.id && x.side !== a.side && Math.abs(x.price - a.price) < 1e-9 && x.qty > 0);
      if (!b || !(a.qty > 0)) continue;
      const m = Math.min(a.qty, b.qty);
      a.qty -= m; b.qty -= m;
    }
    return { value: r.value, route: route.filter(x => x.qty > 1e-7) };
  }

  // Best price at which the board lets you buy (ask) or sell (bid) one unit
  // of `inst`, using everything quoted except the instrument itself.
  function implied(board, inst, opts = {}) {
    const tid = typeof inst === 'string' ? inst : id(inst);
    const tv = vec(tid);
    const exclude = [tid, ...(opts.exclude || [])];
    const legs = legsOf(board, exclude);
    const cap = opts.cap ?? 6;
    const caps = legs.map(() => cap);
    const neg = {};
    for (const [k, q] of Object.entries(tv.w)) neg[k] = -q;
    // Buying the target: build +target from legs, cost = -value; add back
    // the target's own cash constant.
    const buy = solve(legs, tv.w, caps);
    const sell = solve(legs, neg, caps);
    return {
      ask: buy ? -buy.value + tv.c : null,
      askRoute: buy ? buy.route : null,
      bid: sell ? sell.value + tv.c : null,
      bidRoute: sell ? sell.route : null,
    };
  }

  // Largest riskless profit on the board, respecting sizes. A flat net vector
  // means every option and the stock cancel: what is left is cash.
  function bestArb(board, opts = {}) {
    const legs = legsOf(board, opts.exclude || []);
    const caps = legs.map(l => l.size);
    const r = solve(legs, {}, caps);
    if (!r || r.value < 1e-6) return { value: 0, route: [] };
    return r;
  }

  // Best way to close a position (a basis vector plus cash already booked)
  // using the board, respecting sizes. Returns the locked total.
  function bestLayoff(board, position) {
    const legs = legsOf(board);
    const caps = legs.map(l => l.size);
    const neg = {};
    for (const [k, q] of Object.entries(position.w)) neg[k] = -q;
    const r = solve(legs, neg, caps);
    if (!r) return null;
    return { locked: position.cash + position.c + r.value, route: r.route, cost: r.value };
  }

  // ---------- positions ----------
  //
  // A trade: { id, side: 'buy'|'sell', qty, price, who }.
  // A position: net basis vector w, expiry cash c, and cash paid now.

  function position(trades) {
    const w = {}; let c = 0, cash = 0;
    for (const t of trades) {
      const s = t.side === 'buy' ? 1 : -1;
      const v = vec(t.id);
      for (const [k, q] of Object.entries(v.w)) w[k] = (w[k] || 0) + s * t.qty * q;
      c += s * t.qty * v.c;
      cash -= s * t.qty * t.price;
    }
    for (const k of Object.keys(w)) if (Math.abs(w[k]) < 1e-7) delete w[k];
    return { w, c, cash };
  }

  // Net holdings by instrument, for display.
  function holdings(trades) {
    const h = {};
    for (const t of trades) h[t.id] = (h[t.id] || 0) + (t.side === 'buy' ? t.qty : -t.qty);
    for (const k of Object.keys(h)) if (Math.abs(h[k]) < 1e-7) delete h[k];
    return h;
  }

  function positionDelta(model, trades) {
    let d = 0;
    for (const t of trades) d += (t.side === 'buy' ? 1 : -1) * t.qty * delta(model, t.id);
    return d;
  }

  // Edge of a trade against theo: what it is worth to you at fair value.
  function edge(model, t) {
    return (t.side === 'buy' ? 1 : -1) * t.qty * (theo(model, t.id) - t.price);
  }

  // True when the net vector has no options and no stock left: riskless.
  function isFlat(pos) { return Object.keys(pos.w).length === 0; }

  // Options left over, once each strike's call and put are netted through
  // parity. Zero means only stock (pure delta) remains.
  function optionRisk(pos) {
    return Object.entries(pos.w).filter(([k]) => k !== 'S').reduce((a, [, q]) => a + Math.abs(q), 0);
  }

  const api = {
    get TICK() { return TICK; }, setTick, round, floorT, ceilT, id, parse, label, shortLabel, vec,
    callTheo, putTheo, shiftModel, theo, delta, strikeVega, vegaTable, vega, split, bsCall, simplex,
    legsOf, solve, implied, bestArb, bestLayoff,
    position, holdings, positionDelta, edge, isFlat, optionRisk,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
