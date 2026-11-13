import { address, canonical, clone, exactKeys, integer, requireCondition, sha256 } from './common.js';
import { merkleRoot } from './merkle.js';

export const GENESIS_TIME = 1704067200000;
export const DEFAULT_CONSENSUS = Object.freeze({
  initialDifficulty: 2,
  minimumDifficulty: 1,
  maximumDifficulty: 5,
  adjustmentInterval: 4,
  targetBlockMilliseconds: 1000,
  maximumFutureMilliseconds: 120000,
  blockReward: 50,
  maximumBlockBytes: 8192,
});
const genesisCache = new Map();

export function consensusConfig(options = {}) {
  const config = { ...DEFAULT_CONSENSUS, ...options };
  exactKeys(config, Object.keys(DEFAULT_CONSENSUS));
  for (const value of Object.values(config)) requireCondition(integer(value, 1), 'INVALID_CONFIG', 'Consensus values must be positive integers');
  requireCondition(config.minimumDifficulty <= config.initialDifficulty &&
    config.initialDifficulty <= config.maximumDifficulty && config.maximumDifficulty <= 8 &&
    config.adjustmentInterval >= 2 && config.maximumBlockBytes >= 1024,
  'INVALID_CONFIG', 'Invalid difficulty, retarget interval or block size');
  return Object.freeze(config);
}

export function headerHash(header) {
  return sha256(canonical(header));
}

export function meetsDifficulty(hash, difficulty) {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) &&
    integer(difficulty, 1) && difficulty <= 64 && hash.startsWith('0'.repeat(difficulty));
}

export function blockWork(difficulty) {
  return 16n ** BigInt(difficulty);
}

export function blockBytes(block) {
  return Buffer.byteLength(canonical(block));
}

export function buildBlock(height, previousHash, transactions, difficulty, timestamp) {
  return {
    header: { height, timestamp, previousHash, merkleRoot: merkleRoot(transactions), difficulty, nonce: 0 },
    transactions: clone(transactions),
    hash: '0'.repeat(64),
  };
}

export function mineBlock(candidate) {
  const block = clone(candidate);
  const started = performance.now();
  for (let nonce = 0; nonce <= Number.MAX_SAFE_INTEGER; nonce++) {
    block.header.nonce = nonce;
    block.hash = headerHash(block.header);
    if (meetsDifficulty(block.hash, block.header.difficulty)) {
      return { block, attempts: nonce + 1, milliseconds: performance.now() - started };
    }
  }
  throw new Error('Nonce range exhausted');
}

export function genesisBlock(config) {
  const key = canonical(config);
  if (!genesisCache.has(key)) {
    const candidate = buildBlock(0, '0'.repeat(64), [], config.initialDifficulty, GENESIS_TIME);
    genesisCache.set(key, mineBlock(candidate).block);
  }
  return clone(genesisCache.get(key));
}

export function expectedDifficulty(blocks, config) {
  const tip = blocks.at(-1);
  const height = tip.header.height;
  if (height === 0 || height % config.adjustmentInterval !== 0) return tip.header.difficulty;
  const first = blocks[blocks.length - config.adjustmentInterval];
  const elapsed = tip.header.timestamp - first.header.timestamp;
  const target = (config.adjustmentInterval - 1) * config.targetBlockMilliseconds;
  if (elapsed < target / 2) return Math.min(config.maximumDifficulty, tip.header.difficulty + 1);
  if (elapsed > target * 2) return Math.max(config.minimumDifficulty, tip.header.difficulty - 1);
  return tip.header.difficulty;
}

export function validateHeader(block, previous, expected, config, now = Date.now()) {
  exactKeys(block, ['header', 'transactions', 'hash']);
  validateHeaderLink(block.header, block.hash, previous, expected, config, now);
  requireCondition(Array.isArray(block.transactions) && block.transactions.length > 0,
    'EMPTY_BLOCK', 'A non-genesis block must have a coinbase');
  requireCondition(blockBytes(block) <= config.maximumBlockBytes, 'BLOCK_TOO_LARGE', 'Block exceeds its byte limit');
  requireCondition(block.header.merkleRoot === merkleRoot(block.transactions), 'MERKLE_MISMATCH', 'Transaction data does not match the Merkle root');
}

export function validateHeaderLink(header, hash, previous, expected, config, now = Date.now()) {
  exactKeys(header, ['height', 'timestamp', 'previousHash', 'merkleRoot', 'difficulty', 'nonce']);
  requireCondition(address(header.merkleRoot), 'MERKLE_MISMATCH', 'Merkle root must be a SHA-256 hash');
  requireCondition(integer(header.height) && header.height === previous.header.height + 1,
    'INVALID_HEIGHT', 'Block height must follow the previous block');
  requireCondition(header.previousHash === previous.hash, 'PREVIOUS_HASH_MISMATCH', 'Previous block link is broken');
  requireCondition(integer(header.timestamp) && header.timestamp > previous.header.timestamp &&
    header.timestamp <= now + config.maximumFutureMilliseconds, 'INVALID_TIMESTAMP', 'Invalid block timestamp');
  requireCondition(header.difficulty === expected && integer(header.nonce), 'INVALID_DIFFICULTY', 'Unexpected difficulty or nonce');
  requireCondition(hash === headerHash(header), 'HASH_MISMATCH', 'Stored block hash is incorrect');
  requireCondition(meetsDifficulty(hash, expected), 'INVALID_POW', 'Block does not satisfy proof of work');
}
