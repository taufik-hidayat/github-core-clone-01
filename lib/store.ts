// The in-memory forge: repositories, refs, objects, issues, pull requests,
// labels and comments, plus the core operations every surface shares
// (REST, GraphQL, MCP and git smart HTTP all read and write this one store).
// Deterministic: ids and timestamps derive from the request sequence and
// MAKEFUN_TRIAL_NOW, never from the wall clock or Math.random.

import {
  buildCommit,
  buildTree,
  collectReachable,
  findTreeDir,
  findTreePath,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type TreeEntry,
} from './git-objects.ts';
import { trialNowIso, trialNowSec, shopToken } from './determinism.ts';

export const FORGE_IDENTITY = 'Forge <forge@localhost>';
export const DEFAULT_BRANCH = 'main';
export const FORGE_VERSION = '1.0.0';

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  databaseId: number;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number;
  nextCommentId: number;
}

/** An operation's failure, carried as data so adapters can map it to a status. */
export interface StoreError {
  status: number;
  message: string;
}

function err(status: number, message: string): StoreError {
  return { status, message };
}

export function isStoreError(value: unknown): value is StoreError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoreError).status === 'number' &&
    typeof (value as StoreError).message === 'string'
  );
}

interface DirNode {
  files: Map<string, { oid: string; mode: string }>;
  dirs: Map<string, DirNode>;
}

function emptyDir(): DirNode {
  return { files: new Map(), dirs: new Map() };
}

export class Store {
  /** The login the bearer token names; learned from the first owner-bearing request. */
  viewerLogin: string | null = null;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextRepoSeq = 1;

  // -----------------------------------------------------------------------------------------
  // identity and ids
  // -----------------------------------------------------------------------------------------

  /**
   * The owner question: the first owner-bearing request names the viewer and
   * binds every repository to it; any other owner is foreign (404, never 403).
   */
  checkOwner(owner: string): boolean {
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      return true;
    }
    return this.viewerLogin === owner;
  }

  /** Whether the Authorization header carries this trial's shop token. */
  checkToken(authorization: string | undefined): boolean {
    return authorization === `Bearer ${shopToken()}`;
  }

  /** An opaque, stable Relay-style global id: base64url of `Kind:part:part`. */
  globalId(kind: string, ...parts: (string | number)[]): string {
    return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
  }

  /** Decode a global id, or null when it is not one of ours. */
  decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const [kind, ...parts] = text.split(':');
      if (kind === undefined || kind === '' || parts.length === 0) return null;
      if (!/^[A-Za-z]+$/.test(kind)) return null;
      return { kind, parts };
    } catch {
      return null;
    }
  }

  repoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  repoByDatabaseId(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.databaseId === id) return repo;
    return undefined;
  }

  repoByGlobalId(id: string): Repo | undefined {
    const decoded = this.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Repository' || decoded.parts.length !== 1) return undefined;
    const dbId = Number(decoded.parts[0]);
    if (!Number.isInteger(dbId)) return undefined;
    return this.repoByDatabaseId(dbId);
  }

  // -----------------------------------------------------------------------------------------
  // object store helpers
  // -----------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Build (and store) the tree for a flat path -> blob map; returns the root tree oid. */
  buildTreeFromPaths(repo: Repo, paths: Map<string, { oid: string; mode: string }>): string {
    const root = emptyDir();
    for (const [path, entry] of paths) {
      const segments = path.split('/').filter((segment) => segment !== '');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        let child = node.dirs.get(name);
        if (child === undefined) {
          child = emptyDir();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object on the forge identity at the trial's now; returns its oid. */
  createCommit(repo: Repo, fields: { tree: string; parents: readonly string[]; message: string }): string {
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents,
      message: fields.message,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: trialNowSec(),
    });
    return this.putObject(repo, 'commit', data);
  }

  // -----------------------------------------------------------------------------------------
  // repositories
  // -----------------------------------------------------------------------------------------

  createRepo(input: { name: string; description?: string; private?: boolean }): Repo | StoreError {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '' || name.length > 100 || !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(name)) {
      return err(422, 'name is invalid');
    }
    if (this.repos.has(name)) return err(422, `Repository ${name} already exists`);
    const repo: Repo = {
      name,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      databaseId: this.nextRepoId++,
      seq: this.nextRepoSeq++,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === '') return null;
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      return object !== undefined && object.type === 'commit' ? ref : null;
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const oid = repo.refs.get(full);
    if (oid !== undefined) return oid;
    return null;
  }

  /** The ref a branch name names, as a full ref. */
  branchRef(branch: string): string {
    return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  }

  /** All branch names, sorted. */
  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Commits reachable from `tip`, newest first (parents after their children). */
  commitList(repo: Repo, tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      order.push(oid);
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) queue.push(parent);
    }
    return order;
  }

  /** The merge-base of two commits: the first common ancestor walking from `a`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsB = new Set<string>();
    const queueB: string[] = [b];
    while (queueB.length > 0) {
      const oid = queueB.shift()!;
      if (ancestorsB.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      ancestorsB.add(oid);
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    const queueA: string[] = [a];
    const seenA = new Set<string>();
    while (queueA.length > 0) {
      const oid = queueA.shift()!;
      if (seenA.has(oid)) continue;
      seenA.add(oid);
      if (ancestorsB.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    return null;
  }

  // -----------------------------------------------------------------------------------------
  // contents
  // -----------------------------------------------------------------------------------------

  /** The commit a branch (or ref) points at, with its tree, or null. */
  commitAt(repo: Repo, ref: string): { oid: string; tree: string } | null {
    const oid = this.resolveRef(repo, ref);
    if (oid === null) return null;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return { oid, tree: parseCommit(object.data).tree };
  }

  /** Create or update one file through the contents API. */
  commitFile(
    repo: Repo,
    input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { commitSha: string; contentSha: string; created: boolean } | StoreError {
    const segments = input.path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
      return err(422, 'path is invalid');
    }
    const cleanPath = segments.join('/');
    const branch = input.branch ?? repo.defaultBranch;
    const ref = this.branchRef(branch);
    const blobSha = this.putObject(repo, 'blob', input.content);
    const existingRef = repo.refs.get(ref);
    if (existingRef === undefined) {
      // An unborn repository (or a first commit on a new branch name): root commit.
      if (repo.refs.size > 0) return err(404, `branch ${branch} does not exist`);
      const paths = new Map<string, { oid: string; mode: string }>();
      paths.set(cleanPath, { oid: blobSha, mode: '100644' });
      const tree = this.buildTreeFromPaths(repo, paths);
      const commitSha = this.createCommit(repo, { tree, parents: [], message: input.message });
      repo.refs.set(ref, commitSha);
      return { commitSha, contentSha: blobSha, created: true };
    }
    const tip = this.commitAt(repo, ref);
    if (tip === null) return err(404, `branch ${branch} does not exist`);
    const lookup = this.lookup(repo);
    const current = findTreePath(lookup, tip.tree, segments);
    if (current !== null && input.sha === undefined) return err(422, 'sha was not supplied');
    if (current !== null && input.sha !== undefined && input.sha.toLowerCase() !== current.toLowerCase()) {
      return err(409, 'sha does not match the current blob');
    }
    if (current === null && input.sha !== undefined) return err(409, 'sha does not match the current blob');
    const paths = flattenTree(lookup, tip.tree);
    paths.set(cleanPath, { oid: blobSha, mode: '100644' });
    const tree = this.buildTreeFromPaths(repo, paths);
    const commitSha = this.createCommit(repo, { tree, parents: [tip.oid], message: input.message });
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha: blobSha, created: current === null };
  }

  /** Delete one file through the contents API. */
  deleteFile(
    repo: Repo,
    input: { path: string; message: string; branch?: string; sha?: string },
  ): { commitSha: string } | StoreError {
    const segments = input.path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) return err(422, 'path is invalid');
    const cleanPath = segments.join('/');
    const branch = input.branch ?? repo.defaultBranch;
    const ref = this.branchRef(branch);
    const tip = this.commitAt(repo, ref);
    if (tip === null) return err(404, `branch ${branch} does not exist`);
    const lookup = this.lookup(repo);
    const current = findTreePath(lookup, tip.tree, segments);
    if (current === null) return err(404, `file ${cleanPath} does not exist`);
    if (input.sha !== undefined && input.sha.toLowerCase() !== current.toLowerCase()) {
      return err(409, 'sha does not match the current blob');
    }
    const paths = flattenTree(lookup, tip.tree);
    paths.delete(cleanPath);
    const tree = this.buildTreeFromPaths(repo, paths);
    const commitSha = this.createCommit(repo, { tree, parents: [tip.oid], message: input.message });
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  /** Read one path at a ref: a file, a directory, or nothing. */
  readPath(
    repo: Repo,
    path: string,
    ref?: string,
  ):
    | { kind: 'file'; sha: string; size: number; content: Buffer }
    | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] }
    | null {
    const tip = this.commitAt(repo, ref ?? repo.defaultBranch);
    if (tip === null) return null;
    const lookup = this.lookup(repo);
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) {
      const entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] = [];
      for (const entry of parseTree(lookup(tip.tree)!.data)) {
        entries.push({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
        });
      }
      return { kind: 'dir', entries };
    }
    const blobOid = findTreePath(lookup, tip.tree, segments);
    if (blobOid !== null) {
      const blob = repo.objects.get(blobOid);
      if (blob === undefined) return null;
      return { kind: 'file', sha: blobOid, size: blob.data.length, content: blob.data };
    }
    const dirOid = findTreeDir(lookup, tip.tree, segments);
    if (dirOid === null) return null;
    const dirObject = repo.objects.get(dirOid);
    if (dirObject === undefined) return null;
    const base = segments.join('/');
    const entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] = [];
    for (const entry of parseTree(dirObject.data)) {
      entries.push({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: `${base}/${entry.name}`,
        sha: entry.oid,
      });
    }
    return { kind: 'dir', entries };
  }

  // -----------------------------------------------------------------------------------------
  // issues and comments
  // -----------------------------------------------------------------------------------------

  createIssue(input: { repo: Repo; title: string; body?: string; labels?: string[] }): Issue | StoreError {
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') return err(422, 'title is required');
    const labels: string[] = [];
    for (const name of input.labels ?? []) {
      if (!input.repo.labels.has(name)) return err(422, `label ${name} does not exist`);
      labels.push(name);
    }
    const number = input.repo.nextNumber++;
    const issue: Issue = {
      id: this.globalId('Issue', input.repo.databaseId, number),
      number,
      title,
      body: input.body ?? '',
      state: 'open',
      labels,
      comments: [],
      seq: number,
    };
    input.repo.issues.push(issue);
    return issue;
  }

  issueByNumber(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: repo.nextCommentId++, body };
    issue.comments.push(comment);
    return comment;
  }

  // -----------------------------------------------------------------------------------------
  // pull requests
  // -----------------------------------------------------------------------------------------

  createPull(input: {
    repo: Repo;
    head: string;
    base: string;
    title: string;
    body?: string;
  }): Pull | StoreError {
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') return err(422, 'title is required');
    const headRef = this.branchRef(input.head);
    const baseRef = this.branchRef(input.base);
    const headSha = input.repo.refs.get(headRef);
    const baseSha = input.repo.refs.get(baseRef);
    if (headSha === undefined) return err(422, `head branch ${input.head} does not exist`);
    if (baseSha === undefined) return err(422, `base branch ${input.base} does not exist`);
    for (const existing of input.repo.pulls) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        return err(422, 'a pull request already exists for this head and base');
      }
    }
    const number = input.repo.nextNumber++;
    const pull: Pull = {
      id: this.globalId('PullRequest', input.repo.databaseId, number),
      number,
      title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: number,
    };
    input.repo.pulls.push(pull);
    return pull;
  }

  pullByNumber(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Whether a pull request merges cleanly (three-way, no path changed both ways). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const headTip = repo.refs.get(this.branchRef(pull.headRef));
    const baseTip = repo.refs.get(this.branchRef(pull.baseRef));
    if (headTip === undefined || baseTip === undefined) return false;
    if (headTip === baseTip) return true;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return false;
    return this.threeWayMerge(repo, base, headTip, baseTip).conflict === false;
  }

  /**
   * The three-way merge of head onto base with `mergeBase` as the common
   * ancestor. Returns the merged path map, or a conflict flag.
   */
  threeWayMerge(
    repo: Repo,
    mergeBaseOid: string,
    headOid: string,
    baseOid: string,
  ): { conflict: boolean; paths: Map<string, { oid: string; mode: string }> } {
    const lookup = this.lookup(repo);
    const baseCommit = repo.objects.get(mergeBaseOid);
    const headCommit = repo.objects.get(headOid);
    const baseTipCommit = repo.objects.get(baseOid);
    if (baseCommit === undefined || headCommit === undefined || baseTipCommit === undefined) {
      return { conflict: true, paths: new Map() };
    }
    const basePaths = flattenTree(lookup, parseCommit(baseCommit.data).tree);
    const headPaths = flattenTree(lookup, parseCommit(headCommit.data).tree);
    const tipPaths = flattenTree(lookup, parseCommit(baseTipCommit.data).tree);
    const paths = new Map<string, { oid: string; mode: string }>();
    let conflict = false;
    const all = new Set<string>([...basePaths.keys(), ...headPaths.keys(), ...tipPaths.keys()]);
    for (const path of all) {
      const b = basePaths.get(path);
      const h = headPaths.get(path);
      const t = tipPaths.get(path);
      const same = (a: { oid: string } | undefined, c: { oid: string } | undefined): boolean =>
        (a === undefined && c === undefined) || (a !== undefined && c !== undefined && a.oid === c.oid);
      if (same(h, t)) {
        if (h !== undefined) paths.set(path, h);
      } else if (same(b, t)) {
        if (h !== undefined) paths.set(path, h);
      } else if (same(b, h)) {
        if (t !== undefined) paths.set(path, t);
      } else {
        conflict = true;
      }
    }
    return { conflict, paths };
  }

  /** The changed files of a pull request: merge-base tree vs head tree. */
  pullFiles(
    repo: Repo,
    pull: Pull,
  ): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = repo.refs.get(this.branchRef(pull.headRef)) ?? pull.headSha;
    const baseTip = repo.refs.get(this.branchRef(pull.baseRef)) ?? pull.baseSha;
    const base = this.mergeBase(repo, headTip, baseTip);
    const lookup = this.lookup(repo);
    const basePaths =
      base === null
        ? new Map<string, { oid: string; mode: string }>()
        : flattenTree(lookup, parseCommit(repo.objects.get(base)!.data).tree);
    const headCommit = repo.objects.get(headTip);
    if (headCommit === undefined) return [];
    const headPaths = flattenTree(lookup, parseCommit(headCommit.data).tree);
    const files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const all = new Set<string>([...basePaths.keys(), ...headPaths.keys()]);
    for (const path of [...all].sort()) {
      const b = basePaths.get(path);
      const h = headPaths.get(path);
      if (b === undefined && h === undefined) continue;
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      let status = 'modified';
      let additions = 0;
      let deletions = 0;
      if (b === undefined) {
        status = 'added';
        const text = repo.objects.get(h!.oid)?.data.toString('utf8') ?? '';
        additions = countLines(text);
      } else if (h === undefined) {
        status = 'removed';
        const text = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        deletions = countLines(text);
      } else {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const diff = lineDiff(oldText, newText);
        additions = diff.additions;
        deletions = diff.deletions;
      }
      files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return files;
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | StoreError {
    if (pull.state !== 'open') return err(405, 'pull request is already closed');
    const headTip = repo.refs.get(this.branchRef(pull.headRef));
    const baseTip = repo.refs.get(this.branchRef(pull.baseRef));
    if (headTip === undefined || baseTip === undefined) return err(422, 'a branch of this pull request no longer exists');
    if (headTip === baseTip) {
      // Nothing to merge: mark it merged without a new commit.
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = trialNowIso();
      pull.mergeCommitSha = baseTip;
      return { sha: baseTip };
    }
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return err(422, 'the pull request has no merge base');
    const merged = this.threeWayMerge(repo, base, headTip, baseTip);
    if (merged.conflict) return err(405, 'this pull request has conflicts that must be resolved');
    const tree = this.buildTreeFromPaths(repo, merged.paths);
    const sha = this.createCommit(repo, {
      tree,
      parents: [baseTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
    });
    repo.refs.set(this.branchRef(pull.baseRef), sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialNowIso();
    pull.mergeCommitSha = sha;
    return { sha };
  }

  // -----------------------------------------------------------------------------------------
  // git refs
  // -----------------------------------------------------------------------------------------

  /** Create a branch ref at a commit. */
  createRef(repo: Repo, ref: string, sha: string): StoreError | null {
    if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
    if (repo.refs.has(ref)) return err(422, `ref ${ref} already exists`);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return err(422, 'sha is not a commit this repository holds');
    repo.refs.set(ref, sha);
    return null;
  }

  /** Apply one receive-pack command; returns the report line for it. */
  applyPushCommand(
    repo: Repo,
    command: { oldOid: string; newOid: string; ref: string },
  ): { ok: boolean; reason: string } {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) return { ok: false, reason: 'ref does not exist' };
      if (current.toLowerCase() !== command.oldOid.toLowerCase() && command.oldOid !== ZERO_OID) {
        return { ok: false, reason: 'old oid does not match' };
      }
      repo.refs.delete(command.ref);
      return { ok: true, reason: '' };
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) return { ok: false, reason: 'object not found' };
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) return { ok: false, reason: 'ref already exists' };
      repo.refs.set(command.ref, command.newOid);
      return { ok: true, reason: '' };
    }
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (current.toLowerCase() !== command.oldOid.toLowerCase()) {
      return { ok: false, reason: 'old oid does not match' };
    }
    if (command.ref.startsWith('refs/heads/')) {
      // Fast-forward only: the new tip must descend from the old one.
      // The common case is a direct child (the new commit's parent is the
      // old tip); only fall back to the full ancestry walk when it is not.
      if (command.newOid !== command.oldOid) {
        const target = repo.objects.get(command.newOid);
        const direct =
          target !== undefined &&
          target.type === 'commit' &&
          parseCommit(target.data).parents.some((parent) => parent.toLowerCase() === command.oldOid.toLowerCase());
        if (!direct && !isAncestor(command.oldOid, command.newOid, this.lookup(repo))) {
          return { ok: false, reason: 'non-fast-forward' };
        }
      }
    }
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }

  /** The objects reachable from a ref's tip, for the push's completeness check. */
  reachableFrom(repo: Repo, oid: string): Set<string> {
    return collectReachable([oid], this.lookup(repo));
  }
}

/** Lines in a text: trailing newline does not add an empty line. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** LCS line diff counts: added lines vs removed lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0) return { additions: n, deletions: 0 };
  if (n === 0) return { additions: 0, deletions: m };
  // LCS over lines; files here are small (the suite's blobs are a few KiB).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: n - common, deletions: m - common };
}
