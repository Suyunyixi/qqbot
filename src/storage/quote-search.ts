/** 引用原文的搜索条件只接受内部固定字段名，查询内容仍使用参数绑定。 */
export function quoteSearchSql(rawColumn:'raw'|'m.raw', mode:'like'|'contains'):string {
  const text="json_extract(element.value,'$.content')";
  const match=mode==='like'?`${text} LIKE ? ESCAPE '\\'`:`instr(${text},?)>0`;
  return `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${rawColumn}) THEN COALESCE(json_extract(${rawColumn},'$.msgElements'),json_extract(${rawColumn},'$.raw.msg_elements'),'[]') ELSE '[]' END) AS element
    WHERE CASE WHEN element.type='object' THEN
      (json_extract(element.value,'$.message_type')=103 OR json_extract(element.value,'$.msg_idx')=json_extract(${rawColumn},'$.refMsgIdx') OR json_extract(element.value,'$.msg_idx')=json_extract(${rawColumn},'$.raw.ref_msg_idx'))
      AND ${match} ELSE 0 END)`;
}
