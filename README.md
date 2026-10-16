# Betbot

https://github.com/user-attachments/assets/4753a237-5cec-4c2e-961e-1d3709f5589a

A play-money prediction market for friend groups. Ask a question in the chat ("Will Rahul be late?"), everyone bets fake points, prices move as people bet, and the creator settles it. **No real money, ever.**

The game engine knows nothing about chat apps. Adapters translate platform messages into `handleCommand(...)` and send back the string it returns. Included: a terminal simulator and adapters for **Telegram**, **Discord** and **WhatsApp**.

## Demo

<video src="https://github.com/sk82santhosh-cpu/Betbot/raw/main/docs/demo.mp4" controls muted width="360"></video>

[Watch the demo](docs/demo.mp4)

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

Requires Node 20+ (Node 22+ for Discord).

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

**Telegram** (official Bot API, recommended: no ban risk):

1. Message [@BotFather](https://t.me/BotFather), run `/newbot`, copy the token.
2. `TELEGRAM_BOT_TOKEN=123:abc npm start -- --adapter telegram`
3. Add the bot to a group. Commands work as `/bet yes 50` or `/bet@yourbot yes 50`. Make it a group admin only if you want admin-gated `/resolve` to see the member list (not required).

**Discord** (official gateway; needs Node 22+):

1. In the [Developer Portal](https://discord.com/developers/applications) create an application, add a Bot, copy its token, and turn on **Message Content Intent**.
2. Invite it with the `bot` scope and "Send Messages" + "Read Message History" permissions.
3. `DISCORD_BOT_TOKEN=... npm start -- --adapter discord`

One Discord server = one group economy. Server owners and members with Administrator or Manage Server count as admins.

Run several at once with `--adapter telegram,discord,whatsapp`; they share one database but every chat keeps its own economy.

**Using it in a group** (any platform):

1. Create a market: `/new Will Rahul be late Friday? | closes fri 6pm`
2. Everyone bets: `/bet yes 50` (add the market number when several are open: `/bet #2 yes 50`)
3. Check on it: `/odds`, `/market 1`, `/balance`, `/leaderboard`
4. Cash out early with `/sell yes all`
5. When it's decided, the creator or a group admin settles it: `/resolve 1 yes` (or `/void 1` to refund everyone)

The bot only runs while your process is running; see Docker below for leaving it on a server.

**Docker:**

```bash
docker compose up -d --build
```

`./auth` and `./data` are mounted as volumes.

## Natural language mode (optional)

On Telegram you can write plain English instead of strict commands, if you configure an LLM. Without a key this is completely off and the bot behaves exactly as before.

> @betbot put 50 on yes for the rahul thing
> @betbot what are the odds on the rain one?
> (replying to a bot message) sell all my no

How it works:

- It only triggers when the bot is **@mentioned** or when the message is a **reply to one of the bot's messages** (see the privacy mode note below). Everything else in the chat is never sent anywhere.
- Messages starting with `/` never call the LLM.
- The model only picks a command and its arguments (via tool calling, validated with a zod schema that mirrors the command types). Anything invalid is dropped. Balances, payouts and permission checks are decided by the engine exactly as for a typed command, so a model that gets tricked still can't resolve a market it doesn't own or mint points.
- It resolves references like "the rahul thing" only against the group's open markets. If more than one fits, or confidence is low, it asks a question listing the candidates instead of acting.
- A bet over 25% of your balance, and any `/resolve` or `/void`, gets a **Confirm / Cancel** button first. Only the person who asked can press it, and it expires after 2 minutes.
- Per-user and per-group rate limits apply.

### Quick start with a free Gemini key

1. Create a key at <https://aistudio.google.com/apikey> (free tier, rate limited; Google may use free-tier prompts to improve its products, so keep private info out of market questions).
2. Find a model ID your key can use. In AI Studio pick a Flash model and click **Get code** to copy the exact `model` string, or list them:
   ```bash
   read -s KEY        # paste the key (hidden), press Enter
   curl -s "https://generativelanguage.googleapis.com/v1beta/models" -H "x-goog-api-key: $KEY" | grep '"name"'
   ```
   Use the part after `models/` as `LLM_MODEL`. Model names change over time; the Flash and Flash-Lite families are the cheap, fast ones.
3. Check the key and model without Telegram:
   ```bash
   LLM_PROVIDER=gemini LLM_API_KEY=$KEY LLM_MODEL=<model-id> npx tsx scripts/try-nlu.mts
   ```
   You should see commands like `{"type":"bet","side":"yes","points":50,"marketNum":1}`, a "Which market do you mean?" question for vague bets, and `null` for small talk.
4. Start the bot with the same variables:
   ```bash
   LLM_PROVIDER=gemini LLM_API_KEY=$KEY LLM_MODEL=<model-id> \
   TELEGRAM_BOT_TOKEN=<your-token> npm start -- --adapter telegram
   ```
   The startup line ends with `(natural language: gemini)` when it's on.
5. In your group, create a market, then talk to the bot:
   ```
   /new Will Rahul finish the project by Friday? | closes fri 6pm
   @yourbot put 50 on yes for the rahul thing
   @yourbot what are the odds?
   (reply to a bot message)  sell all my yes
   ```

Keep API keys and the Telegram token out of the repo and out of screenshots. If one leaks, revoke it (`/revoke` in @BotFather; delete the key in AI Studio) and make a new one.

**BotFather privacy mode.** With privacy mode on (the default), Telegram delivers `/commands` and *replies to the bot's own messages*, so replying to the bot always works. Plain `@botname ...` mentions may not be delivered; if they get no response, either disable privacy (`/setprivacy` > Disable in @BotFather, then remove and re-add the bot to the group) or make the bot a group admin. Run with `LOG_LEVEL=debug` to see (metadata only) whether Telegram is delivering your messages.

| Env var | Default | |
|---|---|---|
| `LLM_PROVIDER` | unset (NLU off) | `openai` (any OpenAI-compatible API), `anthropic`, `gemini`, or `ollama` |
| `LLM_API_KEY` | unset | Required, except for `ollama` or an `openai` provider with a custom `LLM_BASE_URL` |
| `LLM_MODEL` | provider default | Set it explicitly. Must support tool/function calling |
| `LLM_BASE_URL` | provider default | For Ollama, LM Studio, vLLM, OpenRouter, ... |
| `LLM_TIMEOUT_MS` | `15000` | Raise for slow local models |
| `NLU_RATE_USER_PER_MIN` | `6` | LLM calls per user per minute |
| `NLU_RATE_GROUP_PER_MIN` | `30` | LLM calls per group per minute |
| `NLU_MIN_CONFIDENCE` | `0.6` | Below this the bot asks instead of acting |
| `LOG_LEVEL` | unset | `debug` also logs message text. Never use it with real chats you care about |

```bash
LLM_PROVIDER=anthropic LLM_API_KEY=... LLM_MODEL=claude-haiku-5-5 \
TELEGRAM_BOT_TOKEN=... npm start -- --adapter telegram
```

**Cost.** Each addressed message is one small request (a short system prompt, your open market questions, the message) and a few tokens back. With a small, cheap model that is typically a fraction of a cent per message; check your provider's current pricing, and lower the rate limits if the group is chatty. Local models cost nothing.

**Privacy.** When someone addresses the bot in plain English, the provider receives: that message text, the speaker's display name, the questions of the group's open markets, and the current time. It never receives balances, user IDs or chat history. Nothing is cached, the API key is sent only in a request header (never in a URL) and never logged, and message text is not logged unless `LOG_LEVEL=debug`. If that is more than you want to share, use Ollama so nothing leaves your machine.

**Ollama (fully local).**

```bash
ollama pull llama3.1          # any model with tool calling support
LLM_PROVIDER=ollama LLM_MODEL=llama3.1 TELEGRAM_BOT_TOKEN=... npm start -- --adapter telegram
```

`ollama` defaults the base URL to `http://localhost:11434/v1` and needs no key. If the bot runs in Docker and Ollama on the host, set `LLM_BASE_URL=http://host.docker.internal:11434/v1`. Local models need RAM: `llama3.1` (5 GB) is too heavy for an 8 GB machine, so try `llama3.2` (2 GB) and raise `LLM_TIMEOUT_MS` for the first, model-loading call. Small local models are less reliable at picking the right market; the confidence and clarification rules are what keep that safe.

### Troubleshooting natural language mode

| Symptom | Likely cause and fix |
|---|---|
| No reply at all to `@yourbot ...` and no log line | Telegram privacy mode isn't delivering mentions. Reply to a bot message instead, or disable privacy / make the bot admin (see above). Run with `LOG_LEVEL=debug` and look for `[telegram] update ...` lines. |
| "I didn't catch that" | The model returned nothing usable, or the provider call failed. Check the terminal for a `[nlu] provider ... failed` line. |
| `HTTP 404` | Wrong `LLM_MODEL`. The error text says which model wasn't found; list the models your key can use (see the quick start). |
| `HTTP 401` / `403` | Bad or revoked API key. |
| `HTTP 429` | Free-tier rate limit. Wait a minute, or lower `NLU_RATE_USER_PER_MIN`. |
| "Which market do you mean?" | More than one open market fits. Name it, e.g. "the rain one", or use `/bet #2 yes 50`. |
| `timeout` | Slow or local model. Raise `LLM_TIMEOUT_MS`. |
| Nothing mentions `natural language` at startup | `LLM_PROVIDER` or `LLM_API_KEY` is missing in that command, so the mode is off. |

The NLU code lives in `src/core/nlu.ts` and `src/core/llm/` and is platform-agnostic, so Discord and WhatsApp can use it later by calling `parse()` the same way the Telegram adapter does.

## Configuration

| Env var | Default | |
|---|---|---|
| `GROUPBET_ADAPTER` | `cli` | `cli`, `whatsapp`, `telegram`, `discord`, or a comma list (or `--adapter`) |
| `TELEGRAM_BOT_TOKEN` | unset | From @BotFather |
| `DISCORD_BOT_TOKEN` | unset | From the Developer Portal |
| `GROUPBET_DB` | `./data/groupbet.db` (`:memory:` for CLI) | SQLite file |
| `GROUPBET_B` | `100` | Default liquidity for new markets |
| `TZ` | `Asia/Kolkata` | Timezone for `/new ... closes <time>` |
| `GROUPBET_AUTH_DIR` | `./auth` | Baileys session folder |
| `GROUPBET_PAIR_PHONE` | unset | Use a pairing code instead of a QR |

## Layout

```
src/core/      commands, LMSR math, ledger, engine, optional nlu + llm/ providers (no adapter imports)
src/db/        schema.sql + migrations
src/adapters/  cli.ts, whatsapp.ts, telegram.ts, discord.ts
tests/         vitest
```

Roadmap: weekly/seasonal leaderboard resets (the ledger already has a `season` column; see the TODO in `src/core/ledger.ts`).

## License

MIT
