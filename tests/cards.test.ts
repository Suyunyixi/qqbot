import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-card-test-'));
const { initConfig } = await import('../src/config/settings.js');
const { buildNativeArk } = await import('../src/domain/card.js');
const { Store } = await import('../src/storage/store.js');
const { ReplyRuntime } = await import('../src/delivery/reply.js');
const { QQAdapter } = await import('../src/platform/qq/adapter.js');
const { Harness } = await import('../src/agent/harness.js');
const { splitMarkdown } = await import('../src/delivery/markdown.js');
const { qqMentionMarkup } = await import('../src/platform/qq/mentions.js');
initConfig();

describe('QQ 原生卡片', () => {
  it('底层官方网关接收频道普通消息和平台事件', async () => {
    const store=new Store(':memory:');const states:boolean[]=[];
    const adapter=new QQAdapter({appId:'app',appSecret:'secret'},store,(state)=>states.push(state),(options)=>({start:async()=>{
      options.onReady?.({});
      await options.onRawEvent?.('MESSAGE_CREATE',{id:'normal',channel_id:'ch',guild_id:'guild',author:{id:'member',username:'群友'},content:'普通发言',timestamp:new Date().toISOString()});
      await options.onRawEvent?.('GUILD_CREATE',{id:'guild'});
    }}));
    vi.spyOn(adapter.bot.tokenManager,'getAccessToken').mockResolvedValue('fake');vi.spyOn(adapter.bot.tokenManager,'startBackgroundRefresh').mockImplementation(()=>{});vi.spyOn(adapter.bot.tokenManager,'stopBackgroundRefresh').mockImplementation(()=>{});
    const harness=new Harness(store,{send:async()=>({})});const receive=vi.spyOn(harness,'receive').mockResolvedValue(false);adapter.listen(harness);
    await adapter.start();
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({scope:'guild',conversationId:'ch',isMention:false,content:'普通发言'}),expect.any(Function),expect.any(Function));
    expect(store.db.prepare('SELECT event_type FROM qq_events').get()).toMatchObject({event_type:'GUILD_CREATE'});expect(states).toEqual([true,false]);
    harness.stop();store.close();
  });
  it('网关恢复序号与消息同事务提交，入库失败不越过丢失位置', async () => {
    const store=new Store(':memory:');const errors=vi.spyOn(console,'error').mockImplementation(()=>{});let attempt=0;
    const adapter=new QQAdapter({appId:'app',appSecret:'secret'},store,()=>{},(options)=>({start:async()=>{
      const message=(id:string)=>({kind:'group' as const,groupOpenid:'g',senderId:'u',messageId:id,content:'群聊',timestamp:new Date().toISOString(),rawEventType:'GROUP_MESSAGE_CREATE',raw:{}});
      attempt++;
      if(attempt===2) {
        expect(options.session!.load()).toEqual({sessionId:'session',lastSeq:1});
        options.session!.save({sessionId:'session',lastSeq:2});options.onMessage(message('two'));
        options.session!.save({sessionId:'session',lastSeq:3});options.onMessage(message('three'));
        expect(store.recent('g',10).map((row)=>row.id)).toEqual(['one','two','three']);
        expect(JSON.parse(store.getAppSetting('qq_gateway_session')!).lastSeq).toBe(3);
        adapter.stop();return;
      }
      options.session!.save({sessionId:'session',lastSeq:1});
      expect(store.getAppSetting('qq_gateway_session')).toBeUndefined();
      options.onMessage(message('one'));
      expect(store.recent('g',10)).toHaveLength(1);
      expect(JSON.parse(store.getAppSetting('qq_gateway_session')!)).toEqual({sessionId:'session',lastSeq:1});
      const fail=vi.spyOn(store,'setAppSetting').mockImplementationOnce(()=>{throw Error('模拟数据库故障')});
      options.session!.save({sessionId:'session',lastSeq:2});options.onMessage(message('two'));
      await vi.waitFor(()=>expect(errors).toHaveBeenCalled());
      expect(store.recent('g',10).map((row)=>row.id)).toEqual(['one']);
      expect(JSON.parse(store.getAppSetting('qq_gateway_session')!).lastSeq).toBe(1);
      expect(options.abortSignal.aborted).toBe(true);
      fail.mockRestore();
    }}),1);
    vi.spyOn(adapter.bot.tokenManager,'getAccessToken').mockResolvedValue('fake');vi.spyOn(adapter.bot.tokenManager,'startBackgroundRefresh').mockImplementation(()=>{});vi.spyOn(adapter.bot.tokenManager,'stopBackgroundRefresh').mockImplementation(()=>{});
    const harness=new Harness(store,{send:async()=>({})});adapter.listen(harness);
    try {await adapter.start();} finally {harness.stop();store.close();errors.mockRestore();}
  });
  it('频道消息映射到独立会话并用官方频道 API 回复', async () => {
    const store=new Store(':memory:');const adapter=new QQAdapter({appId:'test-app',appSecret:'test-secret'},store,()=>{});adapter.connected=true;
    const harness=new Harness(store,{send:async()=>({})});const receive=vi.spyOn(harness,'receive').mockResolvedValue(true);adapter.listen(harness);
    const emitter=adapter.bot as unknown as {emit(event:string,...values:unknown[]):Promise<void>};
    await emitter.emit('message',{}, {kind:'guild',senderId:'member',channelId:'channel',guildId:'guild',messageId:'in-guild',content:'你好',timestamp:new Date().toISOString(),rawEventType:'AT_MESSAGE_CREATE',raw:{author:{id:'member'}}});
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({scope:'guild',conversationId:'channel',isMention:true}));
    store.record({id:'in-guild',conversationId:'channel',scope:'guild',senderId:'member',content:'你好',timestamp:new Date().toISOString(),isMention:true,attachments:[]});
    const channel=vi.spyOn(adapter.bot.messageApi,'sendChannelMessageRaw').mockResolvedValue({id:'sent',timestamp:new Date().toISOString()});
    await new ReplyRuntime(store,adapter).send('channel','guild','in-guild','text','**频道回复**');
    expect(channel).toHaveBeenCalledWith('channel',expect.any(Object),expect.objectContaining({msg_id:'in-guild',markdown:{content:'**频道回复**'}}));
    harness.stop();store.close();
  });
  it('发送原生按钮并接收、确认按钮事件', async () => {
    const store=new Store(':memory:');const adapter=new QQAdapter({appId:'test-app',appSecret:'test-secret'},store,()=>{});adapter.connected=true;
    const send=vi.spyOn(adapter.bot,'send').mockResolvedValue({id:'buttons',timestamp:new Date().toISOString()});
    store.record({id:'input',conversationId:'g',scope:'group',senderId:'u',content:'选一个',timestamp:new Date().toISOString(),isMention:true,attachments:[]});
    await new ReplyRuntime(store,adapter).send('g','group','input','keyboard',JSON.stringify({text:'请选择',buttons:[{label:'MP3',data:'mp3'}]}));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({msgType:2,keyboard:expect.objectContaining({content:expect.objectContaining({rows:expect.any(Array)})})}));
    const harness=new Harness(store,{send:async()=>({})});const receive=vi.spyOn(harness,'receive').mockResolvedValue(true);const ack=vi.spyOn(adapter.bot,'acknowledgeInteraction').mockResolvedValue();adapter.listen(harness);
    const emitter=adapter.bot as unknown as {emit(event:string,...values:unknown[]):Promise<void>};
    await emitter.emit('interaction',{}, {id:'evt1',group_openid:'g',group_member_openid:'u',data:{resolved:{button_data:'mp3'}}});
    expect(ack).toHaveBeenCalledWith('evt1',0);expect(receive).toHaveBeenCalledWith(expect.objectContaining({id:'interaction:evt1',content:'用户点击了按钮：mp3'}));
    harness.stop();store.close();
  });
  it('按钮事件的多段回复使用 event_id 并递增序号', async () => {
    const store=new Store(':memory:');const adapter=new QQAdapter({appId:'test-app',appSecret:'test-secret'},store,()=>{});adapter.connected=true;
    const send=vi.spyOn(adapter.bot,'send').mockResolvedValue({id:'sent',timestamp:new Date().toISOString()});
    store.record({id:'interaction:evt',conversationId:'g',scope:'group',senderId:'u',content:'选择',timestamp:new Date().toISOString(),isMention:true,attachments:[]});
    const reply=new ReplyRuntime(store,adapter);await reply.send('g','group','interaction:evt','text','第一段');await reply.send('g','group','interaction:evt','text','第二段');
    expect(send.mock.calls[0]?.[0].extra).toMatchObject({event_id:'evt',msg_seq:1});
    expect(send.mock.calls[1]?.[0].extra).toMatchObject({event_id:'evt',msg_seq:2});
    store.close();
  });
  it('QQ 平台 API 仅接受官方相对路径', async () => {
    const store=new Store(':memory:');const adapter=new QQAdapter({appId:'test-app',appSecret:'test-secret'},store,()=>{});adapter.connected=true;
    const get=vi.spyOn(adapter.bot.api,'get').mockResolvedValue({ok:true});
    await expect(adapter.qqApi('GET','/users/@me/guilds')).resolves.toEqual({ok:true});
    await expect(adapter.qqApi('GET','https://example.com/steal')).rejects.toThrow('相对路径');
    await expect(adapter.qqApi('GET','//example.com/steal')).rejects.toThrow('相对路径');
    expect(get).toHaveBeenCalledTimes(1);store.close();
  });
  it('普通回复使用 QQ 原生 Markdown 消息，保留被动回复目标', async () => {
    const store = new Store(':memory:');
    const adapter = new QQAdapter({ appId: 'test-app', appSecret: 'test-secret' }, store, () => {});
    adapter.connected = true;
    const markdown = vi.spyOn(adapter.bot, 'sendMarkdown');
    const send = vi.spyOn(adapter.bot, 'send').mockResolvedValue({ id: 'qq-md-1', timestamp: new Date().toISOString() });
    const plain = vi.spyOn(adapter.bot, 'sendText');
    store.record({ id: 'in-md', conversationId: 'g', scope: 'group', senderId: 'u', content: '格式', timestamp: new Date().toISOString(), isMention: true, attachments: [] });
    await new ReplyRuntime(store, adapter).send('g', 'group', 'in-md', 'text', '# 标题\n\n**加粗**\n\n- 一项');
    expect(markdown).toHaveBeenCalledWith({ scope: 'group', targetId: 'g', msgId: 'in-md' }, '# 标题\n\n**加粗**\n\n- 一项');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ msgType: 2, markdown: { content: '# 标题\n\n**加粗**\n\n- 一项' } }));
    expect(plain).not.toHaveBeenCalled();
    store.close();
  });
  it('群回复将旧 @ 转成官方标签，并以原生 Markdown 请求发送', async () => {
    const store=new Store(':memory:');const adapter=new QQAdapter({appId:'app',appSecret:'secret'},store,()=>{});adapter.connected=true;
    store.record({id:'input-at',conversationId:'g',scope:'group',senderId:'sender',content:'说说',timestamp:new Date().toISOString(),isMention:true,attachments:[]});
    const raw=vi.spyOn(adapter.bot.messageApi,'sendRaw').mockResolvedValue({id:'sent',timestamp:new Date().toISOString()});
    await new ReplyRuntime(store,adapter).send('g','group','input-at','text','<@member-1> **你好**');
    expect(raw).toHaveBeenCalledWith('group','g',expect.any(Object),expect.objectContaining({msg_id:'input-at',msg_type:2,markdown:{content:'<qqbot-at-user id="member-1" /> **你好**'}}));
    expect(qqMentionMarkup('`<@example>` 和 <@!member-1>')).toBe('`<@example>` 和 <qqbot-at-user id="member-1" />');
    store.close();
  });
  it('长 Markdown 的代码块跨消息保持闭合和语言标记', () => {
    const text = '说明\n\n```python\n' + Array.from({length:30}, (_, i) => `print(${i})`).join('\n') + '\n```\n\n结束';
    const chunks = splitMarkdown(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks.join('\n')).toContain('print(29)');
  });
  it('长回复切分时不会拆开 QQ @ 标记',()=>{
    const tag='<qqbot-at-user id="member-123456" />';
    const parts=splitMarkdown(`${'甲'.repeat(90)}${tag}你好`,100);
    expect(parts).toEqual(['甲'.repeat(90),`${tag}你好`]);
  });
  it('按官方 23 模板构造多条链接列表', () => {
    const ark = buildNativeArk({ kind: 'list', title: '榜单', items: [{ text: '视频一', url: 'https://www.bilibili.com/video/BV1example' }, { text: '视频二' }] });
    expect(ark.template_id).toBe(23);
    expect(ark.kv.find((item) => item.key === '#LIST#')?.obj).toEqual([
      { obj_kv: [{ key: 'desc', value: '视频一' }, { key: 'link', value: 'https://www.bilibili.com/video/BV1example' }] },
      { obj_kv: [{ key: 'desc', value: '视频二' }] },
    ]);
    expect(() => buildNativeArk({ kind: 'list', title: '榜单', items: [] })).toThrow('至少一条');
  });
  it('按官方 37 模板构造大图卡片',()=>{
    const card=buildNativeArk({kind:'cover',title:'标题',subtitle:'副标题',url:'https://example.com/page',imageUrl:'https://example.com/image.png'});
    expect(card.template_id).toBe(37);expect(card.kv).toContainEqual({key:'#METACOVER#',value:'https://example.com/image.png'});
    expect(()=>buildNativeArk({kind:'cover',title:'标题',url:'https://example.com'})).toThrow('图片');
  });
  it('通过统一回复队列使用官方 SDK 发送 24 模板，并记录结果', async () => {
    const store = new Store(':memory:');
    const adapter = new QQAdapter({ appId: 'test-app', appSecret: 'test-secret' }, store, () => {});
    adapter.connected = true;
    const send = vi.spyOn(adapter.bot, 'send').mockResolvedValue({ id: 'qq-card-1', timestamp: new Date().toISOString() });
    store.record({ id: 'in-1', conversationId: 'g', scope: 'group', senderId: 'u', content: '卡片', timestamp: new Date().toISOString(), isMention: true, attachments: [] });
    const reply = new ReplyRuntime(store, adapter);
    await reply.send('g', 'group', 'in-1', 'card', JSON.stringify({ kind: 'link', title: '视频', url: 'https://www.bilibili.com/video/BV1example' }));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ msgType: 3, target: { scope: 'group', targetId: 'g', msgId: 'in-1' }, ark: { template_id: 24 } });
    expect(store.recent('g', 10).at(-1)?.content).toBe('[card] 视频');
    store.close();
  });
});
