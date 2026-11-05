export function requestsGroupStyleChange(text: string): boolean {
  const request=text.replace(/<@!?[^>]+>/g,'').trim();
  const subject=/(?:本群|群聊|群内|群里|这个群).{0,12}(?:风格|语气|人设|性格)|群风格|群语气/;
  const action=/修改|更改|改成|改为|改变|调整|设定|设置|重写|更新|切换|换成|替换/;
  const negated=/(?:不要|不许|不准|禁止|别|不能|无需|不用|不需要|停止).{0,12}(?:修改|更改|改|调整|设定|设置|重写|更新|切换|替换)/;
  const direct=/^(?:(?:你|请|麻烦|帮我|我要|我想|直接|现在|立即)\s*)*(?:把|将|修改|更改|调整|设定|设置|重写|更新|切换|替换)/;
  return direct.test(request) && subject.test(request) && action.test(request) && !negated.test(request);
}
