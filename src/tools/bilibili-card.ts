import { createHash } from 'node:crypto';

const table=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36','Referer':'https://www.bilibili.com','Accept-Language':'zh-CN,zh;q=0.9'};
const normalize=(text:string)=>text.replace(/<[^>]*>/g,'').replace(/[\s\u200b\u3000]/g,'').toLowerCase();

/** 按卡片标题查询 B 站候选；不把同名搜索结果当作已确认的原视频。 */
export async function searchBilibiliCard(title:string,signal?:AbortSignal) {
  const fetchJson=async(url:string)=>{
    const response=await fetch(url,{headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`B 站接口 HTTP ${response.status}`);
    const data=await response.json() as {code?:number;message?:string;data?:any};
    return data;
  };
  const nav=await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  const filename=(url:unknown)=>typeof url==='string'?url.split('/').pop()?.split('.')[0] ?? '':'';
  const raw=filename(nav.data?.wbi_img?.img_url)+filename(nav.data?.wbi_img?.sub_url);
  const key=table.map((index)=>raw[index] ?? '').join('').slice(0,32);
  if(key.length!==32)throw new Error('B 站未提供搜索签名信息');
  const matches=new Map<string,{bvid:string;title:string;author:string;url:string;cover?:string;duration?:string}>();
  const errors:string[]=[];let completed=0;
  for(const order of ['totalrank','click','pubdate']) {
    try {
      const params:Record<string,string|number>={search_type:'video',keyword:title,page:1,order,wts:Math.floor(Date.now()/1000)};
      const query=Object.keys(params).sort().map((name)=>`${encodeURIComponent(name)}=${encodeURIComponent(String(params[name]).replace(/[!'()*]/g,''))}`).join('&');
      const signature=createHash('md5').update(query+key).digest('hex');
      const data=await fetchJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}&w_rid=${signature}`);
      if(data.code!==0)throw new Error(`B 站搜索返回 ${data.code} ${data.message ?? ''}`);
      completed++;
      const items=Array.isArray(data.data?.result)?data.data.result:[];
      for(const item of items) {
        if(typeof item.bvid!=='string' || !/^BV[0-9A-Za-z]{10}$/.test(item.bvid) || typeof item.title!=='string' || normalize(item.title)!==normalize(title))continue;
        matches.set(item.bvid,{bvid:item.bvid,title:item.title.replace(/<[^>]*>/g,''),author:typeof item.author==='string'?item.author:'',url:`https://www.bilibili.com/video/${item.bvid}`,cover:typeof item.pic==='string'?item.pic:undefined,duration:typeof item.duration==='string'?item.duration:undefined});
      }
    } catch(error) {if(signal?.aborted)throw error;errors.push(error instanceof Error?error.message:String(error));}
  }
  if(!completed)throw new Error(`B 站搜索不可用：${errors.join('；')}`);
  const candidates=[...matches.values()];
  return {candidates,match:'标题完全一致的候选，不等于已证明与分享卡片相同',hint:candidates.length?'结合作者、封面或其他来源验证；同名或证据不足时不要声称已确认。':'未找到完全同名的候选，可换搜索方法；不能据此断言视频不存在。',...(errors.length?{errors}:{} )};
}
