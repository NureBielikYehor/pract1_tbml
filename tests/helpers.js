import { Blockchain } from '../src/blockchain.js';
import { mineBlock } from '../src/block.js';
import { createWallet } from '../src/wallet.js';

export function fixture(options = {}) {
  const wallets = [createWallet(), createWallet(), createWallet()];
  const chain = new Blockchain({ initialDifficulty: 1, adjustmentInterval: 3, ...options });
  return { chain, a: wallets[0], b: wallets[1], c: wallets[2] };
}

export function mine(chain, miner, timestamp = chain.tip.header.timestamp + 1000) {
  const result = mineBlock(chain.candidate(miner.address ?? miner, timestamp));
  chain.addBlock(result.block);
  return result.block;
}

export function fork(chain) {
  const result = new Blockchain(chain.config);
  result.adoptChain(chain.blocks);
  return result;
}
