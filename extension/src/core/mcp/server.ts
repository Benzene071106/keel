import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { EditorHost } from '../host';
import type { ReviewGate } from '../review/gate';
import { registerTools, type ToolEvents } from './tools';
import { registerContextTools, type ContextEvents } from './contextTools';
import type { ContextService } from '../context/service';

export interface RunningMcpServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

export interface McpServerOptions {
  host: EditorHost;
  gate: ReviewGate;
  events?: ToolEvents & ContextEvents;
  /** Enables context_pack / find_symbol / repo_map. */
  context?: ContextService;
  port?: number;
  token?: string;
}

/**
 * Keel's editor-as-MCP-server. TrueForge only speaks remote MCP, so the extension serves
 * streamable HTTP on loopback, guarded by a per-window bearer token.
 * Stateless mode: every POST gets a fresh server/transport pair (TrueForge reconnects per turn).
 */
export async function startMcpServer(opts: McpServerOptions): Promise<RunningMcpServer> {
  const token = opts.token ?? randomBytes(24).toString('hex');
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.post('/mcp', async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const server = new McpServer({ name: 'keel-editor', version: '0.0.1' });
    const events = opts.events ?? {};
    registerTools(server, opts.host, opts.gate, {
      ...events,
      onFileWritten: (path, a, r) => {
        opts.context?.invalidate();
        events.onFileWritten?.(path, a, r);
      },
    });
    if (opts.context) registerContextTools(server, opts.context, events);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      opts.host.log(`MCP request failed: ${String(err)}`);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });
  // Stateless server: no standalone SSE stream, no session deletion.
  app.get('/mcp', (_req, res) => res.status(405).end());
  app.delete('/mcp', (_req, res) => res.status(405).end());

  const httpServer: Server = await new Promise(resolve => {
    const s = app.listen(opts.port ?? 0, '127.0.0.1', () => resolve(s));
  });
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => new Promise<void>(resolve => httpServer.close(() => resolve())),
  };
}
