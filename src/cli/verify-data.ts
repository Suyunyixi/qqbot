import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.env.BOT_DATA_DIR ?? '/data';
const files = ['bot.sqlite', 'checkpoints.sqlite'];
const result: Record<string, unknown> = {};
for (const name of files) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) throw new Error(`缺少 ${name}`);
  const hashes: Record<string, string> = {};
  for (const suffix of ['', '-wal']) if (fs.existsSync(file + suffix)) hashes[suffix || 'database'] = createHash('sha256').update(fs.readFileSync(file + suffix)).digest('hex');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`${name} 完整性检查失败`);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    const tables: Record<string, number> = {};
    for (const { name: table } of names) tables[table] = (db.prepare(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`).get() as { n: number }).n;
    result[name] = { integrity, tables, hashes };
  } finally { db.close(); }
}
console.log(JSON.stringify(result));
