import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { PoolInfo, PriceQuote } from './types';
import { fetchPoolsFromAPIs } from './registry';

export class PoolManager {
  private pools: PoolInfo[] = [];

  constructor(private connection: Connection) {}

  async init(tokenMints: string[]): Promise<PoolInfo[]> {
    console.log('📡 Fetching pools from DEX APIs...\n');
    this.pools = await fetchPoolsFromAPIs(tokenMints, this.connection);
    console.log(`\n📊 ${this.pools.length} pools ready`);
    return this.pools;
  }

  getPoolsForPair(tokenA: PublicKey, tokenB: PublicKey): PoolInfo[] {
    return this.pools.filter(p =>
      (p.tokenA.equals(tokenA) && p.tokenB.equals(tokenB)) ||
      (p.tokenB.equals(tokenA) && p.tokenA.equals(tokenB))
    );
  }

  getAllPools(): PoolInfo[] {
    return this.pools;
  }

  getQuote(pool: PoolInfo, inputMint: PublicKey, inputAmount: Decimal): PriceQuote {
    const isForward = pool.tokenA.equals(inputMint);
    const reserveIn = isForward ? pool.reserveA : pool.reserveB;
    const reserveOut = isForward ? pool.reserveB : pool.reserveA;
    const outputMint = isForward ? pool.tokenB : pool.tokenA;

    let outputAmount: Decimal;

    // For Orca whirlpools, use API price directly (most accurate, no RPC needed)
    if (pool.orcaApiPrice && pool.orcaApiPrice.gt(0)) {
      // orcaApiPrice = tokenB per tokenA in HUMAN units
      // Convert to raw: rawPrice = apiPrice * 10^decimalsB / 10^decimalsA
      const decA = pool.decimalsA || 9;
      const decB = pool.decimalsB || 9;
      const rawPrice = pool.orcaApiPrice.mul(new Decimal(10).pow(decB)).div(new Decimal(10).pow(decA));
      const feeMultiplier = new Decimal(10000 - pool.fee).div(10000);
      const effectiveIn = inputAmount.mul(feeMultiplier);

      if (isForward) {
        outputAmount = effectiveIn.mul(rawPrice).floor();
      } else {
        outputAmount = effectiveIn.div(rawPrice).floor();
      }
    } else if ((pool.poolType === 'whirlpool' || pool.poolType === 'clmm') && pool.sqrtPriceX64) {
      const Q64 = new Decimal(2).pow(64);
      const sqrtPrice = pool.sqrtPriceX64.div(Q64);
      const price = sqrtPrice.mul(sqrtPrice);
      const feeMultiplier = new Decimal(10000 - pool.fee).div(10000);
      const effectiveIn = inputAmount.mul(feeMultiplier);

      if (isForward) {
        outputAmount = effectiveIn.mul(price).floor();
      } else {
        outputAmount = effectiveIn.div(price).floor();
      }
    } else {
      outputAmount = this.getAmountOut(inputAmount, reserveIn, reserveOut, pool.fee);
    }

    const actualRate = inputAmount.isZero() ? new Decimal(0) : outputAmount.div(inputAmount);
    const idealRate = reserveIn.isZero() ? new Decimal(0) : reserveOut.div(reserveIn);
    const priceImpact = idealRate.isZero() ? new Decimal(0) : new Decimal(1).minus(actualRate.div(idealRate));

    return { pool, inputMint, outputMint, inputAmount, outputAmount, priceImpact, effectivePrice: actualRate };
  }

  private getAmountOut(amountIn: Decimal, reserveIn: Decimal, reserveOut: Decimal, feeBps: number): Decimal {
    const feeMultiplier = new Decimal(10000 - feeBps).div(10000);
    const effectiveIn = amountIn.mul(feeMultiplier);
    return effectiveIn.mul(reserveOut).div(reserveIn.add(effectiveIn)).floor();
  }
}
