// Social pack catalog screen. The heavy social/wallet modules load only here.

import type { Screen } from '../app/ui.ts';
import { h, megabytes } from '../app/ui.ts';
import type { createSocialCatalog, SocialPack, SocialSnapshot } from '../social/catalog.ts';

type Catalog = ReturnType<typeof createSocialCatalog>;

function accessLabel(pack: SocialPack): string {
  if (pack.importState === 'done') return 'Imported';
  if (pack.importState === 'error') return 'Failed';
  if (pack.importState === 'downloading' || pack.importState === 'importing') return pack.progress ?? 'Working…';
  if (pack.access === 'sample') return 'Sample';
  if (pack.access === 'open') return 'Available';
  if (pack.access === 'error') return 'Balance check failed';
  return 'Locked';
}

export function socialScreen(onClose: () => void, onImported: (added: number) => void): Screen {
  const root = h('div', { class: 'screen social' });
  let catalog: Catalog | undefined;
  let snapshot: SocialSnapshot = { packs: [], loading: true };
  let closed = false;

  const header = h('div', { class: 'social-head' });
  const list = h('div', { class: 'social-list' });
  const status = h('p', { class: 'notice', role: 'status' });

  function render(): void {
    const wallet = snapshot.walletAddress ? `${snapshot.walletAddress.slice(0, 6)}…${snapshot.walletAddress.slice(-4)}` : 'Anonymous';
    header.replaceChildren(
      h('button', { class: 'ghost', onclick: onClose }, '← Songs'),
      h('strong', {}, 'Social packs'),
      h('span', { class: 'wallet' }, wallet),
      snapshot.walletAddress ? h('button', { class: 'ghost', onclick: () => void catalog?.disconnect() }, 'Disconnect') : h('button', { class: 'primary', onclick: () => void catalog?.connect() }, 'Connect wallet'),
      h('button', { class: 'ghost', onclick: () => void catalog?.refresh() }, snapshot.loading ? 'Loading…' : 'Refresh'),
    );
    const rows: HTMLElement[] = [];
    if (snapshot.error) rows.push(h('p', { class: 'notice error' }, `Feed error: ${snapshot.error}`));
    if (snapshot.walletError) rows.push(h('p', { class: 'notice error' }, `Wallet error: ${snapshot.walletError}`));
    if (snapshot.packs.length === 0 && !snapshot.loading) rows.push(h('p', { class: 'notice' }, 'No packs found. Publish haven.file.full records with a stepmania-pack manifest.'));
    for (const pack of snapshot.packs) {
      const canDownload = pack.access === 'sample' || pack.access === 'open';
      const busy = pack.importState === 'downloading' || pack.importState === 'importing';
      rows.push(
        h('article', { class: `pack-card access-${pack.access}${busy ? ' busy' : ''}` },
          h('div', { class: 'pack-main' },
            h('div', { class: 'pack-title' }, pack.title, pack.sample ? h('span', { class: 'badge sample' }, 'sample') : null),
            h('div', { class: 'pack-meta' }, pack.album ?? pack.media.name ?? 'StepMania pack', pack.media.size ? ` · ${megabytes(pack.media.size)}` : '', pack.songs.length ? ` · ${pack.songs.length} song${pack.songs.length === 1 ? '' : 's'}` : ''),
            pack.songs.length ? h('div', { class: 'pack-songs' }, pack.songs.slice(0, 6).map((song) => h('span', {}, `${song.artist} — ${song.title}`)).flatMap((el, i) => (i === 0 ? [el] : [', ', el]))) : null,
            h('div', { class: `pack-state ${pack.importState ?? ''}` }, accessLabel(pack)),
          ),
          canDownload || busy ? h('button', { class: 'primary', disabled: busy || !canDownload, onclick: () => void catalog?.download(pack.id, (added) => { if (added > 0) onImported(added); }) }, busy ? 'Working…' : pack.importState === 'done' ? 'Import again' : 'Download') : null,
        ),
      );
    }
    list.replaceChildren(...rows);
  }

  void import('../social/catalog.ts').then(({ createSocialCatalog }) => {
    if (closed) return;
    catalog = createSocialCatalog((next) => {
      snapshot = next;
      if (!closed) render();
    });
    void catalog.refresh();
  });

  root.append(header, status, list);
  render();
  return {
    root,
    close() {
      closed = true;
    },
  };
}
