// Lazy AppKit/wagmi wallet boundary. No React; framework-agnostic AppKit only.

import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createAppKit } from '@reown/appkit';
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, optimism, optimismSepolia, sepolia } from '@reown/appkit/networks';
import type { AppKitNetwork } from '@reown/appkit/networks';
import { connect, disconnect, getConnection, signTypedData, switchChain, watchConnection, type Config } from '@wagmi/core';
import { baseAccount } from '@wagmi/connectors/baseAccount';
import { coinbaseWallet } from '@wagmi/connectors/coinbaseWallet';
import type { SocialConfig } from './config.ts';
import type { SocialSigner } from './aol.ts';
import { registerHavenOsBridge, type HavenOsBridgeClient } from './os-bridge.ts';

const networks = [mainnet, base, optimism, arbitrum, sepolia, baseSepolia, optimismSepolia, arbitrumSepolia] as [AppKitNetwork, ...AppKitNetwork[]];

interface WalletState {
  config: SocialConfig;
  wagmiConfig: Config;
  modal: ReturnType<typeof createAppKit> | null;
  listeners: Set<(address: string | undefined) => void>;
  stopWatch?: () => void;
  bridge: HavenOsBridgeClient | null;
  bridgeAddress?: string;
}

let statePromise: Promise<WalletState> | undefined;

async function ensure(config: SocialConfig): Promise<WalletState> {
  if (!statePromise) {
    statePromise = (async () => {
      const bridge = registerHavenOsBridge({ appId: 'feetonfire' });
      const welcome = bridge ? await bridge.waitForWelcome(1200) : null;

      // AppKit's own Coinbase/Base connectors run telemetry that injects an inline
      // <script>, which the page CSP blocks. Supplying them here with telemetry off
      // keeps the wallets but skips the injection (and the console error).
      const adapter = new WagmiAdapter({
        projectId: config.walletConnectProjectId || 'unset',
        networks,
        connectors: [
          baseAccount({ preference: { options: 'all', telemetry: false } }),
          coinbaseWallet({ preference: { options: 'all', telemetry: false } }),
        ],
      });
      const wagmiConfig = adapter.wagmiConfig;
      const listeners = new Set<(address: string | undefined) => void>();
      const bridgeAddress =
        welcome?.wallet.address && !welcome.wallet.watchOnly ? welcome.wallet.address : undefined;
      const state: WalletState = {
        config,
        wagmiConfig,
        modal: null,
        listeners,
        bridge: welcome ? bridge : null,
        bridgeAddress,
      };
      if (state.bridge) {
        state.bridge.onEvent('accountsChanged', (accounts) => {
          const list = Array.isArray(accounts) ? accounts : [];
          state.bridgeAddress = typeof list[0] === 'string' ? list[0] : undefined;
          for (const listener of listeners) listener(state.bridgeAddress);
        });
      }
      if (config.walletConnectProjectId) {
        state.modal = createAppKit({
          adapters: [adapter],
          projectId: config.walletConnectProjectId,
          networks,
          metadata: { name: 'Dance', description: 'StepMania packs from your DataDAO feeds.', url: typeof location === 'undefined' ? 'http://localhost' : location.origin, icons: [] },
          themeMode: 'dark',
          features: { analytics: false },
          // Our coinbaseWallet connector above replaces the one AppKit would add.
          enableCoinbase: false,
        });
      }
      state.stopWatch = watchConnection(wagmiConfig, {
        onChange: (connection) => {
          if (state.bridge?.connectedToHost && state.bridgeAddress) return;
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
  if (state.bridge?.connectedToHost) return state.bridgeAddress;
  const connection = getConnection(state.wagmiConfig);
  return connection.addresses?.[0];
}

export async function connectWallet(config: SocialConfig): Promise<string | undefined> {
  const state = await ensure(config);
  if (state.bridge?.connectedToHost) {
    const accounts = (await state.bridge.provider.request({ method: 'eth_requestAccounts' })) as string[] | undefined;
    state.bridgeAddress = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : undefined;
    for (const listener of state.listeners) listener(state.bridgeAddress);
    return state.bridgeAddress;
  }
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
  if (state.bridge?.connectedToHost) {
    state.bridgeAddress = undefined;
    for (const listener of state.listeners) listener(undefined);
  }
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
  if (state.bridge?.connectedToHost && state.bridgeAddress) {
    const bridge = state.bridge;
    const address = state.bridgeAddress;
    const wantChainHex = `0x${Number(config.eip712ChainId).toString(16)}`;
    return {
      address,
      async signTypedData(args) {
        let previous: string | undefined;
        try {
          const cur = await bridge.provider.request({ method: 'eth_chainId' });
          if (typeof cur === 'string') previous = cur;
        } catch {
          // ignore
        }
        const needSwitch = !previous || previous.toLowerCase() !== wantChainHex.toLowerCase();
        if (needSwitch) {
          await bridge.provider
            .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: wantChainHex }] })
            .catch(() => undefined);
        }
        try {
          const payload = JSON.stringify(
            {
              domain: args.domain,
              types: args.types,
              primaryType: args.primaryType,
              message: args.message,
            },
            (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
          );
          const sig = await bridge.provider.request({
            method: 'eth_signTypedData_v4',
            params: [address, payload],
          });
          if (typeof sig !== 'string') throw new Error('Haven OS bridge returned an invalid signature');
          return sig;
        } finally {
          if (needSwitch && previous && previous.toLowerCase() !== wantChainHex.toLowerCase()) {
            await bridge.provider
              .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: previous }] })
              .catch(() => undefined);
          }
        }
      },
    };
  }
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
