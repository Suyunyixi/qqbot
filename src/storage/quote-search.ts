/** 引用原文的搜索条件只接受内部固定字段名，查询内容仍使用参数绑定。 */
export function quoteSearchSql(rawColumn:'raw'|'m.raw', mode:'like'|'contains'):string {
  const text='quotes.content';
  const match=mode==='like'?`${text} LIKE ? ESCAPE '\\'`:`instr(${text},?)>0`;
  const raw=`CASE WHEN json_valid(${rawColumn}) THEN ${rawColumn} ELSE '{}' END`;
  return `EXISTS (SELECT 1 FROM (
    SELECT json_extract(element.value,'$.content') AS content FROM json_each(COALESCE(json_extract(${raw},'$.msgElements'),json_extract(${raw},'$.raw.msg_elements'),'[]')) AS element
      WHERE CASE WHEN element.type='object' THEN json_extract(element.value,'$.message_type')=103 OR json_extract(element.value,'$.msg_idx')=json_extract(${raw},'$.refMsgIdx') OR json_extract(element.value,'$.msg_idx')=json_extract(${raw},'$.raw.ref_msg_idx') ELSE 0 END
    UNION ALL
    SELECT json_extract(node.value,'$.content') AS content FROM json_each(COALESCE(json_extract(${raw},'$.raw.parallel_message.msg_nodes'),'[]')) AS node
      WHERE node.type='object' AND (json_extract(${raw},'$.msgType')=103 OR json_extract(${raw},'$.raw.message_type')=103 OR json_extract(${raw},'$.refMsgIdx') IS NOT NULL OR json_extract(${raw},'$.raw.ref_msg_idx') IS NOT NULL)
  ) AS quotes WHERE ${match})`;
}
