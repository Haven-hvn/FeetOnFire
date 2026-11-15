// Pack byte retrieval: clear IPFS/UnixFS roots and sealed Filecoin pieces.

import type { SocialConfig } from './config.ts';
import type { DancePack } from './protocol.ts';

async function fetchBytes(url: string, onProgress?: (received: number, total?: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const total = Number(response.headers.get('content-length')) || undefined;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
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
}

function gatewayUrl(gateway: string, cid: string): string {
  if (/^https?:\/\//i.test(cid)) return cid;
  return `${gateway.replace(/\/+$/, '')}/ipfs/${cid}`;
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
  const gateways = [config.ipfsGateway, 'https://ipfs.io', 'https://w3s.link'].filter((v, i, a) => v && a.indexOf(v) === i);
  let lastError: unknown;
  for (const gateway of gateways) {
    try {
      return await fetchBytes(gatewayUrl(gateway, cid), onProgress, signal);
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
        return await fetchBytes(url, onProgress, signal);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    const direct = filbeamUrl(pack.owner, piece, chainId);
    if (direct) {
      try {
        return await fetchBytes(direct, onProgress, signal);
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
