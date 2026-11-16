// Git object primitives: hashing, trees, commits, tags and reachability.
// Pure functions over Buffers; no I/O, no clock, no randomness.

import { createHash } from 'node:crypto';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const OID_RE = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return OID_RE.test(value);
}

/** SHA-1 over `<type> <size>\0` + bytes, the git object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare as if they ended in '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const aName = a.mode === '40000' ? `${a.name}/` : a.name;
  const bName = b.mode === '40000' ? `${b.name}/` : b.name;
  if (aName < bName) return -1;
  if (aName > bName) return 1;
  return 0;
}

/** Serialize tree entries in git sort order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const head = Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8');
    const oid = Buffer.from(entry.oid, 'hex');
    if (oid.length !== 20) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(head, oid);
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

/** Serialize a commit object. `author`/`committer` are `Name <email>`; the timestamp gets ` +0000`. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const who = `${fields.timestamp} +0000`;
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${who}`);
  lines.push(`committer ${fields.committer} ${who}`);
  // Two empty lines: the join turns them into the blank line that separates
  // the headers from the message (a single one leaves no '\n\n' to split on).
  lines.push('');
  lines.push('');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}${message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface BuildTagFields {
  object: string;
  type: string;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}

/** Serialize an annotated tag object. */
export function buildTag(fields: BuildTagFields): Buffer {
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger} ${fields.timestamp} +0000`,
    '',
    '',
  ];
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}${message}`, 'utf8');
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Everything reachable from `roots`: commits walk trees and parents, tags
 * walk their target, trees walk their entries (gitlinks excluded). Throws
 * when an object is missing, unless `allowMissing`.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `oid` (or equal to it). */
export function isAncestor(ancestor: string, oid: string, lookup: ObjectLookup): boolean {
  if (ancestor === oid) return true;
  try {
    return collectReachable([oid], lookup).has(ancestor);
  } catch {
    return false;
  }
}

/** The blob oid a tree holds at `segments`, or null. */
export function findTreePath(
  lookup: ObjectLookup,
  treeOid: string,
  segments: readonly string[],
): string | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The tree oid a tree holds at `segments` (the directory itself), or null. */
export function findTreeDir(
  lookup: ObjectLookup,
  treeOid: string,
  segments: readonly string[],
): string | null {
  let current = treeOid;
  for (const segment of segments) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

/** Flatten a tree into path -> {oid, mode} for every blob, recursively. */
export function flattenTree(
  lookup: ObjectLookup,
  treeOid: string,
  prefix = '',
  out: Map<string, { oid: string; mode: string }> = new Map(),
): Map<string, { oid: string; mode: string }> {
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(lookup, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}
