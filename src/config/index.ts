import dotenv from 'dotenv';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

dotenv.config();

// Wallet
const secretKey = bs58.decode(process.env.PRIVATE_KEY!);
export const wallet = Keypair.fromSecretKey(secretKey);

// Connections
export const connection = new Connection(process.env.RPC_HTTP!, {
  wsEndpoint: process.env.RPC_WSS!,
  commitment: 'confirmed',
});

// Trading params
export const config = {
  dryRun: process.env.DRY_RUN === 'true',
  minProfitBps: parseInt(process.env.MIN_PROFIT_BPS || '50'),
  maxTradeSizeSol: parseFloat(process.env.MAX_TRADE_SIZE_SOL || '0.5'),
  slippageBps: parseInt(process.env.SLIPPAGE_BPS || '100'),
  pollIntervalMs: 500, // ~1 Solana slot
};

// Well-known tokens
export const TOKENS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
};

// DEX Program IDs
export const PROGRAMS = {
  RAYDIUM_AMM: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  RAYDIUM_CLMM: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
  ORCA_WHIRLPOOL: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
  PUMPFUN: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  PUMPSWAP: new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
};

console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
console.log(`  Mode: ${config.dryRun ? 'DRY RUN' : ' LIVE'}`);
