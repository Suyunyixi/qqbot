/** 将旧版 @ 标记转换为 QQ 当前格式；代码片段原样保留。 */
export function qqMentionMarkup(text:string):string {
  const code=/(`{3,}|`{1,2})[\s\S]*?\1/g;
  let output='';let from=0;
  const convert=(part:string)=>part.replace(/<@!?([A-Za-z0-9_-]{1,200})>/g,(_match,id:string)=>`<qqbot-at-user id="${id}" />`);
  for(const match of text.matchAll(code)) {
    const index=match.index;
    output+=convert(text.slice(from,index))+match[0];
    from=index+match[0].length;
  }
  return output+convert(text.slice(from));
}
