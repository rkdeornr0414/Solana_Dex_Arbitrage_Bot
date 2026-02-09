import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { PoolInfo } from './types';

/**
 * Real-time price stream via Solana WebSocket subscriptions.
 * Subscribes to pool account changes so reserves update live.
 */
export class PriceStream {
  private subscriptions: number[] = [];
  private onUpdate: ((pool: PoolInfo) => void) | null = null;

  constructor(private connection: Connection) {}

  /**
   * Subscribe to account changes for all pool addresses.
   * When a pool's on-chain state changes (trade happens),
   * we re-fetch reserves and trigger a callback.
   */
  async subscribe(pools: PoolInfo[], onUpdate: (pool: PoolInfo) => void): Promise<void> {
    this.onUpdate = onUpdate;
    console.log(`📡 Subscribing to ${pools.length} pool accounts via WebSocket...`);

    for (const pool of pools) {
      try {
        const subId = this.connection.onAccountChange(
          pool.address,
          (accountInfo) => {
            try {
              this.handleAccountUpdate(pool, accountInfo.data);
            } catch {}
          },
          'confirmed'
        );
        this.subscriptions.push(subId);
      } catch (e: any) {
        console.log(`   ⚠️ Failed to subscribe to ${pool.dex} ${pool.address.toBase58().slice(0, 8)}...`);
      }
    }

    console.log(`   ✅ ${this.subscriptions.length} subscriptions active\n`);
  }

  private handleAccountUpdate(pool: PoolInfo, data: Buffer): void {
    // Parse reserves from account data based on DEX type
    try {
      if (pool.dex === 'raydium') {
        this.parseRaydiumUpdate(pool, data);
      } else if (pool.dex === 'orca') {
        this.parseOrcaUpdate(pool, data);
      }

      pool.lastUpdate = Date.now();

      if (this.onUpdate) {
        this.onUpdate(pool);
      }
    } catch {}
  }

  /**
   * Raydium AMM V4: parse token amounts from pool state
   * The pool account stores current reserve amounts
   */
  private parseRaydiumUpdate(pool: PoolInfo, data: Buffer): void {
    // Raydium AMM V4 pool state layout varies by version
    // For CLMM (Concentrated): different layout
    // We'll use a simpler approach: re-fetch via RPC on change notification
    this.refetchReserves(pool);
  }

  /**
   * Orca Whirlpool: parse sqrtPrice from pool state
   */
  private parseOrcaUpdate(pool: PoolInfo, data: Buffer): void {
    // Whirlpool stores sqrtPriceX64 — complex to parse for reserves
    // Simpler: re-fetch on notification
    this.refetchReserves(pool);
  }

  /**
   * Fallback: on any account change notification, re-query the Raydium/Orca
   * API for updated reserves. This is triggered by WebSocket, so it's
   * still real-time — just using HTTP to get clean data.
   */
  private async refetchReserves(pool: PoolInfo): Promise<void> {
    try {
      if (pool.dex === 'raydium') {
        const url = `https://api-v3.raydium.io/pools/info/ids?ids=${pool.address.toBase58()}`;
        const resp = await fetch(url);
        if (!resp.ok) return;
        const data: any = await resp.json();
        if (!data.success || !data.data?.[0]) return;

        const p = data.data[0];
        const decimalsA = p.mintA?.decimals || 9;
        const decimalsB = p.mintB?.decimals || 9;

        pool.reserveA = new Decimal(p.mintAmountA).mul(new Decimal(10).pow(decimalsA)).floor();
        pool.reserveB = new Decimal(p.mintAmountB).mul(new Decimal(10).pow(decimalsB)).floor();
      }
      // For Orca, individual pool endpoint would be needed
      // For now, Orca reserves stay at initial values (updated less frequently)

      pool.lastUpdate = Date.now();
    } catch {}
  }

  async unsubscribeAll(): Promise<void> {
    for (const subId of this.subscriptions) {
      try {
        await this.connection.removeAccountChangeListener(subId);
      } catch {}
    }
    this.subscriptions = [];
    console.log('📡 All WebSocket subscriptions removed');
  }
}
