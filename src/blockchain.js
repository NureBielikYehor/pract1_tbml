import fs from 'node:fs';
import { addAmounts, address, canonical, clone, exactKeys, requireCondition, writeJsonAtomic } from './common.js';
import { blockBytes, blockWork, buildBlock, consensusConfig, expectedDifficulty, genesisBlock, validateHeader } from './block.js';
import { createCoinbase, transactionId, validateCoinbase, validateTransfer } from './transaction.js';

function emptyState() {
  return { balances: new Map(), nonces: new Map(), confirmed: new Set() };
}

function balance(state, owner) {
  return state.balances.get(owner) ?? 0;
}

function applyTransfer(state, transaction) {
  validateTransfer(transaction);
  const expectedNonce = state.nonces.get(transaction.sender) ?? 0;
  requireCondition(transaction.nonce === expectedNonce, 'INVALID_NONCE', 'Confirmed nonces must be consecutive');
  const id = transactionId(transaction);
  requireCondition(!state.confirmed.has(id), 'DUPLICATE', 'Transaction is already confirmed');
  const cost = addAmounts(transaction.amount, transaction.fee);
  requireCondition(balance(state, transaction.sender) >= cost, 'INSUFFICIENT_FUNDS', 'Transfer exceeds the confirmed balance');
  state.balances.set(transaction.sender, balance(state, transaction.sender) - cost);
  state.balances.set(transaction.recipient, addAmounts(balance(state, transaction.recipient), transaction.amount));
  state.nonces.set(transaction.sender, expectedNonce + 1);
  state.confirmed.add(id);
}

export function validateChain(blocks, config = consensusConfig(), now = Date.now()) {
  requireCondition(Array.isArray(blocks) && blocks.length > 0, 'EMPTY_CHAIN', 'Chain must contain genesis');
  requireCondition(canonical(blocks[0]) === canonical(genesisBlock(config)), 'INVALID_GENESIS', 'Genesis differs from the network genesis');
  const state = emptyState();
  let work = blockWork(config.initialDifficulty);
  const prefix = [blocks[0]];
  for (let index = 1; index < blocks.length; index++) {
    const block = blocks[index];
    validateHeader(block, prefix.at(-1), expectedDifficulty(prefix, config), config, now);
    let fees = 0;
    for (const transaction of block.transactions.slice(1)) {
      applyTransfer(state, transaction);
      fees = addAmounts(fees, transaction.fee);
    }
    const reward = block.transactions[0];
    validateCoinbase(reward, index, addAmounts(config.blockReward, fees));
    const rewardId = transactionId(reward);
    requireCondition(!state.confirmed.has(rewardId), 'DUPLICATE', 'Coinbase is already confirmed');
    // Credit the reward after transfers, so it cannot finance a transfer in this block.
    state.balances.set(reward.recipient, addAmounts(balance(state, reward.recipient), reward.amount));
    state.confirmed.add(rewardId);
    work += blockWork(block.header.difficulty);
    prefix.push(block);
  }
  return { state, work };
}

export class Blockchain {
  constructor(options = {}) {
    this.config = consensusConfig(options);
    this.blocks = [genesisBlock(this.config)];
    this.pending = [];
    this.refresh();
  }

  get tip() { return this.blocks.at(-1); }
  get height() { return this.tip.header.height; }

  refresh() {
    const validated = validateChain(this.blocks, this.config);
    this.state = validated.state;
    this.work = validated.work;
  }

  account(owner) {
    requireCondition(address(owner), 'INVALID_ADDRESS', 'Invalid account address');
    const outgoing = this.pending.filter(transaction => transaction.sender === owner);
    const reserved = outgoing.reduce((total, transaction) => addAmounts(total, addAmounts(transaction.amount, transaction.fee)), 0);
    return {
      address: owner,
      balance: balance(this.state, owner),
      reserved,
      available: balance(this.state, owner) - reserved,
      confirmedNonce: this.state.nonces.get(owner) ?? 0,
      nextNonce: (this.state.nonces.get(owner) ?? 0) + outgoing.length,
    };
  }

  addTransaction(transaction) {
    validateTransfer(transaction);
    const account = this.account(transaction.sender);
    requireCondition(transaction.nonce >= account.confirmedNonce, 'NONCE_TOO_LOW', 'Nonce has already been confirmed');
    const id = transactionId(transaction);
    requireCondition(!this.state.confirmed.has(id) && !this.pending.some(item => transactionId(item) === id),
      'DUPLICATE', 'Transaction is already in the chain or mempool');
    requireCondition(transaction.nonce === account.nextNonce, 'INVALID_NONCE', 'Expected nonce ' + account.nextNonce);
    requireCondition(addAmounts(transaction.amount, transaction.fee) <= account.available,
      'INSUFFICIENT_FUNDS', 'Balance is reserved by confirmed or pending transfers');
    const single = buildBlock(this.height + 1, this.tip.hash,
      [createCoinbase(transaction.sender, addAmounts(this.config.blockReward, transaction.fee), this.height + 1), transaction],
      expectedDifficulty(this.blocks, this.config), Math.max(Date.now(), this.tip.header.timestamp + 1));
    requireCondition(blockBytes(single) + 15 <= this.config.maximumBlockBytes,
      'TRANSACTION_TOO_LARGE', 'Transaction cannot fit in a block');
    this.pending = [...this.pending, clone(transaction)];
    return id;
  }

  rebuildMempool(candidates) {
    this.pending = [];
    const rejected = [];
    const seen = new Set();
    const sorted = [...candidates].sort((a, b) => a.nonce - b.nonce || b.fee - a.fee || transactionId(a).localeCompare(transactionId(b)));
    for (const transaction of sorted) {
      const id = transactionId(transaction);
      if (seen.has(id) || this.state.confirmed.has(id)) continue;
      seen.add(id);
      try {
        this.addTransaction(transaction);
      } catch (error) {
        rejected.push({ id, code: error.code, message: error.message });
      }
    }
    return rejected;
  }

  candidate(miner, timestamp = Math.max(Date.now(), this.tip.header.timestamp + 1)) {
    requireCondition(address(miner), 'INVALID_ADDRESS', 'Invalid miner address');
    const height = this.height + 1;
    const difficulty = expectedDifficulty(this.blocks, this.config);
    const selected = [];
    const excluded = new Set();
    const state = validateChain(this.blocks, this.config).state;
    let fees = 0;
    while (true) {
      const eligible = this.pending.filter(transaction => !excluded.has(transactionId(transaction)) &&
        transaction.nonce === (state.nonces.get(transaction.sender) ?? 0));
      eligible.sort((a, b) => b.fee - a.fee || transactionId(a).localeCompare(transactionId(b)));
      if (eligible.length === 0) break;
      const transaction = eligible[0];
      excluded.add(transactionId(transaction));
      const nextFees = addAmounts(fees, transaction.fee);
      const reward = createCoinbase(miner, addAmounts(this.config.blockReward, nextFees), height);
      const proposed = buildBlock(height, this.tip.hash, [reward, ...selected, transaction], difficulty, timestamp);
      // A safe integer nonce can grow from one to sixteen decimal digits while mining.
      if (blockBytes(proposed) + 15 > this.config.maximumBlockBytes) continue;
      applyTransfer(state, transaction);
      selected.push(transaction);
      fees = nextFees;
    }
    return buildBlock(height, this.tip.hash,
      [createCoinbase(miner, addAmounts(this.config.blockReward, fees), height), ...selected], difficulty, timestamp);
  }

  addBlock(block) {
    const blocks = [...this.blocks, clone(block)];
    const validated = validateChain(blocks, this.config);
    const pending = this.pending;
    this.blocks = blocks;
    this.state = validated.state;
    this.work = validated.work;
    return this.rebuildMempool(pending);
  }

  adoptChain(candidate) {
    const blocks = clone(candidate);
    const validated = validateChain(blocks, this.config);
    if (validated.work <= this.work) return { adopted: false, restored: [], rejected: [] };
    let common = 0;
    while (common < Math.min(blocks.length, this.blocks.length) && blocks[common].hash === this.blocks[common].hash) common++;
    const orphaned = this.blocks.slice(common).flatMap(block => block.transactions.slice(1));
    const candidates = [...this.pending, ...orphaned];
    this.blocks = blocks;
    this.state = validated.state;
    this.work = validated.work;
    const rejected = this.rebuildMempool(candidates);
    const restored = orphaned.filter(transaction => this.pending.some(item => transactionId(item) === transactionId(transaction))).map(transactionId);
    return { adopted: true, commonHeight: common - 1, restored, rejected };
  }

  save(filename) {
    writeJsonAtomic(filename, { version: 1, consensus: this.config, blocks: this.blocks, mempool: this.pending });
  }

  static load(filename, options = {}) {
    const chain = new Blockchain(options);
    if (!fs.existsSync(filename)) return chain;
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    exactKeys(saved, ['version', 'consensus', 'blocks', 'mempool']);
    requireCondition(saved.version === 1 && canonical(saved.consensus) === canonical(chain.config),
      'INVALID_CONFIG', 'Saved chain uses different consensus parameters');
    requireCondition(Array.isArray(saved.mempool), 'INVALID_MEMPOOL', 'Invalid saved mempool');
    chain.blocks = clone(saved.blocks);
    chain.refresh();
    for (const transaction of saved.mempool) chain.addTransaction(transaction);
    return chain;
  }
}
