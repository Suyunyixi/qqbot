import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir } from '../config/settings.js';

/** One stable host-mapped workspace per conversation. */
export function workspaceFor(conversationId: string): string {
  const group = createHash('sha256').update(conversationId).digest('hex').slice(0, 24);
  const root = process.env.BOT_WORKSPACE_DIR ? path.resolve(process.env.BOT_WORKSPACE_DIR) : path.join(dataDir, 'artifacts');
  const dir = path.join(root, group);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve symlinks and reject files outside the current conversation. */
export function resolveWorkspaceFile(conversationId: string, file: string): string {
  const root = fs.realpathSync(workspaceFor(conversationId));
  // Deep Agents' filesystem is virtual: /foo and relative foo both name a
  // file inside this conversation's root. Accept the actual mapped path too.
  const resolved = path.resolve(file);
  const workspaceRoot = fs.realpathSync(path.dirname(root));
  if (path.isAbsolute(file) && resolved.startsWith(workspaceRoot + path.sep) && !resolved.startsWith(root + path.sep)) {
    throw new Error('只能访问当前会话工作目录中的文件');
  }
  const candidate = resolved.startsWith(root + path.sep)
    ? resolved
    : path.resolve(root, file.replace(/^[/\\]+/, ''));
  const actual = fs.realpathSync(candidate);
  if (!actual.startsWith(root + path.sep) || !fs.statSync(actual).isFile()) throw new Error('只能访问当前会话工作目录中的文件');
  return actual;
}
