import { PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { connection, config, wallet, TOKENS } from './config';
import { PoolManager } from './pools/poolManager';
import { PriceStream } from './pools/priceStream';
import { SpatialStrategy } from './strategies/spatial';
import { TemporalStrategy } from './strategies/temporal';
import { TriangularStrategy } from './strategies/triangular';
import { Executor } from './execution/executor';
import { RiskManager } from './risk/riskManager';
import { ArbOpportunity, PoolInfo } from './pools/types';

// Load tokens from tokens.json (edit that file to add/remove tokens, then restart)
function loadTokenMints(): string[] {
  const tokensPath = path.resolve(__dirname, '..', 'tokens.json');
  try {
    const data = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    const mints = data.tokens.map((t: any) => t.mint);
    console.log(`📋 Loaded ${mints.length} tokens from tokens.json`);
    data.tokens.forEach((t: any) => console.log(`   • ${t.symbol}: ${t.mint.slice(0, 8)}...`));
    return mints;
  } catch (e: any) {
    console.error(` Failed to load tokens.json: ${e.message}`);
    process.exit(1);
  }
}

const MEME_MINTS = loadTokenMints();

class ArbitrageBot {
  private poolManager: PoolManager;
  private priceStream: PriceStream;
  private spatial: SpatialStrategy;
  private temporal: TemporalStrategy;
  private triangular: TriangularStrategy;
  private executor: Executor;
  private risk: RiskManager;
  private running = false;
  private cycleCount = 0;
  private updatesReceived = 0;

  constructor() {
    this.poolManager = new PoolManager(connection);
    this.priceStream = new PriceStream(connection);
    this.spatial = new SpatialStrategy(this.poolManager);
    this.temporal = new TemporalStrategy(connection, this.poolManager);
    this.triangular = new TriangularStrategy(this.poolManager);
    this.executor = new Executor(connection);
    this.risk = new RiskManager(connection);
  }

  async start() {
    console.log('\n Solana Arbitrage Bot');
    console.log('═'.repeat(50));
    console.log(`Wallet:     ${wallet.publicKey.toBase58()}`);
    console.log(`Mode:       ${config.dryRun ? '📝 DRY RUN' : '🔴 LIVE'}`);
    console.log(`Min Profit: ${config.minProfitBps} bps`);
    console.log(`Max Size:   ${config.maxTradeSizeSol} SOL`);
    console.log('═'.repeat(50));

    try {
      const balance = await connection.getBalance(wallet.publicKey);
      console.log(` Balance: ${balance / 1e9} SOL\n`);
    } catch (e: any) {
      console.log(`  Balance check failed\n`);
    }

    // Fetch pools from APIs
    const pools = await this.poolManager.init(MEME_MINTS);
    if (pools.length === 0) {
      console.log('\n No pools loaded.');
      return;
    }

    // Subscribe to real-time updates via WebSocket
    await this.priceStream.subscribe(pools, (updatedPool: PoolInfo) => {
      this.updatesReceived++;
    });

    // Periodic API refresh every 10 seconds (backup for WebSocket)
    const refreshInterval = setInterval(async () => {
      try {
        await this.poolManager.init(MEME_MINTS);
        console.log(` Reserves refreshed from API (WS updates: ${this.updatesReceived})`);
      } catch {}
    }, 10000);

    // Main scanning loop
    this.running = true;
    console.log(` Scanning ${pools.length} pools for arbitrage...\n`);

    while (this.running) {
      try {
        await this.runCycle();
      } catch (e: any) {
        if (this.cycleCount % 100 === 0) console.error(`Cycle error: ${e.message}`);
      }
      await sleep(config.pollIntervalMs);
    }

    clearInterval(refreshInterval);
    await this.priceStream.unsubscribeAll();
  }

  private async runCycle() {
    this.cycleCount++;
    const tradeSize = new Decimal(config.maxTradeSizeSol).mul(1e9);
    let bestOpp: ArbOpportunity | null = null;

    for (const mint of MEME_MINTS) {
      const mintPk = new PublicKey(mint);
      const pools = this.poolManager.getPoolsForPair(TOKENS.SOL, mintPk);
      if (pools.length < 2) continue;

      // Check all three strategies
      const opps = [
        ...this.spatial.findOpportunities(pools, TOKENS.SOL, tradeSize),
        ...this.temporal.findOpportunities(pools, TOKENS.SOL),
        ...this.triangular.findOpportunities(pools, TOKENS.SOL, tradeSize),
      ];

      for (const opp of opps) {
        if (!bestOpp || opp.profitBps > bestOpp.profitBps) {
          bestOpp = opp;
        }
      }
    }

    if (bestOpp) {
      const riskCheck = await this.risk.canExecute(bestOpp);
      if (riskCheck.allowed) {
        const success = await this.executor.execute(bestOpp);
        success ? this.risk.recordSuccess() : this.risk.recordFailure();
      } else if (this.cycleCount % 200 === 0) {
        console.log(`  Blocked: ${riskCheck.reason}`);
      }
    }

    if (this.cycleCount % 100 === 0) {
      const stats = this.executor.getStats();
      console.log(` Cycle ${this.cycleCount} | WS updates: ${this.updatesReceived} | Execs: ${stats.executions} | Profit: ${stats.totalProfit} SOL`);
    }
  }

  stop() {
    this.running = false;
    const stats = this.executor.getStats();
    console.log(`\n Bot stopped — Cycles: ${this.cycleCount} | Execs: ${stats.executions} | Profit: ${stats.totalProfit} SOL`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

const bot = new ArbitrageBot();
process.on('SIGINT', () => { bot.stop(); process.exit(0); });
process.on('SIGTERM', () => { bot.stop(); process.exit(0); });
bot.start().catch(err => { console.error('Fatal:', err); process.exit(1); });
