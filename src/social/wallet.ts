// Lazy AppKit/wagmi wallet boundary. No React; framework-agnostic AppKit only.

import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createAppKit } from '@reown/appkit';
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, optimism, optimismSepolia, sepolia } from '@reown/appkit/networks';
import type { AppKitNetwork } from '@reown/appkit/networks';
import { connect, disconnect, getConnection, signTypedData, switchChain, watchConnection, type Config } from '@wagmi/core';
import type { SocialConfig } from './config.ts';
import type { SocialSigner } from './aol.ts';

const networks = [mainnet, base, optimism, arbitrum, sepolia, baseSepolia, optimismSepolia, arbitrumSepolia] as [AppKitNetwork, ...AppKitNetwork[]];

interface WalletState {
  config: SocialConfig;
  wagmiConfig: Config;
  modal: ReturnType<typeof createAppKit> | null;
  listeners: Set<(address: string | undefined) => void>;
  stopWatch?: () => void;
}

let statePromise: Promise<WalletState> | undefined;

async function ensure(config: SocialConfig): Promise<WalletState> {
  if (!statePromise) {
    statePromise = (async () => {
      const adapter = new WagmiAdapter({ projectId: config.walletConnectProjectId || 'unset', networks });
      const wagmiConfig = adapter.wagmiConfig;
      const listeners = new Set<(address: string | undefined) => void>();
      const state: WalletState = { config, wagmiConfig, modal: null, listeners };
      if (config.walletConnectProjectId) {
        state.modal = createAppKit({
          adapters: [adapter],
          projectId: config.walletConnectProjectId,
          networks,
          metadata: { name: 'Dance', description: 'StepMania packs from your DataDAO feeds.', url: typeof location === 'undefined' ? 'http://localhost' : location.origin, icons: [] },
          themeMode: 'dark',
          features: { analytics: false },
        });
      }
      state.stopWatch = watchConnection(wagmiConfig, {
        onChange: (connection) => {
          const address = connection.addresses?.[0];
          for (const listener of listeners) listener(address);
        },
      });
      return state;
    })();
  }
  return statePromise;
}

export async function walletStatus(config: SocialConfig): Promise<string | undefined> {
  const state = await ensure(config);
  const connection = getConnection(state.wagmiConfig);
  return connection.addresses?.[0];
}

export async function connectWallet(config: SocialConfig): Promise<string | undefined> {
  const state = await ensure(config);
  if (!config.walletConnectProjectId) throw new Error('VITE_DANCE_WALLETCONNECT_PROJECT_ID is not configured');
  state.modal?.open({ view: 'Connect' });
  for (let i = 0; i < 300; i++) {
    const address = await walletStatus(config);
    if (address) return address;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

export async function disconnectWallet(config: SocialConfig): Promise<void> {
  const state = await ensure(config);
  await disconnect(state.wagmiConfig).catch(() => undefined);
}

export function onWalletChange(config: SocialConfig, listener: (address: string | undefined) => void): () => void {
  void ensure(config).then((state) => state.listeners.add(listener));
  return () => {
    void statePromise?.then((state) => state.listeners.delete(listener));
  };
}

export async function walletSigner(config: SocialConfig): Promise<SocialSigner | undefined> {
  const state = await ensure(config);
  const connection = getConnection(state.wagmiConfig);
  const address = connection.addresses?.[0];
  if (!address) return undefined;
  const targetChainId = BigInt(config.eip712ChainId);
  const targetChain = state.wagmiConfig.chains.find((chain) => BigInt(chain.id) === targetChainId);
  return {
    address,
    async signTypedData(args) {
      const previous = connection.chainId;
      if (targetChain && previous !== targetChain.id) await switchChain(state.wagmiConfig, { chainId: targetChain.id }).catch(() => undefined);
      try {
        return await signTypedData(state.wagmiConfig, args as never);
      } finally {
        const current = getConnection(state.wagmiConfig).chainId;
        if (targetChain && current === targetChain.id && previous && previous !== targetChain.id) await switchChain(state.wagmiConfig, { chainId: previous }).catch(() => undefined);
      }
    },
  };
}
