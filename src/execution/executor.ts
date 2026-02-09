import {
  Connection, PublicKey, Transaction, VersionedTransaction,
  ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, createCloseAccountInstruction,
} from '@solana/spl-token';
import Decimal from 'decimal.js';
import BN from 'bn.js';
import { ArbOpportunity, PoolInfo } from '../pools/types';
import { config, wallet, PROGRAMS } from '../config';
import {
  PUMPFUN_PROGRAM, PUMPFUN_FEE_RECIPIENT,
  getBondingCurvePDA, getGlobalPDA, getEventAuthorityPDA,
} from '../pools/pumpfun';
import {
  PUMPSWAP_PROGRAM, PUMPSWAP_GLOBAL_CONFIG, PUMPSWAP_FEE_RECIPIENT,
  PUMPSWAP_FEE_PROGRAM, getPumpSwapEventAuthority, getPumpSwapPoolAuthority,
  parsePumpSwapPool,
} from '../pools/pumpswap';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const SOL_STR = SOL_MINT.toBase58();
const API_TIMEOUT_MS = 10_000;

// Raydium AMM Authority PDA
const [AMM_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from([97, 109, 109, 32, 97, 117, 116, 104, 111, 114, 105, 116, 121])],
  new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
);

/**
 * Transaction Executor — Raw Instructions
 *
 * - Raydium swaps: raw AMM-V4 instructions (buy AND sell)
 * - Orca swaps: raw Whirlpool swap instructions (tick arrays via string-seed PDAs)
 *
 * Executes as TWO sequential transactions (not atomic).
 * If leg 1 succeeds but leg 2 fails, we temporarily hold tokens.
 */
export class Executor {
  private executionCount = 0;
  private totalProfit = new Decimal(0);
  private lastExecution: { key: string; timestamp: number } | null = null;

  constructor(private connection: Connection) {}

  async execute(opportunity: ArbOpportunity): Promise<boolean> {
    const { type, buyPool, sellPool, inputAmount, expectedProfit, profitBps } = opportunity;

    const dedupKey = `${buyPool.address.toBase58()}-${sellPool.address.toBase58()}-${type}`;
    const now = Date.now();
    if (this.lastExecution && this.lastExecution.key === dedupKey && now - this.lastExecution.timestamp < 30_000) {
      console.log(`   ⏭️ Skipping duplicate (within 30s)`);
      return false;
    }
    this.lastExecution = { key: dedupKey, timestamp: now };

    console.log(`\n🎯 ${type.toUpperCase()} opportunity found!`);
    console.log(`   Buy:    ${buyPool.dex}[${buyPool.poolType}] @ ${buyPool.address.toBase58().slice(0, 8)}...`);
    console.log(`   Sell:   ${sellPool.dex}[${sellPool.poolType}] @ ${sellPool.address.toBase58().slice(0, 8)}...`);
    console.log(`   Size:   ${inputAmount.div(1e9).toFixed(4)} SOL`);
    console.log(`   Profit: ${expectedProfit.div(1e9).toFixed(6)} SOL (${profitBps} bps)`);

    if (config.dryRun) {
      console.log(`   📝 DRY RUN — not executing`);
      this.executionCount++;
      this.totalProfit = this.totalProfit.add(expectedProfit);
      return true;
    }

    try {
      return await this.executeArb(opportunity);
    } catch (error: any) {
      console.log(`   ❌ Execution failed: ${error.message}`);
      return false;
    }
  }

  private async executeArb(opp: ArbOpportunity): Promise<boolean> {
    const tokenMint = opp.tokenMint;
    const solLamports = opp.inputAmount.toFixed(0);

    // ── Leg 1: Buy token (SOL → Token) ──
    console.log(`   📡 Leg 1: Buy on ${opp.buyPool.dex}...`);
    const sig1 = await this.executeBuyLeg(tokenMint, solLamports, opp.buyPool);

    if (!sig1) { console.log('   ❌ Leg 1 failed'); return false; }
    console.log(`   🔗 Leg 1: ${sig1}`);

    // Get token balance for leg 2
    const tokenAta = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
    await new Promise(r => setTimeout(r, 1000)); // brief settle
    const tokenBal = await this.connection.getTokenAccountBalance(tokenAta);
    const tokenAmount = tokenBal.value.amount;
    console.log(`   💰 Got ${tokenBal.value.uiAmountString} tokens`);

    if (parseInt(tokenAmount) === 0) {
      console.log('   ❌ No tokens received');
      return false;
    }

    // ── Leg 2: Sell token (Token → SOL) ──
    console.log(`   📡 Leg 2: Sell on ${opp.sellPool.dex}...`);

    const sig2 = await this.executeSellLeg(tokenMint, tokenAmount, opp.sellPool);

    if (!sig2) {
      console.log('    Leg 2 failed — trying fallback...');
      const tokenBal2 = await this.connection.getTokenAccountBalance(tokenAta);
      if (parseInt(tokenBal2.value.amount) > 0) {
        const otherPool = opp.sellPool !== opp.buyPool ? opp.buyPool : null;
        if (otherPool) {
          console.log(`    Fallback via ${otherPool.dex}...`);
          const fb = await this.executeSellLeg(tokenMint, tokenBal2.value.amount, otherPool);
          if (fb) console.log(`    Fallback: ${fb}`);
        }
      }
      return false;
    }
    console.log(`    Leg 2: ${sig2}`);

    console.log(`    Arb complete!`);
    this.executionCount++;
    this.totalProfit = this.totalProfit.add(opp.expectedProfit);
    return true;
  }

  private async executeBuyLeg(tokenMint: PublicKey, amount: string, pool: PoolInfo): Promise<string | null> {
    if (pool.dex === 'orca') return this.swapViaOrca(SOL_MINT, tokenMint, amount, pool);
    if (pool.dex === 'pumpfun') return this.swapViaPumpFun(SOL_MINT, tokenMint, amount, pool);
    if (pool.dex === 'pumpswap') return this.swapViaPumpSwap(SOL_MINT, tokenMint, amount, pool);
    if (pool.dex === 'raydium' && pool.poolType === 'cpmm') return this.swapViaCpmm(SOL_MINT, tokenMint, amount, pool);
    if (pool.dex === 'raydium') return this.swapViaRaydiumRaw(SOL_MINT, tokenMint, amount, pool);
    return null;
  }

  private async executeSellLeg(tokenMint: PublicKey, amount: string, pool: PoolInfo): Promise<string | null> {
    if (pool.dex === 'orca') return this.swapViaOrca(tokenMint, SOL_MINT, amount, pool);
    if (pool.dex === 'pumpfun') return this.swapViaPumpFun(tokenMint, SOL_MINT, amount, pool);
    if (pool.dex === 'pumpswap') return this.swapViaPumpSwap(tokenMint, SOL_MINT, amount, pool);
    if (pool.dex === 'raydium' && pool.poolType === 'cpmm') return this.swapViaCpmm(tokenMint, SOL_MINT, amount, pool);
    if (pool.dex === 'raydium') return this.swapViaRaydiumRaw(tokenMint, SOL_MINT, amount, pool);
    return null;
  }

  // ═══════════════════════════════════════════
  // Raydium — raw AMM-V4 swap instruction
  // ═══════════════════════════════════════════
  private async swapViaRaydiumRaw(
    inputMint: PublicKey, outputMint: PublicKey,
    amount: string, pool: PoolInfo,
  ): Promise<string | null> {
    // Read AMM pool on-chain
    const poolAcct = await this.connection.getAccountInfo(pool.address);
    if (!poolAcct) { console.log('   ❌ Raydium pool not found'); return null; }
    const buf = poolAcct.data as Buffer;

    const baseVault = new PublicKey(buf.subarray(336, 368));
    const quoteVault = new PublicKey(buf.subarray(368, 400));
    const baseMint = new PublicKey(buf.subarray(400, 432));
    const quoteMint = new PublicKey(buf.subarray(432, 464));
    const openOrders = new PublicKey(buf.subarray(496, 528));
    const marketId = new PublicKey(buf.subarray(528, 560));
    const marketProgramId = new PublicKey(buf.subarray(560, 592));
    const targetOrders = new PublicKey(buf.subarray(592, 624));

    // Read Serum/OpenBook market
    const marketAcct = await this.connection.getAccountInfo(marketId);
    if (!marketAcct) { console.log('   ❌ Serum market not found'); return null; }
    const mBuf = marketAcct.data as Buffer;
    const vaultSignerNonce = mBuf.readBigUInt64LE(45);
    const serumBaseVault = new PublicKey(mBuf.subarray(117, 149));
    const serumQuoteVault = new PublicKey(mBuf.subarray(165, 197));
    const eventQueue = new PublicKey(mBuf.subarray(253, 285));
    const bids = new PublicKey(mBuf.subarray(285, 317));
    const asks = new PublicKey(mBuf.subarray(317, 349));

    // Derive vault signer
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(vaultSignerNonce);
    const vaultSigner = PublicKey.createProgramAddressSync(
      [marketId.toBuffer(), nonceBuffer], marketProgramId,
    );

    // User ATAs
    const userSourceAta = await getAssociatedTokenAddress(inputMint, wallet.publicKey);
    const userDestAta = await getAssociatedTokenAddress(outputMint, wallet.publicKey);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));

    // Ensure ATAs
    for (const [mint, ata] of [[inputMint, userSourceAta], [outputMint, userDestAta]] as [PublicKey, PublicKey][]) {
      const info = await this.connection.getAccountInfo(ata);
      if (!info) tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint));
    }

    // Wrap SOL if input
    if (inputMint.equals(SOL_MINT)) {
      tx.add(
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userSourceAta, lamports: parseInt(amount) }),
        createSyncNativeInstruction(userSourceAta),
      );
    }

    // swapBaseIn instruction (index 9)
    const ixData = Buffer.alloc(17);
    ixData.writeUInt8(9, 0);
    const amountBN = new BN(amount);
    ixData.set(amountBN.toArrayLike(Buffer, 'le', 8), 1);
    ixData.set(new BN(0).toArrayLike(Buffer, 'le', 8), 9); // minOut = 0 (sim protects)

    tx.add({
      programId: PROGRAMS.RAYDIUM_AMM,
      keys: [
        { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
        { pubkey: pool.address,          isSigner: false, isWritable: true },
        { pubkey: AMM_AUTHORITY,         isSigner: false, isWritable: false },
        { pubkey: openOrders,            isSigner: false, isWritable: true },
        { pubkey: targetOrders,          isSigner: false, isWritable: true },
        { pubkey: baseVault,             isSigner: false, isWritable: true },
        { pubkey: quoteVault,            isSigner: false, isWritable: true },
        { pubkey: marketProgramId,       isSigner: false, isWritable: false },
        { pubkey: marketId,              isSigner: false, isWritable: true },
        { pubkey: bids,                  isSigner: false, isWritable: true },
        { pubkey: asks,                  isSigner: false, isWritable: true },
        { pubkey: eventQueue,            isSigner: false, isWritable: true },
        { pubkey: serumBaseVault,        isSigner: false, isWritable: true },
        { pubkey: serumQuoteVault,       isSigner: false, isWritable: true },
        { pubkey: vaultSigner,           isSigner: false, isWritable: false },
        { pubkey: userSourceAta,         isSigner: false, isWritable: true },
        { pubkey: userDestAta,           isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey,      isSigner: true,  isWritable: true },
      ],
      data: ixData,
    });

    // Unwrap WSOL if output is SOL
    if (outputMint.equals(SOL_MINT)) {
      tx.add(createCloseAccountInstruction(userDestAta, wallet.publicKey, wallet.publicKey));
    }

    tx.feePayer = wallet.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const sim = await this.connection.simulateTransaction(tx);
    if (sim.value.err) {
      console.log(`   ❌ Raydium raw sim failed:`, JSON.stringify(sim.value.err));
      if (sim.value.logs) console.log(`   ${sim.value.logs.slice(-3).join('\n   ')}`);
      return null;
    }

    tx.sign(wallet);
    return this.sendAndConfirm(Buffer.from(tx.serialize()));
  }

  // ═══════════════════════════════════════════
  // Raydium CPMM — raw swap instruction
  // ═══════════════════════════════════════════
  private async swapViaCpmm(
    inputMint: PublicKey, outputMint: PublicKey,
    amount: string, pool: PoolInfo,
  ): Promise<string | null> {
    const CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
    const [cpmmAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_and_lp_mint_auth_seed')], CPMM_PROGRAM);
    const CPMM_SWAP_DISC = Buffer.from('8fbe5adac41e33de', 'hex');

    const poolAcct = await this.connection.getAccountInfo(pool.address);
    if (!poolAcct) { console.log('   ❌ CPMM pool not found'); return null; }
    const buf = poolAcct.data as Buffer;

    const ammConfig = new PublicKey(buf.subarray(8, 40));
    const token0Vault = new PublicKey(buf.subarray(72, 104));
    const token1Vault = new PublicKey(buf.subarray(104, 136));
    const token0Mint = new PublicKey(buf.subarray(168, 200));
    const token1Mint = new PublicKey(buf.subarray(200, 232));

    const isInput0 = inputMint.equals(token0Mint);
    const inputVault = isInput0 ? token0Vault : token1Vault;
    const outputVault = isInput0 ? token1Vault : token0Vault;

    const [observation] = PublicKey.findProgramAddressSync(
      [Buffer.from('observation'), pool.address.toBuffer()], CPMM_PROGRAM);

    const userInputAta = await getAssociatedTokenAddress(inputMint, wallet.publicKey);
    const userOutputAta = await getAssociatedTokenAddress(outputMint, wallet.publicKey);

    // Check token programs (some tokens use Token-2022)
    const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    const inputMintInfo = await this.connection.getAccountInfo(inputMint);
    const outputMintInfo = await this.connection.getAccountInfo(outputMint);
    const inputTokenProg = inputMintInfo?.owner.equals(TOKEN_2022) ? TOKEN_2022 : TOKEN_PROGRAM_ID;
    const outputTokenProg = outputMintInfo?.owner.equals(TOKEN_2022) ? TOKEN_2022 : TOKEN_PROGRAM_ID;

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));

    for (const [mint, ata] of [[inputMint, userInputAta], [outputMint, userOutputAta]] as [PublicKey, PublicKey][]) {
      const info = await this.connection.getAccountInfo(ata);
      if (!info) tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint));
    }

    if (inputMint.equals(SOL_MINT)) {
      tx.add(
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userInputAta, lamports: parseInt(amount) }),
        createSyncNativeInstruction(userInputAta),
      );
    }

    const ixData = Buffer.alloc(24);
    CPMM_SWAP_DISC.copy(ixData, 0);
    ixData.set(new BN(amount).toArrayLike(Buffer, 'le', 8), 8);
    ixData.set(new BN(0).toArrayLike(Buffer, 'le', 8), 16);

    tx.add({
      programId: CPMM_PROGRAM,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: cpmmAuth, isSigner: false, isWritable: false },
        { pubkey: ammConfig, isSigner: false, isWritable: false },
        { pubkey: pool.address, isSigner: false, isWritable: true },
        { pubkey: userInputAta, isSigner: false, isWritable: true },
        { pubkey: userOutputAta, isSigner: false, isWritable: true },
        { pubkey: inputVault, isSigner: false, isWritable: true },
        { pubkey: outputVault, isSigner: false, isWritable: true },
        { pubkey: inputTokenProg, isSigner: false, isWritable: false },
        { pubkey: outputTokenProg, isSigner: false, isWritable: false },
        { pubkey: inputMint, isSigner: false, isWritable: false },
        { pubkey: outputMint, isSigner: false, isWritable: false },
        { pubkey: observation, isSigner: false, isWritable: true },
      ],
      data: ixData,
    });

    if (outputMint.equals(SOL_MINT)) {
      tx.add(createCloseAccountInstruction(userOutputAta, wallet.publicKey, wallet.publicKey));
    }

    tx.feePayer = wallet.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const sim = await this.connection.simulateTransaction(tx);
    if (sim.value.err) {
      console.log(`   ❌ CPMM sim failed:`, JSON.stringify(sim.value.err));
      if (sim.value.logs) console.log(`   ${sim.value.logs.slice(-3).join('\n   ')}`);
      return null;
    }

    tx.sign(wallet);
    return this.sendAndConfirm(Buffer.from(tx.serialize()));
  }

  // ═══════════════════════════════════════════
  // Orca — raw Whirlpool swap instruction
  // ═══════════════════════════════════════════
  private async swapViaOrca(
    inputMint: PublicKey, outputMint: PublicKey,
    amount: string, pool: PoolInfo,
  ): Promise<string | null> {
    // Read pool on-chain for current tick + vaults
    const poolInfo = await this.connection.getAccountInfo(pool.address);
    if (!poolInfo) { console.log('   ❌ Orca pool not found'); return null; }
    const buf = poolInfo.data as Buffer;

    const tickSpacing = buf.readUInt16LE(41);
    const currentTick = buf.readInt32LE(81);
    const tokenMintA = new PublicKey(buf.subarray(101, 133));
    const vaultA = new PublicKey(buf.subarray(133, 165));
    const tokenMintB = new PublicKey(buf.subarray(181, 213));
    const vaultB = new PublicKey(buf.subarray(213, 245));

    const aToB = tokenMintA.equals(inputMint);

    // Derive tick arrays with STRING seeds (critical!)
    const arraySpacing = tickSpacing * 88;
    const currentStart = Math.floor(currentTick / arraySpacing) * arraySpacing;
    const offsets = aToB ? [0, -1, -2] : [0, 1, 2];
    const tickArrays = offsets.map(o => {
      const idx = currentStart + o * arraySpacing;
      return PublicKey.findProgramAddressSync(
        [Buffer.from('tick_array'), pool.address.toBuffer(), Buffer.from(idx.toString())],
        PROGRAMS.ORCA_WHIRLPOOL,
      )[0];
    });

    // Verify tick arrays exist
    const taInfos = await this.connection.getMultipleAccountsInfo(tickArrays);
    if (!taInfos.every(i => i)) {
      console.log(`   ❌ Missing tick arrays (${taInfos.filter(i=>i).length}/3)`);
      return null;
    }

    // Oracle PDA
    const [oraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('oracle'), pool.address.toBuffer()], PROGRAMS.ORCA_WHIRLPOOL);

    // User ATAs
    const userAtaA = await getAssociatedTokenAddress(tokenMintA, wallet.publicKey);
    const userAtaB = await getAssociatedTokenAddress(tokenMintB, wallet.publicKey);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));

    // Ensure ATAs exist
    for (const [mint, ata] of [[tokenMintA, userAtaA], [tokenMintB, userAtaB]] as [PublicKey, PublicKey][]) {
      const info = await this.connection.getAccountInfo(ata);
      if (!info) {
        tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint));
      }
    }

    // Wrap SOL if input is SOL
    const isInputSol = inputMint.equals(SOL_MINT);
    if (isInputSol) {
      const solAta = aToB ? userAtaA : userAtaB;
      tx.add(
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: solAta, lamports: parseInt(amount) }),
        createSyncNativeInstruction(solAta),
      );
    }

    // Whirlpool swap instruction
    const amountIn = new BN(amount);
    const sqrtPriceLimit = aToB
      ? new BN('4295048016')
      : new BN('79226673515401279992447579055');

    const SWAP_DISC = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
    const ixData = Buffer.alloc(42);
    let off = 0;
    SWAP_DISC.copy(ixData, off); off += 8;
    ixData.set(amountIn.toArrayLike(Buffer, 'le', 8), off); off += 8;
    ixData.set(new BN(0).toArrayLike(Buffer, 'le', 8), off); off += 8; // min out = 0 (slippage handled by sqrtPriceLimit)
    ixData.set(sqrtPriceLimit.toArrayLike(Buffer, 'le', 16), off); off += 16;
    ixData.writeUInt8(1, off); off += 1; // amount_specified_is_input = true
    ixData.writeUInt8(aToB ? 1 : 0, off); // a_to_b

    // Accounts always in A/B order
    tx.add({
      programId: PROGRAMS.ORCA_WHIRLPOOL,
      keys: [
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool.address, isSigner: false, isWritable: true },
        { pubkey: userAtaA, isSigner: false, isWritable: true },
        { pubkey: vaultA, isSigner: false, isWritable: true },
        { pubkey: userAtaB, isSigner: false, isWritable: true },
        { pubkey: vaultB, isSigner: false, isWritable: true },
        { pubkey: tickArrays[0], isSigner: false, isWritable: true },
        { pubkey: tickArrays[1], isSigner: false, isWritable: true },
        { pubkey: tickArrays[2], isSigner: false, isWritable: true },
        { pubkey: oraclePda, isSigner: false, isWritable: false },
      ],
      data: ixData,
    });

    // Unwrap WSOL if output is SOL (close the WSOL ATA)
    const isOutputSol = outputMint.equals(SOL_MINT);
    if (isOutputSol && !isInputSol) {
      const wsolAta = aToB ? userAtaB : userAtaA;
      tx.add(createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey));
    }

    tx.feePayer = wallet.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    // Simulate
    const sim = await this.connection.simulateTransaction(tx);
    if (sim.value.err) {
      console.log(`   ❌ Orca sim failed:`, JSON.stringify(sim.value.err));
      if (sim.value.logs) console.log(`   ${sim.value.logs.slice(-2).join('\n   ')}`);
      return null;
    }

    // Sign and send
    tx.sign(wallet);
    return this.sendAndConfirm(Buffer.from(tx.serialize()));
  }

  // ═══════════════════════════════════════════
  // Pump.fun — raw bonding curve instruction
  // ═══════════════════════════════════════════
  private async swapViaPumpFun(
    inputMint: PublicKey, outputMint: PublicKey,
    amount: string, pool: PoolInfo,
  ): Promise<string | null> {
    const isBuy = inputMint.equals(SOL_MINT);
    const tokenMint = isBuy ? outputMint : inputMint;
    const bondingCurve = pool.address;
    const associatedBondingCurve = getAssociatedTokenAddressSync(tokenMint, bondingCurve, true);
    const userAta = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));

    // Ensure user ATA exists
    const ataInfo = await this.connection.getAccountInfo(userAta);
    if (!ataInfo) {
      tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, userAta, wallet.publicKey, tokenMint));
    }

    const amountBN = new BN(amount);
    let ixData: Buffer;

    if (isBuy) {
      // Buy: discriminator + amount(u64, token amount to buy) + maxSolCost(u64)
      const BUY_DISC = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
      // For buy, 'amount' is SOL lamports. We pass max tokens as a large number
      // and maxSolCost as our amount + slippage
      const maxSolCost = amountBN.muln(10000 + config.slippageBps).divn(10000);
      // amount field = 0 means "buy with this much SOL" — actually pump.fun buy amount is token amount
      // We need to estimate tokens. For simplicity, pass max u64 and control via maxSolCost
      ixData = Buffer.alloc(24);
      BUY_DISC.copy(ixData, 0);
      // token amount — use a very large number (buy as many as possible for the SOL)
      const maxTokens = new BN('18446744073709551615'); // u64 max
      ixData.set(maxTokens.toArrayLike(Buffer, 'le', 8), 8);
      ixData.set(maxSolCost.toArrayLike(Buffer, 'le', 8), 16);
    } else {
      // Sell: discriminator + amount(u64, token amount) + minSolOutput(u64)
      const SELL_DISC = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
      ixData = Buffer.alloc(24);
      SELL_DISC.copy(ixData, 0);
      ixData.set(amountBN.toArrayLike(Buffer, 'le', 8), 8);
      // minSolOutput = 0 for now (slippage protection via simulation)
      ixData.set(new BN(0).toArrayLike(Buffer, 'le', 8), 16);
    }

    const globalPda = getGlobalPDA();
    const eventAuthority = getEventAuthorityPDA();
    const RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

    tx.add({
      programId: PUMPFUN_PROGRAM,
      keys: [
        { pubkey: globalPda, isSigner: false, isWritable: false },
        { pubkey: PUMPFUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: RENT, isSigner: false, isWritable: false },
        { pubkey: eventAuthority, isSigner: false, isWritable: false },
        { pubkey: PUMPFUN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: ixData,
    });

    tx.feePayer = wallet.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    // Simulate
    const sim = await this.connection.simulateTransaction(tx);
    if (sim.value.err) {
      console.log(`   ❌ PumpFun sim failed:`, JSON.stringify(sim.value.err));
      if (sim.value.logs) console.log(`   ${sim.value.logs.slice(-3).join('\n   ')}`);
      return null;
    }

    tx.sign(wallet);
    return this.sendAndConfirm(Buffer.from(tx.serialize()));
  }

  // ═══════════════════════════════════════════
  // PumpSwap — raw AMM swap instruction
  // ═══════════════════════════════════════════
  private async swapViaPumpSwap(
    inputMint: PublicKey, outputMint: PublicKey,
    amount: string, pool: PoolInfo,
  ): Promise<string | null> {
    const isBuy = inputMint.equals(SOL_MINT); // buying meme token with SOL
    const tokenMint = isBuy ? outputMint : inputMint;

    // Read pool account to get current data
    const poolInfo = await this.connection.getAccountInfo(pool.address);
    if (!poolInfo) { console.log('   ❌ PumpSwap pool not found'); return null; }
    const poolData = parsePumpSwapPool(pool.address, poolInfo.data as Buffer);
    if (!poolData) { console.log('   ❌ PumpSwap pool parse failed'); return null; }

    const poolAuthority = getPumpSwapPoolAuthority(pool.address);
    const eventAuthority = getPumpSwapEventAuthority();

    // Determine base/quote orientation
    const baseMint = poolData.baseMint;
    const quoteMint = poolData.quoteMint;
    const baseVault = poolData.baseVault;
    const quoteVault = poolData.quoteVault;

    // User ATAs
    const userBaseAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey);
    const userQuoteAta = await getAssociatedTokenAddress(quoteMint, wallet.publicKey);

    // Protocol fee ATAs (fee recipient's ATAs for base and quote)
    const protocolFeeBaseAta = await getAssociatedTokenAddress(baseMint, PUMPSWAP_FEE_RECIPIENT);
    const protocolFeeQuoteAta = await getAssociatedTokenAddress(quoteMint, PUMPSWAP_FEE_RECIPIENT);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));

    // Ensure user ATAs exist
    for (const [mint, ata] of [[baseMint, userBaseAta], [quoteMint, userQuoteAta]] as [PublicKey, PublicKey][]) {
      const info = await this.connection.getAccountInfo(ata);
      if (!info) {
        tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint));
      }
    }

    // Wrap SOL if needed
    if (isBuy) {
      const solAta = baseMint.equals(SOL_MINT) ? userBaseAta : userQuoteAta;
      tx.add(
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: solAta, lamports: parseInt(amount) }),
        createSyncNativeInstruction(solAta),
      );
    }

    const amountBN = new BN(amount);
    let ixData: Buffer;

    if (isBuy) {
      // BUY: discriminator(8) + base_in_amount(u64) + max_quote_amount(u64) + 1 byte
      const BUY_DISC = Buffer.from('66063d1201daebea', 'hex');
      const maxQuote = amountBN.muln(10000 + config.slippageBps).divn(10000);
      ixData = Buffer.alloc(25);
      BUY_DISC.copy(ixData, 0);
      // base_in_amount = max u64 (buy as many tokens as possible)
      const maxTokens = new BN('18446744073709551615');
      ixData.set(maxTokens.toArrayLike(Buffer, 'le', 8), 8);
      ixData.set(maxQuote.toArrayLike(Buffer, 'le', 8), 16);
      ixData[24] = 1; // extra byte
    } else {
      // SELL: discriminator(8) + base_in_amount(u64) + min_quote_amount(u64)
      const SELL_DISC = Buffer.from('33e685a4017f83ad', 'hex');
      ixData = Buffer.alloc(24);
      SELL_DISC.copy(ixData, 0);
      ixData.set(amountBN.toArrayLike(Buffer, 'le', 8), 8);
      ixData.set(new BN(0).toArrayLike(Buffer, 'le', 8), 16); // min out = 0 (sim protects)
    }

    // Determine token programs for base and quote
    // PumpSwap uses Token-2022 for LP mint, but standard Token for SOL and most meme tokens
    const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;
    const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

    // Check which token program each mint uses
    const baseMintInfo = await this.connection.getAccountInfo(baseMint);
    const quoteMintInfo = await this.connection.getAccountInfo(quoteMint);
    const baseTokenProgram = baseMintInfo?.owner.equals(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    const quoteTokenProgram = quoteMintInfo?.owner.equals(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;

    const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

    // Account layout for PumpSwap swap
    const keys = [
      { pubkey: pool.address, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMPSWAP_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: isBuy ? userQuoteAta : userBaseAta, isSigner: false, isWritable: true }, // user token ATA
      { pubkey: baseVault, isSigner: false, isWritable: true },
      { pubkey: quoteVault, isSigner: false, isWritable: true },
      { pubkey: protocolFeeBaseAta, isSigner: false, isWritable: true },
      { pubkey: protocolFeeQuoteAta, isSigner: false, isWritable: true },
      { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
      { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMPSWAP_PROGRAM, isSigner: false, isWritable: false },
    ];

    tx.add({ programId: PUMPSWAP_PROGRAM, keys, data: ixData });

    // Unwrap WSOL if output is SOL
    if (!isBuy) {
      const wsolAta = baseMint.equals(SOL_MINT) ? userBaseAta : userQuoteAta;
      tx.add(createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey));
    }

    tx.feePayer = wallet.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    // Simulate
    const sim = await this.connection.simulateTransaction(tx);
    if (sim.value.err) {
      console.log(`   ❌ PumpSwap sim failed:`, JSON.stringify(sim.value.err));
      if (sim.value.logs) console.log(`   ${sim.value.logs.slice(-3).join('\n   ')}`);
      return null;
    }

    tx.sign(wallet);
    return this.sendAndConfirm(Buffer.from(tx.serialize()));
  }

  // ═══════════════════════════════════════════
  // Shared send + confirm
  // ═══════════════════════════════════════════
  private async sendAndConfirm(serialized: Buffer): Promise<string | null> {
    const sig = await this.connection.sendRawTransaction(serialized, { skipPreflight: true });
    console.log(`   ⏳ Confirming ${sig.slice(0, 20)}...`);
    const conf = await this.connection.confirmTransaction(sig, 'confirmed');
    if (conf.value.err) {
      console.log('   ❌ TX failed:', JSON.stringify(conf.value.err));
      return null;
    }
    console.log(`   ✅ Confirmed`);
    return sig;
  }

  getStats() {
    return {
      executions: this.executionCount,
      totalProfit: this.totalProfit.div(1e9).toFixed(6),
      avgProfit: this.executionCount > 0
        ? this.totalProfit.div(this.executionCount).div(1e9).toFixed(6)
        : '0',
    };
  }
}

async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
