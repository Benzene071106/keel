#!/usr/bin/env node
// Register an OpenAI-compatible model provider in TrueForge without putting the key in a file or in shell history.
//   node scripts/add-provider.mjs groq            (asks for the key, hidden)
//   GROQ_API_KEY=... node scripts/add-provider.mjs groq
//   node scripts/add-provider.mjs --name myhost --base-url https://host/v1 --key-env MY_KEY
// It asks the provider which models the key can use, registers them, and prints the next command.
import readline from 'node:readline';

const TF = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const PRESETS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', prefer: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b'], fast: ['openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile'] },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', prefer: [], fast: [] },
};
const flag = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const presetName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const preset = PRESETS[presetName] ?? {};
const name = flag('name') ?? presetName;
const baseUrl = flag('base-url') ?? preset.baseUrl;
const keyEnv = flag('key-env') ?? preset.keyEnv ?? 'MODEL_API_KEY';
if (!name || !baseUrl) {
  console.error(`Usage: node scripts/add-provider.mjs <${Object.keys(PRESETS).join('|')}>   or   --name <name> --base-url <url> [--key-env VAR]`);
  process.exit(1);
}

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl._writeToOutput = () => {}; // do not echo the key
    rl.question('', answer => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const key = process.env[keyEnv] || (await askHidden(`Paste your ${name} API key (it will not be shown), then press Enter: `));
if (!key) {
  console.error('No key given.');
  process.exit(1);
}

// 1. Which models can this key use?
const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } }).catch(e => ({ ok: false, status: 0, text: async () => String(e.cause?.message ?? e.message) }));
if (!res.ok) {
  console.error(`${name} rejected the request (${res.status}): ${(await res.text()).slice(0, 300)}`);
  console.error(res.status === 401 ? 'The key looks wrong. Create a new one and try again.' : 'Check your internet connection and the base URL.');
  process.exit(1);
}
const listed = (await res.json()).data ?? [];
const chat = listed.filter(m => m.active !== false && !/whisper|tts|guard|embed|playai|orpheus|speech|distil|moderation|image/i.test(m.id));
if (chat.length === 0) {
  console.error('The provider returned no chat models for this key.');
  process.exit(1);
}
// TrueForge model names: lowercase letters, digits and hyphens only.
const tfName = id => id.toLowerCase().split('/').pop().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const seen = new Set();
const models = [];
for (const m of chat) {
  const n = tfName(m.id);
  if (n.length < 2 || seen.has(n)) continue;
  seen.add(n);
  models.push({ model_id: m.id, name: n, properties: { context_length: m.context_window ?? 131072, max_output_tokens: Math.min(m.max_completion_tokens ?? 8192, 32768) } });
}

// 2. Register (create or replace) the provider in TrueForge.
const put = await fetch(`${TF}/api/v1/settings/model-providers`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ manifest: { type: 'custom', name, base_url: baseUrl, auth: { api_key: key }, models } }),
}).catch(() => null);
if (!put) {
  console.error(`TrueForge is not reachable at ${TF}. Start it first: ./scripts/start-trueforge.sh`);
  process.exit(1);
}
if (!put.ok) {
  const body = await put.text();
  console.error(`TrueForge refused the provider (${put.status}): ${body.slice(0, 300)}`);
  if (/Outbound URL blocked/.test(body)) console.error(`TrueForge is blocking ${new URL(baseUrl).host}. Stop TrueForge, run "git pull", start it again with ./scripts/start-trueforge.sh, then rerun this command.`);
  process.exit(1);
}

const pick = list => list.map(id => models.find(m => m.model_id === id)).find(Boolean);
const primary = pick(preset.prefer ?? []) ?? models[0];
const fallback = (preset.prefer ?? []).map(id => models.find(m => m.model_id === id)).filter(Boolean).find(m => m !== primary) ?? models.find(m => m !== primary) ?? primary;
const fast = pick(preset.fast ?? []) ?? primary;
console.log(`Registered provider "${name}" with ${models.length} models:`);
for (const m of models) console.log(`  ${name}/${m.name}`);
console.log('\nNext, point the Keel agents at it (same line in PowerShell and Git Bash):\n');
console.log(`  node scripts/sync-agents.mjs --primary ${name}/${primary.name} --fallback ${name}/${fallback.name} --inline ${name}/${fast.name} --inline-fallback ${name}/${primary.name}`);
