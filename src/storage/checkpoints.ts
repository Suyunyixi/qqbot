import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { dataDir } from '../config/settings.js';

const imagePattern=/"url":"data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})"/g;
const referencePattern=/"url":"qqbot-image:([a-f0-9]{64}):(png|jpeg|gif|webp)"/g;

/** 检查点只保存图片文件的内容哈希，恢复运行时按需读取原图。 */
export function openCheckpointSaver(file:string, mediaRoot=path.join(dataDir,'attachments','checkpoints')):SqliteSaver {
  const saver=SqliteSaver.fromConnString(file);
  const original=saver.serde;
  saver.serde={
    async dumpsTyped(value) {
      const [type,encoded]=await original.dumpsTyped(value);
      if (type!=='json') return [type,encoded];
      let changed=false;
      const content=Buffer.from(encoded).toString('utf8').replace(imagePattern,(_match,mime:string,base64:string)=>{
        const bytes=Buffer.from(base64,'base64');
        const digest=createHash('sha256').update(bytes).digest('hex');
        fs.mkdirSync(mediaRoot,{recursive:true});
        const filename=path.join(mediaRoot,digest);
        try {fs.writeFileSync(filename,bytes,{flag:'wx',mode:0o600});} catch(error) {if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;}
        changed=true;
        return `"url":"qqbot-image:${digest}:${mime.slice(6)}"`;
      });
      return [type,changed ? Buffer.from(content,'utf8') : encoded];
    },
    async loadsTyped(type,encoded) {
      if (type!=='json') return original.loadsTyped(type,encoded);
      const content=(typeof encoded==='string'?encoded:Buffer.from(encoded).toString('utf8')).replace(referencePattern,(_match,digest:string,extension:string)=>{
        const bytes=fs.readFileSync(path.join(mediaRoot,digest));
        if (createHash('sha256').update(bytes).digest('hex')!==digest) throw new Error('检查点图片校验失败');
        return `"url":"data:image/${extension};base64,${bytes.toString('base64')}"`;
      });
      return original.loadsTyped(type,content);
    },
  };
  return saver;
}

/** 只整理已完成会话的旧检查点，后台任务和最新检查点保持不动。 */
export function pruneConversationCheckpoints(saver:SqliteSaver, threadId:string, keep=3):number {
  if(!/^(group|c2c|guild|dm):.+/.test(threadId) || !Number.isInteger(keep) || keep<2)throw new Error('会话检查点清理参数无效');
  const db=saver.db;
  return db.transaction(()=>{
    const params=[threadId,threadId,keep] as const;
    db.prepare(`DELETE FROM writes WHERE thread_id=? AND checkpoint_ns='' AND checkpoint_id NOT IN
      (SELECT checkpoint_id FROM checkpoints WHERE thread_id=? AND checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT ?)`).run(...params);
    return db.prepare(`DELETE FROM checkpoints WHERE thread_id=? AND checkpoint_ns='' AND checkpoint_id NOT IN
      (SELECT checkpoint_id FROM checkpoints WHERE thread_id=? AND checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT ?)`).run(...params).changes;
  })();
}
