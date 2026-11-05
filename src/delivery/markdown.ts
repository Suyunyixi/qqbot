/** Split on line boundaries and reopen fenced code blocks across QQ messages. */
export function splitMarkdown(text: string, limit: number): string[] {
  if (!text.trim()) return [];
  if (text.length <= limit) return [text];
  const result: string[] = [];
  let current = '';
  let fence = '';
  const flush = () => {
    if (!current.trim()) return;
    result.push(current + (fence ? '\n```' : ''));
    current = fence;
  };
  for (const original of text.split('\n')) {
    let line = original;
    const marker = line.match(/^\s*```[^`]*$/);
    const opening = !!marker && !fence;
    const closing = !!marker && !!fence;
    // Reserve space for the closing fence in each message.
    const suffix = fence || opening ? 4 : 0;
    if (current && current.length + 1 + line.length + suffix > limit) flush();
    while (line.length + current.length + (current ? 1 : 0) + suffix > limit) {
      const room = Math.max(1, limit - current.length - (current ? 1 : 0) - suffix);
      let cut = room;
      if (cut < line.length && /[\uD800-\uDBFF]/.test(line[cut - 1]!)) cut--;
      if (!cut) { flush(); continue; }
      current += (current ? '\n' : '') + line.slice(0, cut);
      line = line.slice(cut);
      flush();
    }
    current += (current ? '\n' : '') + line;
    if (opening) fence = line.trim();
    else if (closing) fence = '';
  }
  if (current.trim()) result.push(current);
  return result;
}
