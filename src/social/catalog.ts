// Social catalog boundary: lazy-loads feed, wallet, entitlement, and media code.

import { socialConfig, type SocialConfig } from './config.ts';
import { packAccess, type DancePack, type GateResult, type PackAccess } from './protocol.ts';

export interface SocialPack extends DancePack {
  access: PackAccess;
  importState?: 'idle' | 'downloading' | 'importing' | 'done' | 'error';
  progress?: string;
}

export interface SocialSnapshot {
  packs: SocialPack[];
  walletAddress?: string;
  loading: boolean;
  error?: string;
  walletError?: string;
}

type Listener = (snapshot: SocialSnapshot) => void;

export function createSocialCatalog(onUpdate: Listener, config: SocialConfig = socialConfig()) {
  let snapshot: SocialSnapshot = { packs: [], loading: false };
  const listeners = new Set<Listener>([onUpdate]);
  const emit = () => {
    for (const listener of listeners) listener(snapshot);
  };
  const set = (patch: Partial<SocialSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    emit();
  };
  const packById = (id: string) => snapshot.packs.find((p) => p.id === id);

  async function refresh(): Promise<void> {
    set({ loading: true, error: undefined });
    try {
      const [{ listDancePacks }, { walletStatus }, { evaluateGates }] = await Promise.all([import('./feed.ts'), import('./wallet.ts'), import('./entitlements.ts')]);
      const [packs, walletAddress] = await Promise.all([listDancePacks(config), walletStatus(config)]);
      let balances = new Map<string, GateResult>();
      if (walletAddress) {
        const gates = [...new Map(packs.filter((p) => p.gate).map((p) => [`${p.gate!.chain}:${p.gate!.tokenAddress}:${p.gate!.threshold}`, p.gate!])).values()];
        balances = await evaluateGates(gates, walletAddress, config);
      }
      const previous = new Map(snapshot.packs.map((p) => [p.id, p]));
      set({
        loading: false,
        walletAddress,
        packs: packs.map((pack) => ({ ...pack, access: packAccess(pack, walletAddress, balances), importState: previous.get(pack.id)?.importState ?? 'idle', progress: previous.get(pack.id)?.progress })),
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function connect(): Promise<void> {
    try {
      const { connectWallet } = await import('./wallet.ts');
      set({ walletError: undefined });
      await connectWallet(config);
      await refresh();
    } catch (error) {
      set({ walletError: error instanceof Error ? error.message : String(error) });
    }
  }

  async function disconnect(): Promise<void> {
    const [{ disconnectWallet }, { forgetKeys }] = await Promise.all([import('./wallet.ts'), import('./aol.ts')]);
    await disconnectWallet(config);
    forgetKeys();
    await refresh();
  }

  function updatePack(id: string, patch: Partial<SocialPack>): void {
    set({ packs: snapshot.packs.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }

  async function download(id: string, onImported?: (added: number, replaced: number, problems: string[]) => void): Promise<void> {
    const pack = packById(id);
    if (!pack) return;
    if (pack.access !== 'sample' && pack.access !== 'open') throw new Error('pack is locked');
    updatePack(id, { importState: 'downloading', progress: 'Preparing…' });
    try {
      const [{ fetchPackBytes }, { decryptPackBytes, hasUnlocked, restorePackFromOsBridge, unlockPack }, { walletSigner }] = await Promise.all([import('./media.ts'), import('./aol.ts'), import('./wallet.ts')]);
      const controller = new AbortController();
      const bytes = await fetchPackBytes(pack, config, (received, total) => updatePack(id, { progress: total ? `Downloading ${Math.round((received / total) * 100)}%` : `Downloading ${(received / 1048576).toFixed(1)} MB` }), controller.signal);
      let zip = bytes;
      if (pack.sealed) {
        updatePack(id, { progress: 'Unlocking…' });
        if (!hasUnlocked(pack) && !(await restorePackFromOsBridge(pack))) {
          const signer = await walletSigner(config);
          if (!signer) throw new Error('connect a wallet to unlock this pack');
          await unlockPack(pack, signer, config, (message) => updatePack(id, { progress: message ?? 'Unlocking…' }));
        }
        updatePack(id, { importState: 'importing', progress: 'Decrypting…' });
        zip = await decryptPackBytes(pack, bytes, (done, total) => updatePack(id, { progress: `Decrypting ${Math.round((done / Math.max(1, total)) * 100)}%` }));
      }
      updatePack(id, { importState: 'importing', progress: 'Importing…' });
      const { importFiles } = await import('../app/store.ts');
      const file = new File([zip.buffer as ArrayBuffer], pack.media.name ?? `${pack.title}.zip`, { type: 'application/zip' });
      const result = await importFiles([{ path: file.name, file }], (done, total, name) => updatePack(id, { progress: `Importing ${done + 1} of ${total}: ${name}` }));
      updatePack(id, { importState: result.problems.length && !result.added.length ? 'error' : 'done', progress: result.problems[0] ?? `${result.added.length} song${result.added.length === 1 ? '' : 's'} imported` });
      onImported?.(result.added.length, result.replaced, result.problems);
    } catch (error) {
      updatePack(id, { importState: 'error', progress: error instanceof Error ? error.message : String(error) });
    }
  }

  return { getSnapshot: () => snapshot, subscribe: (listener: Listener) => { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); }, refresh, connect, disconnect, download };
}
