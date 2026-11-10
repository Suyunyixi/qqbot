export interface MentionMember { id:string; names:string[] }

/** 仅转换对话 Agent 明确写出的艾特；重名时不猜测身份。 */
export function resolveDialogueMentions(text:string, members:MentionMember[]):string {
  const byId=new Map(members.map((member)=>[member.id,member]));
  const aliases=new Map<string,MentionMember[]>();
  for(const member of members) for(const name of member.names) {
    if(!name || name===member.id)continue;
    const values=aliases.get(name) ?? [];
    if(!values.some((value)=>value.id===member.id))values.push(member);
    aliases.set(name,values);
  }
  const names=[...aliases.keys()].sort((a,b)=>b.length-a.length).map((name)=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const plain=names.length?new RegExp(`@(${names.join('|')})(?:\\s*[（(]([A-Za-z0-9_-]{1,200})[）)])?(?=\\s|[，。！？、：；,.!?;:]|$)`,'g'):undefined;
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part,index)=>{
    if(index%2)return part;
    const normalized=part.replace(/<@!?([A-Za-z0-9_-]{1,200})>/g,(_match,id:string)=>`<qqbot-at-user id="${id}" />`);
    const tagged=plain?normalized.replace(plain,(original,name:string,id:string|undefined)=>{
      const candidates=aliases.get(name) ?? [];
      const member=id?candidates.find((candidate)=>candidate.id===id):candidates.length===1?candidates[0]:undefined;
      if(!member)throw new Error('艾特对象无法确定，请核对群成员资料');
      return `<qqbot-at-user id="${member.id}" />`;
    }):normalized;
    return tagged.replace(/<qqbot-at-user\s+id="([^"]+)"\s*\/>/g,(original,id:string)=>{
      if(!byId.has(id))throw new Error('艾特对象不在当前会话的已知成员中');
      return original;
    });
  }).join('');
}
