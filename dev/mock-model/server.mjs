#!/usr/bin/env node
// Scripted OpenAI-compatible model for deterministic tests and demos without an API key.
// The model id selects a scenario: dev/mock-model/scenarios/<model_id>.json
//   { "steps": [ { "tool": "read_file", "args": {...} }, { "tools": [ {...}, {...} ] }, { "text": "..." } ] }
// Step i is played when the conversation holds i assistant messages. Special ids:
//   "fail-401"  -> HTTP 401 invalid key      "fail-500" -> HTTP 500
//   "slow-<scenario>" -> same scenario, text streamed one word every 300 ms (for cancel tests)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_MODEL_PORT ?? 7802);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadScenario(id) {
  const file = path.join(here, 'scenarios', `${id}.json`);
  if (!fs.existsSync(file)) return { steps: [{ text: `No scenario named "${id}".` }] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveTool(name, available) {
  return available.find(t => t === name) ?? available.find(t => t.endsWith(`__${name}`) || t.endsWith(`.${name}`) || t.endsWith(`_${name}`)) ?? name;
}

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const j = JSON.parse(body || '{}');
      let id = String(j.model ?? '');
      if (id === 'fail-401') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
      if (id === 'fail-500') {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'upstream exploded' } }));
        return;
      }
      const slow = id.startsWith('slow-');
      if (slow) id = id.slice(5);
      const scenario = loadScenario(id);
      const msgs = j.messages ?? [];
      const turn = msgs.filter(m => m.role === 'assistant').length;
      const step = scenario.steps[Math.min(turn, scenario.steps.length - 1)];
      const available = (j.tools ?? []).map(t => t.function?.name).filter(Boolean);
      console.log(`[mock] ${id} step ${turn}:`, JSON.stringify(step).slice(0, 120));

      const base = { id: `mock-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: j.model };
      const send = o => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let closed = false;
      res.on('close', () => (closed = true));

      const calls = step.tools ?? (step.tool ? [{ tool: step.tool, args: step.args }] : null);
      if (calls) {
        calls.forEach((c, i) => {
          const name = resolveTool(c.tool, available);
          send({ choices: [{ index: 0, delta: { ...(i === 0 ? { role: 'assistant' } : {}), tool_calls: [{ index: i, id: `call_${turn}_${i}`, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(c.args ?? {}) } }] }, finish_reason: null }] });
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
      } else {
        const words = String(step.text ?? 'Done.').split(/(?<= )/);
        for (const w of words) {
          if (closed) return;
          send({ choices: [{ index: 0, delta: { content: w }, finish_reason: null }] });
          await sleep(slow ? 300 : 15);
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[mock] OpenAI-compatible mock model on http://127.0.0.1:${PORT}/v1`));
