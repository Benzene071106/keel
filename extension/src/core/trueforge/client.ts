import { TrueForge } from '@truefoundry/trueforge-sdk';

export function createClient(baseUrl: string): TrueForge {
  // Long turns stream over SSE; the SDK default (60 s) is too short.
  return new TrueForge({ baseUrl, timeoutInSeconds: 900 });
}

async function http(baseUrl: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : undefined;
}

/** Create or replace Keel's MCP server registration (PUT is create-or-replace by name). */
export async function registerMcpServer(baseUrl: string, name: string, url: string, token: string): Promise<void> {
  try {
    await http(baseUrl, 'PUT', '/api/v1/settings/mcp-servers', {
      manifest: {
        type: 'remote',
        name,
        description: 'Keel: the VS Code workspace (read, search, propose edits) exposed as MCP tools.',
        url,
        auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
      },
    });
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg.includes('Outbound URL blocked')) {
      throw new Error(
        'TrueForge blocked Keel\'s localhost MCP server. Start TrueForge with ' +
          'OUTBOUND_URL_ALLOWED_HOSTS=\'["127.0.0.1","localhost"]\' (see scripts/start-trueforge.sh).',
      );
    }
    throw e;
  }
}

export interface AgentDefinition {
  name: string;
  description: string;
  manifest: Record<string, unknown>;
}

/** Create the agent if missing, else update it in place (agents update by immutable id). */
export async function upsertAgent(baseUrl: string, def: AgentDefinition): Promise<void> {
  const list = (await http(baseUrl, 'GET', '/api/v1/agents?limit=100')) as { data?: Array<{ id: string; name: string }> };
  const existing = list.data?.find(a => a.name === def.name);
  if (existing) {
    await http(baseUrl, 'PUT', `/api/v1/agents/${existing.id}`, { description: def.description, manifest: def.manifest });
  } else {
    await http(baseUrl, 'POST', '/api/v1/agents', def);
  }
}
