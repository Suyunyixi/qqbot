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

/** Translate an actual current-workspace path into the filesystem backend's virtual path. */
export function virtualWorkspacePath(conversationId: string, input: string): string {
  const root = path.resolve(workspaceFor(conversationId));
  if (!path.isAbsolute(input)) return input;
  const resolved = path.resolve(input);
  const base = path.dirname(root);
  if (resolved === root) return '/';
  if (resolved.startsWith(root + path.sep)) return `/${path.relative(root, resolved).split(path.sep).join('/')}`;
  if (resolved.startsWith(base + path.sep)) throw new Error('只能访问当前会话工作目录中的文件');
  return input;
}

/** Resolve symlinks and reject entries outside the current conversation. */
export function resolveWorkspaceEntry(conversationId: string, file: string): string {
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
  let actual: string;
  try { actual = fs.realpathSync(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Older agents sometimes passed the real workspace path to a virtual
    // filesystem backend, nesting that path under the conversation root.
    const relative = path.relative(root, candidate);
    const legacy = path.join(root, root.replace(/^[/\\]+/, ''), relative);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw error;
    try { actual = fs.realpathSync(legacy); } catch { throw error; }
  }
  if (actual !== root && !actual.startsWith(root + path.sep)) throw new Error('只能访问当前会话工作目录中的文件');
  return actual;
}
export function resolveWorkspaceFile(conversationId: string, file: string): string {
  const actual = resolveWorkspaceEntry(conversationId, file);
  if (!fs.statSync(actual).isFile()) throw new Error('只能访问当前会话工作目录中的文件');
  return actual;
}
