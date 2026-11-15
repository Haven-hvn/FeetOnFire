// Arkiv feed for Dance pack ZIPs. Loaded lazily by the social catalog.

import { createPublicClient } from '@arkiv-network/sdk';
import { localhost, rabdi } from '@arkiv-network/sdk/chains';
import { asc, eq } from '@arkiv-network/sdk/query';
import { http } from 'viem';
import type { SocialConfig } from './config.ts';
import { DANCE_FILE_GROUP, parseDanceEntity, type ArkivRow, type DancePack } from './protocol.ts';

const PACK_SELECTION = {
  $key: true,
  $owner: true,
  $creator: true,
  $createdAt: true,
  $updatedAt: true,
  $expiresAt: true,
  $attributes: true,
  payload: true,
} as const;

const PAGE_SIZE = 100;
const MAX_CONCURRENT = 2;
const COOLDOWN_MS = 60_000;

let inFlight = 0;
const queue: (() => void)[] = [];
let cooldownUntil = 0;

function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT && Date.now() >= cooldownUntil) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release(): void {
  inFlight--;
  const next = queue.shift();
  if (next) {
    inFlight++;
    next();
  }
}

async function boundedFetch(config: SocialConfig, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await acquire();
    try {
      while (Date.now() < cooldownUntil) await new Promise((r) => setTimeout(r, Math.min(1000, cooldownUntil - Date.now())));
      const headers = new Headers(init?.headers);
      if (config.arkivApiKey) headers.set('X-API-KEY', config.arkivApiKey);
      const response = await fetch(input, { ...init, headers });
      if (response.status === 429) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        continue;
      }
      return response;
    } finally {
      release();
    }
  }
  throw new Error('Arkiv rate limit cooldown');
}

const clients = new Map<string, ReturnType<typeof createPublicClient>>();

function clientFor(config: SocialConfig) {
  const cacheKey = `${config.arkivRpcUrl}:${config.arkivApiKey}`;
  let client = clients.get(cacheKey);
  if (!client) {
    const isLocal = /localhost|127\.0\.0\.1/.test(config.arkivRpcUrl);
    client = createPublicClient({
      chain: isLocal ? localhost : rabdi({ accessKey: config.arkivApiKey }),
      transport: http(config.arkivRpcUrl, {
        retryCount: 0,
        fetchFn: (url, init) => boundedFetch(config, url, init),
      }),
    });
    clients.set(cacheKey, client);
  }
  return client;
}

export async function listDancePacks(config: SocialConfig, onProgress?: (done: number, total?: number) => void): Promise<DancePack[]> {
  const client = clientFor(config);
  const packs = new Map<string, DancePack>();
  let offset = 0;
  let scanned = 0;
  for (;;) {
    const page = await client
      .select(PACK_SELECTION)
      .where(eq('grp', DANCE_FILE_GROUP))
      .orderBy(asc('$key'))
      .limit(PAGE_SIZE)
      .offset(offset)
      .fetch();
    const rows = page.entities as unknown as ArkivRow[];
    for (const row of rows) {
      const pack = parseDanceEntity(row);
      if (pack && !packs.has(pack.id)) packs.set(pack.id, pack);
    }
    scanned += rows.length;
    onProgress?.(scanned, Number(config.maxRecords));
    if (rows.length < PAGE_SIZE || scanned >= Number(config.maxRecords)) break;
    offset += rows.length;
  }
  return [...packs.values()].sort((a, b) => b.createdAt - a.createdAt || a.title.localeCompare(b.title));
}
