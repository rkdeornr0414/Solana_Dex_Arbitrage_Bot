import { PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { PoolInfo, ArbOpportunity } from '../pools/types';
import { PoolManager } from '../pools/poolManager';
import { config, TOKENS } from '../config';

/**
 * Triangular Arbitrage Strategy
 * 
**/