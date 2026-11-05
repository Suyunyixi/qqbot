import { z } from 'zod';

const webUrl = z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), '仅支持 HTTP(S) 链接');
export const nativeCardSchema = z.object({
  kind: z.enum(['link', 'list','cover','custom']).describe('单个链接 link；多条链接 list；大图 cover；已获授权的其他模板 custom'),
  title: z.string().min(1).max(150),
  description: z.string().max(500).optional(),
  url: webUrl.optional(),
  imageUrl: webUrl.optional(),
  subtitle: z.string().max(150).optional(),
  items: z.array(z.object({ text: z.string().min(1).max(200), url: webUrl.optional() })).max(10).optional(),
  templateId:z.number().int().positive().optional(),
  kv:z.array(z.object({key:z.string().min(1).max(100),value:z.string().max(3000).optional(),obj:z.array(z.object({obj_kv:z.array(z.object({key:z.string().max(100),value:z.string().max(3000)})).max(30)})).max(30).optional()})).max(50).optional(),
});
export type NativeCard = z.infer<typeof nativeCardSchema>;

/** QQ official ARK 23 (list), 24 (thumbnail), and 37 (large cover). */
export function buildNativeArk(input: unknown): { template_id: number; kv: Array<{ key: string; value?: string; obj?: unknown[] }> } {
  const card = nativeCardSchema.parse(input);
  if(card.kind==='custom') {if(!card.templateId || !card.kv?.length)throw new Error('自定义卡片需要模板 ID 和字段');return {template_id:card.templateId,kv:card.kv};}
  if (card.kind === 'cover') {
    if (!card.url || !card.imageUrl) throw new Error('大图卡片需要真实的链接和图片地址');
    return {template_id:37,kv:[{key:'#PROMPT#',value:card.title},{key:'#METATITLE#',value:card.title},{key:'#METASUBTITLE#',value:card.subtitle ?? card.description ?? ''},{key:'#METACOVER#',value:card.imageUrl},{key:'#METAURL#',value:card.url}]};
  }
  if (card.kind === 'link') {
    if (!card.url) throw new Error('链接卡片需要真实的 url');
    const kv = [
      { key: '#DESC#', value: card.description ?? card.title },
      { key: '#PROMPT#', value: card.title },
      { key: '#TITLE#', value: card.title },
      { key: '#METADESC#', value: card.description ?? '' },
      { key: '#LINK#', value: card.url },
      { key: '#SUBTITLE#', value: card.subtitle ?? '' },
    ];
    if (card.imageUrl) kv.push({ key: '#IMG#', value: card.imageUrl });
    return { template_id: 24, kv };
  }
  if (!card.items?.length) throw new Error('列表卡片需要至少一条内容');
  return { template_id: 23, kv: [
    { key: '#DESC#', value: card.description ?? card.title },
    { key: '#PROMPT#', value: card.title },
    { key: '#LIST#', obj: card.items.map((item) => ({ obj_kv: [{ key: 'desc', value: item.text }, ...(item.url ? [{ key: 'link', value: item.url }] : [])] })) },
  ] };
}
