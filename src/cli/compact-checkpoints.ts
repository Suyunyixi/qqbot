import path from 'node:path';
import fs from 'node:fs';
import { checkpointPath, dataDir, sqlitePath } from '../config/settings.js';
import { compactCheckpointDatabase } from '../storage/checkpoint-maintenance.js';

if (!process.argv.includes('--apply')) {
  console.log('请先停止机器人和后台任务；使用 --apply 会先备份并校验，再整理已完成的会话检查点。');
} else {
  try {
    const response=await fetch(`http://127.0.0.1:${process.env.BOT_PORT ?? '8765'}/healthz`,{signal:AbortSignal.timeout(1000)});
    if(response.ok)throw new Error('机器人仍在运行，请停止后再整理');
  } catch(error) {
    if(error instanceof Error && error.message==='机器人仍在运行，请停止后再整理')throw error;
  }
  const label=new Date().toISOString().replace(/[:.]/g,'-');
  const backup=path.join(dataDir,'backups',`checkpoints-${label}.sqlite`);
  if(!fs.existsSync(dataDir))throw new Error('数据目录不存在');
  console.log(JSON.stringify(await compactCheckpointDatabase(checkpointPath,sqlitePath,backup),null,2));
}
