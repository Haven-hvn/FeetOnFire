// Haven-AOL v3 epoch unlock for sealed Dance packs. Loaded only for gated media.

import { bytesToHex, hexToBytes, parseGateJson, type DancePack, type GateTriple } from './protocol.ts';
import type { SocialConfig } from './config.ts';
import { openSealedBytes } from './seal.ts';
import { getHavenOsBridge } from './os-bridge.ts';

export interface SocialSigner {
  address: string;
  signTypedData(args: { domain: Record<string, unknown>; types: Record<string, unknown[]>; primaryType: string; message: Record<string, unknown> }): Promise<string>;
}

type VetKey = InstanceType<typeof import('@icp-sdk/vetkeys').VetKey>;

const vetKeys = new Map<string, VetKey>();

function cacheKey(gate: GateTriple, epoch: bigint): string {
  return `${gate.chain}:${gate.tokenAddress.toLowerCase()}:${gate.threshold.toString()}:${epoch.toString()}`;
}

export function hasUnlocked(pack: DancePack): boolean {
  const parsed = pack.gateJson ? parseGateJson(pack.gateJson) : undefined;
  return Boolean(parsed?.epoch !== undefined && vetKeys.has(cacheKey(parsed.gate, BigInt(parsed.epoch))));
}

export function forgetKeys(): void {
  vetKeys.clear();
}

export async function restorePackFromOsBridge(pack: DancePack): Promise<boolean> {
  if (!pack.gateJson) return false;
  const parsed = parseGateJson(pack.gateJson);
  if (!parsed || parsed.version !== 3 || parsed.epoch === undefined) return false;
  const epoch = BigInt(parsed.epoch);
  if (vetKeys.has(cacheKey(parsed.gate, epoch))) return true;
  const bridge = getHavenOsBridge();
  if (!bridge?.connectedToHost) return false;
  try {
    const res = await bridge.getGateKey({
      chainVariant: parsed.gate.chain,
      tokenAddress: parsed.gate.tokenAddress,
      threshold: parsed.gate.threshold.toString(),
      epoch: Number(parsed.epoch),
    });
    if (!res?.vetKeyBase64) return false;
    const vetkeys = await import('@icp-sdk/vetkeys');
    vetKeys.set(cacheKey(parsed.gate, epoch), vetkeys.VetKey.deserialize(base64Decode(res.vetKeyBase64)));
    return true;
  } catch {
    return false;
  }
}

function toHex(bytes: Uint8Array): `0x${string}` {
  return bytesToHex(bytes) as `0x${string}`;
}

function parseSignatureHex(signatureHex: string): Uint8Array {
  const normalized = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
  if (!/^[0-9a-fA-F]{130}$/.test(normalized)) throw new Error('signature must be a 65-byte hex string');
  return hexToBytes(normalized);
}

async function computeDerivationInputV3(chain: GateTriple['chain'], tokenAddress: string, threshold: bigint, epoch: bigint): Promise<Uint8Array> {
  const preimage = `accessol_v3:${chain}:${tokenAddress}:${threshold.toString()}:${epoch.toString()}`;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage)));
}

function buildGateRequestV3TypedData(args: { evmAddress: string; transportPublicKey: Uint8Array; epoch: bigint; nonce: bigint; eip712ChainId: bigint; eip712VerifyingContract: string }) {
  return {
    domain: { name: 'HavenAOL', chainId: args.eip712ChainId, verifyingContract: args.eip712VerifyingContract },
    primaryType: 'GateRequestV3',
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      GateRequestV3: [
        { name: 'evmAddress', type: 'address' },
        { name: 'transportPublicKey', type: 'bytes' },
        { name: 'epoch', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    message: {
      evmAddress: args.evmAddress,
      transportPublicKey: toHex(args.transportPublicKey),
      epoch: args.epoch,
      nonce: args.nonce,
    },
  } as const;
}

function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return BigInt(bytesToHex(bytes));
}

async function agent(config: SocialConfig) {
  const { HttpAgent, AnonymousIdentity } = await import('@icp-sdk/core/agent');
  const a = await HttpAgent.create({ host: config.icpHost, identity: new AnonymousIdentity(), verifyQuerySignatures: false });
  if (config.fetchRootKey) await a.fetchRootKey();
  return a;
}

async function v3Actor(config: SocialConfig) {
  const { Actor } = await import('@icp-sdk/core/agent');
  const { IDL } = await import('@icp-sdk/core/candid');
  const chainVariant = IDL.Variant({ EthMainnet: IDL.Null, EthSepolia: IDL.Null, ArbitrumOne: IDL.Null, BaseMainnet: IDL.Null, OptimismMainnet: IDL.Null });
  const req = IDL.Record({
    chain: chainVariant,
    tokenAddress: IDL.Text,
    threshold: IDL.Nat,
    epoch: IDL.Nat,
    evmAddress: IDL.Text,
    transportPublicKey: IDL.Vec(IDL.Nat8),
    nonce: IDL.Nat,
    signature: IDL.Vec(IDL.Nat8),
    eip712ChainId: IDL.Nat,
    eip712VerifyingContract: IDL.Text,
  });
  const err = IDL.Variant({
    InsufficientBalance: IDL.Record({ required: IDL.Nat, actual: IDL.Nat }),
    InvalidAddress: IDL.Text,
    InvalidThreshold: IDL.Null,
    EvmRpcError: IDL.Text,
    VetKDError: IDL.Text,
    InvalidSignature: IDL.Text,
    NonceAlreadyUsed: IDL.Null,
    InvalidEpoch: IDL.Null,
  });
  const res = IDL.Variant({ ok: IDL.Record({ encrypted_key: IDL.Vec(IDL.Nat8), verification_key: IDL.Vec(IDL.Nat8) }), err });
  const factory = () => IDL.Service({ requestDecryptionKeyV3: IDL.Func([req], [res], []) });
  return Actor.createActor(factory, { agent: await agent(config), canisterId: config.havenAolCanisterId }) as unknown as { requestDecryptionKeyV3(args: Record<string, unknown>): Promise<unknown> };
}

function gateErrorMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'canister rejected the unlock';
  if ('InsufficientBalance' in err) return 'this wallet does not hold the gate token at this epoch';
  if ('InvalidEpoch' in err) return 'epoch not open for unlock yet';
  if ('NonceAlreadyUsed' in err) return 'nonce collision';
  if ('InvalidSignature' in err) return 'invalid signature';
  if ('EvmRpcError' in err) return 'gate RPC error';
  if ('VetKDError' in err) return 'key error';
  return 'canister rejected the unlock';
}

export async function unlockPack(pack: DancePack, signer: SocialSigner, config: SocialConfig, onProgress?: (message: string | null) => void): Promise<void> {
  if (!pack.gateJson) throw new Error('sealed pack has no gate metadata');
  const parsed = parseGateJson(pack.gateJson);
  if (!parsed || parsed.version !== 3 || parsed.epoch === undefined) throw new Error('only Haven-AOL v3 epoch gates are supported');
  if (hasUnlocked(pack)) return;
  if (await restorePackFromOsBridge(pack)) {
    onProgress?.(null);
    return;
  }
  const bridge = getHavenOsBridge();
  if (bridge?.connectedToHost) {
    try {
      onProgress?.('Unlocking via Haven OS keyring…');
      const res = await bridge.unlockGate({
        chainVariant: parsed.gate.chain,
        tokenAddress: parsed.gate.tokenAddress,
        threshold: parsed.gate.threshold.toString(),
        epoch: Number(parsed.epoch),
      });
      if (res?.vetKeyBase64) {
        const vetkeys = await import('@icp-sdk/vetkeys');
        vetKeys.set(cacheKey(parsed.gate, BigInt(parsed.epoch)), vetkeys.VetKey.deserialize(base64Decode(res.vetKeyBase64)));
        onProgress?.(null);
        return;
      }
    } catch {
      // Fall through to local GateRequestV3 flow
    }
  }
  const supported = new Set(['EthMainnet', 'EthSepolia', 'ArbitrumOne', 'BaseMainnet', 'OptimismMainnet']);
  if (!supported.has(parsed.gate.chain)) throw new Error(`Haven-AOL v3 does not support ${parsed.gate.chain}`);
  const vetkeys = await import('@icp-sdk/vetkeys');
  onProgress?.('Preparing signature…');
  const secretKey = vetkeys.TransportSecretKey.random();
  const publicKey = secretKey.publicKeyBytes();
  const nonce = randomNonce();
  const epoch = BigInt(parsed.epoch);
  const typed = buildGateRequestV3TypedData({
    evmAddress: signer.address,
    transportPublicKey: publicKey,
    epoch,
    nonce,
    eip712ChainId: BigInt(config.eip712ChainId),
    eip712VerifyingContract: config.havenAolVerifyingContract,
  });
  onProgress?.('Sign to unlock (no gas)…');
  const signatureHex = await signer.signTypedData({ domain: typed.domain as unknown as Record<string, unknown>, types: typed.types as unknown as Record<string, unknown[]>, primaryType: typed.primaryType, message: typed.message as unknown as Record<string, unknown> });
  const signature = parseSignatureHex(signatureHex);
  onProgress?.('Requesting epoch key…');
  const actor = await v3Actor(config);
  const raw = await actor.requestDecryptionKeyV3({
    chain: { [parsed.gate.chain]: null },
    tokenAddress: parsed.gate.tokenAddress,
    threshold: parsed.gate.threshold,
    epoch,
    evmAddress: signer.address,
    transportPublicKey: publicKey,
    nonce,
    signature,
    eip712ChainId: BigInt(config.eip712ChainId),
    eip712VerifyingContract: config.havenAolVerifyingContract,
  });
  if (typeof raw !== 'object' || raw === null || !('ok' in raw)) throw new Error(gateErrorMessage((raw as { err?: unknown }).err));
  const ok = (raw as { ok: { encrypted_key: ArrayLike<number>; verification_key: ArrayLike<number> } }).ok;
  onProgress?.('Recovering key…');
  const derivationInput = await computeDerivationInputV3(parsed.gate.chain, parsed.gate.tokenAddress, parsed.gate.threshold, epoch);
  const vetKey = vetkeys.EncryptedVetKey.deserialize(new Uint8Array(ok.encrypted_key)).decryptAndVerify(secretKey, vetkeys.DerivedPublicKey.deserialize(new Uint8Array(ok.verification_key)), derivationInput);
  vetKeys.set(cacheKey(parsed.gate, epoch), vetKey);
  onProgress?.(null);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function decryptPackBytes(pack: DancePack, sealed: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  if (!pack.gateJson) throw new Error('sealed pack has no gate metadata');
  const parsed = parseGateJson(pack.gateJson);
  if (!parsed || parsed.version !== 3 || parsed.epoch === undefined) throw new Error('only Haven-AOL v3 epoch gates are supported');
  const vetKey = vetKeys.get(cacheKey(parsed.gate, BigInt(parsed.epoch)));
  if (!vetKey) throw new Error('epoch key not unlocked on this device');
  const raw = parsed.raw as { encryptedAesKey?: unknown };
  if (typeof raw.encryptedAesKey !== 'string') throw new Error('gate metadata has no encrypted AES key');
  const vetkeys = await import('@icp-sdk/vetkeys');
  const aesKey = vetkeys.IbeCiphertext.deserialize(base64Decode(raw.encryptedAesKey)).decrypt(vetKey);
  return openSealedBytes(sealed, aesKey, onProgress);
}
