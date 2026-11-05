import type { MessageRow } from '../storage/store.js';

/** Mark recent messages without duplicating the entire conversation in the prompt. */
export function recentActivityMarker(timestamp: string, now: number, windowSeconds: number): string {
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= -60000 && age <= windowSeconds * 1000 ? '近期互动' : '';
}

/** Select a recent group conversation window without guessing who addressed the bot. */
export function recentSocialContext(rows: MessageRow[], now: number, windowSeconds: number): string {
  const windowMs=windowSeconds*1000;
  const recent=rows.filter((row)=>{const timestamp=Date.parse(row.timestamp);const age=now-timestamp;return Number.isFinite(timestamp) && age>=-60000 && age<=windowMs;}).slice(-30);
  return recent.map((row)=>{
    const age=Math.max(0,Math.round((now-Date.parse(row.timestamp))/1000));
    const sender=row.direction==='out'?'机器人':`${row.sender_name??'群友'} [${row.sender_id}]`;
    return `[${row.timestamp}，约 ${age} 秒前] ${sender}：${row.content}${row.attachments!=='[]'?` 附件:${row.attachments}`:''}`;
  }).join('\n').slice(-10000);
}
