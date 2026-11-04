import { initConfig } from '../config/settings.js';
import { Store } from '../storage/store.js';
import { doctor } from '../startup/doctor.js';
import { loadPlugins } from '../tools/plugins.js';

initConfig();
const store = new Store();
try {
  await loadPlugins();
  const checks = await doctor(store, !process.argv.includes('--offline'));
  for (const check of checks) console.log(`[${check.ok ? '通过' : '失败'}] ${check.name}: ${check.message}`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
} finally { store.close(); }
