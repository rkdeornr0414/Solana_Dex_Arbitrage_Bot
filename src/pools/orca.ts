import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { PoolInfo } from './types';
import { PROGRAMS } from '../config';

// Orca Whirlpool account layout
const WHIRLPOOL_SIZE = 653;

export class OrcaFetcher {
  constructor(private connection: Connection) {}

  async getPoolsByTokenPair(tokenA: PublicKey, tokenB: PublicKey): Promise<PoolInfo[]> {
    const accounts = await this.connection.getProgramAccounts(PROGRAMS.ORCA_WHIRLPOOL, {
      filters: [
        { dataSize: WHIRLPOOL_SIZE },
      ],
    });

    const pools: PoolInfo[] = [];

    for (const { pubkey, account } of accounts) {
      try {
        const data = account.data;

        // Whirlpool layout: tokenMintA at offset 101, tokenMintB at offset 181
        const mintA = new PublicKey(data.slice(101, 133));
        const mintB = new PublicKey(data.slice(181, 213));

        const matchForward = mintA.equals(tokenA) && mintB.equals(tokenB);
        const matchReverse = mintA.equals(tokenB) && mintB.equals(tokenA);

        if (!matchForward && !matchReverse) continue;

        // Token vaults: vaultA at offset 133, vaultB at offset 213
        const vaultA = new PublicKey(data.slice(133, 165));
        const vaultB = new PublicKey(data.slice(213, 245));

        const [balA, balB] = await Promise.all([
          this.connection.getTokenAccountBalance(vaultA),
          this.connection.getTokenAccountBalance(vaultB),
        ]);

        // Fee rate from whirlpool data (u16 at offset 65)
        const feeRate = data.readUInt16LE(65); // in hundredths of a bip

        pools.push({
          address: pubkey,
          dex: 'orca',
          poolType: 'whirlpool',
          tokenA: mintA,
          tokenB: mintB,
          reserveA: new Decimal(balA.value.amount),
          reserveB: new Decimal(balB.value.amount),
          fee: Math.ceil(feeRate / 100), // convert to bps
          lastUpdate: Date.now(),
        });
      } catch (e) {
        continue;
      }
    }

    return pools;
  }

  /**
   * Concentrated liquidity quote (simplified for active range)
   * For meme coins, most liquidity is in a single wide range,
   * so constant-product approximation works reasonably well.
   * Full tick-based computation would be needed for production.
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
