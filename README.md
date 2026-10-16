# groupbet

A play-money prediction market for friend groups. Ask a question in the chat ("Will Rahul be late?"), everyone bets fake points, prices move as people bet, and the creator settles it. **No real money, ever.**

The game engine knows nothing about chat apps. Adapters translate platform messages into `handleCommand(...)` and send back the string it returns. Included: a terminal simulator and a WhatsApp adapter.

> **Disclaimer.** WhatsApp mode uses [Baileys](https://github.com/WhiskeySockets/Baileys), an *unofficial* library. It may violate WhatsApp's Terms of Service and the number you connect **may get banned**. Use a spare number. Self-host only. Points are play points with no monetary value.

## Commands

| Command | What it does |
|---|---|
| `/new <question> \| closes <time>` | Create a market. Time: `fri 6pm`, `in 2h`, `tomorrow 9am`. Optional `\| b 200` sets liquidity. |
| `/bet [#id] yes\|no <points>` | Spend points on a side. `#id` is only needed when several markets are open. |
| `/sell [#id] yes\|no <shares\|all>` | Sell shares back at the current price. |
| `/odds [#id]` | Odds and volume. |
| `/markets` | Open markets (and closed ones awaiting resolution). |
| `/market <#id>` | Details, odds, top holders. |
| `/resolve <#id> yes\|no` | Settle a market. Creator or group admin only. |
| `/void <#id>` | Cancel and refund everyone's net spend. Creator or group admin only. |
| `/balance` | Your points (or an @mentioned player's). |
| `/leaderboard` | This group's ranking. |
| `/help` | Command list. |

Everyone starts with 1000 points per group. Every group has its own economy, markets (`#1`, `#2`, ...) and leaderboard. Markets close automatically at their deadline; the creator can still resolve them afterwards. Default timezone is `Asia/Kolkata` (set `TZ` to change).

## How it works

Markets use Hanson's **LMSR** (logarithmic market scoring rule), an automated market maker. You never need a counterparty: the market always quotes a price.

- The market tracks how many YES and NO shares exist (`qy`, `qn`). A share pays 1 point if its side wins, 0 otherwise.
- The price of YES is `e^(qy/b) / (e^(qy/b) + e^(qn/b))`, which is also the market's probability. It starts at 50%.
- Buying YES raises its price, so early believers get a better average price than latecomers. Spending 50 points when the price is 0.70 gives you roughly 71 shares, not 50/0.70, because your own purchase moves the price as you go.
- `b` controls depth. Higher `b` means prices move less per point (default 100). The market maker can lose at most `b * ln 2` points per market, which is the "subsidy" that makes trading always possible.
- Selling shares back is the same curve in reverse, so buying then selling immediately returns what you paid (before whole-point rounding).

Bookkeeping: balances are never stored; they are `SUM(delta)` over an append-only ledger (enforced by SQLite triggers). The market maker has its own ledger rows, written as a pair with every user row, so the sum of the whole group's ledger always equals the signup grants. A test checks this across bets, sells, resolves and voids. Shares are floats, points are whole numbers; payouts and sale proceeds round down in the market maker's favour.

## Run it

Requires Node 20+.

```bash
npm install
npm test
```

**CLI simulator** (no WhatsApp needed):

```bash
npm run cli
> as rahul: /new Will it rain tomorrow? | closes in 2h
> as khush: /bet yes 200
> as meera: /bet no 100
> as rahul: /resolve 1 yes
```

Meta commands: `:admin <name>` toggles admin, `:advance 2h` moves the fake clock (to test auto-close), `:who`, `:quit`. The CLI uses an in-memory DB unless `GROUPBET_DB` is set.

**WhatsApp mode:**

```bash
npm run whatsapp
```

On first run, link the bot as a linked device. Either scan the QR printed in the terminal or set `GROUPBET_PAIR_PHONE=<country code + number>` to get a pairing code to enter under *Linked devices > Link with phone number*. Session files live in `./auth` and the database in `./data/groupbet.db`. If WhatsApp logs the bot out, delete `./auth` and pair again. Only group messages are handled.

**Docker:**

```bash
docker compose up -d --build
```

`./auth` and `./data` are mounted as volumes.

### Configuration

| Env var | Default | |
|---|---|---|
| `GROUPBET_ADAPTER` | `cli` | `cli` or `whatsapp` (or `--adapter`) |
| `GROUPBET_DB` | `./data/groupbet.db` (`:memory:` for CLI) | SQLite file |
| `GROUPBET_B` | `100` | Default liquidity for new markets |
| `TZ` | `Asia/Kolkata` | Timezone for `/new ... closes <time>` |
| `GROUPBET_AUTH_DIR` | `./auth` | Baileys session folder |
| `GROUPBET_PAIR_PHONE` | unset | Use a pairing code instead of a QR |

## Layout

```
src/core/      commands, LMSR math, ledger, engine (no adapter imports)
src/db/        schema.sql + migrations
src/adapters/  cli.ts, whatsapp.ts
tests/         vitest
```

Roadmap: weekly/seasonal leaderboard resets (the ledger already has a `season` column; see the TODO in `src/core/ledger.ts`).

## License

MIT
