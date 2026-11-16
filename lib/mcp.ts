// MCP at /mcp: JSON-RPC 2.0 Streamable HTTP (plain JSON responses, no SSE),
// protocol revision 2026-07-28, six tools acting on the same Store as REST
// and git. Authentication is checked before method dispatch.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isStoreError, type Store } from './store.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository (defaults to the authenticated user).' },
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state of issues to list: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(id: string | number | null, structured: Record<string, unknown>): Record<string, unknown> {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  });
}

function toolErrorResult(id: string | number | null, message: string): Record<string, unknown> {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function missingArg(id: string | number | null, name: string): Record<string, unknown> {
  return rpcError(id, -32602, `Missing required argument: ${name}`);
}

function resolveRepo(store: Store, owner: string, repoName: string) {
  if (!store.checkOwner(owner)) return null;
  return store.repoByName(repoName) ?? null;
}

function handleToolsCall(store: Store, id: string | number | null, params: Record<string, unknown>): Record<string, unknown> {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const definition = TOOLS.find((tool) => tool.name === name);
  if (definition === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  for (const required of definition.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) return missingArg(id, required);
  }
  const owner = typeof args.owner === 'string' ? args.owner : (store.viewerLogin ?? '');
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const created = store.createRepo({
        name: repoName,
        description: typeof args.description === 'string' ? args.description : undefined,
        private: args.private === true,
      });
      if (isStoreError(created)) return toolErrorResult(id, created.message);
      const repo = created;
      return toolResult(id, {
        name: repo.name,
        full_name: `${store.viewerLogin ?? owner}/${repo.name}`,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = resolveRepo(store, owner, args.repo as string);
      if (repo === null) return toolErrorResult(id, 'Not Found');
      return toolResult(id, {
        name: repo.name,
        full_name: `${store.viewerLogin ?? owner}/${repo.name}`,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const repo = resolveRepo(store, owner, args.repo as string);
      if (repo === null) return toolErrorResult(id, 'Not Found');
      const issue = store.createIssue({ repo, title: args.title as string, body: typeof args.body === 'string' ? args.body : undefined });
      if (isStoreError(issue)) return toolErrorResult(id, issue.message);
      return toolResult(id, {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      });
    }
    case 'list_issues': {
      const repo = resolveRepo(store, owner, args.repo as string);
      if (repo === null) return toolErrorResult(id, 'Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      return toolResult(id, { issues });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, owner, args.repo as string);
      if (repo === null) return toolErrorResult(id, 'Not Found');
      const result = store.createPull({
        repo,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : undefined,
        head: args.head as string,
        base: args.base as string,
      });
      if (isStoreError(result)) return toolErrorResult(id, `Validation Failed: ${result.message}`);
      return toolResult(id, {
        id: result.id,
        number: result.number,
        title: result.title,
        body: result.body,
        state: result.state,
        head: result.headRef,
        base: result.baseRef,
      });
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, owner, args.repo as string);
      if (repo === null) return toolErrorResult(id, 'Not Found');
      const pull = store.pullByNumber(repo, Number(args.pull_number));
      if (pull === undefined) return toolErrorResult(id, 'Not Found');
      const result = store.mergePull(repo, pull);
      if (isStoreError(result)) return toolErrorResult(id, `Merge failed: ${result.message}`);
      return toolResult(id, { merged: true, sha: result.sha, number: pull.number, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
    }
    default:
      return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
}

/**
 * Handle one POST /mcp request. Returns true when the path belongs to MCP.
 * Authentication is checked before any method dispatch.
 */
export function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if (!store.checkToken(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let request: RpcRequest;
  try {
    request = JSON.parse(body.toString('utf8')) as RpcRequest;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (request === null || typeof request !== 'object' || typeof request.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = request.id === undefined ? null : request.id;
  const params = (request.params ?? {}) as Record<string, unknown>;
  // A notification has no id and gets a bare 202.
  if (request.method === 'notifications/initialized' && request.id === undefined) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return true;
  }
  switch (request.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      const protocolVersion = requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION;
      sendJson(
        res,
        200,
        rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
      return true;
    }
    case 'server/discover': {
      sendJson(
        res,
        200,
        rpcResult(id, {
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        }),
      );
      return true;
    }
    case 'tools/list': {
      // The tool list is static, so two calls are byte-identical.
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    }
    case 'tools/call': {
      sendJson(res, 200, handleToolsCall(store, id, params));
      return true;
    }
    case 'ping': {
      sendJson(res, 200, rpcResult(id, {}));
      return true;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${request.method}`));
      return true;
    }
  }
}
