import Database from 'better-sqlite3';
import path from 'node:path';
import { dataDir } from '../config/settings.js';

const [command, conversationId] = process.argv.slice(2);
if (command !== 'list' && (command !== 'export' || !conversationId)) {
  console.error('用法：node dist/cli/history.js list | export <会话ID>');
  process.exit(2);
}
const db = new Database(path.join(dataDir, 'bot.sqlite'), { readonly: true, fileMustExist: true });
try {
  if (command === 'list') {
    for (const row of db.prepare('SELECT conversation_id,scope,COUNT(*) AS messages,MAX(timestamp) AS last_message_at FROM messages GROUP BY conversation_id,scope ORDER BY last_message_at DESC').iterate()) console.log(JSON.stringify(row));
  } else {
    const statement = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq');
    for (const row of statement.iterate(conversationId) as Iterable<Record<string, unknown>>) {
      for (const key of ['raw', 'attachments']) {
        if (typeof row[key] === 'string') {
          try { row[key] = JSON.parse(row[key] as string) as unknown; } catch { /* Preserve the stored value. */ }
        }
      }
      console.log(JSON.stringify(row));
    }
  }
} finally { db.close(); }
