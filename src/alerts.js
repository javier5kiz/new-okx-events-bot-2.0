/**
 * alerts.js — Optional Discord webhook alerts (entry / win / loss).
 * Silent no-op when DISCORD_WEBHOOK_URL is not set. Never throws.
 */
class Alerts {
  constructor(url) {
    this.url = (url || '').trim();
    this.enabled = !!this.url;
  }

  async _post(title, color, fields) {
    if (!this.enabled) return;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{ title, color, fields: fields.map(([name, value]) => ({ name, value: String(value), inline: true })), timestamp: new Date().toISOString() }],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) console.error(`[Discord] ${res.status} ${res.statusText}`);
    } catch (e) {
      console.error(`[Discord] ${e.message}`);
    }
  }

  entry(t) {
    return this._post(`🔥 ENTRY — ${t.asset} ${t.side}`, 0xffa500, [
      ['Band', t.band], ['Buy', `${t.buyPrice.toFixed(2)}`], ['Target', 'Sell @ 0.30'],
      ['Size', t.sz], ['Trade #', t.n], ['Contract', t.instId],
    ]);
  }

  win(t) {
    return this._post(`🎉 WIN — ${t.asset} ${t.side}`, 0x00cc66, [
      ['Buy', t.buyPrice.toFixed(2)], ['Exit', t.sellPrice.toFixed(2)], ['Profit', `$${t.profit.toFixed(4)}`],
      ['Winrate', `${t.winrate.toFixed(1)}% (${t.wins}W/${t.losses}L)`], ['Exit via', t.settled ? 'Settlement' : 'Limit sell'], ['Contract', t.instId],
    ]);
  }

  loss(t) {
    return this._post(`💀 LOSS — ${t.asset} ${t.side}`, 0xff3333, [
      ['Buy', t.buyPrice.toFixed(2)], ['Loss', `$${Math.abs(t.loss).toFixed(4)}`],
      ['Winrate', `${t.winrate.toFixed(1)}% (${t.wins}W/${t.losses}L)`], ['Contract', t.instId],
    ]);
  }
}

module.exports = Alerts;
