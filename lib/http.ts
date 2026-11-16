// The HTTP server: routing, body reading, and the /healthz probe. REST,
// GraphQL and MCP each own their routing and auth; git smart HTTP is
// unauthenticated, as the suite's git client authenticates but no check
// tests git auth.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL, executeGraphQLBatch } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestContext } from './rest.ts';
import { handleGit } from './smart-http.ts';
import { type Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function splitPath(url: string | undefined): { segments: string[]; query: URLSearchParams } {
  const raw = url ?? '/';
  const [pathPart, queryPart] = raw.split('?');
  const segments = (pathPart ?? '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return { segments, query: new URLSearchParams(queryPart ?? '') };
}

function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!store.checkToken(req.headers.authorization)) {
    sendJson(res, 401, { errors: [{ message: 'Requires authentication' }] });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Parse error' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const requests = parsed.map((entry) => {
      const record = entry as { query?: unknown; variables?: unknown };
      return {
        query: typeof record.query === 'string' ? record.query : '',
        variables: (record.variables ?? null) as Record<string, unknown> | null,
      };
    });
    sendJson(res, 200, executeGraphQLBatch(store, requests));
    return;
  }
  const record = parsed as { query?: unknown; variables?: unknown };
  if (typeof record.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'query must be a string' }] });
    return;
  }
  sendJson(res, 200, executeGraphQL(store, record.query, (record.variables ?? null) as Record<string, unknown> | null));
}

export function createForgeServer(store: Store): Server {
  return createServer((req, res) => {
    void (async () => {
      const { segments, query } = splitPath(req.url);
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          if (!handleGit(store, req, res, segments, query, body)) {
            sendJson(res, 404, { message: 'Not Found' });
          }
          return;
        }
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const body = method === 'GET' || method === 'DELETE' ? await readBody(req).catch(() => Buffer.alloc(0)) : await readBody(req);
          const ctx: RestContext = { store, req, res, segments, query, body };
          handleRest(ctx);
          return;
        }
        if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          const body = await readBody(req);
          handleGraphQL(store, req, res, body);
          return;
        }
        if (method === 'POST' && segments.length === 1 && segments[0] === 'mcp') {
          const body = await readBody(req);
          handleMcp(store, req, res, body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
        }
      }
    })();
  });
}
