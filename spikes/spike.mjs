// Day-0 spike: a localhost MCP server + a mock OpenAI-compatible model,
// to prove TrueForge (local mode) can drive a tool loop against both.
import http from 'node:http';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MCP_PORT = 7801;
const MODEL_PORT = 7802;
const TOKEN = 'spike-token';

// ---------- MCP server ----------
function buildServer() {
  const server = new McpServer({ name: 'keel-spike', version: '0.0.1' });
  server.registerTool(
    'hello',
    {
      description: 'Say hello to someone. Returns a greeting string.',
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      console.log('[mcp] hello called with', name);
      return { content: [{ type: 'text', text: `hello, ${name}! (from localhost MCP)` }] };
    },
  );
  return server;
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.post('/mcp', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    console.log('[mcp] rejected: bad auth', req.headers.authorization);
    return res.status(401).json({ error: 'unauthorized' });
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get('/mcp', (_req, res) => res.status(405).end());
app.listen(MCP_PORT, '127.0.0.1', () => console.log(`[mcp] listening 127.0.0.1:${MCP_PORT}/mcp`));

// ---------- Mock OpenAI-compatible model ----------
// Turn 1 (last message from user): call the first tool whose name contains "hello".
// Turn 2 (last message is a tool result): stream a text answer echoing the tool output.
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    console.log('[model]', req.method, req.url);
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
    const j = JSON.parse(body || '{}');
    const msgs = j.messages ?? [];
    const last = msgs[msgs.length - 1] ?? {};
    const tools = (j.tools ?? []).map(t => t.function?.name);
    console.log('[model] last role:', last.role, 'tools:', tools.join(','));
    const base = { id: 'mock-1', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: j.model };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (last.role === 'tool') {
      const text = `The tool said: ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}`;
      for (const piece of text.match(/.{1,12}/g)) sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    } else {
      const toolName = tools.find(n => n && n.includes('hello')) ?? tools[0];
      console.log('[model] choosing tool', toolName);
      sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: '' } }] }, finish_reason: null }] });
      const args = toolName && toolName.includes('hello') ? JSON.stringify({ name: 'forge' }) : '{}';
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen(MODEL_PORT, '127.0.0.1', () => console.log(`[model] listening 127.0.0.1:${MODEL_PORT}/v1`));
