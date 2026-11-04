import { z } from 'zod';

const webUrl = z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), '仅支持 HTTP(S) 链接');
export const nativeCardSchema = z.object({
  kind: z.enum(['link', 'list']).describe('单个链接使用 link；多条链接使用 list'),
  title: z.string().min(1).max(150),
  description: z.string().max(500).optional(),
  url: webUrl.optional(),
  imageUrl: webUrl.optional(),
  subtitle: z.string().max(150).optional(),
  items: z.array(z.object({ text: z.string().min(1).max(200), url: webUrl.optional() })).max(10).optional(),
});
export type NativeCard = z.infer<typeof nativeCardSchema>;

/** QQ official ARK 23 (list) and 24 (text with thumbnail). */
export function buildNativeArk(input: unknown): { template_id: number; kv: Array<{ key: string; value?: string; obj?: unknown[] }> } {
  const card = nativeCardSchema.parse(input);
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
