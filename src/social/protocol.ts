// Pure protocol helpers for Dance's social pack feed.
// These functions deliberately avoid Web3/network imports so they can be unit-tested in Node.

export const DANCE_FILE_GROUP = 'haven.file.full';
export const PACK_MANIFEST_KIND = 'stepmania-pack';
export const PACK_MANIFEST_VERSION = 1;
export const STEPMANIA_ZIP_MIME = 17;

export type ChainVariant = 'EthMainnet' | 'EthSepolia' | 'BaseMainnet' | 'BaseSepolia' | 'OptimismMainnet' | 'OptimismSepolia' | 'ArbitrumOne' | 'ArbitrumSepolia';

export interface GateTriple {
  chain: ChainVariant;
  tokenAddress: string;
  threshold: bigint;
}

export interface GateJson {
  version: number;
  epoch?: bigint;
  gate: GateTriple;
  raw: Record<string, unknown>;
}

export interface PackSong {
  path?: string;
  title: string;
  artist: string;
  album?: string;
  track?: number;
}

export interface PackMedia {
  fcid?: string;
  piece?: string;
  mime?: number;
  contentType?: string;
  size?: number;
  name?: string;
  sha256?: string;
}

export interface DancePack {
  id: string;
  title: string;
  description?: string;
  album?: string;
  songs: PackSong[];
  media: PackMedia;
  gate?: GateTriple;
  gateJson?: string;
  sample: boolean;
  sealed: boolean;
  createdAt: number;
  owner?: string;
  source: 'manifest' | 'media';
}

export interface GateResult {
  held: boolean;
  error?: string;
}

export type PackAccess = 'sample' | 'open' | 'locked' | 'error';

export interface ArkivRow {
  [key: string]: unknown;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const GATE_CHAINS = new Set<ChainVariant>(['EthMainnet', 'EthSepolia', 'BaseMainnet', 'BaseSepolia', 'OptimismMainnet', 'OptimismSepolia', 'ArbitrumOne', 'ArbitrumSepolia']);
const EIP155_TO_VARIANT: Record<number, ChainVariant> = {
  1: 'EthMainnet',
  11155111: 'EthSepolia',
  8453: 'BaseMainnet',
  84532: 'BaseSepolia',
  10: 'OptimismMainnet',
  11155420: 'OptimismSepolia',
  42161: 'ArbitrumOne',
  421614: 'ArbitrumSepolia',
};

export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && EVM_ADDRESS.test(value);
}

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function gateKey(gate: GateTriple): string {
  return `${gate.chain}:${normalizeAddress(gate.tokenAddress)}:${gate.threshold.toString()}`;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('invalid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function bigintValue(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

function boolValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return undefined;
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value?: unknown }).value;
    if (inner !== undefined) return inner;
  }
  return value;
}

export function toAttributeRecord(attributes: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(attributes)) {
    for (const item of attributes) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const name = text(rec.name) ?? text(rec.key);
      if (!name) continue;
      out[name] = unwrap(rec.value ?? rec);
    }
    return out;
  }
  if (!attributes || typeof attributes !== 'object') return out;
  for (const [name, raw] of Object.entries(attributes as Record<string, unknown>)) {
    out[name] = unwrap(raw);
  }
  return out;
}

function decodePayloadValue(value: unknown): unknown {
  const unwrapped = unwrap(value);
  if (unwrapped instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(unwrapped));
    } catch {
      return undefined;
    }
  }
  if (typeof unwrapped === 'string') {
    const s = unwrapped.trim();
    if (!s) return undefined;
    if (s.startsWith('0x')) {
      try {
        return JSON.parse(new TextDecoder().decode(hexToBytes(s)));
      } catch {
        return undefined;
      }
    }
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  }
  if (unwrapped && typeof unwrapped === 'object') return unwrapped;
  return undefined;
}

export function decodePayload(value: unknown): Record<string, unknown> | undefined {
  const decoded = decodePayloadValue(value);
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? (decoded as Record<string, unknown>) : undefined;
}

export function parseGateTriple(raw: unknown): GateTriple | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const chain = text(obj.chain);
  const tokenAddress = text(obj.tokenAddress);
  const threshold = bigintValue(obj.threshold);
  if (!chain || !GATE_CHAINS.has(chain as ChainVariant) || !isAddress(tokenAddress ?? '') || threshold === undefined) return undefined;
  return { chain: chain as ChainVariant, tokenAddress: tokenAddress!, threshold };
}

export function parseGateJson(raw: unknown): GateJson | undefined {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const gate = parseGateTriple(obj.gate) ?? parseGateTriple(obj);
  const version = num(obj.v ?? obj.version);
  if (!gate || version === undefined) return undefined;
  return { version, epoch: bigintValue(obj.epoch), gate, raw: obj };
}

function chainVariantFromAttribute(value: unknown): ChainVariant | undefined {
  const named = text(value);
  if (named && GATE_CHAINS.has(named as ChainVariant)) return named as ChainVariant;
  let id: number | undefined;
  if (typeof value === 'number') id = value;
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) id = Number(value.trim());
  return id === undefined ? undefined : EIP155_TO_VARIANT[id];
}

function parseGateFromAttributes(attributes: Record<string, unknown>): GateTriple | undefined {
  const chain = chainVariantFromAttribute(attributes.gate_chain);
  const tokenAddress = text(attributes.gate_token) ?? text(attributes.gate_tokenAddress);
  const threshold = bigintValue(attributes.gate_threshold);
  if (!chain || !isAddress(tokenAddress ?? '') || threshold === undefined) return undefined;
  return { chain, tokenAddress: tokenAddress!, threshold };
}

function baseName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.(zip|smzip)$/i, '') || undefined;
}

function looksLikeZip(name: string | undefined, mime: number | undefined, contentType?: string): boolean {
  if (mime === STEPMANIA_ZIP_MIME) return true;
  if (/\.(zip|smzip)$/i.test(name ?? '')) return true;
  return /zip/i.test(contentType ?? '');
}

function parseSongs(value: unknown): PackSong[] {
  if (!Array.isArray(value)) return [];
  const songs: PackSong[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const title = text(obj.title);
    const artist = text(obj.artist);
    if (!title || !artist) continue;
    songs.push({
      path: text(obj.path),
      title,
      artist,
      album: text(obj.album),
      track: num(obj.track),
    });
  }
  return songs;
}

function manifestValid(dance: unknown): dance is { kind: string; version: number; album?: string; sample?: boolean; songs?: unknown } {
  return Boolean(dance && typeof dance === 'object' && !Array.isArray(dance) && (dance as Record<string, unknown>).kind === PACK_MANIFEST_KIND && num((dance as Record<string, unknown>).version) === PACK_MANIFEST_VERSION);
}

export function parseDanceEntity(row: ArkivRow): DancePack | undefined {
  const attributes = toAttributeRecord(row.$attributes ?? row.attributes);
  const payload = decodePayload(row.payload ?? attributes.payload);
  if (!payload) return undefined;

  const payloadExtra = payload.x && typeof payload.x === 'object' && !Array.isArray(payload.x) ? (payload.x as Record<string, unknown>) : undefined;
  const danceRaw = payloadExtra?.dance ?? payload.dance;
  const hasManifest = manifestValid(danceRaw);
  const mime = num(payload.mime ?? attributes.mime);
  const contentType = text(payload.ct) ?? text(attributes.ct);
  const mediaName = text(payload.name) ?? text(attributes.name);
  if (!hasManifest && !looksLikeZip(mediaName, mime, contentType)) return undefined;

  const dance = hasManifest ? (danceRaw as Record<string, unknown>) : undefined;
  const gateJsonRaw = payload.gate;
  const gateJson = typeof gateJsonRaw === 'string' ? gateJsonRaw : gateJsonRaw === undefined ? undefined : JSON.stringify(gateJsonRaw);
  const parsedGate = parseGateJson(gateJsonRaw);
  const gate = parsedGate?.gate ?? parseGateFromAttributes(attributes);
  const title = text(attributes.title) ?? text(payload.title) ?? text(dance?.album) ?? text(dance?.title) ?? baseName(mediaName) ?? 'Untitled pack';
  const media: PackMedia = {
    fcid: text(payload.fcid),
    piece: text(payload.piece),
    mime,
    contentType,
    size: num(payload.size),
    name: mediaName,
    sha256: text(payload.pt_hash ?? payload.sha256 ?? payload.sha256_ct ?? attributes.sha256_ct),
  };
  const key = text(row.$key) ?? text(row.key) ?? `${title}:${media.piece ?? media.fcid ?? ''}`;
  const created = num(row.$createdAt ?? row.createdAt) ?? 0;

  return {
    id: key,
    title,
    description: text(attributes.description) ?? text(payload.description) ?? text(dance?.description),
    album: text(dance?.album) ?? baseName(mediaName),
    songs: parseSongs(dance?.songs),
    media,
    gate,
    gateJson,
    sample: boolValue(dance?.sample) === true || boolValue(attributes.sample) === true,
    sealed: Boolean(media.piece) || num(attributes.sealed) === 1,
    createdAt: created,
    owner: text(row.$owner) ?? text(row.owner),
    source: hasManifest ? 'manifest' : 'media',
  };
}

export function packAccess(pack: DancePack, walletAddress: string | undefined, balances: ReadonlyMap<string, GateResult>): PackAccess {
  if (pack.sample && pack.media.fcid) return 'sample';
  if (!pack.gate) return 'open';
  if (!walletAddress) return 'locked';
  const result = balances.get(gateKey(pack.gate));
  if (!result) return 'error';
  if (result.error) return 'error';
  return result.held ? 'open' : 'locked';
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function formatThreshold(threshold: bigint): string {
  return threshold.toString();
}
