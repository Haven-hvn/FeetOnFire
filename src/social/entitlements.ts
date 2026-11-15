// Token-gate entitlement checks for social packs.

import { createPublicClient, http } from 'viem';
import type { SocialConfig } from './config.ts';
import { gateKey, type ChainVariant, type GateResult, type GateTriple } from './protocol.ts';

const BALANCE_OF_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const VARIANT_TO_EIP155: Record<ChainVariant, number> = {
  EthMainnet: 1,
  EthSepolia: 11155111,
  BaseMainnet: 8453,
  BaseSepolia: 84532,
  OptimismMainnet: 10,
  OptimismSepolia: 11155420,
  ArbitrumOne: 42161,
  ArbitrumSepolia: 421614,
};

const DEFAULT_RPC: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  84532: 'https://base-sepolia-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  11155420: 'https://optimism-sepolia-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  421614: 'https://arbitrum-sepolia-rpc.publicnode.com',
};

const clients = new Map<number, ReturnType<typeof createPublicClient>>();

export function chainIdForGate(gate: GateTriple): number {
  return VARIANT_TO_EIP155[gate.chain];
}

function clientFor(chainId: number) {
  let client = clients.get(chainId);
  if (!client) {
    client = createPublicClient({ chain: { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [DEFAULT_RPC[chainId] ?? 'https://ethereum-rpc.publicnode.com'] } } }, transport: http(DEFAULT_RPC[chainId]) });
    clients.set(chainId, client);
  }
  return client;
}

export async function balanceOfGate(gate: GateTriple, owner: string, _config: SocialConfig): Promise<GateResult> {
  try {
    const chainId = chainIdForGate(gate);
    const client = clientFor(chainId);
    const balance = (await client.readContract({
      address: gate.tokenAddress as `0x${string}`,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [owner as `0x${string}`],
    })) as bigint;
    return { held: balance >= gate.threshold };
  } catch (error) {
    return { held: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function evaluateGates(gates: readonly GateTriple[], owner: string, config: SocialConfig): Promise<Map<string, GateResult>> {
  const unique = new Map<string, GateTriple>();
  for (const gate of gates) unique.set(gateKey(gate), gate);
  const entries = await Promise.all([...unique.entries()].map(async ([key, gate]) => [key, await balanceOfGate(gate, owner, config)] as const));
  return new Map(entries);
}
