/** 保留原有 ok/result 字段，同时明确完整成功、部分完成和失败。 */
export function toolResult(result:unknown):string {
  const value=result && typeof result==='object'?result as Record<string,unknown>:undefined;
  const partial=value?.delivered===false || (value?.delivered===true && typeof value.noteError==='string');
  return JSON.stringify({ok:true,status:partial?'partial':'success',result});
}
export function toolFailure(error:unknown):string {
  return JSON.stringify({ok:false,status:'failed',error:error instanceof Error?error.message:String(error)});
}
