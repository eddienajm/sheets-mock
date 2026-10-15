# Sheets Mock

An options market-making game on a whiteboard. You get asked for markets, the market trades on them, and you hedge, lean for the exit, and spot what's wrong with the orders it writes on the board. It trains put-call parity, straddles, spreads, boxes and flies, delta hedging, and pricing under vol flow.

## How to play

1. Click the green **Code** button above and choose **Download ZIP**. Unzip it.
2. Open `index.html` in your browser by double-clicking it.

That's all. You don't need to install anything or run a server. If you use git, you can clone the repo instead:

```
git clone https://github.com/eddienajm/sheets-mock.git
```

and open `index.html`.

## The game

The start screen offers four levels, each adding to the one before:

1. **Just put-call parity**
2. **Parity and combos**: straddles, spreads, boxes and flies
3. **Parity, combos and the stock moving**: the stock widens (how much wider your markets should go depends on delta), and the stock moves on a stale board (one trade: the most edge × size)
4. **Vega and trade flow**: option-equivalent vega in the trade list, and a market that leans one way on vol, moving fair value as it trades

A session is five questions on one board, plus whatever follow-ups your trades lead to. "Replay 12 October" plays a fixed 15-question mock instead.

- **Make a market.** Type it straight onto the board and press Enter.
- **Trade or rest a price.** Click a price on the board to trade it, or change the price on the ticket to rest your own bid or offer inside it.
- **Change a quote.** Click one of your own quotes to change it or take it down.
- **Read the trade list.** It shows every trade with its delta (and vega, at level 4), with a net position row at the top.
- **Learn from each question.** After each one, the board explains what happened step by step and lights up the prices it's talking about. "Why?" opens the reasoning behind each step, and "‹ Back" looks at earlier questions.

Rates are zero, so put-call parity is exact: P = C − S + K.

## For developers

The game is plain HTML and JavaScript, with no build step.

[PRINCIPLES.md](PRINCIPLES.md) is the list of trading principles the game is built and judged against. The tests run on Node:

```
node test/principles.test.js
node test/fuzz.test.js
```

| File | What it does |
|---|---|
| `js/engine.js` | Instruments as vectors over stock and calls, a small linear program for lay-off markets and arbs, positions, delta and vega |
| `js/scenario.js` | Board generation, the question generator, the 12 October replay |
| `js/game.js` | The running book, the market's behaviour, follow-ups, judging and explanations |
| `js/ui.js` | The start screen, whiteboard, ticket, explanations and review |
