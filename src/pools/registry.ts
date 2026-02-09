import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { PoolInfo } from './types';
import { fetchPumpFunPools } from './pumpfun';
import { fetchPumpSwapPools } from './pumpswap';

const SOL = 'So11111111111111111111111111111111111111112';

const fetchWithTimeout = async (url: string, ms = 30000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
};

export async function fetchPoolsFromAPIs(tokenMints: string[], connection?: Connection): Promise<PoolInfo[]> {
  const pools: PoolInfo[] = [];

  // ── Raydium API v3 (sequential with delay to avoid rate limits) ──
  const rayResults: PromiseSettledResult<any[]>[] = [];
  for (const mint of tokenMints) {
    try {
      const url = `https://api-v3.raydium.io/pools/info/mint?mint1=${SOL}&mint2=${mint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=5&page=1`;
      const resp = await fetchWithTimeout(url, 30000);
      if (!resp.ok) { rayResults.push({ status: 'fulfilled', value: [] }); continue; }
      const data: any = await resp.json();
      rayResults.push({ status: 'fulfilled', value: data.success && data.data?.data ? data.data.data : [] });
    } catch (e: any) {
      console.log(`   ⚠️ Raydium fetch failed for ${mint.slice(0,8)}...: ${e.message?.slice(0,40)}`);
      rayResults.push({ status: 'rejected', reason: e });
    }
    await new Promise(r => setTimeout(r, 500)); // 500ms delay between requests
  }

  for (const result of rayResults) {
    if (result.status !== 'fulfilled') continue;
    for (const p of result.value) {
      if (!p.id || !p.mintAmountA || !p.mintAmountB) continue;
      const decimalsA = p.mintA?.decimals || 9;
      const decimalsB = p.mintB?.decimals || 9;
      const isClmm = p.type === 'Concentrated' || p.programId === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
      const isCpmm = p.programId === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
      const poolType = isClmm ? 'clmm' : isCpmm ? 'cpmm' : 'amm-v4';

      const poolInfo: PoolInfo = {
        address: new PublicKey(p.id),
        dex: 'raydium',
        poolType,
        tokenA: new PublicKey(p.mintA.address),
        tokenB: new PublicKey(p.mintB.address),
        reserveA: new Decimal(p.mintAmountA).mul(new Decimal(10).pow(decimalsA)).floor(),
        reserveB: new Decimal(p.mintAmountB).mul(new Decimal(10).pow(decimalsB)).floor(),
        fee: Math.round((p.feeRate || 0.0025) * 10000),
        lastUpdate: Date.now(),
        decimalsA,
        decimalsB,
      };
      if (p.vault?.A) poolInfo.vaultA = new PublicKey(p.vault.A);
      if (p.vault?.B) poolInfo.vaultB = new PublicKey(p.vault.B);
      console.log(`   ✅ raydium[${poolInfo.poolType}] ${p.mintA.symbol}/${p.mintB.symbol}`);
      pools.push(poolInfo);
    }
  }
  console.log(`   Raydium total: ${pools.length}`);

  // ── Orca Whirlpool: list API + batched on-chain reads ──
  try {
    const resp = await fetchWithTimeout('https://api.mainnet.orca.so/v1/whirlpool/list', 15000);
    if (resp.ok) {
      const data: any = await resp.json();
      const mintSet = new Set(tokenMints);
      const candidates: any[] = [];
      for (const wp of (data.whirlpools || [])) {
        const hasToken = mintSet.has(wp.tokenA?.mint) || mintSet.has(wp.tokenB?.mint);
        const hasSOL = wp.tokenA?.mint === SOL || wp.tokenB?.mint === SOL;
        if (!hasToken || !hasSOL) continue;
        if (parseFloat(wp.tvl || '0') < 1000) continue;
        candidates.push(wp);
      }

      // Use Orca API price directly — no on-chain reads (GetBlock rate limits)
      const ORCA_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
      for (const wp of candidates) {
        const price = parseFloat(wp.price || '0');
        if (price <= 0) continue;

        const decimalsA = wp.tokenA?.decimals || 9;
        const decimalsB = wp.tokenB?.decimals || 9;
        const addr = new PublicKey(wp.address);
        const [oraclePda] = PublicKey.findProgramAddressSync(
          [Buffer.from('oracle'), addr.toBuffer()], ORCA_PROGRAM,
        );

        // Reserves from API (tvl-based, for filtering only — quoting uses price)
        const tvlSol = parseFloat(wp.tvl || '0') / 150; // rough SOL estimate
        const reserveA = new Decimal(tvlSol / 2).mul(new Decimal(10).pow(decimalsA)).floor();
        const reserveB = new Decimal(tvlSol / 2 * price).mul(new Decimal(10).pow(decimalsB)).floor();

        // Store price as effective rate for quoting
        pools.push({
          address: addr,
          dex: 'orca',
          poolType: 'whirlpool',
          tokenA: new PublicKey(wp.tokenA.mint),
          tokenB: new PublicKey(wp.tokenB.mint),
          reserveA: reserveA.isZero() ? new Decimal(1) : reserveA,
          reserveB: reserveB.isZero() ? new Decimal(1) : reserveB,
          fee: Math.round((wp.lpFeeRate || 0.003) * 10000),
          lastUpdate: Date.now(),
          oracle: oraclePda,
          decimalsA,
          decimalsB,
          // Store raw price for direct quoting (tokenB per tokenA)
          orcaApiPrice: new Decimal(price),
        });
        console.log(`   ✅ orca ${wp.tokenA?.symbol}/${wp.tokenB?.symbol} — price: ${price}`);
      }
    }
  } catch (e: any) {
    console.log(`   ⚠️ Orca fetch error: ${e.message?.slice(0, 60)}`);
  }
  console.log(`   Orca total: ${pools.filter(p => p.dex === 'orca').length}`);

  // ── Pump.fun bonding curves ──
  if (connection) {
    try {
      const pumpPools = await fetchPumpFunPools(connection, tokenMints);
      pools.push(...pumpPools);
    } catch (e: any) {
      console.log(`   ⚠️ PumpFun fetch error: ${e.message?.slice(0, 60)}`);
    }
  }

  // ── PumpSwap AMM (graduated pump.fun tokens) ──
  if (connection) {
    try {
      const rpcUrl = (connection as any)._rpcEndpoint || '';
      const pumpSwapPools = await fetchPumpSwapPools(connection, tokenMints, rpcUrl);
      pools.push(...pumpSwapPools);
    } catch (e: any) {
      console.log(`   ⚠️ PumpSwap fetch error: ${e.message?.slice(0, 60)}`);
    }
  }

  return pools;
}

function bufToU128(buf: Buffer): bigint {
  let result = 0n;
  for (let i = 15; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[i]);
  }
  return result;
}
