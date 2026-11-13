import { address, canonical, exactKeys, integer, requireCondition, sha256 } from './common.js';
import { transactionId } from './transaction.js';

function parentHash(left, right) {
  return sha256(Buffer.from(left + right, 'hex'));
}

export function merkleRoot(transactions) {
  if (transactions.length === 0) return sha256(Buffer.alloc(0));
  let level = transactions.map(transactionId);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(parentHash(level[i], level[i + 1] ?? level[i]));
    }
    level = next;
  }
  return level[0];
}

export function merkleProof(transactions, index) {
  requireCondition(integer(index) && index < transactions.length, 'INVALID_INDEX', 'Transaction index is out of range');
  const proof = { index, total: transactions.length, siblings: [] };
  let level = transactions.map(transactionId);
  let position = index;
  while (level.length > 1) {
    const sibling = position ^ 1;
    proof.siblings.push(level[sibling] ?? level[position]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(parentHash(level[i], level[i + 1] ?? level[i]));
    level = next;
    position = Math.floor(position / 2);
  }
  return proof;
}

export function verifyMerkleProof(transaction, proof, root) {
  try {
    exactKeys(proof, ['index', 'total', 'siblings']);
    if (!integer(proof.total, 1) || !integer(proof.index) || proof.index >= proof.total || !Array.isArray(proof.siblings)) return false;
    if (!address(root)) return false;
    let hash = sha256(canonical(transaction));
    let position = proof.index;
    let width = proof.total;
    let depth = 0;
    while (width > 1) {
      const sibling = proof.siblings[depth];
      if (!address(sibling)) return false;
      if (position % 2 === 0 && position + 1 === width && sibling !== hash) return false;
      hash = position % 2 === 0 ? parentHash(hash, sibling) : parentHash(sibling, hash);
      width = Math.ceil(width / 2);
      position = Math.floor(position / 2);
      depth++;
    }
    return depth === proof.siblings.length && hash === root;
  } catch {
    return false;
  }
}
