import { canonical, clone, exactKeys, integer, requireCondition, writeJsonAtomic } from './common.js';
import { consensusConfig, expectedDifficulty, genesisBlock, validateHeaderLink } from './block.js';
import { verifyMerkleProof } from './merkle.js';

export class LightClient {
  constructor(headers, options = {}) {
    this.config = consensusConfig(options);
    requireCondition(Array.isArray(headers) && headers.length > 0, 'EMPTY_CHAIN', 'Headers must include genesis');
    const genesis = genesisBlock(this.config);
    const expectedGenesis = { header: genesis.header, hash: genesis.hash };
    requireCondition(canonical(headers[0]) === canonical(expectedGenesis), 'INVALID_GENESIS', 'Unknown header genesis');
    const prefix = [headers[0]];
    for (const item of headers.slice(1)) {
      exactKeys(item, ['header', 'hash']);
      validateHeaderLink(item.header, item.hash, prefix.at(-1), expectedDifficulty(prefix, this.config), this.config);
      prefix.push(item);
    }
    this.headers = clone(headers);
  }

  verify(transaction, proof, height, hash) {
    if (!integer(height) || height >= this.headers.length) return false;
    const block = this.headers[height];
    return block.hash === hash && verifyMerkleProof(transaction, proof, block.header.merkleRoot);
  }

  save(filename) {
    writeJsonAtomic(filename, { consensus: this.config, headers: this.headers });
  }
}
