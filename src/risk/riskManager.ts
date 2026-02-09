import Decimal from 'decimal.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { ArbOpportunity } from '../pools/types';
import { config, wallet } from '../config';

/**
 * Risk Manager
 * 
 * Guards against:
 * - Oversized positions
 * - Stale data
 * - Low balance
 * - Rapid consecutive failures
 */
