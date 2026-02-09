import { PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';

export interface PoolInfo {
  address: PublicKey;
  dex: 'raydium' | 'orca' | 'pumpfun' | 'pumpswap';
  poolType: 'amm-v4' | 'clmm' | 'cpmm' | 'whirlpool' | 'bonding-curve';
  tokenA: PublicKey;
  tokenB: PublicKey;
  reserveA: Decimal;
  reserveB: Decimal;
  fee: number; // basis points
  lastUpdate: number;
  // On-chain accounts needed for swap instructions
  vaultA?: PublicKey;
  vaultB?: PublicKey;
  authority?: PublicKey;      // pool authority / PDA
  openOrders?: PublicKey;     // Raydium AMM open orders
  targetOrders?: PublicKey;   // Raydium AMM target orders
  marketId?: PublicKey;       // Raydium AMM serum market
  marketProgramId?: PublicKey;
  marketAuthority?: PublicKey;
  marketBaseVault?: PublicKey;
  marketQuoteVault?: PublicKey;
  marketBids?: PublicKey;
  marketAsks?: PublicKey;
  marketEventQueue?: PublicKey;
  tickArrays?: PublicKey[];   // CLMM / Whirlpool tick arrays
  oracle?: PublicKey;         // Whirlpool oracle
  decimalsA?: number;
  decimalsB?: number;
  sqrtPriceX64?: Decimal;  // For concentrated liquidity pools (whirlpool/CLMM)
  orcaApiPrice?: Decimal;  // Direct price from Orca API (tokenB per tokenA in human units)
}

export interface PriceQuote {
  pool: PoolInfo;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputAmount: Decimal;
  outputAmount: Decimal;
  priceImpact: Decimal;
  effectivePrice: Decimal;
}

export interface ArbOpportunity {
  type: 'spatial' | 'temporal' | 'triangular';
  buyPool: PoolInfo;
  sellPool: PoolInfo;
  tokenMint: PublicKey;
  inputAmount: Decimal;
  expectedProfit: Decimal;
  profitBps: number;
  timestamp: number;
}
