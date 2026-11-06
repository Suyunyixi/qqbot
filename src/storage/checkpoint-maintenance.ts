import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openCheckpointSaver, pruneConversationCheckpoints } from './checkpoints.js';

export async function compactCheckpointDatabase(checkpointFile:string,botFile:string,backupFile:string):Promise<{backup:string;removed:number;beforeBytes:number;afterBytes:number}> {
  if(!fs.existsSync(checkpointFile) || !fs.existsSync(botFile))throw new Error('数据库文件不存在');
  if(path.resolve(backupFile)===path.resolve(checkpointFile) || fs.existsSync(backupFile))throw new Error('备份路径无效或已存在');
  const bot=new Database(botFile,{readonly:true,fileMustExist:true});
  try {
    const active=bot.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued','running','waiting','interrupted')").get() as {n:number};
    if(active.n)throw new Error('存在未完成的后台任务，请先完成或安全停止后再整理');
  } finally {bot.close();}
  const beforeBytes=fs.statSync(checkpointFile).size;
  fs.mkdirSync(path.dirname(backupFile),{recursive:true});
  const source=new Database(checkpointFile,{readonly:true,fileMustExist:true});
  try {await source.backup(backupFile);} finally {source.close();}
  const backup=new Database(backupFile,{readonly:true,fileMustExist:true});
  try {if(backup.pragma('quick_check',{simple:true})!=='ok')throw new Error('备份完整性检查失败');} finally {backup.close();}
  const saver=openCheckpointSaver(checkpointFile);
  let removed=0;
  try {
    const threads=saver.db.prepare("SELECT DISTINCT thread_id FROM checkpoints WHERE checkpoint_ns='' AND (thread_id LIKE 'group:%' OR thread_id LIKE 'c2c:%' OR thread_id LIKE 'guild:%' OR thread_id LIKE 'dm:%')").all() as Array<{thread_id:string}>;
    for(const thread of threads)removed+=pruneConversationCheckpoints(saver,thread.thread_id);
    saver.db.exec('VACUUM');
  } finally {saver.db.close();}
  return {backup:backupFile,removed,beforeBytes,afterBytes:fs.statSync(checkpointFile).size};
}
