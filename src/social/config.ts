// Runtime configuration for the social layer. Values are Vite-exposed and safe to ship.

export interface SocialConfig {
  arkivRpcUrl: string;
  arkivApiKey: string;
  walletConnectProjectId: string;
  icpHost: string;
  havenAolCanisterId: string;
  havenAolVerifyingContract: string;
  fetchRootKey: boolean;
  ipfsGateway: string;
  synapseBaseUrl: string;
  synapseApiKey: string;
  eip712ChainId: number;
  maxRecords: number;
}

function env(name: string, fallback = ''): string {
  const value = import.meta.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function socialConfig(): SocialConfig {
  const eip712 = Number(env('VITE_DANCE_EIP712_CHAIN_ID', '1'));
  const maxRecords = Number(env('VITE_DANCE_MAX_RECORDS', '200'));
  return {
    arkivRpcUrl: env('VITE_DANCE_ARKIV_RPC_URL', 'https://rpc.rabdi.db-chain.testnet.arkiv.network'),
    arkivApiKey: env('VITE_DANCE_ARKIV_API_KEY'),
    walletConnectProjectId: env('VITE_DANCE_WALLETCONNECT_PROJECT_ID'),
    icpHost: env('VITE_DANCE_ICP_HOST', 'https://icp0.io'),
    havenAolCanisterId: env('VITE_DANCE_HAVEN_AOL_CANISTER_ID', 'gny6k-fqaaa-aaaab-ag3ra-cai'),
    havenAolVerifyingContract: env('VITE_DANCE_HAVEN_AOL_VERIFYING_CONTRACT', '0x0000000000000000000000000000000000000000'),
    fetchRootKey: env('VITE_DANCE_HAVEN_AOL_FETCH_ROOT_KEY', 'false') === 'true',
    ipfsGateway: env('VITE_DANCE_IPFS_GATEWAY', 'https://w3s.link'),
    synapseBaseUrl: env('VITE_DANCE_SYNAPSE_BASE_URL', 'https://api.synapse.storage'),
    synapseApiKey: env('VITE_DANCE_SYNAPSE_API_KEY'),
    eip712ChainId: Number.isSafeInteger(eip712) && eip712 > 0 ? eip712 : 1,
    maxRecords: Number.isSafeInteger(maxRecords) && maxRecords > 0 ? maxRecords : 200,
  };
}
