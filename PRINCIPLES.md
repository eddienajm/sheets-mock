# Trading principles the game tests

The game is judged against this list. Each principle has an ID; `test/principles.test.js` checks the game reproduces the worked examples (worked through on the 12 October mock and in the notes on it). Add a principle here before building a beat for it.

Rate is zero throughout, so parity is exact.

## Pricing

**P1 Theo comes from the board.** A strike's call is worth the mid of the tightest market the board makes in it: its own quote, or one built through parity, the spreads or the box. Puts and structures follow by parity. Strikes priced one at a time can, after rounding, bend the call curve the wrong way and price a fly below zero. Theo is then pulled back onto a curve with no arb in it (falling, convex, each spread within its strike gap), keeping each strike inside its own market where possible. Fixture: call 8/10, stock 100/101 → call 9, put 9 − 100.5 + 100 = 8.5.

**P2 Every option is its partner plus stock.** P = C − S + K, so C = P + S − K. Fixture: selling the 120 put at 24.5 and selling stock at 100 to hedge is selling the 120 call at 24.5 + 100 − 120 = 4.5.

**P3 The synthetic future.** A long call and a short put at strike K are a long future at K + C − P. A long put and a short call are a short future at the same price. Compare that price with the stock, buying low and selling high. Fixture: buy the 100 put at 7 and sell the 100 call at 8, and you have sold the future at 100 + 8 − 7 = 101. With stock offered at 101 there is no arb, so the call has to go at 8.5 or more.

**P4 Straddle = call + put = 2C − S + K.** A fair straddle is the fair call plus the fair put. Buying two calls and selling a share is a straddle. Fixture: with stock at 102/103 and the call at 8/10, the call is worth 9 and the put 6.5. Buying the straddle back on the board costs 2 × 10 − 102 + 100 = 18, so an 18 bid has nothing in it and an 18.5 bid has +0.5.

**P5 Spreads.** A call spread is C1 − C2 and a put spread is P2 − P1. Both sit between 0 and K2 − K1.

**P6 The box.** Call spread + put spread = K2 − K1. The put spread market is the strike gap less the call spread market, with bid and offer swapped. Fixture: a 110/120 call spread at 2/3 makes the put spread 7/8.

**P7 The fly.** C1 − 2C2 + C3 is the lower call spread less the upper one. It is never below 0 or above the wing width, and the call fly equals the put fly.

**P8 A stock move moves each option by its delta.** ΔC = Δc·ΔS and ΔP = (Δc − 1)·ΔS. Quotes that do not move go stale. In the 12 October replay the room was still showing the call at 8/10 after the stock moved, so theo there came off that quote.

## Making a market

**M1 Armable.** Whatever trades on your quote can be laid off on the board at a profit. The room's standard is the board's lay-off market plus half a tick each side.

**M2 Contain theo; never cross the board.**

**M3 Hedge slippage scales with delta.** Hedging an option costs |Δ| × half the stock spread per lot. When the stock widens, each side needs about |Δ| × (the rise in half-spread) more edge. Fixture: the stock goes from 1 wide to 3 wide, so the half-spread rises by 1. The 50-delta 100 strike widens 0.5 a side and the 95-delta 80 call widens about 1.

**M4 Asymmetric edge on a round trip.** Selling a 90-delta put means selling 90% of the stock straight away. The call that completes the round trip needs only the last 10%, so it needs less edge than the put did.

## After you trade

**A1 Check the arb first.** Ask whether the position can be closed on the board at a profit right now: the partner plus stock, the box, or the spreads. If it can, do it for the full size the board shows.

**A2 Otherwise hold it outright and hedge the delta.** Trade |Δ| × qty of stock to be delta flat, and never leave delta open. Fixture: long 25 100 puts at 50 delta → buy 13 stock.

**A3 Then lean your markets to get out.** When you're long, lower your bid and improve your offer. Quote the partner beyond break-even, where break-even is the partner price at which the synthetic future equals the stock you hedged with. Resting inside the board can beat crossing it. Fixtures:
- Long the 100 put at 7 with stock bought at 101: the call breaks even at 101 − 100 + 7 = 8. Offering it at 9 locks +1 a lot (+1.5 on the put against theo, less 0.5 crossing the stock).
- Short the 120 put at 24.5 with stock sold at 100: the call breaks even at 4.5. Crossing its 4 offer locks +0.5 a lot, and bidding 3.5 and getting hit locks +1.

**A4 Tell it from the trade that happened.** Never walk through the side that didn't trade.

## Orders from the market

**O1 An order is worth taking only if the board does the opposite for less.** Compare the order with the board's implied market. An order at the board's level has nothing in it.

**O2 Edge × size.** Trade the most you can lay off. When a leg is thinner than the order, size to the thinnest leg.

**O3 Wait on a walked price** until it is through break-even.

**O4 A pulled quote changes the route.** With the put offer gone, the straddle can only be laid off through two calls and the stock.

**O5 After an order in a structure, show your own market in it.**

## Stock moves on a stale book

**S1 Rank stale quotes by edge × size,** where edge is against the delta-moved theo, net of the hedge.

## Vega and flow

**V1 Option-equivalent vega.** Kept to easy numbers, in steps of 0.05. The strike with the most vega always carries 1 a lot, and the two wing strikes carry 0.1. The strikes in between follow the Black-Scholes vega shape on each side of the top strike, exp(−d1²/2) with d1 = N⁻¹(delta), rescaled to run from 0.1 up to 1. Fixture: on the night's board (95/80/50/20/10 delta) that gives 0.1, 0.65, 1, 0.5, 0.1. Call and put on a strike share it, and stock has none. A straddle is 2, a call spread is the difference of its legs, and a box is 0. Net vega is the sum over the trade list, like net delta.

**F1 Persistent flow moves fair value.** When the market keeps buying vol, fair moves up: every 50 vega it buys, the ATM option is worth 1 more, and each other strike moves by its own vega. Moves are rounded to the tick and trimmed wherever a fly would go below zero or a spread outside its bounds. Call and put on a strike move together, so parity holds and spreads, boxes and flies stay in line. The room re-marks, your quotes don't, and you should move yours with it. A stale offer gets lifted by the informed half of the flow. Fixture: after the market buys 50 vega, the top-vega call and put both rise 1, the other strikes by their vega rounded to the tick, the box doesn't move, and the room's board still has no arb.

## How the game behaves (design rules, not trading principles)

- **G1** When the market trades your standing quotes, half the time it is informed and hits only quotes off theo; the other half it is clueless.
- **G2** When the market posts liquidity, half of it is fair and half is an opportunity.
- **G3** There is one running book. Your quotes stay on the board at your levels, a used-up side shows struck at size 0, and your market replaces the room's in that instrument. Follow-ups come from your position.
- **G4** The game's language is "arb to flat", "hold it outright, delta-hedged" and "buy N stock to hedge to delta flat". Never "lock" a position or "square" the stock.
- **G5** Each explanation step is one line. The framework behind it sits in an expandable "Why?".
- **G6** A session is five questions, plus whatever follow-ups they cause. The components are chosen on the start screen.

- **G7** The trade list shows each line's delta (and vega, with that toggle on) in shares and vega, with a net row at the top as a running total.
- **G8** With flow on (level 4 on the start screen), the market leans one way on vol for the whole session, buying or selling; the start screen doesn't say which. 80% of its orders and of its trades on your quotes go that way and 20% against. Every 50 vega of net flow moves fair value 1 at the money.
