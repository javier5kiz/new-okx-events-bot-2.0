/**
 * index.js — Entry point. HuggingFace Docker Space: serves health on port 7860.
 *
 * The health endpoint reports the REAL state (starting / auth_failed / running) so a
 * Space that is "up" but not trading is obvious. Auth failures are retried instead of
 * leaving the process idle forever.
 */
const http = require('http');
const OKX = require('./okx');
const Alerts = require('./alerts');
const Strategy = require('./strategy');

const PORT = parseInt(process.env.PORT || '7860', 10);
const IS_DEMO = process.env.IS_DEMO === 'true' || process.env.OKX_SIMULATED === 'true';
const BASE_URL = process.env.OKX_BASE_URL || 'https://www.okx.com';
const AUTH_RETRY_MS = 60000;

const state = { status: 'starting', mode: IS_DEMO ? 'DEMO' : 'LIVE', server: BASE_URL, authError: null, startedAt: Date.now() };
let strategy = null;

const mask = (s) => (s && s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)` : s ? `(${s.length} chars)` : '(empty)');

// ── Health server — start FIRST so HuggingFace sees the port immediately ──
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: state.status,
    mode: state.mode,
    server: state.server,
    authError: state.authError,
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
    ...(strategy ? strategy.snapshot() : {}),
  }));
});
server.listen(PORT, '0.0.0.0', () => console.log(`🌐 Health server on 0.0.0.0:${PORT}`));

async function main() {
  console.log('\n==================================================');
  console.log('🤖 NEW OKX EVENTS BOT 2.0 — BTC + ETH Bollinger Bands(10), 5-min');
  console.log('==================================================');
  console.log(`🔧 Mode: ${state.mode}  |  Server: ${BASE_URL}`);
  console.log('🎯 Band touch → orderbook → buy ~10¢ side → sell @ 30¢ | 0.1 contracts fixed');

  const key = process.env.OKX_API_KEY || '';
  const secret = process.env.OKX_SECRET_KEY || '';
  const pass = process.env.OKX_PASSPHRASE || '';
  console.log(`🔑 OKX_API_KEY ${mask(key.trim())} | OKX_SECRET_KEY ${secret.trim() ? 'set' : 'EMPTY'} | OKX_PASSPHRASE ${pass.trim() ? 'set' : 'EMPTY'}`);
  console.log('==================================================\n');

  const alerts = new Alerts(process.env.DISCORD_WEBHOOK_URL);
  console.log(`🔔 Discord alerts: ${alerts.enabled ? 'ON' : 'off'}`);

  if (!key.trim() || !secret.trim() || !pass.trim()) {
    state.status = 'missing_credentials';
    state.authError = 'Set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE as Space secrets, then restart.';
    console.error(`❌ ${state.authError}`);
    return; // nothing to retry until the user restarts with secrets
  }

  const okx = new OKX({ apiKey: key, secretKey: secret, passphrase: pass, isDemo: IS_DEMO, baseURL: BASE_URL });

  // Retry auth so a transient error or a fixed secret doesn't need a manual restart loop
  for (;;) {
    const a = await okx.auth();
    if (a.ok) break;
    state.status = 'auth_failed';
    state.authError = `${a.msg} (code ${a.code})`;
    console.error(`❌ OKX auth failed: ${state.authError}`);
    console.error(`   Mode=${state.mode} Server=${BASE_URL}. Demo and live keys are NOT interchangeable; EU/US accounts need OKX_BASE_URL.`);
    console.error(`   Retrying in ${AUTH_RETRY_MS / 1000}s...`);
    await new Promise((r) => setTimeout(r, AUTH_RETRY_MS));
  }

  console.log('✅ OKX authentication OK');
  state.status = 'running';
  state.authError = null;

  strategy = new Strategy(okx, alerts);

  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n🛑 ${sig} — shutting down`);
    try { strategy.stop(); } catch (_) { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await strategy.start();
}

main().catch((e) => { console.error('💥 Fatal:', e); state.status = 'crashed'; state.authError = e.message; });
