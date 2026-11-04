// Test-only OpenAI-compatible endpoint for exercising startup without a model.
import http from 'node:http';

http.createServer((request, response) => {
  let body = '';
  request.on('data', (part) => { body += part; });
  request.on('end', () => {
    const input = JSON.parse(body || '{}');
    const probe = Array.isArray(input.tools) && input.tools.some((item) => item.function?.name === 'startup_probe');
    const message = probe
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'probe-1', type: 'function', function: { name: 'startup_probe', arguments: '{}' } }] }
      : { role: 'assistant', content: '图片中有二维码图案。' };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'startup-test', object: 'chat.completion', created: 1, model: 'startup-test', choices: [{ index: 0, message, finish_reason: probe ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
}).listen(11434, '0.0.0.0');
