import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import Decimal from 'decimal.js';
import { PoolInfo } from './types';

export const PUMPFUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMPFUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ1w8Tt5KwKc');
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export interface BondingCurveData {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export function getBondingCurvePDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMPFUN_PROGRAM,
  )[0];
}

export function getGlobalPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PUMPFUN_PROGRAM,
  )[0];
}

export function getEventAuthorityPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMPFUN_PROGRAM,
  )[0];
}

export function parseBondingCurve(data: Buffer): BondingCurveData | null {
  if (data.length < 49) return null;
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data[48] !== 0,
  };
}

export async function fetchBondingCurve(
  connection: Connection,
  mint: PublicKey,
): Promise<BondingCurveData | null> {
  const pda = getBondingCurvePDA(mint);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return parseBondingCurve(info.data as Buffer);
}

/** Calculate buy output: solIn → tokens out (before fee) */
export function getBuyQuote(curve: BondingCurveData, solIn: bigint): bigint {
  const solAfterFee = solIn * 99n / 100n; // 1% fee
  const newSolReserves = curve.virtualSolReserves + solAfterFee;
  const k = curve.virtualTokenReserves * curve.virtualSolReserves;
  const newTokenReserves = k / newSolReserves;
  return curve.virtualTokenReserves - newTokenReserves;
}

/** Calculate sell output: tokensIn → SOL out (before fee) */
export function getSellQuote(curve: BondingCurveData, tokensIn: bigint): bigint {
  const newTokenReserves = curve.virtualTokenReserves + tokensIn;
  const k = curve.virtualTokenReserves * curve.virtualSolReserves;
  const newSolReserves = k / newTokenReserves;
  const solOut = curve.virtualSolReserves - newSolReserves;
  return solOut * 99n / 100n; // 1% fee
}

/**
 * Fetch pump.fun bonding curves for a list of mints and return as PoolInfo[].
 * Skips graduated (complete=true) curves.
 */
export async function fetchPumpFunPools(
  connection: Connection,
  tokenMints: string[],
): Promise<PoolInfo[]> {
  const pools: PoolInfo[] = [];
  const pdas = tokenMints.map(m => getBondingCurvePDA(new PublicKey(m)));

  // Batch fetch in chunks of 100
  const CHUNK = 100;
  for (let i = 0; i < pdas.length; i += CHUNK) {
    const chunk = pdas.slice(i, i + CHUNK);
    const mints = tokenMints.slice(i, i + CHUNK);
    const infos = await connection.getMultipleAccountsInfo(chunk);

    for (let j = 0; j < infos.length; j++) {
      const info = infos[j];
      if (!info) continue;
      const curve = parseBondingCurve(info.data as Buffer);
      if (!curve || curve.complete) continue;
      if (curve.realSolReserves === 0n) continue;

      const mint = new PublicKey(mints[j]);
      const bondingCurve = pdas[i + j];

      pools.push({
        address: bondingCurve,
        dex: 'pumpfun',
        poolType: 'bonding-curve',
        tokenA: SOL_MINT,
        tokenB: mint,
        reserveA: new Decimal(curve.virtualSolReserves.toString()),
        reserveB: new Decimal(curve.virtualTokenReserves.toString()),
        fee: 100, // 1% = 100 bps
        lastUpdate: Date.now(),
        decimalsA: 9,
        decimalsB: 6, // pump.fun tokens are 6 decimals
        // Store vault for swap instructions
        vaultA: undefined, // SOL goes to bonding curve directly
        vaultB: getAssociatedTokenAddressSync(mint, bondingCurve, true),
      });
      console.log(`   ✅ pumpfun[bonding-curve] SOL/${mints[j].slice(0, 8)}... reserves: ${Number(curve.realSolReserves) / 1e9} SOL`);
    }
  }
  console.log(`   PumpFun total: ${pools.length}`);
  return pools;
}
