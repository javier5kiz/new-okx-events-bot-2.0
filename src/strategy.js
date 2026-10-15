/**
 * strategy.js — Bollinger Bands(10) 5-min event-contract strategy (BTC + ETH)
 * ═══════════════════════════════════════════════════════════════════════════
 *   1. BB(10, 2σ) on confirmed 5-minute spot candles.
 *   2. Spot touches UPPER band  -> if UP price >= 0.90 (DOWN <= 0.10): buy DOWN ("no")
 *      Spot touches LOWER band  -> if DOWN price >= 0.90 (UP <= 0.10): buy UP ("yes")
 *      Between the bands -> no trade. One trade per 5-min contract per asset.
 *   3. Fixed 0.1 contracts. Right after the buy, place SELL LIMIT @ 0.30 (1:2 RR).
 *   4. Funds stay in FUNDING; a small float sits in TRADING for instant entries and
 *      is refilled after each trade (live only).
 *   5. Track win/loss: sell filled = win; else settle at expiry (1.0 win / 0 loss).
 */

const ASSETS = [
  { id: 'BTC', series: 'BTC-UPDOWN-5MIN', spot: 'BTC-USDT' },
  { id: 'ETH', series: 'ETH-UPDOWN-5MIN', spot: 'ETH-USDT' },
];

const BB_LEN = 10;
const BB_MULT = 2;
const SELL_PX = 0.30;
const MIN_ENTRY = 0.90;
const POLL_MS = 1000;
const LOG_MS = 5000;
const BB_REFRESH_MS = 30000;

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const SIZE = num(process.env.TRADE_SIZE, 0.1);
const FLOAT_USD = num(process.env.TRADING_FLOAT_USD, 0.02);

class Strategy {
  constructor(okx, alerts) {
    this.okx = okx;
    this.alerts = alerts;
    this.running = false;
    this.wins = 0;
    this.losses = 0;
    this.trades = 0;
    this.profit = 0;
    this.a = {};
    for (const x of ASSETS) {
      this.a[x.id] = { cfg: x, upper: null, lower: null, mid: null, bbAt: 0, contract: null, expSeen: 0, traded: false, open: [], logAt: 0, stats: { trades: 0, wins: 0, losses: 0, profit: 0 } };
    }
  }

  winrate() { const t = this.wins + this.losses; return t ? (this.wins / t) * 100 : 0; }
  openCount() { return Object.values(this.a).reduce((s, x) => s + x.open.length, 0); }

  snapshot() {
    return {
      trades: this.trades, wins: this.wins, losses: this.losses,
      winrate: `${this.winrate().toFixed(1)}%`, profit: +this.profit.toFixed(4), open: this.openCount(),
    };
  }

  // ── Bollinger Bands ─────────────────────────────────────────────
  async updateBands(id) {
    const s = this.a[id];
    const cs = (await this.okx.candles(s.cfg.spot, '5m', 30)).filter((c) => c.confirm === 1).slice(0, BB_LEN);
    if (cs.length < BB_LEN) { console.warn(`[BB:${id}] only ${cs.length} confirmed candles`); return; }
    const closes = cs.map((c) => c.close);
    const sma = closes.reduce((a, b) => a + b, 0) / BB_LEN;
    const sd = Math.sqrt(closes.reduce((a, b) => a + (b - sma) ** 2, 0) / BB_LEN);
    s.mid = sma; s.upper = sma + BB_MULT * sd; s.lower = sma - BB_MULT * sd; s.bbAt = Date.now();
    console.log(`[BB:${id}] lower=${s.lower.toFixed(2)} mid=${s.mid.toFixed(2)} upper=${s.upper.toFixed(2)}`);
  }

  // ── Contract cycle ──────────────────────────────────────────────
  async refreshContract(id) {
    const s = this.a[id];
    const c = await this.okx.activeContract(s.cfg.series);
    if (!c) { s.contract = null; return; }
    if (c.expTime !== s.expSeen) {
      s.expSeen = c.expTime; s.traded = false;
      console.log(`\n[${id} NEW CYCLE] ${c.instId} strike=${c.stk} expires=${new Date(c.expTime).toISOString()}`);
    }
    s.contract = c;
  }

  async scan(instId) {
    const b = await this.okx.orderbook(instId, 10);
    if (!b || !b.asks.length || !b.bids.length) return null;
    const ask = parseFloat(b.asks[0][0]);
    const bid = parseFloat(b.bids[0][0]);
    return { up: ask, down: 1 - bid };
  }

  // ── Float management ────────────────────────────────────────────
  async refillFloat(why) {
    if (this.okx.isDemo) return;
    try {
      const r = await this.okx.ensureFunds(FLOAT_USD);
      if (r.ok && r.moved > 0) console.log(`   🔄 Float refilled +$${r.moved} → trading $${r.bal.toFixed(4)} (${why})`);
      else if (!r.ok) console.warn(`   ⚠️ Float refill failed (${why}): ${r.why}`);
    } catch (e) { console.warn(`   ⚠️ Float refill error (${why}): ${e.message}`); }
  }

  // ── Entry ───────────────────────────────────────────────────────
  async enter(id, band, contract, ob) {
    const s = this.a[id];
    let outcome, price, side;
    if (band === 'UPPER') {
      if (ob.up < MIN_ENTRY) return console.log(`   [${id} SKIP] upper touched but UP ${ob.up.toFixed(2)} < ${MIN_ENTRY}`);
      outcome = 'no'; price = ob.down; side = 'DOWN';
    } else {
      if (ob.down < MIN_ENTRY) return console.log(`   [${id} SKIP] lower touched but DOWN ${ob.down.toFixed(2)} < ${MIN_ENTRY}`);
      outcome = 'yes'; price = ob.up; side = 'UP';
    }
    console.log(`\n   🔥 [${id}] ${band} band → buy ${side} @ ~${price.toFixed(2)} (UP=${ob.up.toFixed(2)} DOWN=${ob.down.toFixed(2)})`);

    // Normally a no-op: float is already in trading. Fallback tops up the shortfall.
    const need = Math.round(SIZE * price * 1.05 * 1e6) / 1e6;
    const f = await this.okx.ensureFunds(need);
    if (!f.ok) return console.warn(`   ⛔ [${id}] SKIP: cannot fund $${need} — ${f.why}`);
    if (f.moved > 0) console.log(`   💸 [${id}] float was short, topped up $${f.moved}`);

    const buy = await this.okx.buyMarket(contract.instId, outcome, SIZE);
    if (buy.code !== '0') return console.error(`   ❌ [${id}] buy failed: ${buy.msg || JSON.stringify(buy.data?.[0] || buy)}`);
    const ordId = buy.data?.[0]?.ordId;
    console.log(`   ✅ [${id}] buy placed ordId=${ordId} size=${SIZE} outcome=${outcome}`);

    await this.okx.sleep(500);
    let fill = price;
    if (ordId) {
      const st = await this.okx.orderStatus(contract.instId, ordId);
      const od = st?.data?.[0];
      if (st?.code === '0' && od?.state === 'filled') fill = parseFloat(od.avgPx || od.px || price);
      else if (od) console.log(`   ⏳ [${id}] order state: ${od.state}`);
    }

    const sell = await this.okx.sellLimit(contract.instId, outcome, SIZE, SELL_PX);
    let sellId = null;
    if (sell.code !== '0') console.error(`   ❌ [${id}] sell limit failed: ${sell.msg || JSON.stringify(sell.data?.[0] || sell)} — will settle at expiry`);
    else { sellId = sell.data?.[0]?.ordId; console.log(`   ✅ [${id}] sell limit @ ${SELL_PX} ordId=${sellId}`); }

    s.open.push({ instId: contract.instId, outcome, side, band, buyPrice: fill, sz: SIZE, sellId, expTime: contract.expTime });
    this.trades++; s.stats.trades++;
    console.log(`   📊 [${id}] TRADE #${s.stats.trades}: ${side} @ ${fill.toFixed(2)} → sell @ ${SELL_PX}`);

    await this.refillFloat(`after ${id} trade`);
    await this.alerts.entry({ asset: id, side, band, buyPrice: fill, sz: SIZE, n: s.stats.trades, instId: contract.instId });
  }

  // ── Win / loss tracking ─────────────────────────────────────────
  record(id, win, profit) {
    const s = this.a[id];
    if (win) { this.wins++; s.stats.wins++; } else { this.losses++; s.stats.losses++; }
    this.profit += profit; s.stats.profit += profit;
  }

  async checkOpen(id) {
    const s = this.a[id];
    const keep = [];
    for (const t of s.open) {
      const base = { asset: id, side: t.side, buyPrice: t.buyPrice, instId: t.instId };

      if (t.sellId) {
        const r = await this.okx.orderStatus(t.instId, t.sellId);
        const od = r?.data?.[0];
        if (r?.code === '0' && od?.state === 'filled') {
          const px = parseFloat(od.avgPx || SELL_PX);
          const profit = (px - t.buyPrice) * t.sz;
          this.record(id, true, profit);
          console.log(`\n   🎉 [${id}] WIN ${t.side} sold @ ${px.toFixed(2)} (bought ${t.buyPrice.toFixed(2)}) profit=${profit.toFixed(4)}`);
          await this.alerts.win({ ...base, sellPrice: px, profit, winrate: this.winrate(), wins: this.wins, losses: this.losses, settled: false });
          continue;
        }
      }

      if (Date.now() > t.expTime) {
        const st = await this.okx.settlement(t.instId, t.expTime);
        if (st && st.direction !== 'SKIP') {
          const won = st.direction === t.side;
          if (won) {
            const profit = (1 - t.buyPrice) * t.sz;
            this.record(id, true, profit);
            console.log(`\n   🎉 [${id}] WIN (settled) ${t.side} → 1.0 profit=${profit.toFixed(4)}`);
            await this.alerts.win({ ...base, sellPrice: 1, profit, winrate: this.winrate(), wins: this.wins, losses: this.losses, settled: true });
          } else {
            const loss = -t.buyPrice * t.sz;
            this.record(id, false, loss);
            console.log(`\n   💀 [${id}] LOSS (settled) ${t.side} → 0 loss=${loss.toFixed(4)}`);
            await this.alerts.loss({ ...base, loss, winrate: this.winrate(), wins: this.wins, losses: this.losses });
          }
          continue;
        }
      }
      keep.push(t);
    }
    s.open = keep;
  }

  printStats() {
    console.log('\n═══════════════════════════════════════════════');
    console.log(`📊 WINRATE ${this.winrate().toFixed(1)}% (${this.wins}W/${this.losses}L) | trades ${this.trades} | open ${this.openCount()} | P&L $${this.profit.toFixed(4)}`);
    for (const id of Object.keys(this.a)) {
      const t = this.a[id].stats;
      console.log(`   ${id}: ${t.trades} trades ${t.wins}W/${t.losses}L P&L $${t.profit.toFixed(4)}`);
    }
    console.log('═══════════════════════════════════════════════\n');
  }

  // ── Per-asset loop ──────────────────────────────────────────────
  async loop(id) {
    const s = this.a[id];
    while (this.running) {
      try {
        if (Date.now() - s.bbAt > BB_REFRESH_MS) await this.updateBands(id);
        await this.refreshContract(id);
        if (!s.contract) { await this.okx.sleep(5000); continue; }

        await this.checkOpen(id);

        const price = await this.okx.spot(s.cfg.spot);
        if (!price) { await this.okx.sleep(3000); continue; }

        const now = Date.now();
        if (now - s.logAt >= LOG_MS) {
          const left = Math.max(0, Math.round((s.contract.expTime - now) / 1000));
          const pos = !s.upper ? 'n/a' : price >= s.upper ? 'UPPER TOUCHED' : price <= s.lower ? 'LOWER TOUCHED' : price > s.mid ? 'above mid' : 'below mid';
          console.log(`[${id}] ${left}s left | $${price.toFixed(2)} | BB ${s.lower?.toFixed(2)}/${s.mid?.toFixed(2)}/${s.upper?.toFixed(2)} | ${pos} | traded=${s.traded ? 'Y' : 'N'}`);
          s.logAt = now;
        }

        if (!s.traded && s.upper && s.lower) {
          const band = price >= s.upper ? 'UPPER' : price <= s.lower ? 'LOWER' : null;
          if (band) {
            console.log(`\n🎯 [${id}] ${band} BAND TOUCHED $${price.toFixed(2)}`);
            const ob = await this.scan(s.contract.instId);
            if (ob) { await this.enter(id, band, s.contract, ob); s.traded = true; }
          }
        }
        await this.okx.sleep(POLL_MS);
      } catch (e) {
        console.error(`[${id} ERROR]`, e.message);
        await this.okx.sleep(3000);
      }
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log(`💰 Size ${SIZE} contracts fixed | float $${FLOAT_USD} kept in trading, rest in funding | sell @ ${SELL_PX}`);
    await this.refillFloat('startup');
    this._t = setInterval(() => { if (this.trades > 0) this.printStats(); }, 60000);
    await Promise.all(Object.keys(this.a).map((id) => this.loop(id)));
  }

  stop() {
    this.running = false;
    if (this._t) clearInterval(this._t);
    this.printStats();
  }
}

module.exports = Strategy;
