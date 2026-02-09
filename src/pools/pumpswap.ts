import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { PoolInfo } from './types';

export const PUMPSWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMPSWAP_GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
export const PUMPSWAP_FEE_RECIPIENT = new PublicKey('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');
export const PUMPSWAP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const POOL_DATA_SIZE = 301;
const POOL_DISCRIMINATOR = 'f19a6d0411b16dbc';
const ACTIVE_STATUS = 0xff;

export interface PumpSwapPoolData {
  address: PublicKey;
  poolCreator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  status: number;
}

export function parsePumpSwapPool(address: PublicKey, data: Buffer): PumpSwapPoolData | null {
  if (data.length !== POOL_DATA_SIZE) return null;
  const disc = data.subarray(0, 8).toString('hex');
  if (disc !== POOL_DISCRIMINATOR) return null;
  const status = data[8];
  if (status !== ACTIVE_STATUS) return null;

  return {
    address,
    poolCreator: new PublicKey(data.subarray(11, 43)),
    baseMint: new PublicKey(data.subarray(43, 75)),
    quoteMint: new PublicKey(data.subarray(75, 107)),
    lpMint: new PublicKey(data.subarray(107, 139)),
    baseVault: new PublicKey(data.subarray(139, 171)),
    quoteVault: new PublicKey(data.subarray(171, 203)),
    status,
  };
}

export function getPumpSwapEventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMPSWAP_PROGRAM,
  )[0];
}

export function getPumpSwapPoolAuthority(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_authority'), pool.toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
}

/**
 * Discover PumpSwap pools for given token mints using Helius enhanced transaction API.
 * Looks for recent PUMP_AMM swap transactions involving the mint and extracts pool addresses.
 */
async function discoverPoolsViaHelius(
  connection: Connection,
  tokenMints: string[],
  rpcUrl: string,
): Promise<Map<string, PublicKey>> {
  const poolMap = new Map<string, PublicKey>();
  const apiKey = rpcUrl.match(/api-key=([^&]+)/)?.[1];
  if (!apiKey) return poolMap;

  for (const mint of tokenMints) {
    try {
      const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${apiKey}&limit=20&type=SWAP`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) continue;
      const txs: any[] = await resp.json() as any[];

      for (const tx of txs) {
        if (tx.source !== 'PUMP_AMM') continue;
        // Check if our mint is directly involved in the swap (not multi-hop through another pool)
        const transfers = tx.tokenTransfers || [];
        const mintTransfers = transfers.filter((t: any) => t.mint === mint);
        const solTransfers = transfers.filter((t: any) => t.mint === SOL_MINT.toBase58());
        if (mintTransfers.length === 0 || solTransfers.length === 0) continue;

        // The pool's vault accounts are the fromUserAccount/toUserAccount for the token transfers
        // We need to find the account that's both a token vault for our mint AND SOL
        const mintAccounts = new Set(mintTransfers.flatMap((t: any) => [t.fromUserAccount, t.toUserAccount]));
        const solAccounts = new Set(solTransfers.flatMap((t: any) => [t.fromUserAccount, t.toUserAccount]));
        const commonAccounts = [...mintAccounts].filter(a => solAccounts.has(a));

        // Check each common account — the pool is the owner of the vaults
        for (const acct of commonAccounts) {
          if (!acct) continue;
          const info = await connection.getAccountInfo(new PublicKey(acct));
          if (info && info.owner.equals(PUMPSWAP_PROGRAM) && info.data.length === POOL_DATA_SIZE) {
            poolMap.set(mint, new PublicKey(acct));
            break;
          }
        }
        if (poolMap.has(mint)) break;
      }
    } catch (e: any) {
      // Silent fail per token
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return poolMap;
}

/**
 * Fetch PumpSwap pools for a list of token mints.
 * Uses Helius enhanced API for pool discovery, then reads pool data on-chain.
 */
export async function fetchPumpSwapPools(
  connection: Connection,
  tokenMints: string[],
  rpcUrl?: string,
): Promise<PoolInfo[]> {
  const pools: PoolInfo[] = [];

  // Step 1: Discover pool addresses
  const poolAddresses = rpcUrl
    ? await discoverPoolsViaHelius(connection, tokenMints, rpcUrl)
    : new Map<string, PublicKey>();

  if (poolAddresses.size === 0) {
    console.log(`   PumpSwap: no pools discovered for current tokens`);
    return pools;
  }

  // Step 2: Batch fetch pool account data
  const entries = [...poolAddresses.entries()];
  const poolInfos = await connection.getMultipleAccountsInfo(
    entries.map(([_, addr]) => addr),
  );

  // Step 3: Parse pools and read vault balances
  const vaultAddresses: PublicKey[] = [];
  const parsedPools: { mint: string; pool: PumpSwapPoolData }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const info = poolInfos[i];
    if (!info) continue;
    const parsed = parsePumpSwapPool(entries[i][1], info.data as Buffer);
    if (!parsed) continue;
    parsedPools.push({ mint: entries[i][0], pool: parsed });
    vaultAddresses.push(parsed.baseVault, parsed.quoteVault);
  }

  // Batch fetch vault balances
  if (vaultAddresses.length > 0) {
    const vaultInfos = await connection.getMultipleAccountsInfo(vaultAddresses);
    for (let i = 0; i < parsedPools.length; i++) {
      const { mint, pool } = parsedPools[i];
      const baseVaultInfo = vaultInfos[i * 2];
      const quoteVaultInfo = vaultInfos[i * 2 + 1];
      if (!baseVaultInfo || !quoteVaultInfo) continue;

      // Parse token account balances (amount at offset 64, 8 bytes LE)
      const baseBalance = baseVaultInfo.data.length >= 72
        ? (baseVaultInfo.data as Buffer).readBigUInt64LE(64)
        : 0n;
      const quoteBalance = quoteVaultInfo.data.length >= 72
        ? (quoteVaultInfo.data as Buffer).readBigUInt64LE(64)
        : 0n;

      if (baseBalance === 0n || quoteBalance === 0n) continue;

      // Determine which is SOL and which is the meme token
      const baseMintStr = pool.baseMint.toBase58();
      const isSolBase = baseMintStr === SOL_MINT.toBase58();
      const decimalsBase = isSolBase ? 9 : 6; // pump.fun tokens are 6 decimals
      const decimalsQuote = isSolBase ? 6 : 9;

      pools.push({
        address: pool.address,
        dex: 'pumpswap',
        poolType: 'amm-v4', // constant-product like AMM-V4
        tokenA: pool.baseMint,
        tokenB: pool.quoteMint,
        reserveA: new Decimal(baseBalance.toString()),
        reserveB: new Decimal(quoteBalance.toString()),
        fee: 25, // PumpSwap charges ~0.25% (25 bps)
        lastUpdate: Date.now(),
        decimalsA: decimalsBase,
        decimalsB: decimalsQuote,
        vaultA: pool.baseVault,
        vaultB: pool.quoteVault,
        authority: getPumpSwapPoolAuthority(pool.address),
      });
      console.log(`   ✅ pumpswap SOL/${mint.slice(0, 8)}... reserves: ${Number(isSolBase ? baseBalance : quoteBalance) / 1e9} SOL`);
    }
  }

  console.log(`   PumpSwap total: ${pools.length}`);
  return pools;
}
