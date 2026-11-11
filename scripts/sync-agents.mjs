#!/usr/bin/env node
// Create or update Keel's TrueForge agents from agents/*.json.
// ${KEEL_PRIMARY_MODEL} / ${KEEL_FALLBACK_MODEL} are substituted from the environment.
// For every agent X, an "X-fallback" twin is generated that uses KEEL_FALLBACK_MODEL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TF = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
// Flags work in every shell (PowerShell, cmd, bash); they set the same variables as the environment would.
//   node scripts/sync-agents.mjs --primary openai/gpt-x --fallback anthropic/claude-x [--inline provider/model] [--inline-fallback provider/model]
//   node scripts/sync-agents.mjs --mock        (scripted mock model, no API key)
const flag = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
if (process.argv.includes('--mock')) {
  process.env.KEEL_PRIMARY_MODEL ??= 'mock/edit-helpers';
  process.env.KEEL_MODEL_KEEL_INLINE ??= 'mock/inline-debug-flag';
}
if (flag('primary')) process.env.KEEL_PRIMARY_MODEL = flag('primary');
if (flag('fallback')) process.env.KEEL_FALLBACK_MODEL = flag('fallback');
if (flag('inline')) process.env.KEEL_MODEL_KEEL_INLINE = flag('inline');
if (flag('inline-fallback')) process.env.KEEL_MODEL_KEEL_INLINE_FALLBACK = flag('inline-fallback');
const primary = process.env.KEEL_PRIMARY_MODEL;
const fallback = process.env.KEEL_FALLBACK_MODEL ?? primary;
if (!primary) {
  console.error('Usage: node scripts/sync-agents.mjs --primary <provider/model> [--fallback <provider/model>]   or   --mock');
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
  // Per-agent override, e.g. KEEL_MODEL_KEEL_INLINE / KEEL_MODEL_KEEL_INLINE_FALLBACK (used for scripted mock tests).
  const envKey = `KEEL_MODEL_${JSON.parse(raw).name.toUpperCase().replace(/-/g, '_')}`;
  const p = process.env[envKey] ?? primary;
  const f = process.env[`${envKey}_FALLBACK`] ?? (process.env[envKey] ? p : fallback);
  for (const [suffix, model] of [['', p], ['-fallback', f]]) {
    const def = JSON.parse(raw.replaceAll('${KEEL_PRIMARY_MODEL}', model));
    def.name += suffix;
    const found = existing.find(a => a.name === def.name);
    if (found) await http('PUT', `/api/v1/agents/${found.id}`, { description: def.description, manifest: def.manifest });
    else await http('POST', '/api/v1/agents', def);
    console.log(`${found ? 'updated' : 'created'} ${def.name} -> ${model}`);
  }
}
