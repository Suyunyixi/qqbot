import { readConfig } from '../config/settings.js';
import { readPublicWebpage } from './web.js';

export interface SearchSource { title: string; url: string; snippet?: string; publishedAt?: string; imageUrl?: string; thumbnailUrl?: string; provider: string }
type Range = 'any' | 'day' | 'week' | 'month' | 'year';
function cleanUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; }
}
async function searx(query: string, range: Range, category: 'general' | 'images'): Promise<SearchSource[]> {
  const config = readConfig(); const url = new URL('/search', config.tools.searchUrl);
  url.searchParams.set('q', query); url.searchParams.set('format', 'json'); url.searchParams.set('language', 'zh-CN');
  if (range !== 'any') url.searchParams.set('time_range', range);
  if (category === 'images') url.searchParams.set('categories', 'images');
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) }); if (!response.ok) throw new Error(`搜索服务 HTTP ${response.status}`);
  const result = await response.json() as {results?: Array<Record<string,unknown>>};
  if (!Array.isArray(result.results)) throw new Error('搜索服务没有返回有效结果');
  return result.results.flatMap((item) => {
    const link = cleanUrl(item.url); if (!link) return [];
    return [{ url: link, title: typeof item.title === 'string' ? item.title : link, snippet: typeof item.content === 'string' ? item.content.slice(0,1200) : undefined, publishedAt: typeof item.publishedDate === 'string' ? item.publishedDate : undefined, imageUrl: cleanUrl(item.img_src), thumbnailUrl: cleanUrl(item.thumbnail_src), provider: 'searxng' }];
  });
}
async function deepseek(query: string): Promise<SearchSource[]> {
  const config = readConfig(); if (!config.model.apiKey) throw new Error('搜索 provider 缺少模型密钥');
  const endpoint = `${config.tools.deepseekSearchBaseUrl.replace(/\/+$/, '')}/messages`;
  const response = await fetch(endpoint, { method:'POST', redirect:'error', headers: { 'content-type':'application/json', 'anthropic-version':'2023-06-01', 'x-api-key':config.model.apiKey, authorization:`Bearer ${config.model.apiKey}` }, body:JSON.stringify({ model:config.tools.deepseekSearchModel,max_tokens:2048,messages:[{role:'user',content:[{type:'text',text:`Perform a web search for the query: ${query}`}]}],tools:[{type:'web_search_20250305',name:'web_search',max_uses:3}],thinking:{type:'disabled'} }), signal:AbortSignal.timeout(90000) });
  const data = await response.json() as {content?: Array<Record<string,unknown>>; error?:{message?:string}; message?:string};
  if (!response.ok) throw new Error(`DeepSeek 搜索 HTTP ${response.status}: ${(data.error?.message ?? data.message ?? '请求失败').replaceAll(config.model.apiKey,'[REDACTED]')}`);
  const blocks = Array.isArray(data.content) ? data.content : [];
  const searches = blocks.filter((b) => b.type === 'web_search_tool_result');
  if (!searches.length) throw new Error('DeepSeek 搜索未返回结构化来源');
  const snippets = new Map<string,string>();
  for (const block of blocks) if (Array.isArray(block.citations)) for (const citation of block.citations as Array<Record<string,unknown>>) if (typeof citation.url === 'string' && typeof citation.cited_text === 'string') snippets.set(citation.url,citation.cited_text);
  return searches.flatMap((block) => Array.isArray(block.content) ? (block.content as Array<Record<string,unknown>>).flatMap((item) => {
    const link=cleanUrl(item.url); if (item.type!=='web_search_result' || !link) return [];
    return [{ url:link,title:typeof item.title==='string'?item.title:link,snippet:snippets.get(link),publishedAt:typeof item.page_age==='string'?item.page_age:undefined,provider:'deepseek' }];
  }) : []);
}
export async function searchWeb(queries: string[], options: {range?:Range; category?:'general'|'images'} = {}) {
  const config = readConfig(); const category=options.category ?? 'general'; const range=options.range ?? 'any';
  const unique=[...new Set(queries.map((q)=>q.trim()).filter(Boolean))].slice(0,4); if (!unique.length) throw new Error('搜索关键词不能为空');
  const batches = await Promise.all(unique.map(async (query) => {
    const attempts: Array<{query:string;provider:string;count:number;error?:string}> = []; const results: SearchSource[] = [];
    const useDeepseek = config.tools.searchProvider === 'deepseek' || (config.tools.searchProvider === 'auto' && new URL(config.model.baseUrl).hostname === 'api.deepseek.com' && !!config.model.apiKey);
    const providers = category === 'images' ? ['searxng'] : config.tools.searchProvider === 'auto' ? (useDeepseek ? ['deepseek','searxng'] : ['searxng']) : [config.tools.searchProvider];
    for (const provider of providers) {
      try {
        const found=provider==='deepseek'?await deepseek(query):await searx(query,range,category);
        const items=category==='images' ? found.filter((item) => !!item.imageUrl) : found;
        attempts.push({query,provider,count:items.length}); results.push(...items);
        if (items.length) break;
      } catch(error) { attempts.push({query,provider,count:0,error:error instanceof Error?error.message:'搜索失败'}); }
    }
    // Image engines are often unavailable. Fall back to real search results
    // and discover image URLs from their source pages, retaining attribution.
    if (category === 'images' && results.length === 0 && useDeepseek) {
      try {
        const pages = await deepseek(`${query} 图片 素材`);
        const discovered = await Promise.all(pages.slice(0, 5).map(async (source) => {
          try {
            const page = await readPublicWebpage(source.url);
            return (page.images ?? []).map((imageUrl) => ({ ...source, imageUrl, provider: 'deepseek-page' }));
          } catch { return []; }
        }));
        const images = discovered.flat();
        attempts.push({ query, provider: 'deepseek-page', count: images.length });
        results.push(...images);
      } catch (error) { attempts.push({ query, provider: 'deepseek-page', count: 0, error: error instanceof Error ? error.message : '图片来源检索失败' }); }
    }
    return {attempts,results};
  }));
  const attempts = batches.flatMap((batch) => batch.attempts); const results = batches.flatMap((batch) => batch.results);
  const seen=new Set<string>(); const sources=results.filter((item)=>{const key=category==='images'?item.imageUrl??item.url:item.url;if(seen.has(key))return false;seen.add(key);return true}).slice(0,24);
  const rangeEnforced = range === 'any' || !attempts.some((attempt) => attempt.provider.startsWith('deepseek') && attempt.count > 0);
  const dateNotice = rangeEnforced ? '' : ' DeepSeek 搜索接口未强制限制时间范围，必须逐条核对来源日期。';
  return { queriedAt:new Date().toISOString(), queries:unique, range, rangeEnforced, category, sources, attempts, sufficient:sources.length>0, notice:(sources.length?'搜索结果是线索，应读取原文、核对日期和适用范围后再下结论。':'没有找到可用来源；请更换关键词、搜索源或如实说明无法验证。') + dateNotice + (category === 'images' ? ' 图片链接来自搜索结果页面，须检查素材是否与主题相符。' : '') };
}
export async function researchWeb(queries: string[], range: Range = 'any') {
  const result=await searchWeb(queries,{range});
  const reads=await Promise.all(result.sources.slice(0,4).map(async (source)=>{try{return {source,document:await readPublicWebpage(source.url)}}catch(error){return {source,error:error instanceof Error?error.message:'读取失败'}}}));
  return { ...result, reads, notice:`${result.notice} 搜索摘要不是证据；核对原文与日期，区分官方事实、社区观点与推断，无法验证时不得当作确定结论。` };
}
