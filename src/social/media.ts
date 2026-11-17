// Pack byte retrieval: clear IPFS/UnixFS roots and sealed Filecoin pieces.

import type { SocialConfig } from './config.ts';
import type { DancePack } from './protocol.ts';

interface FetchOptions {
  onProgress?: (received: number, total?: number) => void;
  signal?: AbortSignal;
  /** Total attempts per URL, including the first. Default 3. */
  attempts?: number;
}

function abortError(): DOMException {
  return new DOMException('Fetch cancelled', 'AbortError');
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

// Resumable byte retrieval: gateways support HTTP Range, so a dropped
// connection resumes from the last received byte instead of restarting a
// multi-megabyte pack; a gateway that ignores Range (200 instead of 206)
// simply restarts that attempt. Retries are bounded and abort always wins.
async function fetchBytes(url: string, { onProgress, signal, attempts = 3 }: FetchOptions = {}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  let total: number | undefined;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      const headers: Record<string, string> = {};
      if (received > 0) headers.Range = `bytes=${received}-`;
      const response = await fetch(url, { signal, headers });
      if (!response.ok || !response.body) {
        const error = new Error(`download failed (${response.status})`);
        if (response.status >= 400 && response.status < 500) throw Object.assign(error, { noRetry: true });
        throw error;
      }
      if (received > 0 && response.status === 200) {
        chunks.length = 0;
        received = 0;
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(length) && length > 0) total = response.status === 206 ? received + length : length;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress?.(received, total);
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    } catch (error) {
      if (isAbort(error, signal)) throw abortError();
      if ((error as { noRetry?: boolean })?.noRetry) throw error;
      if (attempt === Math.max(1, attempts) - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw new Error('download failed');
}

function gatewayUrl(gateway: string, cid: string): string {
  let ref = cid.trim();
  if (/^https?:\/\//i.test(ref)) {
    // A full gateway URL still names content: re-root its /ipfs/ or /ipns/
    // path on each gateway, so one gateway's CORS or rate-limit failure does
    // not sink every fallback attempt.
    const match = ref.match(/\/(ipfs|ipns)\/([^/?#]+)/i);
    if (!match) return ref;
    return `${gateway.replace(/\/+$/, '')}/${match[1]}/${match[2]}`;
  }
  ref = ref.replace(/^ipfs:\/\//i, '');
  return `${gateway.replace(/\/+$/, '')}/ipfs/${ref}`;
}

function filecoinChainIdForGate(gateChain?: string): 314 | 314159 {
  return gateChain === 'EthSepolia' ? 314159 : 314;
}

function filbeamUrl(owner: string, pieceCid: string, filecoinChainId: 314 | 314159): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return undefined;
  const host = filecoinChainId === 314159 ? 'calibration.filbeam.io' : 'filbeam.io';
  return `https://${owner.toLowerCase()}.${host}/${pieceCid}`;
}

async function fetchClear(pack: DancePack, config: SocialConfig, onProgress?: (received: number, total?: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const cid = pack.media.fcid;
  if (!cid) throw new Error('pack has no clear file reference');
  // Public gateways are best-effort and rate-limit per IP; try several so a
  // single 429/403 does not hide a healthy upload. Pinata has been the most
  // reliable for Haven's Filecoin clear roots.
  const gateways = [
    config.ipfsGateway,
    'https://w3s.link',
    'https://ipfs.io',
    'https://gateway.pinata.cloud',
    'https://cf-ipfs.com',
    'https://dweb.link',
    'https://gateway.ipfs.io',
    'https://4everland.io',
  ].filter((v, i, a) => v && a.indexOf(v) === i);
  let lastError: unknown;
  for (const gateway of gateways) {
    try {
      return await fetchBytes(gatewayUrl(gateway, cid), { onProgress, signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('clear pack download failed');
}

async function fetchSealed(pack: DancePack, config: SocialConfig, onProgress?: (received: number, total?: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const piece = pack.media.piece;
  if (!piece) throw new Error('pack has no sealed piece reference');
  const chainId = filecoinChainIdForGate(pack.gate?.chain);
  const { Synapse } = await import('@filoz/synapse-sdk');
  const { getChain } = await import('@filoz/synapse-core/chains');
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
  const synapse = Synapse.create({
    account: privateKeyToAccount(generatePrivateKey()),
    chain: getChain(chainId) as unknown as NonNullable<Parameters<typeof Synapse.create>[0]['chain']>,
    source: 'dance',
    withCDN: true,
  });
  if (pack.owner) {
    try {
      const { tryFrom, resolvePieceUrl, filbeamResolver, chainResolver } = await import('@filoz/synapse-core/piece');
      const parsed = tryFrom(piece);
      if (parsed != null) {
        const url = await resolvePieceUrl({ address: pack.owner.toLowerCase() as `0x${string}`, client: synapse.client, pieceCid: parsed, resolvers: [filbeamResolver, chainResolver], ...(signal ? { signal } : {}) });
        return await fetchBytes(url, { onProgress, signal });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    const direct = filbeamUrl(pack.owner, piece, chainId);
    if (direct) {
      try {
        return await fetchBytes(direct, { onProgress, signal });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
  }
  const bytes = await synapse.storage.download({ pieceCid: piece, withCDN: true });
  const out = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  onProgress?.(out.length, out.length);
  return out;
}

export async function fetchPackBytes(pack: DancePack, config: SocialConfig, onProgress?: (received: number, total?: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  if (pack.media.fcid && !pack.sealed) return fetchClear(pack, config, onProgress, signal);
  if (pack.media.piece) return fetchSealed(pack, config, onProgress, signal);
  if (pack.media.fcid) return fetchClear(pack, config, onProgress, signal);
  throw new Error('pack has no downloadable media reference');
}
