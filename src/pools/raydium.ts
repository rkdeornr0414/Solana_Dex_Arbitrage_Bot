import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { PoolInfo } from './types';
import { PROGRAMS } from '../config';

// Raydium AMM V4 account layout offsets
const AMM_LAYOUT = {
  tokenAMint: 400,
  tokenBMint: 432,
  tokenAVault: 336,
  tokenBVault: 368,
  fees: 4, // fee numerator at offset
};

export class RaydiumFetcher {
  constructor(private connection: Connection) {}

  async getPoolsByTokenPair(tokenA: PublicKey, tokenB: PublicKey): Promise<PoolInfo[]> {
    // Fetch Raydium AMM pools via getProgramAccounts
    // Filter by token mints
    const accounts = await this.connection.getProgramAccounts(PROGRAMS.RAYDIUM_AMM, {
      filters: [
        { dataSize: 752 }, // AMM V4 account size
      ],
    });

    const pools: PoolInfo[] = [];

    for (const { pubkey, account } of accounts) {
      try {
        const data = account.data;
        const mintA = new PublicKey(data.slice(400, 432));
        const mintB = new PublicKey(data.slice(432, 464));

        // Check if this pool matches our token pair (either direction)
        const matchForward = mintA.equals(tokenA) && mintB.equals(tokenB);
        const matchReverse = mintA.equals(tokenB) && mintB.equals(tokenA);

        if (!matchForward && !matchReverse) continue;

        // Get vault balances
        const vaultA = new PublicKey(data.slice(336, 368));
        const vaultB = new PublicKey(data.slice(368, 400));

        const [balA, balB] = await Promise.all([
          this.connection.getTokenAccountBalance(vaultA),
          this.connection.getTokenAccountBalance(vaultB),
        ]);

        pools.push({
          address: pubkey,
          dex: 'raydium',
          poolType: 'amm-v4',
          tokenA: mintA,
          tokenB: mintB,
          reserveA: new Decimal(balA.value.amount),
          reserveB: new Decimal(balB.value.amount),
          fee: 25, // Raydium standard 0.25%
          lastUpdate: Date.now(),
        });
      } catch (e) {
        continue;
      }
    }

    return pools;
  }

  /**
   * Calculate output amount using constant-product formula (Lasagne paper Eq. 2)
   * (x + Δx)(y - Δy) = k  →  Δy = y * Δx / (x + Δx)
   * After fee: Δx_effective = Δx * (1 - fee)
   */
  static getAmountOut(
    amountIn: Decimal,
    reserveIn: Decimal,
    reserveOut: Decimal,
    feeBps: number
  ): Decimal {
    const feeMultiplier = new Decimal(10000 - feeBps).div(10000);
    const effectiveIn = amountIn.mul(feeMultiplier);
    const numerator = effectiveIn.mul(reserveOut);
    const denominator = reserveIn.add(effectiveIn);
    return numerator.div(denominator).floor();
  }
}
