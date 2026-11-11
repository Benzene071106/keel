#!/usr/bin/env node
// Create or update Keel's TrueForge agents from agents/*.json.
// ${KEEL_PRIMARY_MODEL} / ${KEEL_FALLBACK_MODEL} are substituted from the environment.
// For every agent X, an "X-fallback" twin is generated that uses KEEL_FALLBACK_MODEL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TF = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const primary = process.env.KEEL_PRIMARY_MODEL;
const fallback = process.env.KEEL_FALLBACK_MODEL ?? primary;
if (!primary) {
  console.error('Set KEEL_PRIMARY_MODEL (e.g. openai/gpt-x or mock/edit-helpers). Optional: KEEL_FALLBACK_MODEL.');
  process.exit(1);
}
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');

async function http(method, p, body) {
  const res = await fetch(TF + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

// Agents must reference a registered MCP server. If the extension has not registered
// keel-editor yet, register a placeholder; the extension replaces it with its live URL on activation.
const mcpName = process.env.KEEL_MCP_NAME ?? 'keel-editor';
const mcpRes = await fetch(`${TF}/api/v1/settings/mcp-servers/${mcpName}`);
if (mcpRes.status === 404) {
  await http('PUT', '/api/v1/settings/mcp-servers', {
    manifest: {
      type: 'remote',
      name: mcpName,
      description: 'Placeholder; the Keel extension re-registers its live URL on activation.',
      url: 'http://127.0.0.1:9/mcp',
      auth: { type: 'header', headers: { Authorization: 'Bearer placeholder' } },
    },
  });
  console.log(`registered placeholder MCP server ${mcpName}`);
}

const { data: existing = [] } = await http('GET', '/api/v1/agents?limit=100');
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  for (const [suffix, model] of [['', primary], ['-fallback', fallback]]) {
    const def = JSON.parse(raw.replaceAll('${KEEL_PRIMARY_MODEL}', model));
    def.name += suffix;
    const found = existing.find(a => a.name === def.name);
    if (found) await http('PUT', `/api/v1/agents/${found.id}`, { description: def.description, manifest: def.manifest });
    else await http('POST', '/api/v1/agents', def);
    console.log(`${found ? 'updated' : 'created'} ${def.name} -> ${model}`);
  }
}
