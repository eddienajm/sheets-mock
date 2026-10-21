# Trading principles the game tests

The game is judged against this list. Each principle has an ID; `test/principles.test.js` checks the game reproduces the worked examples (worked through on the 12 and 20 October mocks and in the notes on them). Add a principle here before building a beat for it.

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

**P9 Price a structure from mids, then add the width.** Theo of any structure is the sum of its legs' theos, weighted. The market you can arb it against is as wide as the sum of each leg's width times its weight, so a fly counts its body twice. Fixture (20 October): put fly 90/95/100 on 90P 0.70/0.75, 95P 1.70/1.91, 100P 4.025/4.08: theo 0.725 − 2 × 1.805 + 4.0525 = 1.1675; the legs arb it at 0.905 / 1.43, 0.525 wide (0.05 + 2 × 0.21 + 0.055).

**P10 A structure prices its legs.** At K = S on a choice stock the call and put are equal, so the 100 straddle at 8.05 / 8.15 makes each leg 4.025 / 4.075. The tightest source sets theo (P1): with the straddle there, a 3.9 bid in the call doesn't.

**P11 Spreads hold their value.** A spread between close strikes carries little of any greek, so it barely moves in a session. Write down every spread's value from the starting board, and quote spreads tight. A price well away from that value is a trade to hold, even when the board offers no arb out of it. Fixture (20 October, the conductor's own words): the 105/110 put spread starts worth 10.89 − 6.98 = 3.91, so 3.80 is a buy, though arbing out straight away (sell the 110 put at 10.85, buy the 105 put at 7.06) loses 0.01.

**P12 Directions: write the pluses and minuses on the strikes.** Buying a call spread buys the lower strike and sells the upper. Buying a put spread buys the upper strike and sells the lower, which is the opposite diagonal on the board. A put fly 90/95/100 is +90 −2×95 +100: long the 100/95 put spread, short the 95/90. Call spread + put spread on the same strikes is a long box worth the gap, so a sold call spread is arbed by **selling** the put spread too. Fixture: sold the 95/100 call spread at x, sell the 95/100 put spread at 2.30: x + 2.30 − 5 a lot.

## Making a market

**M1 Armable.** Whatever trades on your quote can be arbed on the board at a profit. The room's standard is the board's own market plus a tick each side.

**M2 Contain theo; never cross the board.**

**M3 Hedge slippage scales with delta.** Hedging an option costs |Δ| × half the stock spread per lot. When the stock widens, each side needs about |Δ| × (the rise in half-spread) more edge. Fixture: the stock goes from 1 wide to 3 wide, so the half-spread rises by 1. The 50-delta 100 strike widens 0.5 a side and the 95-delta 80 call widens about 1.

**M4 Asymmetric edge on a round trip.** Selling a 90-delta put means selling 90% of the stock straight away. The call that completes the round trip needs only the last 10%, so it needs less edge than the put did.

**M5 A choice stock has no spread.** Stock bid = offer, so hedging costs nothing and a parity market is the partner's market moved by K − S, exactly. Make it a tick wider each side so a fill can be arbed for a tick. Levels 1 and 2 of the game deal a choice stock; level 3 puts the spread back. Fixture (20 October): stock 100 choice, 90 call 10.6/10.72 → 90 put lays off at 0.60/0.72; show 0.59/0.73.

**M6 Lean with the strike next door.** When the market buys extrinsic at one strike, it is bidding vol, and the strikes beside it should go the same way. Raise your bid there rather than pull it. After a structure is bid, lean its legs the way it is long: a bid for the put fly 90/95/100 raises the 100/95 put spread and lowers the 95/90. Fixture (20 October): the conductor lifts the 90 put at 0.73; pulling the 1.69 bid in the 95 put is wrong, because selling the 95/90 put spread at 1.10 would leave you long the 95s.

## After you trade

**A1 Check the arb first.** Ask whether the position can be closed on the board at a profit right now: the partner plus stock, the box, or the spreads. If it can, do it for the full size the board shows.

**A2 Otherwise hold it outright and hedge the delta.** Trade |Δ| × qty of stock to be delta flat, and never leave delta open. Fixture: long 25 100 puts at 50 delta → buy 13 stock.

**A3 Then lean your markets to get out.** When you're long, lower your bid and improve your offer. Quote the partner beyond break-even, where break-even is the partner price at which the synthetic future equals the stock you hedged with. Resting inside the board can beat crossing it. Fixtures:
- Long the 100 put at 7 with stock bought at 101: the call breaks even at 101 − 100 + 7 = 8. Offering it at 9 locks +1 a lot (+1.5 on the put against theo, less 0.5 crossing the stock).
- Short the 120 put at 24.5 with stock sold at 100: the call breaks even at 4.5. Crossing its 4 offer locks +0.5 a lot, and bidding 3.5 and getting hit locks +1.

**A4 Tell it from the trade that happened.** Never walk through the side that didn't trade.

**A5 Arb through as many legs as the board needs.** The route out can run through a spread and another leg, not only the partner and the stock. Fixtures (20 October):
- Bought the 95 put at 1.79: sell the 95/90 put spread at 1.10, which leaves you long the 90 put at 0.69, and sell it at the 0.70 bid: +0.01 a lot.
- Sold the 95/90 put spread at 1.20: buy it back through the legs, lifting the 95 put at 1.85 and hitting the 90 put at 0.70, for 1.15: +0.05 a lot.
- Conductor bids the fly at 1.25: lift the 100/95 put spread at 2.39 and hit the 95/90 at 1.15, buying the fly for 1.24: +0.01 a lot.

**A6 If both legs of an arb are on the board, trade the scarce one first and keep the size as your exit.** With the 100 straddle bid 8.05 for 1,000 and two calls offered at 3.98 (7.96, choice stock), the arb is +0.09. Buy the calls first: the straddle bid is the deep side you lean on to get out, and the conductor raising it says that side is the one to be on.

**A7 A position is not an arb.** Name it before you trade it. Buying the 95/90 put spread at 1.20 and selling the 100/95 at 2.30 is selling the fly at 1.10, and the board buys it back at 1.43. Buying the 105/110 put spread at 3.80 and arbing out at 3.79 loses 0.01; hold it instead (P11).

## Orders from the market

**O1 An order is worth taking only if the board does the opposite for less.** Compare the order with the board's implied market. An order at the board's level has nothing in it. A bid in a straddle or an option is a bid for vol: sell it to them, and buy the same extrinsic back cheaper through the legs. An offer is the reverse. Fixture (20 October): straddle bid 8.05, 100 calls offered 3.98, stock 100 choice. Sell the straddle at 8.05, buy two calls and sell a share for 7.96: +0.09 a lot. If you sell to the bid and don't buy the calls, say that: the arb is left undone.

**O2 Edge × size.** Trade the most you can arb. When a leg is thinner than the order, size to the thinnest leg.

**O3 Wait on a walked price** until it is through break-even.

**O4 A pulled quote changes the route.** With the put offer gone, the straddle can only be arbed through two calls and the stock.

**O5 After an order in a structure, show your own market in it.**

## Stock moves on a stale book

**S1 Rank stale quotes by edge × size,** where edge is against the delta-moved theo, net of the hedge.

## Vega and flow

**V1 Option-equivalent vega.** Kept to easy numbers, in steps of 0.05. The strike with the most vega always carries 1 a lot, and the two wing strikes carry 0.1. The strikes in between follow the Black-Scholes vega shape on each side of the top strike, exp(−d1²/2) with d1 = N⁻¹(delta), rescaled to run from 0.1 up to 1. Fixture: on the night's board (95/80/50/20/10 delta) that gives 0.1, 0.65, 1, 0.5, 0.1. Call and put on a strike share it, and stock has none. A straddle is 2, a call spread is the difference of its legs, and a box is 0. Net vega is the sum over the trade list, like net delta.

**F1 Persistent flow moves fair value.** When the market keeps buying vol, fair moves up: every 50 vega it buys, the ATM option is worth 1 more, and each other strike moves by its own vega. Moves are rounded to the tick and trimmed wherever a fly would go below zero or a spread outside its bounds. Call and put on a strike move together, so parity holds and spreads, boxes and flies stay in line. The room re-marks, your quotes don't, and you should move yours with it. A stale offer gets lifted by the informed half of the flow. Fixture: after the market buys 50 vega, the top-vega call and put both rise 1, the other strikes by their vega rounded to the tick, the box doesn't move, and the room's board still has no arb.

## How the conductor runs it (20 October)

The conductor's job is to find out whether the room sees the arb. These rules decide what the game's conductor does next.

- **C1 Build the board in a chain.** Ask for markets in an order where each one is priced from what is already up: the 90 put from the 90 call, the 95 put from the 95/90 put spread and the 90 put, the straddle from the 100 call, the fly from three puts, the 100/95 put spread from the fly and the puts, the 95/100 call spread through the box, the 105/110 put spread from the 105 put and the 110 call.
- **C2 Trade a good market, then watch.** When someone shows a market that the board lets them arb at a profit, trade it, then see whether they complete the arb (the 95/90 put spread and the 95 put on 20 October).
- **C3 Lean one way, and open an arb through the legs.** Post orders in structures, priced so the legs beat them, and keep pushing the same way: straddle bid 7.96, then 8.05; fly bid 1.2, then 1.25. That is G8's flow, at the scale of one session.
- **C4 Refresh after a trade.** Pull the traded market and ask for it again (the 95 put, the 95/90 put spread).
- **C5 Tick and size are part of the board.** 20 October ran a choice stock, a 0.01 increment and 500 lots, so the edges were one to nine cents.

In the game: every level runs this conductor. Each session draws its scale: a 0.5 tick with 25-lot sizes (12 October), 0.05 with 100s, or 0.01 with 500s (20 October); market widths are set in units of 0.5, 0.05 and 0.05. The 20 October replay keeps the room's own mistakes, so its board can carry an arb the room left (the fly against a 1.15 bid in the 95/90 put spread). After the chain, the conductor uses the older moves too (O3 walked price, O4 pulled quote, an order in a single option, the box with a wide call), up to two a session.

## How explanations read (20 October)

From the first replay: "We need the guidance to be very streamlined, very clear... the minimum words on the page." The worked logic from 20 October is the model: name the one relationship, put the board's numbers through it, then say what the trade lets you do.

- **E1 Price it in one line.** The first step names the relationship that prices the instrument, shows the board's legs and gives the market and theo. Fixture: "At the money, twice the call: 100 call 3.8 / 3.98, stock 100 → 100 straddle 7.6 / 7.96, theo 7.78."
- **E2 Then the trade that happened, and what it lets you do now.** Fixture: sold the straddle at 7.96, the board buys it back at 7.96, so hold it and bid below 7.96 to get out: the straddle, or the 100 call or put up to 3.98. A third step only when something is left to do (a hedge, a lean).
- **E3 Say only what applies.** No hedge line for a position with no delta. No hedge cost on a choice stock. Once one side of your market has traded, the other side is not judged for being armable: a higher bid is now welcome, up to break-even.
- **E4 A verdict only for a mistake or money.** One plain line: a market that crosses the board or misses theo, a side that only scratches if it's hit, an arb missed, delta left open, or the money an arb made. Nothing when the market was fine.
- **E5 "Why?" is one or two sentences about this case,** not the general framework. A step that needs no why has none.

## How the game behaves (design rules, not trading principles)

- **G1** Only the conductor trades, as on 20 October: it trades your market when it has an arb (C2). With flow on (level 5) the market also trades your standing quotes between questions, half the time informed and hitting only quotes off theo, half the time clueless.
- **G2** When the market posts liquidity, half of it is fair and half is an opportunity.
- **G3** There is one running book. Your quotes stay on the board at your levels, a used-up side shows struck at size 0, and your market replaces the room's in that instrument. Follow-ups come from your position.
- **G4** The game's language is "arb to flat", "hold it outright, delta-hedged" and "buy N stock to hedge to delta flat". Never "lock" a position or "square" the stock.
- **G5** Explanations follow E1 to E5 below.
- **G6** A session runs as long as the night does: the conductor's chain (about four questions at level 1, eight to eleven with the combos), up to two older moves, and whatever follow-ups they cause. The start screen has five cumulative levels: parity on a choice stock; + combos; + a stock spread; + the stock widening and moving; + vega and flow.

- **G7** The trade list shows each line's delta (and vega, with that toggle on) in shares and vega, with a net row at the top as a running total.
- **G8** With flow on (level 4 on the start screen), the market leans one way on vol for the whole session, buying or selling; the start screen doesn't say which. 80% of its orders and of its trades on your quotes go that way and 20% against. Every 50 vega of net flow moves fair value 1 at the money.
