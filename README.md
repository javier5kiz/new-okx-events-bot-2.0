---
title: New OKX Events Bot 2.0
emoji: 📈
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# New OKX Events Bot 2.0

Lightweight Node.js bot for **OKX Event Contracts** (BTC and ETH 5-minute UP/DOWN markets). Zero npm dependencies. Built to run as a **HuggingFace Docker Space** on port **7860**.

## Strategy

Per asset (BTC, ETH), on 5-minute spot candles:

1. **Bollinger Bands(10), 2σ** on confirmed 5m candles (length 10, not the usual 20).
2. **Band touch → orderbook scan** of the active `*-UPDOWN-5MIN` contract:
   - Spot touches the **upper band** and **UP ≥ 90¢** (DOWN ≤ 10¢) → buy **DOWN**.
   - Spot touches the **lower band** and **DOWN ≥ 90¢** (UP ≤ 10¢) → buy **UP**.
   - Between the bands → no trade.
3. **Fixed size: 0.1 contracts.** No martingale, no balance-based sizing.
4. Right after the buy, place a **SELL LIMIT at 30¢** (buy ≤10¢, sell 30¢ = 1:2 RR).
5. **One trade per 5-minute contract per asset.**
6. **Winrate tracking** (combined + per asset). Win = sell fills at 30¢, or the contract settles in your favour at $1. Loss = it settles against you.

## Funding → trading float

Your money stays in the **funding** account. A small float (`TRADING_FLOAT_USD`, default `$0.02`) sits in the **trading** account so a valid setup can enter instantly. It is refilled from funding at startup and right after every trade. If the float is ever short at entry, the bot moves the shortfall and still trades. Live only: OKX demo has no transfers.

Live transfers need an API key with **Trade + Withdraw** permission.

## Deploy on HuggingFace Spaces

1. Create a Space, SDK **Docker**.
2. Upload these files, keeping the `src/` folder:
   ```
   Dockerfile
   package.json
   README.md
   src/index.js
   src/okx.js
   src/strategy.js
   src/alerts.js
   ```
3. Space **Settings → Variables and secrets**. Add as **Secrets**:
   `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`
   and as Variables (or Secrets): `IS_DEMO` (`false` for live, `true` for a demo key).
4. Open the Space URL. The health endpoint shows the real state:

```json
{"status":"running","mode":"LIVE","server":"https://www.okx.com","authError":null,"uptimeSec":42,"trades":0,"winrate":"0.0%"}
```

`status` is one of `starting`, `running`, `auth_failed`, `missing_credentials`, `crashed`. If it says `auth_failed`, `authError` contains OKX's exact message, and the bot retries every 60 seconds.

### If you see "API key doesn't exist"

- A **demo** key only works with `IS_DEMO=true`; a **live** key only with `IS_DEMO=false`.
- EU / US accounts: set `OKX_BASE_URL` to `https://eea.okx.com` or `https://app.okx.com`.
- Re-paste the three secrets with no spaces or quotes.

## Configuration

| Env var | Description | Default |
|---|---|---|
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | OKX credentials | required |
| `IS_DEMO` | `true` = demo key, `false` = live key | `false` |
| `OKX_BASE_URL` | OKX host (EU/US accounts) | `https://www.okx.com` |
| `PORT` | Health server port | `7860` |
| `TRADE_SIZE` | Contracts per trade | `0.1` |
| `TRADING_FLOAT_USD` | USD kept in trading for instant entries | `0.02` |
| `DISCORD_WEBHOOK_URL` | Discord alerts (optional) | off |

## Run locally

```bash
export OKX_API_KEY=... OKX_SECRET_KEY=... OKX_PASSPHRASE=... IS_DEMO=false
node src/index.js
```

Requires Node 18+. No `npm install` needed.

## Files

```
src/index.js     entry, health server (7860), auth with retry, graceful shutdown
src/okx.js       OKX v5 client, funding to trading transfers
src/strategy.js  Bollinger(10) strategy, orders, winrate
src/alerts.js    optional Discord alerts
```

## Risk

Event contracts can expire worthless. Each trade here risks about $0.01, but a 30¢ target with a ~10¢ entry still needs a real win rate to be profitable. Run it on demo first.
