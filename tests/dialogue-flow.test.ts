import { describe, expect, it } from 'vitest';
import { dialogueInput, requestIncludesPersona, responseText } from '../src/admin/dialogue-flow.js';

describe('对话流程展示',()=>{
  it('提取模型回复正文，不把思考片段当成回复',()=>{
    expect(responseText(JSON.stringify({content:[{type:'thinking',thinking:'不展示'},{type:'text',text:'实际回复'}]}))).toBe('实际回复');
    expect(responseText('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"不展示"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"实际"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"回复"}}\n')).toBe('实际回复');
    expect(responseText(JSON.stringify({choices:[{message:{content:'兼容接口回复'}}]}))).toBe('兼容接口回复');
  });
  it('解析表达层的对象、内容与备注',()=>{
    const request={messages:[{role:'user',content:JSON.stringify({'回复对象':'主人','内容':'文件已发送','备注':'任务完成'})}]};
    expect(dialogueInput(JSON.stringify(request))).toEqual({recipient:'主人',content:'文件已发送',remarks:'任务完成'});
  });
  it('基于真实系统字段验证人格，而非信任版本标签',()=>{
    expect(requestIncludesPersona(JSON.stringify({system:[{type:'text',text:'系统：完整人格'}],messages:[] }),'完整人格')).toBe(true);
    expect(requestIncludesPersona(JSON.stringify({messages:[{role:'user',content:'完整人格'}]}),'完整人格')).toBe(false);
    expect(requestIncludesPersona('不是 JSON','完整人格')).toBeNull();
  });
});
