// git smart HTTP: info/refs advertisements (protocol v2 and v0),
// upload-pack (v2 ls-refs / fetch, v0 fetch) and receive-pack (v0).
// The object store, packfiles and reachability live in lib/git-objects and
// lib/pack; this file is the wire framing around them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
} from './git-objects.ts';
import {
  decodePktLines,
  encodePktLines,
  pktLine,
  pktLineFlush,
  readPack,
  sidebandPackets,
  writePack,
} from './pack.ts';
import { FORGE_VERSION, type Repo, type Store } from './store.ts';

const AGENT = `forge/${FORGE_VERSION}`;
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitRequest {
  owner: string;
  repo: string;
  service: 'git-upload-pack' | 'git-receive-pack';
  action: 'info-refs' | 'upload-pack' | 'receive-pack';
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson404(res: ServerResponse): void {
  const body = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
  sendBuffer(res, 404, 'application/json; charset=utf-8', body);
}

/** The repo a git request names, after the owner check; null answers 404 itself. */
function resolveRepo(store: Store, res: ServerResponse, owner: string, repoName: string): Repo | null {
  if (!store.checkOwner(owner)) {
    sendJson404(res);
    return null;
  }
  const repo = store.repoByName(repoName);
  if (repo === undefined) {
    sendJson404(res);
    return null;
  }
  return repo;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** Every ref line a repo advertises: HEAD first, then heads, then tags (peeled). */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip !== undefined) {
    lines.push({ oid: mainTip, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  }
  const heads = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  for (const ref of heads) lines.push({ oid: repo.refs.get(ref)!, name: ref });
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of tags) {
    const oid = repo.refs.get(ref)!;
    const line: RefLine = { oid, name: ref };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') line.peeled = parseTag(object.data).object;
    lines.push(line);
  }
  return lines;
}

/** The v2 capability advertisement for upload-pack. */
function advertisementV2(service: 'git-upload-pack'): Buffer {
  const parts: Buffer[] = [
    pktLine(`# service=${service}\n`),
    pktLineFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLineFlush(),
  ];
  return Buffer.concat(parts);
}

/** The v0 ref advertisement. `caps` ride the first ref line (or the zero-id line for an empty repo). */
function advertisementV0(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktLineFlush()];
  const lines = refLines(repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      const text = index === 0 ? `${line.oid} ${line.name}\0${caps}\n` : `${line.oid} ${line.name}\n`;
      parts.push(pktLine(text));
      if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

// -------------------------------------------------------------------------------------------
// fetch reachability
// -------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  /** Objects to send, in a deterministic order. */
  objects: GitObject[];
  /** New shallow boundaries to report. */
  shallowOut: string[];
  /** Old boundaries that are no longer shallow. */
  unshallowOut: string[];
  /** Whether any want had a common ancestor with the haves. */
  common: string | null;
}

/**
 * What a fetch sends. Walks from the wants, cutting parent edges at
 * `depth` (deepen N includes generations 0..N-1); subtracts what the client
 * already holds, where a held shallow boundary does not imply its parents.
 * Tag wants peel to their commit; trees and blobs of included commits are
 * always whole.
 */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const boundarySet = new Set(request.shallow);
  // Held: reachable from the haves without crossing a shallow boundary.
  const held = new Set<string>();
  {
    const queue: string[] = [...request.haves];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!boundarySet.has(oid)) for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }
  // Included commits with their distance from the wants.
  const distance = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  for (const want of request.wants) {
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      queue.push({ oid: target, depth: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 0 });
    }
  }
  const included = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (distance.has(oid)) continue;
    if (request.depth !== null && depth >= request.depth) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    distance.set(oid, depth);
    included.add(oid);
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  // The objects to send: each included commit plus the whole of its tree
  // (trees and blobs), never its parents — the depth cut is a hard boundary,
  // so a depth-1 fetch sends exactly the tip commit and its tree.
  const wanted = new Set<string>();
  for (const want of request.wants) {
    const object = lookup(want);
    if (object !== undefined && object.type === 'tag') wanted.add(want);
  }
  for (const oid of included) {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    wanted.add(oid);
    const commit = parseCommit(object.data);
    for (const reachable of collectReachable([commit.tree], lookup, { allowMissing: true })) {
      wanted.add(reachable);
    }
  }
  const toSend = [...wanted].filter((oid) => !held.has(oid)).sort();
  const objects: GitObject[] = [];
  for (const oid of toSend) {
    const object = lookup(oid);
    if (object !== undefined) objects.push({ type: object.type, data: object.data });
  }
  // New shallow boundaries: included commits at the cutoff that still have parents.
  const shallowOut: string[] = [];
  if (request.depth !== null) {
    for (const [oid, depth] of distance) {
      if (depth !== request.depth - 1) continue;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (parseCommit(object.data).parents.length > 0) shallowOut.push(oid);
    }
  }
  shallowOut.sort();
  // Unshallow: an old boundary now included with its parents included too.
  const unshallowOut: string[] = [];
  for (const old of boundarySet) {
    const depth = distance.get(old);
    if (depth === undefined) continue;
    if (request.depth !== null && depth >= request.depth - 1) continue;
    unshallowOut.push(old);
  }
  unshallowOut.sort();
  // Common ancestor for the acknowledgments section.
  let common: string | null = null;
  if (request.haves.length > 0) {
    const wantedClosure = new Set<string>();
    for (const want of request.wants) {
      for (const reachable of collectReachable([want], lookup, { allowMissing: true })) {
        wantedClosure.add(reachable);
      }
    }
    for (const have of request.haves) {
      if (wantedClosure.has(have)) {
        common = have;
        break;
      }
    }
  }
  return { objects, shallowOut, unshallowOut, common };
}

// -------------------------------------------------------------------------------------------
// info/refs
// -------------------------------------------------------------------------------------------

function handleInfoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
): void {
  const repo = resolveRepo(store, res, owner, repoName);
  if (repo === null) return;
  const v2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (v2) {
    sendBuffer(res, 200, UPLOAD_AD, advertisementV2(service));
    return;
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const contentType = service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD;
  sendBuffer(res, 200, contentType, advertisementV0(service, repo, caps));
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

function parseFetchLines(packets: ReturnType<typeof decodePktLines>): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let command = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (line.startsWith('command=')) {
      command = line.slice('command='.length).trim();
      continue;
    }
    if (command === 'fetch') {
      if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isInteger(n) && n > 0) request.depth = n;
      }
    }
  }
  return request;
}

function lsRefsResponse(repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const lines = refLines(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  for (const line of lines) {
    if (!keep(line.name)) continue;
    let text = `${line.oid} ${line.name}`;
    if (symrefs && line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    if (peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    parts.push(pktLine(`${text}\n`));
  }
  if (unborn && !repo.refs.has('refs/heads/main')) {
    parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function fetchV2Response(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine(plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n'));
  if (plan.common !== null) parts.push(pktLine('ready\n'));
  parts.push(pktLineFlush());
  if (request.depth !== null || request.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktLineFlush());
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(pktLineFlush());
  }
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  parts.push(pktLine(plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n'));
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(...sidebandPackets(pack));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function handleUploadPack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = resolveRepo(store, res, owner, repoName);
  if (repo === null) return;
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    sendBuffer(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'malformed pkt-line' }), 'utf8'));
    return;
  }
  const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (v2) {
    const first = packets.find((packet) => packet.kind === 'data');
    const commandLine = first === undefined ? '' : first.payload.toString('utf8');
    if (commandLine.startsWith('command=ls-refs')) {
      sendBuffer(res, 200, UPLOAD_RESULT, lsRefsResponse(repo, packets));
      return;
    }
    if (commandLine.startsWith('command=fetch')) {
      const request = parseFetchLines(packets);
      sendBuffer(res, 200, UPLOAD_RESULT, fetchV2Response(repo, request));
      return;
    }
    sendBuffer(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8'));
    return;
  }
  // v0: wants/haves/shallow/deepen as bare pkt-lines.
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().split(' ')[0]!);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) request.depth = n;
    }
  }
  if (request.wants.length === 0) {
    sendBuffer(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'no want lines' }), 'utf8'));
    return;
  }
  sendBuffer(res, 200, UPLOAD_RESULT, fetchV0Response(repo, request));
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into its command list and its pack bytes. */
function parseReceiveBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  let offset = 0;
  const commands: PushCommand[] = [];
  while (offset < body.length) {
    if (offset + 4 > body.length) return null;
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) return null;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = payload.indexOf('\0');
    const commandText = (nul >= 0 ? payload.slice(0, nul) : payload).trim();
    const parts = commandText.split(' ');
    if (parts.length < 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
    offset += length;
  }
  return { commands, pack: body.subarray(offset) };
}

/**
 * Whether everything reachable from `tip` is present in the store. The walk
 * prunes at any object `packOids` did not carry: such an object was already
 * in the store, and its closure was verified when it was stored.
 */
function closureComplete(repo: Repo, tip: string, packOids: Set<string>): boolean {
  const stack: string[] = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) return false;
    if (!packOids.has(oid)) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return true;
}

function handleReceivePack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = resolveRepo(store, res, owner, repoName);
  if (repo === null) return;
  const parsed = parseReceiveBody(body);
  if (parsed === null || parsed.commands.length === 0) {
    sendBuffer(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'malformed receive-pack' }), 'utf8'));
    return;
  }
  const { commands, pack } = parsed;
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  // The oids this push's pack carried: a completeness walk prunes at any
  // object the pack did not carry, because such an object was already in
  // the store and its closure was verified when it was stored. That keeps
  // the check O(new objects) instead of O(history) on a long chain.
  let packOids = new Set<string>();
  if (updatesRef) {
    if (pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
        packOids = new Set(read.objects.keys());
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (error) {
        unpackOk = false;
        unpackDetail = error instanceof Error ? error.message : 'unpack failed';
      }
    }
  }
  // Apply the ref updates, in order; a refused ref never moves, the others still apply.
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    // A new tip's closure must be complete in the store (bounded walk: prune
    // at objects this pack did not carry).
    if (command.newOid !== ZERO_OID) {
      if (!closureComplete(repo, command.newOid, packOids)) {
        reportLines.push(`ng ${command.ref} missing object\n`);
        continue;
      }
    }
    const result = store.applyPushCommand(repo, command);
    reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
  }
  // The report-status stream is itself pkt-lined, and rides inside band-1
  // sideband frames; the client decodes both layers.
  const reportPkt = Buffer.concat(reportLines.map((line) => pktLine(line)));
  const framed = Buffer.concat(sidebandPackets(reportPkt));
  sendBuffer(res, 200, RECEIVE_RESULT, Buffer.concat([framed, pktLineFlush()]));
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

/**
 * Route one git smart-HTTP request. `segments` are the path parts after the
 * leading slash; the caller has already split `/{owner}/{repo}.git/...`.
 */
export function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  if (segments.length < 2) return false;
  const repoSegment = segments[1]!;
  if (!repoSegment.endsWith('.git')) return false;
  const owner = decodeURIComponent(segments[0]!);
  const repoName = decodeURIComponent(repoSegment.slice(0, -4));
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson404(res);
      return true;
    }
    handleInfoRefs(store, req, res, owner, repoName, service);
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    handleUploadPack(store, req, res, owner, repoName, body);
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    handleReceivePack(store, req, res, owner, repoName, body);
    return true;
  }
  return false;
}
