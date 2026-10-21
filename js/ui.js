// The whiteboard. Renders the Game and turns clicks into game calls.

(function () {
  const E = window.Engine, Sc = window.Scenario, { Game, topOf, n2, signed } = window.GameCore;
  const fmtP = Sc.fmtP;
  const $ = s => document.querySelector(s);

  let game = null;
  let ticket = null;          // { id, side, qty, price, mine }
  let mmErr = '';             // why the last market was refused
  const blank = () => ({ bid: '', bq: '', ask: '', aq: '' });
  let draft = blank();        // a market being typed on the board, kept across redraws
  let animKey = null;         // a hit on your quote animates once, not on every redraw
  let stepIdx = 0;            // which step of the explanation the board is showing
  let whyOpen = false;        // the "Why?" stays open as you step through
  let review = null;          // index into game.history when looking back
  let S = null;               // what the board is drawing: live, the explanation's, or a past question's

  // ---------- start screen ----------

  // Five levels, each adding to the one before. The first two have a choice
  // stock (no spread), so parity and the combos come without hedge costs.
  const COMBOS = { straddle: true, spreads: true, box: true, fly: true };
  const LEVELS = [
    ['Just put-call parity, choice stock', 'The stock has no spread: buy or sell it at one price.', { pcp: true, choice: true }],
    ['Parity and combos, choice stock', 'Adds straddles, spreads, boxes and flies.', { pcp: true, ...COMBOS, choice: true }],
    ['Parity and combos, stock with a spread', 'Hedging now crosses the stock spread: |delta| × half the spread a lot.', { pcp: true, ...COMBOS }],
    ['Parity, combos and the stock moving', 'Adds the stock widening (width scales with delta) and the stock moving on a stale board (edge × size).', { pcp: true, ...COMBOS, width: true, move: true }],
    ['Vega and trade flow', 'All of the above, plus option-equivalent vega in the trade list and trade flow that moves fair value: every 50 vega it trades, 1 at the money.', { pcp: true, ...COMBOS, width: true, move: true, vega: true, flow: true }],
  ];
  function loadLevel() {
    try { const n = +localStorage.getItem('sheetsmock.level5'); if (n >= 0 && n < LEVELS.length) return n; } catch (e) {}
    return 0;
  }
  function saveLevel(n) { try { localStorage.setItem('sheetsmock.level5', String(n)); } catch (e) {} }

  function showSetup() {
    game = null; review = null;
    document.body.classList.add('setup-mode');
    const cur = loadLevel();
    $('#setup').innerHTML = `
      <h2>What do you want to be tested on?</h2>
      <p class="muted">The conductor builds the board one market at a time and trades your market when it has an arb. Prices tick in 0.5, 0.05 or 0.01, with sizes to match.</p>
      <form id="cfg">
        <fieldset>${LEVELS.map(([name, desc], i) => `<label class="choice"><input type="radio" name="level" value="${i}" ${i === cur ? 'checked' : ''}><span><b>${i + 1}. ${name}</b>${desc ? `<span class="muted">${desc}</span>` : ''}</span></label>`).join('')}</fieldset>
        <div class="btns start">
          <button type="button" id="replay-go" class="ghost">Replay 12 October (15 questions)</button>
          <button type="button" id="replay20-go" class="ghost">Replay 20 October (11 questions)</button>
          <button type="submit" class="primary">Start: 5 questions</button>
        </div>
      </form>`;
    const level = () => +$('#cfg').querySelector('input[name=level]:checked').value;
    $('#cfg').addEventListener('submit', e => {
      e.preventDefault();
      const n = level();
      saveLevel(n);
      newGame('gen', LEVELS[n][2]);
    });
    // The night's questions are fixed; level 4 still adds the vega column.
    $('#replay-go').addEventListener('click', () => newGame('replay', null, { vega: !!LEVELS[level()][2].vega }));
    $('#replay20-go').addEventListener('click', () => newGame('replay20', null, { vega: !!LEVELS[level()][2].vega }));
  }


  function newGame(kind, cfg, opts) {
    document.body.classList.remove('setup-mode');
    const seed = Math.floor(Math.random() * 9000) + 1000;
    game = new Game(kind === 'replay' ? Sc.replay1012() : kind === 'replay20' ? Sc.replay1020() : Sc.genSession(seed, cfg), opts);
    ticket = null; mmErr = ''; draft = blank(); stepIdx = 0; animKey = null; review = null;
    render();
    focusSlot();
  }
  const focusSlot = () => setTimeout(() => { const b = $('#mm-bid'); if (b) b.focus(); }, 0);

  const hitKey = () => (game.hit ? `${game.n}:${game.hit.id}:${game.hit.side}:${game.hit.qty}` : null);
  const livePhase = () => ['ask', 'hedge', 'opp', 'pick'].includes(game.phase);

  // ---------- board ----------

  // What the board draws. Live, the explanation's board (as the question
  // started, with your quotes now), or a finished question being looked back at.
  function boardState() {
    if (review != null) {
      const h = game.history[review];
      return { quotes: h.quotes, mine: h.mine, hit: h.hit, live: false, target: null, anim: false };
    }
    const judge = game.phase === 'judge';
    return { quotes: judge ? game.explainQuotes() : game.board.quotes, mine: game.board.mine, hit: game.hit,
      live: livePhase(), target: game.phase === 'ask' ? game.beat.target : null, anim: hitKey() !== animKey };
  }

  // One instrument: the best bid and offer across the room and your quotes.
  // The room's prices are buttons (trade, or rest a price inside). Yours sit
  // in an outlined tile; click one to change it or take it down.
  function cell(qid, extraCls = '') {
    if (S.target === qid) {
      // The asked-for market is typed straight onto the board.
      const slot = (s, q) => `<span class="px"><input class="slot" id="mm-${s}" data-k="${s}" inputmode="decimal" aria-label="${s === 'bid' ? 'bid' : 'offer'}" value="${draft[s]}"><sub><input class="slot qty" id="mm-${q}" data-k="${q}" inputmode="decimal" aria-label="${s === 'bid' ? 'bid' : 'offer'} size" placeholder="${n2(game.beat.size)}" value="${draft[q]}"></sub></span>`;
      return `<form id="mm" class="q target ${extraCls}" autocomplete="off">${slot('bid', 'bq')}<span class="slash">/</span>${slot('ask', 'aq')}</form>`;
    }
    const top = topOf(S.quotes, S.mine, qid);
    if (!top.bid && !top.ask) {
      if (S.live && qid !== 'S') return `<button class="q empty quote ${extraCls}" data-qid="${qid}" data-new="1" title="Show a price in the ${E.label(qid)}">·</button>`;
      return `<span class="q empty ${extraCls}" data-qid="${qid}">·</span>`;
    }
    const h = S.hit && S.hit.id === qid ? S.hit : null;
    const anim = h && S.anim;
    const changed = review == null && game.board.changed && game.board.changed.has(qid);
    const roomQ = S.quotes[qid];
    const side = s => {
      const t = top[s];
      if (!t) {
        if (S.live && qid !== 'S') return `<button class="px ${s} add" data-id="${qid}" data-side="${s}" data-new="1" title="Show a ${s === 'bid' ? 'bid' : 'offer'} in the ${E.label(qid)}">+</button>`;
        return `<span class="px ${s}" data-id="${qid}" data-side="${s}">&nbsp;</span>`;
      }
      const isHit = h && h.side === s && t.mine;
      const cls = ['px', s, t.mine ? 'mine' : '', t.gone ? 'gone' : '', t.order ? 'order' : '', isHit ? 'hit' : '', isHit && anim ? 'anim' : '',
        S.live ? 'live' : '', ticket && ticket.id === qid && ticket.cell === s ? 'picked' : ''].join(' ');
      const sub = `<sub${isHit && anim ? ` data-from="${t.size + h.qty}" data-to="${t.size}"` : ''}>${n2(t.size)}</sub>`;
      const inner = `${fmtP(t.price)}${sub}`;
      if (S.live && (!t.mine || qid !== 'S')) {
        const title = t.mine ? `Your ${s === 'bid' ? 'bid' : 'offer'}: change it or take it down` : `${s === 'bid' ? 'Sell' : 'Buy'} the ${E.label(qid)} at ${fmtP(t.price)}, or rest a price inside`;
        return `<button class="${cls}" data-id="${qid}" data-side="${s}"${t.mine ? ' data-mine="1"' : ''} title="${title}">${inner}</button>`;
      }
      return `<span class="${cls}" data-id="${qid}" data-side="${s}"${t.mine ? ' title="Your quote"' : ''}>${inner}</span>`;
    };
    const tag = h ? `<span class="hittag ${anim ? 'anim' : ''}">${h.conductor === 'sell' ? 'Sold you' : 'Bought'} ${n2(h.qty)}</span>` : '';
    const blue = changed || (roomQ && roomQ.conductor);
    return `<span class="q ${blue ? 'blue' : ''} ${extraCls}" data-qid="${qid}">${side('bid')}<span class="slash">/</span>${side('ask')}${tag}</span>`;
  }

  // Count a traded size down, e.g. 25 to 0, once the board is drawn.
  function runHitAnimation() {
    if (!game || !game.hit || review != null) return;
    const el = document.querySelector('.px.hit.anim sub[data-from]');
    animKey = hitKey();
    if (!el) return;
    const from = +el.dataset.from, to = +el.dataset.to;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.textContent = n2(from);
    const t0 = performance.now(), dur = 700;
    const step = t => {
      const k = Math.min(1, (t - t0) / dur);
      el.textContent = n2(Math.round(from + (to - from) * k));
      if (k < 1) requestAnimationFrame(step);
    };
    setTimeout(() => requestAnimationFrame(step), 250);
  }

  function renderBoard() {
    const b = game.board;
    S = boardState();
    const V = game.showVega;
    const rows = b.strikes.map(k => {
      const d = b.cd[k] != null ? `${Math.round(b.cd[k] * 100)}d` : '';
      const v = V ? `<div class="v" title="option-equivalent vega a lot">${n2(E.vegaTable(b.strikes, b.cd)[k])}v</div>` : '';
      return `<div class="row"><div class="c">${cell('C' + k)}</div><div class="k">${k}</div><div class="p">${cell('P' + k)}</div><div class="d" title="call delta">${d}</div>${v}</div>`;
    }).join('');
    // Straddles, spreads, boxes and flies go to the side: the room's, yours,
    // and whatever is being asked for.
    const sideIds = [...new Set([...Object.keys(S.quotes), ...Object.keys(S.mine)])].filter(id => /^(V|CS|PS|BOX|FLY)/.test(id));
    if (S.target && /^(V|CS|PS|BOX|FLY)/.test(S.target) && !sideIds.includes(S.target)) sideIds.push(S.target);
    const side = sideIds.map(id => `<div class="srow"><span class="slabel">${E.shortLabel(id)}</span>${cell(id)}</div>`).join('');
    $('#board').innerHTML = `
      <div class="stock">S = ${cell('S', 'big')}${b.choice ? '<span class="muted choice-tag">choice</span>' : ''}</div>
      <div class="grid ${V ? 'withv' : ''}">
        <div class="heads"><div class="c">C</div><div class="k"></div><div class="p">P</div><div class="d"></div>${V ? '<div class="v"></div>' : ''}</div>
        ${rows}
      </div>
      <div class="side">${side}</div>`;
    $('#board').classList.toggle('reviewing', review != null);
    $('#board').classList.toggle('penny', (b.tick ?? 0.5) < 0.1);
  }

  // ---------- the question ----------

  function renderSay() {
    const ph = game.phase, bt = game.beat, h = game.hit;
    const say = $('#say');
    const put = (context, line, anim) => {
      say.innerHTML = `<span class="lines">${context ? `<span class="asked">${context}</span>` : ''}<span class="line ${anim ? 'anim' : ''}">${line}</span></span>`;
    };
    if (review != null) {
      const hh = game.history[review];
      return put(`Looking back: question ${hh.q} of ${game.agenda.length}`, hh.title.replace(/\.+$/, '') + '.');
    }
    const mq = bt.target ? game.board.mine[bt.target] : null;
    const shown = mq && mq.bid != null && mq.ask != null ? `Your ${E.label(bt.target)}: ${fmtP(mq.bid)} / ${fmtP(mq.ask)}.` : '';
    const events = game.events().join(' ');
    if (ph === 'ask') return put(events, game.question());
    if (ph === 'pick') return put(events, game.question());
    if ((ph === 'hedge' || ph === 'opp') && game.nagged) return put(shown || events, '<b>What do you do next?</b>', true);
    if (h && ph === 'hedge') {
      const name = E.label(h.id);
      const did = h.conductor === 'sell' ? `The market sold you ${n2(h.qty)} ${name} at ${fmtP(h.price)}.` : `The market bought ${n2(h.qty)} ${name} from you at ${fmtP(h.price)}.`;
      return put([events, shown].filter(Boolean).join(' '), `${did} <b>What do you do?</b>`, hitKey() !== animKey);
    }
    if (ph === 'hedge') return put(events || shown, '<b>What do you do next?</b>');
    if (ph === 'opp') return put(events, game.question());
    if (ph === 'judge' && bt.type === 'make' && !bt.targets) return put(events, `${game.question()} ${shown}${h ? '' : ' No trade.'}`);
    return put(events, game.judged.title.replace(/\.+$/, '') + '.');
  }

  // ---------- trades and controls ----------

  // The session's trades, newest last; earlier questions are greyed. Position,
  // delta and P&L are the player's to work out from here.
  // Delta and vega are each line's total (quantity × per lot), so the net
  // row at the top is the running position: the sum of the column below.
  function tradeList(trades = game.trades, nowN = game.n) {
    if (!trades.length) return '';
    const V = game.showVega, r2 = x => Math.round(x * 100) / 100;
    let nd = 0, nv = 0;
    const rows = trades.map(tr => {
      const q = (tr.side === 'buy' ? 1 : -1) * tr.qty;
      const d = q * E.delta(game.model, tr.id), v = q * E.vega(game.model, tr.id);
      nd += d; nv += v;
      return `<tr class="${tr.beat === nowN ? '' : 'old'}"><td class="num ${q > 0 ? 'long' : 'short'}">${q > 0 ? '+' : ''}${n2(q)}</td><td>${E.label(tr.id)}</td><td class="num">${fmtP(tr.price)}</td><td class="num muted">${signed(r2(d))}</td>${V ? `<td class="num muted">${signed(r2(v))}</td>` : ''}<td class="muted">${tr.fromMarket ? 'your quote' : 'board'}</td></tr>`;
    }).join('');
    const net = `<tr class="net"><td colspan="3">Net position</td><td class="num">${signed(r2(nd))}</td>${V ? `<td class="num">${signed(r2(nv))}</td>` : ''}<td></td></tr>`;
    return `<div class="tl"><table class="trades"><caption>Trade list</caption><thead><tr><th class="num">Qty</th><th>Instrument</th><th class="num">Price</th><th class="num">Delta</th>${V ? '<th class="num" title="option-equivalent vega">OE vega</th>' : ''}<th>With</th></tr>${net}</thead><tbody>${rows}</tbody></table></div>`;
  }

  // The ticket: trade the room's price, or change the price to rest your own
  // bid or offer inside it. On your own quote: change it or take it down.
  function ticketHtml() {
    if (!ticket) return '';
    const t = ticket, r = game.board.quotes[t.id];
    const rs = t.side === 'buy' ? 'ask' : 'bid';
    const room = r && r[rs] != null && (r[rs + 'Size'] ?? 100) > 0 ? { price: r[rs], size: r[rs + 'Size'] ?? 100 } : null;
    const sideBtn = s => `<button type="button" class="tside-btn ${s} ${t.side === s ? 'on' : ''}" data-tside="${s}">${s === 'buy' ? 'Buy' : 'Sell'}</button>`;
    return `
      <form id="tk" class="ticket" autocomplete="off">
        <span class="tsides">${sideBtn('buy')}${sideBtn('sell')}</span>
        <input id="tk-qty" inputmode="decimal" value="${t.qty}" aria-label="quantity">
        <span>${E.label(t.id)} at</span>
        <input id="tk-px" inputmode="decimal" value="${t.price ?? ''}" aria-label="price">
        <span class="muted" id="tk-room">${room ? `board ${t.side === 'buy' ? 'offers' : 'bids'} ${fmtP(room.price)} for ${n2(room.size)}` : `nothing on the board to ${t.side === 'buy' ? 'buy' : 'sell'}`}</span>
        <button type="submit" class="primary" id="tk-go"></button>
        ${t.mine ? `<button type="button" id="tk-pull" class="ghost">Take my ${t.side === 'buy' ? 'bid' : 'offer'} down</button>` : ''}
        <button type="button" id="tk-x" class="ghost">Cancel</button>
        <span class="err" id="tk-err"></span>
      </form>`;
  }
  function ticketMode() {
    const t = ticket, r = game.board.quotes[t.id];
    const rs = t.side === 'buy' ? 'ask' : 'bid';
    const px = parseFloat($('#tk-px').value);
    const rp = r && r[rs] != null && (r[rs + 'Size'] ?? 100) > 0 ? r[rs] : null;
    const crosses = rp != null && px === px && (t.side === 'buy' ? px >= rp : px <= rp);
    $('#tk-go').textContent = crosses ? `${t.side === 'buy' ? 'Buy' : 'Sell'} at ${fmtP(rp)}` : t.side === 'buy' ? 'Post bid' : 'Post offer';
    return { crosses, px };
  }

  // Ticket, trade list and the Undo/Done buttons. `full` adds Done/Pass.
  function tradeArea(full) {
    const ph = game.phase;
    const noTrades = !game.beatTrades.length;
    const label = ph === 'pick' ? 'Pass'
      : ph === 'opp' && noTrades ? (game.canStep() ? 'Pass, wait for a better price' : 'Pass')
      : game.nagged ? 'Leave it' : 'Done';
    const hint = ph === 'hedge' || ph === 'opp' || ph === 'pick'
      ? `<p class="hint">Click a price on the board to trade it, or change the price on the ticket to rest your own bid or offer. Click one of your quotes to change it.</p>` : '';
    const buttons = `
      <div class="btns">
        <button id="undo" class="ghost" ${game.canUndo() ? '' : 'disabled'}>Undo last</button>
        ${full ? `<button id="done" class="primary">${label}</button>` : ''}
      </div>`;
    return `${ticketHtml()}${tradeList()}${hint}${full || game.canUndo() ? buttons : ''}`;
  }

  function bindTradeArea(full) {
    const ph = game.phase;
    if (ticket) {
      const qi = $('#tk-qty'), pi = $('#tk-px');
      ticketMode();
      (ticket.focus === 'px' ? pi : qi).focus();
      (ticket.focus === 'px' ? pi : qi).select();
      pi.addEventListener('input', ticketMode);
      document.querySelectorAll('[data-tside]').forEach(b => b.addEventListener('click', () => {
        ticket.side = b.dataset.tside; ticket.qty = qi.value; ticket.price = pi.value; ticket.mine = false; ticket.cell = null; render();
      }));
      $('#tk').addEventListener('submit', e => {
        e.preventDefault();
        const qty = parseFloat(qi.value), { crosses, px } = ticketMode();
        const r = crosses ? game.trade(ticket.id, ticket.side, qty) : game.post(ticket.id, ticket.side, px, qty);
        if (r.error) { $('#tk-err').textContent = r.error; return; }
        ticket = null; render();
      });
      if ($('#tk-pull')) $('#tk-pull').addEventListener('click', () => { game.pull(ticket.id, ticket.side === 'buy' ? 'bid' : 'ask'); ticket = null; render(); });
      $('#tk-x').addEventListener('click', () => { ticket = null; render(); });
    }
    const u = $('#undo');
    if (u) u.addEventListener('click', () => { game.undo(); ticket = null; render(); });
    const d = $('#done');
    if (full && d) d.addEventListener('click', () => {
      ticket = null;
      if (ph === 'pick' && !game.beatTrades.length) game.finish();
      else if (ph === 'opp' && !game.beatTrades.length) game.pass();
      else if (game.unhedged() && !game.nagged) game.nagged = true;
      else game.wrapUp();
      render();
      focusSlot();
    });
  }

  // The explanation: one line per step, the framework behind it in "Why?".
  function explainHtml(j, k) {
    const steps = j.steps || [];
    if (!steps.length) return '';
    const s = steps[k];
    return `<div class="explain" aria-live="polite">
        <button id="sb" class="ghost step" ${k === 0 ? 'disabled' : ''} aria-label="Previous step">&lsaquo;</button>
        <div class="stepbody">
          <p class="steptext"><span class="stepn">${k + 1} / ${steps.length}</span> ${s.text}</p>
          ${s.why ? `<details class="why" ${whyOpen ? 'open' : ''}><summary>Why?</summary><p>${s.why}</p></details>` : ''}
        </div>
        <button id="sf" class="ghost step" ${k === steps.length - 1 ? 'disabled' : ''} aria-label="Next step">&rsaquo;</button>
      </div>`;
  }
  function bindExplain(steps, k) {
    const go = d => { stepIdx = Math.max(0, Math.min(steps.length - 1, k + d)); render(); };
    if ($('#sb')) $('#sb').addEventListener('click', () => go(-1));
    if ($('#sf')) $('#sf').addEventListener('click', () => go(1));
    const w = $('details.why');
    if (w) w.addEventListener('toggle', () => { whyOpen = w.open; });
  }

  function renderControls() {
    const ph = game.phase;
    const act = $('#act');
    $('#progress').textContent = game.done ? 'Finished' : `${game.questionNo} of ${game.agenda.length}`;
    $('#back').disabled = !game.history.length || review === 0;
    if (review != null) return renderReview();
    if (ph === 'done') { renderSummary(); return; }
    renderSay();

    if (ph === 'ask') {
      act.innerHTML = `${mmErr ? `<p class="err">${mmErr}</p>` : ''}${tradeArea(false)}`;
      document.querySelectorAll('#mm .slot').forEach(el => {
        el.addEventListener('input', e => { draft[e.target.dataset.k] = e.target.value; });
        // Enter shows the market. A form with several fields and no submit
        // button does not submit on Enter by itself.
        el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#mm').requestSubmit(); } });
      });
      $('#mm').addEventListener('submit', e => {
        e.preventDefault();
        const num = s => (s.trim() === '' ? null : parseFloat(s));
        const r = game.submitMarket(parseFloat(draft.bid), parseFloat(draft.ask), num(draft.bq), num(draft.aq));
        if (r.error) { mmErr = r.error; render(); focusSlot(); return; }
        ticket = null; draft = blank(); mmErr = ''; stepIdx = 0;
        render();
        focusSlot();
      });
      bindTradeArea(false);
      return;
    }

    if (ph === 'hedge' || ph === 'opp' || ph === 'pick') {
      act.innerHTML = tradeArea(true);
      bindTradeArea(true);
      return;
    }

    if (ph === 'judge') {
      const j = game.judged;
      const steps = j.steps || [];
      const k = Math.min(stepIdx, Math.max(0, steps.length - 1));
      act.innerHTML = `
        ${tradeList()}
        <ul class="verdict">${j.verdict.map(([c, t]) => `<li class="${c}">${t}</li>`).join('')}</ul>
        ${explainHtml(j, k)}
        <div class="btns"><button id="next" class="primary">Next</button></div>`;
      bindExplain(steps, k);
      $('#next').addEventListener('click', () => { stepIdx = 0; game.next(); render(); focusSlot(); });
      ($('#sf') && !$('#sf').disabled ? $('#sf') : $('#next')).focus();
    }
  }

  // A finished question, read-only.
  function renderReview() {
    const h = game.history[review], j = h.judged;
    renderSay();
    const steps = j.steps || [];
    const k = Math.min(stepIdx, Math.max(0, steps.length - 1));
    $('#act').innerHTML = `
      ${tradeList(h.trades, h.n)}
      <ul class="verdict">${j.verdict.map(([c, t]) => `<li class="${c}">${t}</li>`).join('')}</ul>
      ${explainHtml(j, k)}
      <div class="btns">
        <button id="rv-later" class="ghost" ${review >= game.history.length - 1 ? 'disabled' : ''}>Later question</button>
        <button id="rv-back" class="primary">Back to the game</button>
      </div>`;
    bindExplain(steps, k);
    $('#rv-later').addEventListener('click', () => { review++; stepIdx = 0; render(); });
    $('#rv-back').addEventListener('click', () => { review = null; stepIdx = 0; render(); focusSlot(); });
  }

  function renderSummary() {
    const t = game.totals();
    $('#say').innerHTML = `<span class="lines"><span class="line">Session finished.</span></span>`;
    const rows = game.results.map((r, i) => {
      const worst = r.verdict.some(v => v[0] === 'bad') ? 'bad' : r.verdict.some(v => v[0] === 'warn') ? 'warn' : 'good';
      return `<li class="${worst}"><button class="linkish" data-h="${i}"><span class="n">${i + 1}</span><span class="t">${r.title}</span></button></li>`;
    }).join('');
    $('#act').innerHTML = `
      <div class="summary">
        <p>${t.book.flat ? 'Book flat.' : `Book not flat: ${signed(Math.round(t.book.delta))} shares of delta.`}${game.showVega ? ` Net vega ${signed(Math.round(t.vega * 100) / 100)}.` : ''}${game.flow ? ` The market was a ${game.flow.dir > 0 ? 'buyer' : 'seller'} of vol all session: ${n2(Math.round(Math.abs(game.flow.vega)))} vega, ${game.flow.steps} re-mark${game.flow.steps === 1 ? '' : 's'}.` : ''} ${t.missed ? `${t.missed} opportunit${t.missed > 1 ? 'ies' : 'y'} missed.` : ''} Click a question to look at it again.</p>
        ${tradeList()}
        <ol class="beats">${rows}</ol>
        <div class="btns"><button id="again" class="primary">New game</button></div>
      </div>`;
    $('#act').querySelectorAll('[data-h]').forEach(b => b.addEventListener('click', () => { review = +b.dataset.h; stepIdx = 0; render(); }));
    $('#again').addEventListener('click', showSetup);
  }

  function render() {
    if (!game) return;
    $('#title-sub').textContent = game.session.title;
    renderBoard();
    renderControls();
    runHitAnimation();
    showMarks();
    const tl = $('.tl');
    if (tl) tl.scrollTop = tl.scrollHeight;
  }

  // Light up the cells the current explanation step talks about, tag each
  // with what you do there, and dim the rest of the board.
  function showMarks() {
    const board = $('#board');
    const j = review != null ? game.history[review].judged : game.phase === 'judge' ? game.judged : null;
    const step = j && j.steps && j.steps[Math.min(stepIdx, j.steps.length - 1)];
    board.classList.toggle('explaining', !!step);
    if (!step) return;
    step.marks.forEach((m, i) => {
      const el = (m.side && board.querySelector(`.px[data-id="${m.id}"][data-side="${m.side}"]`)) || board.querySelector(`.q[data-qid="${m.id}"]`);
      if (!el) return;
      el.classList.add('mk', 'mk-' + m.act);
      if (m.note) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = m.note;
        b.style.animationDelay = `${i * 150}ms`;
        el.appendChild(b);
      }
    });
  }

  // ---------- events ----------

  document.addEventListener('click', e => {
    if (!game || review != null || !livePhase()) return;
    const b = e.target.closest('#board button.px, #board button.q');
    if (!b) return;
    const id = b.dataset.id || b.dataset.qid, s = b.dataset.side || 'bid';
    const side = s === 'bid' ? 'sell' : 'buy';
    const want = (game.hit && game.hit.qty) || game.beat.size || 25;
    if (b.dataset.new) {
      // An empty side: rest a price of your own there.
      ticket = { id, side: s === 'bid' ? 'buy' : 'sell', qty: want, price: '', mine: false, focus: 'px', cell: s };
    } else if (b.dataset.mine) {
      const m = game.board.mine[id];
      ticket = { id, side: s === 'bid' ? 'buy' : 'sell', qty: m[s + 'Size'] || want, price: m[s], mine: true, focus: 'px', cell: s };
    } else {
      const q = game.board.quotes[id];
      const size = q[s + 'Size'] ?? 100;
      ticket = { id, side, qty: Math.min(want, size), price: q[s], mine: false, cell: s };
    }
    render();
  });

  // Arrow keys step through the explanation.
  document.addEventListener('keydown', e => {
    if (!game || (game.phase !== 'judge' && review == null) || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const id = e.key === 'ArrowRight' ? '#sf' : e.key === 'ArrowLeft' ? '#sb' : null;
    const btn = id && $(id);
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
  });

  $('#new').addEventListener('click', showSetup);
  $('#back').addEventListener('click', () => {
    if (!game || !game.history.length) return;
    review = review == null ? game.history.length - 1 : Math.max(0, review - 1);
    stepIdx = 0; ticket = null;
    render();
  });

  // Screenshot hooks. Each finds a seed where the market hits the 7 bid of a
  // 7 / 10 market in the 100 put, then steps on from there.
  const demo = location.hash.slice(1);
  if (/^demo/.test(demo)) {
    let seed = 0;
    do { seed++; newGame('replay', null, { seed }); game.submitMarket(7, 10); } while (!(game.hit && game.hit.side === 'bid'));
    if (demo === 'demohit') { render(); }
    if (demo === 'demonag') { animKey = hitKey(); game.nagged = true; render(); }
    if (demo === 'demoticket') { animKey = hitKey(); game.trade('S', 'buy', 13); ticket = { id: 'C100', side: 'sell', qty: 25, price: 9, mine: false, focus: 'px' }; render(); }
    const dx = demo.match(/^demoexplain(\d)$/);
    if (dx) { game.trade('S', 'buy', 13); game.finish(); animKey = hitKey(); stepIdx = +dx[1] - 1; whyOpen = true; render(); }
    if (demo === 'demofollow') { game.trade('S', 'buy', 13); game.finish(); game.next(); render(); }
    if (demo === 'demoback') { game.trade('S', 'buy', 13); game.finish(); game.next(); review = 0; render(); }
    if (demo === 'demowidth') { const s = Sc.genSession(7, { width: true }); s.beats = s.beats.filter(b => b.targets); game = new Game(s, { seed: 1 }); render(); }
    if (demo === 'demopick') { const s = Sc.genSession(11, { move: true }); s.beats = s.beats.filter(b => b.type === 'pick'); game = new Game(s, { seed: 1 }); const c = game.candidates()[0]; game.trade(c.id, c.side, c.size); game.finish(); stepIdx = 1; render(); }
    if (demo === 'demostraddle' || demo === 'demostraddlejudge') {
      const s = Sc.replay1012();
      Sc.applyOps(s.board, [{ op: 'stock', bid: 102, ask: 103 }]);
      s.beats = [s.beats[5]];
      game = new Game(s, { seed: 3 }); game.wrapUp();
      if (demo === 'demostraddlejudge') { game.submitMarket(15, 17); if (game.phase !== 'judge') game.finish(); stepIdx = 0; whyOpen = true; }
      render();
    }
    if (demo === 'democlick') {
      // Through the page itself: click the call's 8 bid, change the price to
      // 9 and submit, so it rests as your offer.
      animKey = hitKey(); render();
      document.querySelector('#board button.px[data-id="S"][data-side="ask"]').click();
      $('#tk-qty').value = '13'; $('#tk').requestSubmit();
      document.querySelector('#board button.px[data-id="C100"][data-side="bid"]').click();
      $('#tk-px').value = '9'; $('#tk-px').dispatchEvent(new Event('input'));
      $('#tk').requestSubmit();
      document.querySelector('#board button.px[data-id="P100"][data-side="bid"]').click();
      $('#tk-px').value = '6.5'; $('#tk-px').dispatchEvent(new Event('input'));
    }
    if (demo === 'demovega') {
      let sd = 0;
      do { sd++; newGame('replay', null, { seed: sd, vega: true }); game.submitMarket(7, 10); } while (!(game.hit && game.hit.side === 'bid'));
      game.trade('S', 'buy', 13); game.trade('C100', 'sell', 25); game.trade('S', 'buy', 12); animKey = hitKey(); render();
    }
    if (demo === 'demoflow') {
      const s = Sc.genSession(21, { pcp: true, flow: true }); s.flowDir = 1;
      game = new Game(s, { seed: 5 });
      const t = game.beat.target, T = E.theo(game.model, t);
      game.submitMarket(E.floorT(T - 1), E.ceilT(T + 1));
      if (game.phase !== 'judge') game.finish();
      game.flow.vega = 52; game.next(); render();
    }
    if (demo === 'demolean') {
      const s = Sc.replay1012(); s.beats = [{ type: 'make', target: 'P120', size: 25 }];
      let sd = 0;
      do { sd++; game = new Game(s, { seed: sd }); game.submitMarket(21.5, 24.5); } while (!(game.hit && game.hit.side === 'ask'));
      game.trade('S', 'sell', 23); game.post('C120', 'buy', 3.5, 25); game.finish(); animKey = hitKey(); stepIdx = 3; whyOpen = true; render();
    }
  } else {
    showSetup();
  }
})();
