// REST v3 under /api/v3: repos, branches, commits, contents, labels, issues,
// pull requests. Views follow GitHub's shape (extra fields are tolerated by
// the suite's validator); every reply is JSON and carries
// X-GitHub-Request-Id. Authentication is a Bearer token equal to
// MAKEFUN_SHOP_TOKEN; an unknown owner is a 404, never a 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './git-objects.ts';
import { trialNowIso } from './determinism.ts';
import {
  isStoreError,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  type StoreError,
} from './store.ts';

export interface RestContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
}

// The request id is a per-run counter: non-empty on every reply, and
// deterministic for a given request sequence (no wall clock, no randomness).
let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter}`;
}

/** A stable positive integer for a string (FNV-1a), for the /user id. */
function stableId(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function send(ctx: RestContext, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo',
    'content-length': body.length,
  });
  ctx.res.end(body);
}

function sendEmpty(ctx: RestContext, status: number): void {
  ctx.res.writeHead(status, { 'x-github-request-id': requestId(), 'x-oauth-scopes': 'repo', 'content-length': 0 });
  ctx.res.end();
}

function sendError(ctx: RestContext, status: number, message: string): void {
  send(ctx, status, { message });
}

function sendStoreError(ctx: RestContext, error: StoreError): void {
  sendError(ctx, error.status, error.message);
}

function parseBody(ctx: RestContext): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** GitHub renders an empty description/body as null. */
function orNull(text: string): string | null {
  return text === '' ? null : text;
}

/** Split a git identity ("Name <email> 1700000000 +0000") into its parts. */
function parseIdentity(identity: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d+)$/.exec(identity);
  if (match === null) return { name: identity, email: '', date: trialNowIso() };
  const timestamp = Number(match[3]);
  return { name: match[1]!, email: match[2]!, date: new Date(timestamp * 1000).toISOString() };
}

// -------------------------------------------------------------------------------------------
// views
// -------------------------------------------------------------------------------------------

function repoView(ctx: RestContext, repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${ctx.store.viewerLogin ?? ''}/${repo.name}`,
    owner: { login: ctx.store.viewerLogin ?? '', id: stableId(ctx.store.viewerLogin ?? ''), type: 'User' },
    private: repo.private,
    description: orNull(repo.description),
    default_branch: repo.defaultBranch,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `${baseUrl(ctx.req)}/${ctx.store.viewerLogin ?? ''}/${repo.name}`,
    url: `${baseUrl(ctx.req)}/api/v3/repos/${ctx.store.viewerLogin ?? ''}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueView(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: orNull(issue.body),
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label })),
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    url: `${baseUrl(ctx.req)}/api/v3/repos/${ctx.store.viewerLogin ?? ''}/${repo.name}/issues/${issue.number}`,
    html_url: `${baseUrl(ctx.req)}/${ctx.store.viewerLogin ?? ''}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(ctx.store.branchRef(pull.headRef)) ?? pull.headSha;
  const baseSha = repo.refs.get(ctx.store.branchRef(pull.baseRef)) ?? pull.baseSha;
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: orNull(pull.body),
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    url: `${baseUrl(ctx.req)}/api/v3/repos/${ctx.store.viewerLogin ?? ''}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl(ctx.req)}/${ctx.store.viewerLogin ?? ''}/${repo.name}/pull/${pull.number}`,
  };
}

function commitView(ctx: RestContext, repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  const commit = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const author = commit !== null ? parseIdentity(commit.author) : { name: '', email: '', date: trialNowIso() };
  const committer = commit !== null ? parseIdentity(commit.committer) : { name: '', email: '', date: trialNowIso() };
  return {
    sha,
    commit: {
      // GitHub's message has no trailing newline; the stored object keeps one.
      message: commit === null ? '' : commit.message.replace(/\n$/, ''),
      author,
      committer,
    },
    url: `${baseUrl(ctx.req)}/api/v3/repos/${ctx.store.viewerLogin ?? ''}/${repo.name}/commits/${sha}`,
  };
}

/** Paginate `items` (already in ascending order) and write the response with Link headers. */
function sendPaginated(ctx: RestContext, items: unknown[], total: number): void {
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const path = ctx.req.url!.split('?')[0];
  const base = `${baseUrl(ctx.req)}${path}`;
  const links: string[] = [];
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page < lastPage) links.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  if (lastPage > 1) links.push(`<${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  if (page > 1) {
    links.push(`<${base}?page=1&per_page=${perPage}>; rel="first"`);
    links.push(`<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  }
  const body = Buffer.from(JSON.stringify(pageItems), 'utf8');
  ctx.res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo',
    ...(links.length > 0 ? { link: links.join(', ') } : {}),
    'content-length': body.length,
  });
  ctx.res.end(body);
}

// -------------------------------------------------------------------------------------------
// repo resolution
// -------------------------------------------------------------------------------------------

/** Resolve the owner/repo pair in a /repos/{owner}/{repo}/... route. */
function resolveRepo(ctx: RestContext, owner: string, repoName: string): Repo | null {
  if (!ctx.store.checkOwner(owner)) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.repoByName(repoName);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

// -------------------------------------------------------------------------------------------
// handlers
// -------------------------------------------------------------------------------------------

function handleRoot(ctx: RestContext): void {
  send(ctx, 200, { current_user_url: `${baseUrl(ctx.req)}/api/v3/user` });
}

function handleMeta(ctx: RestContext): void {
  send(ctx, 200, { installed_version: '1.0.0', github_enterprise: true });
}

function handleGetUser(ctx: RestContext): void {
  const viewer = ctx.store.viewerLogin;
  if (viewer === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  send(ctx, 200, { login: viewer, id: stableId(viewer) });
}

function handleListUserRepos(ctx: RestContext): void {
  const repos = [...ctx.store.repos.values()].sort((a, b) => a.databaseId - b.databaseId);
  sendPaginated(ctx, repos.map((repo) => repoView(ctx, repo)), repos.length);
}

function handleCreateUserRepo(ctx: RestContext): void {
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const name = asString(parsed.value.name);
  if (name === undefined || name.length === 0) {
    sendError(ctx, 422, 'Validation Failed: name is required');
    return;
  }
  const created = ctx.store.createRepo({
    name,
    description: asString(parsed.value.description),
    private: asBoolean(parsed.value.private) ?? false,
  });
  if (isStoreError(created)) {
    // A duplicate name must read as GitHub's "already exists".
    sendError(ctx, created.status, created.message.includes('already exists') ? 'name already exists on this account' : created.message);
    return;
  }
  const defaultBranch = asString(parsed.value.default_branch);
  if (defaultBranch !== undefined && defaultBranch.length > 0) created.defaultBranch = defaultBranch;
  send(ctx, 201, repoView(ctx, created));
}

function handleGetRepo(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  send(ctx, 200, repoView(ctx, repo));
}

function handlePatchRepo(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const description = asString(parsed.value.description);
  if (description !== undefined) repo.description = description;
  send(ctx, 200, repoView(ctx, repo));
}

function handleDeleteRepo(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  ctx.store.deleteRepo(repo);
  sendEmpty(ctx, 204);
}

function handleListBranches(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .sort()
    .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } }));
  send(ctx, 200, branches);
}

function handleGetBranch(ctx: RestContext, owner: string, repoName: string, branch: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    sendError(ctx, 404, 'Branch not found');
    return;
  }
  send(ctx, 200, { name: branch, commit: { sha } });
}

function handleListCommits(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const shaParam = ctx.query.get('sha');
  // The sha parameter may be a branch name, a full ref, or a commit oid.
  const start =
    shaParam !== null
      ? (ctx.store.resolveRef(repo, shaParam) ?? shaParam)
      : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (start === undefined) {
    send(ctx, 200, []);
    return;
  }
  const ordered = ctx.store.commitList(repo, start);
  sendPaginated(ctx, ordered.map((sha) => commitView(ctx, repo, sha)), ordered.length);
}

function handleGetRef(ctx: RestContext, owner: string, repoName: string, refPath: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const sha = repo.refs.get(refPath);
  if (sha === undefined) {
    sendError(ctx, 404, 'Reference does not exist');
    return;
  }
  send(ctx, 200, { ref: refPath, object: { sha, type: 'commit' } });
}

function handleCreateRef(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const ref = asString(parsed.value.ref);
  const sha = asString(parsed.value.sha);
  if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
    sendError(ctx, 422, 'Validation Failed: ref and sha are required');
    return;
  }
  const error = ctx.store.createRef(repo, ref, sha);
  if (error !== null) {
    sendStoreError(ctx, error);
    return;
  }
  send(ctx, 201, { ref, object: { sha, type: 'commit' } });
}

function handleContentsGet(ctx: RestContext, owner: string, repoName: string, path: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const branch = ctx.query.get('ref') ?? repo.defaultBranch;
  const read = ctx.store.readPath(repo, path, branch);
  if (read === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (read.kind === 'file') {
    send(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: read.size,
      name: path.split('/').pop() ?? '',
      path,
      content: read.content.toString('base64'),
      sha: read.sha,
    });
    return;
  }
  send(
    ctx,
    200,
    read.entries.map((entry) => {
      const size = entry.type === 'file' ? (repo.objects.get(entry.sha)?.data.length ?? 0) : 0;
      return { type: entry.type, name: entry.name, path: entry.path, sha: entry.sha, size };
    }),
  );
}

function handleContentsPut(ctx: RestContext, owner: string, repoName: string, path: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const message = asString(parsed.value.message) ?? 'Update file';
  const content = asString(parsed.value.content);
  if (content === undefined) {
    sendError(ctx, 422, 'Validation Failed: content is required');
    return;
  }
  const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
  const sha = asString(parsed.value.sha);
  const result = ctx.store.commitFile(repo, {
    path,
    content: Buffer.from(content, 'base64'),
    message,
    branch,
    sha,
  });
  if (isStoreError(result)) {
    sendStoreError(ctx, result);
    return;
  }
  const status = result.created ? 201 : 200;
  send(ctx, status, {
    content: { name: path.split('/').pop() ?? '', path, sha: result.contentSha, size: Buffer.from(content, 'base64').length, encoding: 'base64' },
    commit: { sha: result.commitSha, message },
  });
}

function handleContentsDelete(ctx: RestContext, owner: string, repoName: string, path: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const message = asString(parsed.value.message) ?? 'Delete file';
  const sha = asString(parsed.value.sha);
  if (sha === undefined) {
    sendError(ctx, 422, 'Validation Failed: sha is required');
    return;
  }
  const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
  const result = ctx.store.deleteFile(repo, { path, message, branch, sha });
  if (isStoreError(result)) {
    sendStoreError(ctx, result);
    return;
  }
  send(ctx, 200, { commit: { sha: result.commitSha, message } });
}

function handleCreateLabel(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const name = asString(parsed.value.name);
  if (name === undefined || name.length === 0) {
    sendError(ctx, 422, 'Validation Failed: name is required');
    return;
  }
  if (!repo.labels.has(name)) repo.labels.set(name, { name, color: asString(parsed.value.color) ?? 'ededed' });
  send(ctx, 201, { name, color: repo.labels.get(name)!.color });
}

function handleListIssues(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  const key = (issue: Issue): number => (sort === 'created' ? issue.seq : issue.number);
  issues.sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
  sendPaginated(ctx, issues.map((issue) => issueView(ctx, repo, issue)), issues.length);
}

function handleCreateIssue(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const title = asString(parsed.value.title);
  if (title === undefined || title.length === 0) {
    sendError(ctx, 422, 'Validation Failed: title is required');
    return;
  }
  const labelsRaw = parsed.value.labels;
  const labels: string[] = [];
  if (Array.isArray(labelsRaw)) {
    for (const label of labelsRaw) {
      if (typeof label === 'string') labels.push(label);
      else if (label !== null && typeof label === 'object' && typeof (label as Record<string, unknown>).name === 'string') {
        labels.push((label as Record<string, unknown>).name as string);
      }
    }
  }
  const issue = ctx.store.createIssue({ repo, title, body: asString(parsed.value.body), labels });
  if (isStoreError(issue)) {
    sendStoreError(ctx, issue);
    return;
  }
  send(ctx, 201, issueView(ctx, repo, issue));
}

function handleGetIssue(ctx: RestContext, owner: string, repoName: string, number: number): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const issue = ctx.store.issueByNumber(repo, number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  send(ctx, 200, issueView(ctx, repo, issue));
}

function handlePatchIssue(ctx: RestContext, owner: string, repoName: string, number: number): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const issue = ctx.store.issueByNumber(repo, number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const state = asString(parsed.value.state);
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = asString(parsed.value.title);
  if (title !== undefined) issue.title = title;
  const body = asString(parsed.value.body);
  if (body !== undefined) issue.body = body;
  send(ctx, 200, issueView(ctx, repo, issue));
}

function handleCreateComment(ctx: RestContext, owner: string, repoName: string, number: number): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const issue = ctx.store.issueByNumber(repo, number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = asString(parsed.value.body);
  if (body === undefined || body.length === 0) {
    sendError(ctx, 422, 'Validation Failed: body is required');
    return;
  }
  const comment = ctx.store.addComment(repo, issue, body);
  send(ctx, 201, { id: comment.id, body: comment.body, created_at: trialNowIso() });
}

function handleListComments(ctx: RestContext, owner: string, repoName: string, number: number): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const issue = ctx.store.issueByNumber(repo, number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const comments = issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: trialNowIso() }));
  send(ctx, 200, comments);
}

function handleListPulls(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  const pulls = [...repo.pulls].filter((pull) => state === 'all' || pull.state === state);
  pulls.sort((a, b) => b.number - a.number);
  sendPaginated(ctx, pulls.map((pull) => pullView(ctx, repo, pull)), pulls.length);
}

function handleCreatePull(ctx: RestContext, owner: string, repoName: string): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const title = asString(parsed.value.title);
  const head = asString(parsed.value.head);
  const base = asString(parsed.value.base);
  if (title === undefined || head === undefined || base === undefined) {
    sendError(ctx, 422, 'Validation Failed: title, head and base are required');
    return;
  }
  const result = ctx.store.createPull({ repo, title, body: asString(parsed.value.body), head, base });
  if (isStoreError(result)) {
    sendStoreError(ctx, result);
    return;
  }
  send(ctx, 201, pullView(ctx, repo, result));
}

function handleGetPull(ctx: RestContext, owner: string, repoName: string, number: number): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const pull = ctx.store.pullByNumber(repo, number);
  if (pull === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  send(ctx, 200, pullView(ctx, repo, pull));
}

function handlePullFiles(ctx: RestContext, owner: string, repoName: string, number: number): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const pull = ctx.store.pullByNumber(repo, number);
  if (pull === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const files = ctx.store.pullFiles(repo, pull);
  send(ctx, 200, files);
}

function handleMergePull(ctx: RestContext, owner: string, repoName: string, number: number): void {
  const repo = resolveRepo(ctx, owner, repoName);
  if (repo === null) return;
  const pull = ctx.store.pullByNumber(repo, number);
  if (pull === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const parsed = parseBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const result = ctx.store.mergePull(repo, pull);
  if (isStoreError(result)) {
    sendStoreError(ctx, result);
    return;
  }
  send(ctx, 200, { merged: true, sha: result.sha, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
}

// -------------------------------------------------------------------------------------------
// router
// -------------------------------------------------------------------------------------------

function isNumberSegment(segment: string | undefined): segment is string {
  return segment !== undefined && /^[0-9]+$/.test(segment);
}

/**
 * Route one /api/v3 request. Returns true when the route belongs to REST
 * (even when it ends in a 404/401), false when the path is not REST at all.
 */
export function handleRest(ctx: RestContext): boolean {
  const segments = ctx.segments;
  const method = ctx.req.method ?? 'GET';
  if (segments.length === 0) return false;
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);

  // The token gate applies to every /api/v3 route, including root and meta.
  if (!ctx.store.checkToken(ctx.req.headers.authorization)) {
    sendError(ctx, 401, 'Requires authentication');
    return true;
  }

  if (method === 'GET' && rest.length === 0) {
    handleRoot(ctx);
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    handleMeta(ctx);
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    handleGetUser(ctx);
    return true;
  }
  if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    handleListUserRepos(ctx);
    return true;
  }
  if (method === 'POST' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    handleCreateUserRepo(ctx);
    return true;
  }
  if (rest.length >= 3 && rest[0] === 'repos') {
    const [, owner, repoName] = rest as [string, string, string];
    const tail = rest.slice(3);
    if (method === 'GET' && tail.length === 0) {
      handleGetRepo(ctx, owner, repoName);
      return true;
    }
    if (method === 'PATCH' && tail.length === 0) {
      handlePatchRepo(ctx, owner, repoName);
      return true;
    }
    if (method === 'DELETE' && tail.length === 0) {
      handleDeleteRepo(ctx, owner, repoName);
      return true;
    }
    if (method === 'GET' && tail.length === 1 && tail[0] === 'branches') {
      handleListBranches(ctx, owner, repoName);
      return true;
    }
    if (method === 'GET' && tail.length === 2 && tail[0] === 'branches') {
      handleGetBranch(ctx, owner, repoName, tail[1]!);
      return true;
    }
    if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
      handleListCommits(ctx, owner, repoName);
      return true;
    }
    if (method === 'GET' && tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
      handleGetRef(ctx, owner, repoName, `refs/${tail.slice(2).join('/')}`);
      return true;
    }
    if (method === 'POST' && tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      handleCreateRef(ctx, owner, repoName);
      return true;
    }
    if (method === 'GET' && tail.length >= 2 && tail[0] === 'contents') {
      handleContentsGet(ctx, owner, repoName, tail.slice(1).join('/'));
      return true;
    }
    if (method === 'PUT' && tail.length >= 2 && tail[0] === 'contents') {
      handleContentsPut(ctx, owner, repoName, tail.slice(1).join('/'));
      return true;
    }
    if (method === 'DELETE' && tail.length >= 2 && tail[0] === 'contents') {
      handleContentsDelete(ctx, owner, repoName, tail.slice(1).join('/'));
      return true;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'labels') {
      handleCreateLabel(ctx, owner, repoName);
      return true;
    }
    if (method === 'GET' && tail.length === 1 && tail[0] === 'issues') {
      handleListIssues(ctx, owner, repoName);
      return true;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'issues') {
      handleCreateIssue(ctx, owner, repoName);
      return true;
    }
    if (method === 'GET' && tail.length === 2 && tail[0] === 'issues' && isNumberSegment(tail[1])) {
      handleGetIssue(ctx, owner, repoName, Number(tail[1]));
      return true;
    }
    if (method === 'PATCH' && tail.length === 2 && tail[0] === 'issues' && isNumberSegment(tail[1])) {
      handlePatchIssue(ctx, owner, repoName, Number(tail[1]));
      return true;
    }
    if (method === 'POST' && tail.length === 3 && tail[0] === 'issues' && isNumberSegment(tail[1]) && tail[2] === 'comments') {
      handleCreateComment(ctx, owner, repoName, Number(tail[1]));
      return true;
    }
    if (method === 'GET' && tail.length === 3 && tail[0] === 'issues' && isNumberSegment(tail[1]) && tail[2] === 'comments') {
      handleListComments(ctx, owner, repoName, Number(tail[1]));
      return true;
    }
    if (method === 'GET' && tail.length === 1 && tail[0] === 'pulls') {
      handleListPulls(ctx, owner, repoName);
      return true;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'pulls') {
      handleCreatePull(ctx, owner, repoName);
      return true;
    }
    if (method === 'GET' && tail.length === 2 && tail[0] === 'pulls' && isNumberSegment(tail[1])) {
      handleGetPull(ctx, owner, repoName, Number(tail[1]));
      return true;
    }
    if (method === 'GET' && tail.length === 3 && tail[0] === 'pulls' && isNumberSegment(tail[1]) && tail[2] === 'files') {
      handlePullFiles(ctx, owner, repoName, Number(tail[1]));
      return true;
    }
    if (method === 'PUT' && tail.length === 3 && tail[0] === 'pulls' && isNumberSegment(tail[1]) && tail[2] === 'merge') {
      handleMergePull(ctx, owner, repoName, Number(tail[1]));
      return true;
    }
  }
  // A matched /api/v3 prefix with no known route is a JSON 404, never HTML.
  sendError(ctx, 404, 'Not Found');
  return true;
}
