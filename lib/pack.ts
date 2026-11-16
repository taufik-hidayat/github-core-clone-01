// pkt-lines, packfiles and git deltas. The wire framing git smart HTTP
// speaks, implemented on node:zlib and node:crypto.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, type GitObject, type GitObjectType } from './git-objects.ts';

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface GitPacket {
  kind: PacketKind;
  /** The payload without the 4-byte length prefix (empty for flush/delim/response-end). */
  payload: Buffer;
  /** The raw packet bytes, length prefix included. */
  raw: Buffer;
}

export const PKT_LINE_MAX = 65520;

function pktLineHeader(length: number): Buffer {
  return Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
}

/** One pkt-line: 4 hex digits of total length, then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([pktLineHeader(body.length + 4), body]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a list of lines (strings) and markers ('flush' | 'delim' | 'response-end'). */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktLineFlush());
    else if (line === 'delim') parts.push(pktLineDelim());
    else if (line === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(bytes: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('pkt-line is truncated');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} is out of range`);
    if (offset + length > bytes.length) throw new Error('pkt-line is truncated');
    packets.push({
      kind: 'data',
      payload: bytes.subarray(offset + 4, offset + length),
      raw: bytes.subarray(offset, offset + length),
    });
    offset += length;
  }
  return packets;
}

/** A sideband frame: band byte + data, pkt-lined. Band 1 = data, 2 = progress, 3 = error. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split `data` into sideband band-1 packets of at most `chunk` bytes of payload each. */
export function sidebandPackets(data: Buffer, chunk = 65515): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunk) {
    parts.push(sidebandPacket(1, data.subarray(offset, Math.min(data.length, offset + chunk))));
  }
  return parts;
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, plain objects, no deltas) with its SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Whether a pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return { ok: actual === expected, expected, actual };
}

interface PackEntryRead {
  offset: number;
  type: GitObjectType;
  size: number;
  data: Buffer;
  oid: string;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number } {
  let byte = buffer[start]!;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the next offset. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (written === undefined || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset |= delta[offset++]! << (i * 8);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) copySize |= delta[offset++]! << (i * 8);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past its base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert runs past its data');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (written !== targetSize) throw new Error(`delta wrote ${written} bytes, expected ${targetSize}`);
  return out;
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile into its objects. Plain objects and OFS/REF deltas resolve;
 * delta bases may come from earlier pack entries or from `resolveBase` (the
 * repo store). Throws on a corrupt pack.
 */
export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const checksum = verifyPackChecksum(pack);
  if (!checksum.ok) throw new Error('pack trailer does not match its bytes');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, PackEntryRead>();
  let offset = 12;
  let deltaCount = 0;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const { size, next } = readVarintSize(pack, offset);
    offset = next;
    const first = pack[entryOffset]!;
    const typeCode = (first >> 4) & 0x07;
    if (typeCode === 6) {
      // OFS_DELTA: base is an earlier entry at entryOffset - baseOffset.
      const { baseOffset, next: dataStart } = readOfsDeltaBase(pack, offset);
      const base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta names an unknown base offset');
      const { data: delta, next: after } = inflateAt(pack, dataStart);
      const data = applyDelta(base.data, delta);
      const oid = hashObject(base.type, data);
      const entry: PackEntryRead = { offset: entryOffset, type: base.type, size, data, oid };
      objects.set(oid, { type: base.type, data });
      byOffset.set(entryOffset, entry);
      deltaCount += 1;
      offset = after;
    } else if (typeCode === 7) {
      // REF_DELTA: base named by oid; it may be in this pack or in the store.
      if (offset + 20 > pack.length) throw new Error('ref-delta has no base oid');
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: delta, next: after } = inflateAt(pack, offset);
      let base = [...byOffset.values()].find((entry) => entry.oid === baseOid);
      let baseObject = base === undefined ? undefined : { type: base.type, data: base.data };
      if (baseObject === undefined && options.resolveBase !== undefined) baseObject = options.resolveBase(baseOid);
      if (baseObject === undefined) throw new Error(`ref-delta names an unknown base ${baseOid}`);
      const data = applyDelta(baseObject.data, delta);
      const oid = hashObject(baseObject.type, data);
      const entry: PackEntryRead = { offset: entryOffset, type: baseObject.type, size, data, oid };
      objects.set(oid, { type: baseObject.type, data });
      byOffset.set(entryOffset, entry);
      deltaCount += 1;
      offset = after;
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
      const { data, next: after } = inflateAt(pack, offset);
      if (data.length !== size) throw new Error(`pack entry size ${data.length} != header ${size}`);
      const oid = hashObject(type, data);
      const entry: PackEntryRead = { offset: entryOffset, type, size, data, oid };
      objects.set(oid, { type, data });
      byOffset.set(entryOffset, entry);
      offset = after;
    }
  }
  return { version, declaredCount, objects, deltaCount };
}
