/**
 * okx.js — Minimal OKX v5 REST client (no dependencies, uses built-in fetch)
 * Covers: auth check, event contracts, candles, orderbook, balances,
 * funding->trading transfers, market/limit orders, order status, settlement.
 */
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round6 = (n) => Math.round(n * 1e6) / 1e6;

class OKX {
  constructor({ apiKey, secretKey, passphrase, isDemo, baseURL }) {
    this.apiKey = (apiKey || '').trim();
    this.secretKey = (secretKey || '').trim();
    this.passphrase = (passphrase || '').trim();
    this.isDemo = !!isDemo;
    this.baseURL = (baseURL || 'https://www.okx.com').replace(/\/+$/, '');
    this._tdMode = null;
  }

  sleep(ms) { return sleep(ms); }

  // ── core request ────────────────────────────────────────────────
  async request(method, path, body = null, priv = false) {
    try {
      const bodyStr = body ? JSON.stringify(body) : '';
      const headers = { 'Content-Type': 'application/json' };
      if (priv) {
        const ts = new Date().toISOString();
        const sig = crypto.createHmac('sha256', this.secretKey)
          .update(ts + method.toUpperCase() + path + bodyStr).digest('base64');
        Object.assign(headers, {
          'OK-ACCESS-KEY': this.apiKey,
          'OK-ACCESS-SIGN': sig,
          'OK-ACCESS-TIMESTAMP': ts,
          'OK-ACCESS-PASSPHRASE': this.passphrase,
        });
        if (this.isDemo) headers['x-simulated-trading'] = '1';
      }
      const res = await fetch(this.baseURL + path, {
        method, headers, body: bodyStr || undefined,
        signal: AbortSignal.timeout(10000),
      });
      return await res.json();
    } catch (e) {
      return { code: '-1', msg: e.message || String(e), data: [] };
    }
  }

  // ── auth / account ──────────────────────────────────────────────
  async auth() {
    const res = await this.request('GET', '/api/v5/account/balance', null, true);
    if (res.code === '0') return { ok: true };
    return { ok: false, code: res.code, msg: res.msg };
  }

  async tdMode() {
    if (this._tdMode) return this._tdMode;
    const res = await this.request('GET', '/api/v5/account/config', null, true);
    const lv = parseInt(res?.data?.[0]?.acctLv || '1', 10);
    this._tdMode = lv === 1 ? 'cash' : 'isolated';
    console.log(`🔧 Account level ${lv} → tdMode=${this._tdMode}`);
    return this._tdMode;
  }

  // ── balances / transfers ────────────────────────────────────────
  async tradingUSDT() {
    const res = await this.request('GET', '/api/v5/account/balance', null, true);
    if (res.code !== '0') return null;
    const d = res.data?.[0]?.details?.find((x) => x.ccy === 'USDT');
    return d ? parseFloat(d.availBal || '0') : 0;
  }

  async fundingUSDT() {
    const res = await this.request('GET', '/api/v5/asset/balances?ccy=USDT', null, true);
    if (res.code !== '0') { console.warn(`⚠️ funding balance: ${res.msg} (${res.code})`); return null; }
    const d = res.data?.find((x) => x.ccy === 'USDT');
    return d ? parseFloat(d.availBal || '0') : 0;
  }

  async transferToTrading(amt) {
    const res = await this.request('POST', '/api/v5/asset/transfer',
      { ccy: 'USDT', amt: String(amt), from: '6', to: '18', type: '0' }, true);
    if (res.code === '0') console.log(`   💸 Moved $${amt} funding → trading`);
    else console.error(`   ❌ Transfer failed: ${res.msg} (${res.code})`);
    return res;
  }

  /** Make sure trading holds >= needUSD. Tops up only the shortfall from funding. */
  async ensureFunds(needUSD) {
    const need = round6(needUSD);
    let bal = await this.tradingUSDT();
    if (bal === null) return { ok: false, bal: null, moved: 0, why: 'cannot read trading balance' };
    if (bal >= need) return { ok: true, bal, moved: 0 };
    if (this.isDemo) return { ok: false, bal, moved: 0, why: `demo balance $${bal.toFixed(4)} < $${need} (no transfers on demo)` };

    const short = round6(need - bal);
    const fund = await this.fundingUSDT();
    if (fund === null) return { ok: false, bal, moved: 0, why: 'cannot read funding balance' };
    if (fund < short) return { ok: false, bal, moved: 0, why: `funding $${fund.toFixed(4)} < needed $${short}` };

    const tr = await this.transferToTrading(short);
    if (tr.code !== '0') return { ok: false, bal, moved: 0, why: `transfer failed: ${tr.msg}` };
    await sleep(800);
    bal = await this.tradingUSDT();
    return { ok: bal !== null && bal >= need, bal, moved: short, why: null };
  }

  // ── market data ─────────────────────────────────────────────────
  async activeContract(seriesId) {
    const res = await this.request('GET', `/api/v5/public/instruments?instType=EVENTS&seriesId=${encodeURIComponent(seriesId)}`);
    if (res.code !== '0' || !Array.isArray(res.data)) return null;
    const now = Date.now();
    return res.data
      .map((i) => ({ instId: i.instId, stk: parseFloat(i.stk || '0'), expTime: parseInt(i.expTime || '0', 10), state: i.state }))
      .filter((c) => c.state === 'live' && c.expTime > now && c.stk > 0)
      .sort((a, b) => a.expTime - b.expTime)[0] || null;
  }

  async candles(instId, bar = '5m', limit = 30) {
    const res = await this.request('GET', `/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`);
    if (res.code !== '0' || !Array.isArray(res.data)) return [];
    return res.data.map((c) => ({ ts: +c[0], close: parseFloat(c[4]), confirm: parseInt(c[8] || '0', 10) }));
  }

  async spot(instId) {
    const res = await this.request('GET', `/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
    const last = parseFloat(res?.data?.[0]?.last || '0');
    return last > 0 ? last : null;
  }

  async orderbook(instId, depth = 10) {
    const res = await this.request('GET', `/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=${depth}`);
    const b = res?.data?.[0];
    return b ? { asks: b.asks || [], bids: b.bids || [] } : null;
  }

  // ── orders ──────────────────────────────────────────────────────
  async placeOrder({ instId, outcome, side, ordType, sz, px }) {
    const body = { instId, tdMode: await this.tdMode(), side, ordType, sz: String(sz) };
    if (px != null) body.px = String(px);
    if (outcome) body.outcome = outcome;
    let res = await this.request('POST', '/api/v5/trade/order', body, true);

    // If the account's tdMode guess was wrong, try the others once
    const sCode = res?.data?.[0]?.sCode;
    const sMsg = (res?.data?.[0]?.sMsg || '').toLowerCase();
    if (sCode && sCode !== '0' && (sCode === '51000' || sCode === '59125' || sMsg.includes('tdmode'))) {
      for (const m of ['cash', 'cross', 'isolated'].filter((x) => x !== body.tdMode)) {
        body.tdMode = m;
        res = await this.request('POST', '/api/v5/trade/order', body, true);
        if (res?.data?.[0]?.sCode === '0') { this._tdMode = m; break; }
      }
    }
    return res;
  }

  buyMarket(instId, outcome, sz) { return this.placeOrder({ instId, outcome, side: 'buy', ordType: 'market', sz }); }
  sellLimit(instId, outcome, sz, px) { return this.placeOrder({ instId, outcome, side: 'sell', ordType: 'limit', sz, px }); }

  orderStatus(instId, ordId) {
    return this.request('GET', `/api/v5/trade/order?instId=${encodeURIComponent(instId)}&ordId=${encodeURIComponent(ordId)}`, null, true);
  }

  /** Direction a contract settled: UP / DOWN / SKIP (unknown yet). */
  async settlement(instId, expTime) {
    if (Date.now() < expTime) return null;
    const res = await this.request('GET', `/api/v5/market/history-mark-price-candles?instId=${encodeURIComponent(instId)}&bar=1m&limit=5`);
    if (res.code !== '0' || !Array.isArray(res.data) || !res.data.length) return { direction: 'SKIP' };
    const last = parseFloat(res.data[0][4]);
    return { direction: last > 0.5 ? 'UP' : last < 0.5 ? 'DOWN' : 'SKIP', last };
  }
}

module.exports = OKX;
