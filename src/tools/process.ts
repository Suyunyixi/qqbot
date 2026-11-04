import { spawn } from 'node:child_process';

export async function runProcess(program: string, args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error(`${program} 已取消`)); return; }
    const child = spawn(program, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { child.kill(); } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? 300000);
    const abort = () => kill();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-200000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-200000); });
    child.once('error', (err) => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (timedOut) reject(new Error(`${program} 执行超时`));
      else if (options.signal?.aborted) reject(new Error(`${program} 已取消`));
      else if (code !== 0) reject(new Error(`${program} 失败 (${code}): ${stderr.slice(-2000)}`));
      else resolve({ stdout, stderr });
    });
  });
}
