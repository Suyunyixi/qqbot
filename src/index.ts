import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import { initConfig, setRuntimeConfigProvider } from './config/settings.js';
import { doctor, type Check } from './startup/doctor.js';
import { Store } from './storage/store.js';
import { Harness } from './agent/harness.js';
import { beginQr, QQAdapter, savedCredentials } from './platform/qq/adapter.js';
import { loadPlugins } from './tools/plugins.js';
import { handleAdmin, handlePersona } from './admin/api.js';

interface Status { phase: 'checking' | 'waiting_qr' | 'connecting' | 'ready' | 'failed'; checks: Check[]; qqConnected: boolean; error?: string; qrUrl?: string }
const status: Status = { phase: 'checking', checks: [], qqConnected: false };
const port = Number(process.env.BOT_PORT ?? 8765);
const adminDir = path.resolve(process.cwd(), 'assets/admin');
initConfig();
const store = new Store();
setRuntimeConfigProvider(() => store.getAppSetting('runtime_config'));
let adapter: QQAdapter | undefined;
let harness: Harness | undefined;
let startedTasks = false;
let checksReady = false;
function refreshConnectionState(): void {
  if (!adapter || !harness) return;
  if (status.qqConnected) for (const check of status.checks) if (!check.ok) void harness.balanceAlert.report(check.message);
  status.phase = status.qqConnected ? (checksReady ? 'ready' : 'checking') : 'connecting';
  if (status.qqConnected && checksReady) {
    if (!startedTasks) { startedTasks = true; harness.start(); }
    harness.tasks.notifyPending();
  }
}

const server = http.createServer(async (req, res) => {
  const restricted = process.env.BOT_CONTROL_INTERFACE;
  const controlAddresses = restricted ? (os.networkInterfaces()[restricted] ?? []).map((entry) => entry.address) : [];
  if (req.socket.localAddress && controlAddresses.includes(req.socket.localAddress)) { res.writeHead(403); res.end(); return; }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ alive: true, phase: status.phase })); return; }
  if (pathname === '/readyz') { res.writeHead(status.phase === 'ready' ? 200 : 503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ready: status.phase === 'ready', phase: status.phase })); return; }
  if (pathname === '/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ phase: status.phase, checks: status.checks, qqConnected: status.qqConnected, bound: Boolean(store.qqCredentials() || (process.env.QQBOT_APPID && process.env.QQBOT_SECRET)), error: status.error, hasQr: !!status.qrUrl })); return; }
  if (pathname === '/qr.svg' && status.qrUrl) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(await QRCode.toString(status.qrUrl, { type: 'svg', margin: 2 })); return; }
  if (pathname === '/api/persona') { await handlePersona(req, res, store); return; }
  if (pathname.startsWith('/api/')) { await handleAdmin(req, res, store, harness); return; }
  if (pathname === '/admin.js' || pathname === '/admin.css' || pathname === '/tools.js') {
    res.writeHead(200, { 'Content-Type': pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(fs.readFileSync(path.join(adminDir, path.basename(pathname)))); return;
  }
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
    res.end(fs.readFileSync(path.join(adminDir, 'index.html'))); return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, process.env.BOT_HOST ?? '127.0.0.1', () => console.log(`状态与扫码页面：http://127.0.0.1:${port}`));

async function main(): Promise<void> {
  await loadPlugins();
  // Services can become available after the QR page starts, particularly while
  // a first model download is in progress. Keep retrying failed checks rather
  // than requiring a manual restart after dependencies recover.
  const checksPromise = (async () => {
    for (;;) {
      const checks = await doctor(store).catch((error: unknown): Check[] => [{ name: '启动检查', ok: false, message: error instanceof Error ? error.message : String(error) }]);
      status.checks = checks;
      if (status.qqConnected && harness) {
        for (const check of checks) if (!check.ok) void harness.balanceAlert.report(check.message);
        if (checks.some((check)=>check.name==='模型与工具调用' && check.ok)) harness.balanceAlert.recovered();
      }
      for (const check of checks) console.log(`[${check.ok ? '通过' : '失败'}] ${check.name}: ${check.message}`);
      if (checks.every((check) => check.ok)) { status.error = undefined; return; }
      status.error = '启动自检未通过，修复依赖后将自动重试';
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  })();
  void checksPromise.then(() => { checksReady = true; refreshConnectionState(); });
  let credentials = savedCredentials(store);
  if (!credentials) {
    status.phase = 'waiting_qr';
    credentials = await beginQr(store, (url) => { status.qrUrl = url; console.log('请使用手机 QQ 扫码，或打开本地状态页。'); });
    status.qrUrl = undefined;
  }
  status.phase = 'connecting';
  adapter = new QQAdapter(credentials, store, (connected) => {
    status.qqConnected = connected;
    refreshConnectionState();
  });
  harness = new Harness(store, adapter);
  adapter.listen(harness);
  await adapter.start();
  status.qqConnected = false;
  status.phase = 'failed'; status.error = 'QQ 连接已停止';
}
void main().catch((error: unknown) => { status.phase = 'failed'; status.error = error instanceof Error ? error.message : String(error); console.error('启动失败：', status.error); });
const notifications = setInterval(() => { if (status.phase === 'ready') harness?.tasks.notifyPending(); }, 30000);
function stop() { clearInterval(notifications); harness?.stop(); adapter?.stop(); server.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
