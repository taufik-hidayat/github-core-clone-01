// GraphQL at /api/graphql: a small recursive-descent parser and an executor
// over the same Store the REST and git layers use. It covers exactly the
// documents the suite sends (queries, mutations, inline fragments, batched
// bodies, introspection) plus __typename. Unknown fields answer HTTP 200 with
// an errors array naming the field, as GitHub does.

import { trialNowIso } from './determinism.ts';
import { isStoreError, type Issue, type Pull, type Repo, type Store } from './store.ts';

/** A stable positive integer for a string (FNV-1a). */
function stableId(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i++;
      continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '"') {
      let value = '';
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += source[i];
          i++;
        }
      }
      i++;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (char === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      i++;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j]!)) j++;
      const text = source.slice(i, j);
      tokens.push(text.includes('.') ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// AST + parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string;
  arguments: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: { name: string; type: string; defaultValue: ValueNode | null }[];
  selectionSet: SelectionNode[];
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, saw ${token.kind} ${'value' in token ? token.value : ''}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = token.value;
      this.next();
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value as string;
    }
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, type, defaultValue });
      }
      this.expectPunct(')');
    }
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selectionSet };
  }

  private parseType(): string {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let type = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        type += '!';
      }
      return type;
    }
    const name = this.expectName();
    let type = name;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      let typeCondition: string | null = null;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const selectionSet = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition, selectionSet };
    }
    const first = this.expectName();
    let name = first;
    let alias = first;
    const next = this.peek();
    if (next.kind === 'punct' && next.value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selectionSet: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, arguments: args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

// -------------------------------------------------------------------------------------------
// schema: the field list of every type the executor knows
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  User: ['login', 'id'],
  BranchRef: ['name', 'target'],
  Commit: ['oid', 'message', 'abbreviatedOid'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  FileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileEdge: ['node', 'cursor'],
  FileChange: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  __Schema: ['queryType', 'mutationType'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

interface ExecutorContext {
  store: Store;
  variables: Record<string, unknown>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined | null): number {
  if (cursor === undefined || cursor === null) return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : -1;
  } catch {
    return -1;
  }
}

interface ConnectionItem {
  node: unknown;
  nodeType: string;
}

/** Slice a full ordered list into a connection (first/after only, as the suite uses). */
function connection(
  items: ConnectionItem[],
  args: Record<string, unknown>,
): { type: string; items: ConnectionItem[]; start: number; pageInfo: Record<string, unknown>; totalCount: number } {
  const after = decodeCursor(typeof args.after === 'string' ? args.after : null);
  const start = after + 1;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const slice = items.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  return {
    type: items.length > 0 ? items[0]!.nodeType : 'Issue',
    items: slice,
    start,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(start) : null,
      endCursor: slice.length > 0 ? encodeCursor(endIndex) : null,
    },
    totalCount: items.length,
  };
}

type Resolved =
  | { kind: 'scalar'; value: unknown }
  | { kind: 'object'; type: string; value: unknown }
  | { kind: 'connection'; connectionType: string; value: ReturnType<typeof connection> }
  | { kind: 'null' };

function nullResolved(): Resolved {
  return { kind: 'null' };
}

/** Validate the whole document against the schema before executing anything. */
function validateOperation(operation: OperationNode): { field: string; type: string } | null {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const check = (selections: SelectionNode[], parentType: string, rootField: string): { field: string; type: string } | null => {
    for (const selection of selections) {
      if (selection.kind === 'inlineFragment') {
        const type = selection.typeCondition ?? parentType;
        const found = check(selection.selectionSet, type, rootField);
        if (found !== null) return found;
        continue;
      }
      const name = selection.name;
      if (name === '__typename') continue;
      const fields = TYPE_FIELDS[parentType];
      if (fields === undefined || !fields.includes(name)) return { field: name, type: parentType };
      const childType = childTypeOf(parentType, name);
      if (childType !== null && selection.selectionSet.length > 0) {
        const found = check(selection.selectionSet, childType, rootField);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return check(operation.selectionSet, rootType, operation.selectionSet[0]?.kind === 'field' ? operation.selectionSet[0].name : '');
}

/** The GraphQL type of a field's object value (null when scalar or context-dependent). */
function childTypeOf(parentType: string, field: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'Viewer', repository: 'Repository', node: 'Repository', __type: '__Type', __schema: '__Schema' },
    Mutation: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
    Repository: {
      owner: 'User',
      defaultBranchRef: 'BranchRef',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection',
      pullRequest: 'PullRequest',
    },
    BranchRef: { target: 'Commit' },
    IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    IssueEdge: { node: 'Issue' },
    PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
    PullRequestEdge: { node: 'PullRequest' },
    PullRequest: { files: 'FileConnection' },
    FileConnection: { nodes: 'FileChange', edges: 'FileEdge', pageInfo: 'PageInfo' },
    FileEdge: { node: 'FileChange' },
    IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo' },
    IssueCommentEdge: { node: 'IssueComment' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'CommentEdge' },
    CommentEdge: { node: 'IssueComment' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
    __Schema: { queryType: '__Type', mutationType: '__Type' },
  };
  return map[parentType]?.[field] ?? null;
}

class Executor {
  private readonly ctx: ExecutorContext;

  constructor(ctx: ExecutorContext) {
    this.ctx = ctx;
  }

  executeOperation(operation: OperationNode): Record<string, unknown> {
    const invalid = validateOperation(operation);
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const rootField = operation.selectionSet[0]?.kind === 'field' ? operation.selectionSet[0].name : '';
    if (invalid !== null) {
      return {
        data: { [rootField]: null },
        errors: [{ message: `Cannot query field "${invalid.field}" on type "${invalid.type}".` }],
      };
    }
    const variables: Record<string, unknown> = {};
    for (const definition of operation.variableDefinitions) {
      variables[definition.name] =
        this.ctx.variables[definition.name] ??
        (definition.defaultValue !== null ? valueOf(definition.defaultValue, this.ctx.variables) : null);
    }
    const data: Record<string, unknown> = {};
    for (const selection of operation.selectionSet) {
      if (selection.kind === 'inlineFragment') continue;
      const resolved = this.resolveRoot(selection, variables);
      data[selection.alias] = this.materialize(selection, resolved, variables, rootType);
    }
    return { data };
  }

  private materialize(selection: FieldNode, resolved: Resolved, variables: Record<string, unknown>, parentType: string): unknown {
    if (resolved.kind === 'null') return null;
    if (resolved.kind === 'scalar') return resolved.value;
    if (resolved.kind === 'connection') {
      const value: Record<string, unknown> = {};
      for (const child of selection.selectionSet) {
        if (child.kind === 'inlineFragment') continue;
        if (child.name === 'nodes') {
          value[child.alias] = resolved.value.items.map((item) => this.executeFields(item.node as Record<string, unknown>, item.nodeType, child.selectionSet, variables));
        } else if (child.name === 'edges') {
          value[child.alias] = resolved.value.items.map((item, index) => {
            const out: Record<string, unknown> = {};
            for (const edgeChild of child.selectionSet) {
              if (edgeChild.kind === 'inlineFragment') continue;
              if (edgeChild.name === 'node') {
                out[edgeChild.alias] = this.executeFields(item.node as Record<string, unknown>, item.nodeType, edgeChild.selectionSet, variables);
              } else if (edgeChild.name === 'cursor') {
                out[edgeChild.alias] = encodeCursor(resolved.value.start + index);
              }
            }
            return out;
          });
        } else if (child.name === 'pageInfo') {
          const pageInfo = resolved.value.pageInfo;
          const out: Record<string, unknown> = {};
          for (const pageChild of child.selectionSet) {
            if (pageChild.kind === 'inlineFragment') continue;
            out[pageChild.alias] = pageInfo[pageChild.name] ?? null;
          }
          value[child.alias] = out;
        } else if (child.name === 'totalCount') {
          value[child.alias] = resolved.value.totalCount;
        }
      }
      return value;
    }
    return this.executeFields(resolved.value as Record<string, unknown>, resolved.type, selection.selectionSet, variables);
  }

  private executeFields(value: Record<string, unknown>, type: string, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition === null || selection.typeCondition === type) {
          Object.assign(out, this.executeFields(value, type, selection.selectionSet, variables));
        }
        continue;
      }
      if (selection.name === '__typename') {
        out[selection.alias] = type;
        continue;
      }
      const resolved = this.resolveField(type, value, selection, variables);
      out[selection.alias] = this.materialize(selection, resolved, variables, type);
    }
    return out;
  }

  private resolveRoot(field: FieldNode, variables: Record<string, unknown>): Resolved {
    const args = argsOf(field, variables);
    if (field.name === 'viewer') {
      const viewer = this.ctx.store.viewerLogin;
      if (viewer === null) return nullResolved();
      return { kind: 'object', type: 'Viewer', value: { login: viewer, id: stableId(viewer) } };
    }
    if (field.name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      if (!this.ctx.store.checkOwner(owner)) return nullResolved();
      const repo = this.ctx.store.repoByName(name);
      if (repo === undefined) return nullResolved();
      return { kind: 'object', type: 'Repository', value: repo as unknown as Record<string, unknown> };
    }
    if (field.name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const resolved = this.resolveGlobalId(id);
      return resolved ?? nullResolved();
    }
    if (field.name === '__type') {
      const name = typeof args.name === 'string' ? args.name : '';
      return { kind: 'object', type: '__Type', value: this.introspectionType(name) };
    }
    if (field.name === '__schema') {
      return { kind: 'object', type: '__Schema', value: {} };
    }
    if (field.name === 'createIssue') return this.mutationCreateIssue(args);
    if (field.name === 'closeIssue') return this.mutationCloseIssue(args);
    if (field.name === 'createPullRequest') return this.mutationCreatePullRequest(args);
    if (field.name === 'mergePullRequest') return this.mutationMergePullRequest(args);
    if (field.name === 'addComment') return this.mutationAddComment(args);
    return nullResolved();
  }

  private resolveGlobalId(id: string): Resolved | null {
    let text: string;
    try {
      text = Buffer.from(id, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const parts = text.split(':');
    if (parts[0] === 'Repository' && parts.length === 2) {
      const repo = this.ctx.store.repoByDatabaseId(Number(parts[1]));
      if (repo === undefined) return null;
      return { kind: 'object', type: 'Repository', value: repo as unknown as Record<string, unknown> };
    }
    if (parts[0] === 'Issue' && parts.length === 3) {
      const repo = this.ctx.store.repoByDatabaseId(Number(parts[1]));
      const issue = repo?.issues.find((candidate) => candidate.number === Number(parts[2]));
      if (issue === undefined) return null;
      return { kind: 'object', type: 'Issue', value: issue as unknown as Record<string, unknown> };
    }
    if (parts[0] === 'PullRequest' && parts.length === 3) {
      const repo = this.ctx.store.repoByDatabaseId(Number(parts[1]));
      const pull = repo?.pulls.find((candidate) => candidate.number === Number(parts[2]));
      if (pull === undefined) return null;
      return { kind: 'object', type: 'PullRequest', value: pull as unknown as Record<string, unknown> };
    }
    return null;
  }

  private introspectionType(name: string): Record<string, unknown> {
    const fields = TYPE_FIELDS[name] ?? [];
    return {
      name,
      kind: ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT',
      fields: fields.map((field) => ({ name: field })),
      enumValues: (ENUM_VALUES[name] ?? []).map((value) => ({ name: value })),
    };
  }

  private resolveField(type: string, value: Record<string, unknown>, field: FieldNode, variables: Record<string, unknown>): Resolved {
    const args = argsOf(field, variables);
    if (type === '__Type') {
      if (field.name === 'fields') return { kind: 'scalar', value: (value.fields as { name: string }[]).map((entry) => ({ name: entry.name })) };
      if (field.name === 'enumValues') return { kind: 'scalar', value: value.enumValues };
      if (field.name === 'kind') return { kind: 'scalar', value: value.kind };
      if (field.name === 'name') return { kind: 'scalar', value: value.name };
    }
    if (type === '__Field' || type === '__EnumValue') {
      if (field.name === 'name') return { kind: 'scalar', value: value.name };
    }
    if (type === '__Schema') {
      if (field.name === 'queryType') return { kind: 'object', type: '__Type', value: this.introspectionType('Query') };
      if (field.name === 'mutationType') return { kind: 'object', type: '__Type', value: this.introspectionType('Mutation') };
    }
    if (type === 'Viewer' || type === 'User') {
      if (field.name === 'login') return { kind: 'scalar', value: value.login ?? null };
      if (field.name === 'id') return { kind: 'scalar', value: value.id ?? null };
    }
    if (type === 'Repository') return this.resolveRepository(value as unknown as Repo, field, args);
    if (type === 'BranchRef') {
      if (field.name === 'name') return { kind: 'scalar', value: value.name ?? null };
      if (field.name === 'target') {
        const target = value.target as { oid: string } | null;
        if (target === null) return nullResolved();
        return { kind: 'object', type: 'Commit', value: { oid: target.oid } };
      }
    }
    if (type === 'Commit') {
      if (field.name === 'oid') return { kind: 'scalar', value: value.oid ?? null };
      if (field.name === 'abbreviatedOid') return { kind: 'scalar', value: typeof value.oid === 'string' ? value.oid.slice(0, 7) : null };
      if (field.name === 'message') return { kind: 'scalar', value: '' };
    }
    if (type === 'Issue') return this.resolveIssue(value as unknown as Issue, field);
    if (type === 'PullRequest') return this.resolvePull(value as unknown as Pull, field, args);
    if (type === 'FileChange') {
      if (field.name === 'path') return { kind: 'scalar', value: value.path ?? null };
      if (field.name === 'additions') return { kind: 'scalar', value: value.additions ?? 0 };
      if (field.name === 'deletions') return { kind: 'scalar', value: value.deletions ?? 0 };
      if (field.name === 'changeType') return { kind: 'scalar', value: value.changeType ?? null };
    }
    if (type === 'IssueComment') {
      if (field.name === 'id') return { kind: 'scalar', value: value.id === undefined || value.id === null ? null : String(value.id) };
      if (field.name === 'body') return { kind: 'scalar', value: value.body ?? null };
    }
    if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
      if (field.name === 'issue') {
        const issue = value.issue as Issue | null;
        if (issue === null || issue === undefined) return nullResolved();
        return { kind: 'object', type: 'Issue', value: issue as unknown as Record<string, unknown> };
      }
    }
    if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
      if (field.name === 'pullRequest') {
        const pull = value.pullRequest as Pull | null;
        if (pull === null || pull === undefined) return nullResolved();
        return { kind: 'object', type: 'PullRequest', value: pull as unknown as Record<string, unknown> };
      }
    }
    if (type === 'AddCommentPayload') {
      if (field.name === 'commentEdge') {
        return { kind: 'object', type: 'CommentEdge', value: { node: value.comment ?? null } };
      }
    }
    if (type === 'CommentEdge') {
      if (field.name === 'node') {
        const node = value.node as { id: string; body: string } | null;
        if (node === null || node === undefined) return nullResolved();
        return { kind: 'object', type: 'IssueComment', value: node as unknown as Record<string, unknown> };
      }
    }
    return nullResolved();
  }

  private resolveRepository(repo: Repo, field: FieldNode, args: Record<string, unknown>): Resolved {
    const store = this.ctx.store;
    switch (field.name) {
      case 'id':
        return { kind: 'scalar', value: store.globalId('Repository', repo.databaseId) };
      case 'databaseId':
        return { kind: 'scalar', value: repo.databaseId };
      case 'name':
        return { kind: 'scalar', value: repo.name };
      case 'nameWithOwner':
        return { kind: 'scalar', value: `${store.viewerLogin ?? ''}/${repo.name}` };
      case 'owner':
        return { kind: 'object', type: 'User', value: { login: store.viewerLogin ?? '', id: stableId(store.viewerLogin ?? '') } };
      case 'defaultBranchRef': {
        const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (sha === undefined) return nullResolved();
        return { kind: 'object', type: 'BranchRef', value: { name: repo.defaultBranch, target: { oid: sha } } };
      }
      case 'viewerPermission':
        return { kind: 'scalar', value: 'ADMIN' };
      case 'hasIssuesEnabled':
        return { kind: 'scalar', value: true };
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.find((candidate) => candidate.number === number);
        if (issue === undefined) return nullResolved();
        return { kind: 'object', type: 'Issue', value: issue as unknown as Record<string, unknown> };
      }
      case 'issues': {
        let issues = [...repo.issues];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const direction = orderBy?.direction ?? 'ASC';
        issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
        const items: ConnectionItem[] = issues.map((issue) => ({
          node: issue as unknown as Record<string, unknown>,
          nodeType: 'Issue',
        }));
        return { kind: 'connection', connectionType: 'IssueConnection', value: connection(items, args) };
      }
      case 'pullRequests': {
        const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
        const items: ConnectionItem[] = pulls.map((pull) => ({
          node: pull as unknown as Record<string, unknown>,
          nodeType: 'PullRequest',
        }));
        return { kind: 'connection', connectionType: 'PullRequestConnection', value: connection(items, args) };
      }
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (pull === undefined) return nullResolved();
        return { kind: 'object', type: 'PullRequest', value: pull as unknown as Record<string, unknown> };
      }
      default:
        return nullResolved();
    }
  }

  private resolveIssue(issue: Issue, field: FieldNode): Resolved {
    switch (field.name) {
      case 'id':
        return { kind: 'scalar', value: issue.id };
      case 'number':
        return { kind: 'scalar', value: issue.number };
      case 'title':
        return { kind: 'scalar', value: issue.title };
      case 'body':
        return { kind: 'scalar', value: issue.body };
      case 'state':
        return { kind: 'scalar', value: issue.state.toUpperCase() };
      case 'createdAt':
        return { kind: 'scalar', value: trialNowIso() };
      default:
        return nullResolved();
    }
  }

  /** The repo holding a pull request (pulls carry no repo id of their own). */
  private repoOfPull(pull: Pull): Repo | undefined {
    for (const repo of this.ctx.store.repos.values()) {
      if (repo.pulls.includes(pull)) return repo;
    }
    return undefined;
  }

  private resolvePull(pull: Pull, field: FieldNode, args: Record<string, unknown>): Resolved {
    switch (field.name) {
      case 'id':
        return { kind: 'scalar', value: pull.id };
      case 'number':
        return { kind: 'scalar', value: pull.number };
      case 'title':
        return { kind: 'scalar', value: pull.title };
      case 'body':
        return { kind: 'scalar', value: pull.body };
      case 'headRefName':
        return { kind: 'scalar', value: pull.headRef };
      case 'baseRefName':
        return { kind: 'scalar', value: pull.baseRef };
      case 'mergeable': {
        const repo = this.repoOfPull(pull);
        if (repo === undefined) return { kind: 'scalar', value: 'UNKNOWN' };
        return { kind: 'scalar', value: this.ctx.store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING' };
      }
      case 'state':
        return { kind: 'scalar', value: pull.merged ? 'MERGED' : pull.state.toUpperCase() };
      case 'merged':
        return { kind: 'scalar', value: pull.merged };
      case 'files': {
        const repo = this.repoOfPull(pull);
        if (repo === undefined) {
          return { kind: 'connection', connectionType: 'FileConnection', value: connection([], args) };
        }
        const files = this.ctx.store.pullFiles(repo, pull);
        const items: ConnectionItem[] = files.map((file) => ({
          node: {
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status.toUpperCase(),
          } as unknown as Record<string, unknown>,
          nodeType: 'FileChange',
        }));
        return { kind: 'connection', connectionType: 'FileConnection', value: connection(items, args) };
      }
      default:
        return nullResolved();
    }
  }

  // -- mutations ---------------------------------------------------------------

  private mutationCreateIssue(args: Record<string, unknown>): Resolved {
    const input = args.input as { repositoryId?: string; title?: string; body?: string } | undefined;
    if (input === undefined) return nullResolved();
    const repoId = this.decodeRepositoryId(input.repositoryId ?? '');
    const repo = repoId === null ? undefined : this.ctx.store.repoByDatabaseId(repoId);
    if (repo === undefined || input.title === undefined) return nullResolved();
    const issue = this.ctx.store.createIssue({ repo, title: input.title, body: input.body });
    if (isStoreError(issue)) return nullResolved();
    return { kind: 'object', type: 'CreateIssuePayload', value: { issue } };
  }

  private mutationCloseIssue(args: Record<string, unknown>): Resolved {
    const input = args.input as { issueId?: string } | undefined;
    if (input === undefined) return nullResolved();
    const found = this.findIssueByGlobalId(input.issueId ?? '');
    if (found === null) return nullResolved();
    found.issue.state = 'closed';
    return { kind: 'object', type: 'CloseIssuePayload', value: { issue: found.issue } };
  }

  private mutationCreatePullRequest(args: Record<string, unknown>): Resolved {
    const input = args.input as { repositoryId?: string; title?: string; body?: string; headRefName?: string; baseRefName?: string } | undefined;
    if (input === undefined) return nullResolved();
    const repoId = this.decodeRepositoryId(input.repositoryId ?? '');
    const repo = repoId === null ? undefined : this.ctx.store.repoByDatabaseId(repoId);
    if (repo === undefined || input.title === undefined || input.headRefName === undefined || input.baseRefName === undefined) {
      return nullResolved();
    }
    const result = this.ctx.store.createPull({ repo, title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName });
    if (isStoreError(result)) return nullResolved();
    return { kind: 'object', type: 'CreatePullRequestPayload', value: { pullRequest: result } };
  }

  private mutationMergePullRequest(args: Record<string, unknown>): Resolved {
    const input = args.input as { pullRequestId?: string; mergeMethod?: string } | undefined;
    if (input === undefined) return nullResolved();
    const found = this.findPullByGlobalId(input.pullRequestId ?? '');
    if (found === null) return nullResolved();
    const result = this.ctx.store.mergePull(found.repo, found.pull);
    if (isStoreError(result)) return nullResolved();
    return { kind: 'object', type: 'MergePullRequestPayload', value: { pullRequest: found.pull } };
  }

  private mutationAddComment(args: Record<string, unknown>): Resolved {
    const input = args.input as { subjectId?: string; body?: string } | undefined;
    if (input === undefined || input.body === undefined) return nullResolved();
    const found = this.findIssueByGlobalId(input.subjectId ?? '');
    if (found === null) return nullResolved();
    const comment = this.ctx.store.addComment(found.repo, found.issue, input.body);
    // GraphQL ids are strings; the REST comment id stays an integer.
    return { kind: 'object', type: 'AddCommentPayload', value: { comment: { id: String(comment.id), body: comment.body } } };
  }

  private decodeRepositoryId(globalId: string): number | null {
    try {
      const text = Buffer.from(globalId, 'base64url').toString('utf8');
      const parts = text.split(':');
      if (parts[0] === 'Repository' && parts.length === 2) return Number(parts[1]);
    } catch {
      return null;
    }
    return null;
  }

  private findIssueByGlobalId(globalId: string): { repo: Repo; issue: Issue } | null {
    try {
      const text = Buffer.from(globalId, 'base64url').toString('utf8');
      const parts = text.split(':');
      if (parts[0] !== 'Issue' || parts.length !== 3) return null;
      const repo = this.ctx.store.repoByDatabaseId(Number(parts[1]));
      const issue = repo?.issues.find((candidate) => candidate.number === Number(parts[2]));
      if (repo === undefined || issue === undefined) return null;
      return { repo, issue };
    } catch {
      return null;
    }
  }

  private findPullByGlobalId(globalId: string): { repo: Repo; pull: Pull } | null {
    try {
      const text = Buffer.from(globalId, 'base64url').toString('utf8');
      const parts = text.split(':');
      if (parts[0] !== 'PullRequest' || parts.length !== 3) return null;
      const repo = this.ctx.store.repoByDatabaseId(Number(parts[1]));
      const pull = repo?.pulls.find((candidate) => candidate.number === Number(parts[2]));
      if (repo === undefined || pull === undefined) return null;
      return { repo, pull };
    } catch {
      return null;
    }
  }
}

// -------------------------------------------------------------------------------------------
// HTTP entry point
// -------------------------------------------------------------------------------------------

/**
 * Execute one GraphQL request body. Returns the JSON response value: a single
 * object, or an array when the body is a batch.
 */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown> | null): Record<string, unknown> | { errors: { message: string }[] } {
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Syntax Error' }] };
  }
  if (operations.length === 0) return { errors: [{ message: 'Syntax Error: empty document' }] };
  const executor = new Executor({ store, variables: variables ?? {} });
  return executor.executeOperation(operations[0]!);
}

export function executeGraphQLBatch(
  store: Store,
  requests: { query: string; variables?: Record<string, unknown> | null }[],
): Record<string, unknown>[] {
  return requests.map((request) => executeGraphQL(store, request.query, request.variables ?? null));
}
