import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Blockchain, validateChain } from '../src/blockchain.js';
import { blockBytes, buildBlock, expectedDifficulty, GENESIS_TIME, headerHash, mineBlock } from '../src/block.js';
import { canonical, clone, sha256 } from '../src/common.js';
import { createTransaction, transactionId } from '../src/transaction.js';
import { merkleProof, merkleRoot, verifyMerkleProof } from '../src/merkle.js';
import { LightClient } from '../src/light-client.js';
import { fixture, fork, mine } from './helpers.js';

const code = expected => error => error.code === expected;

test('canonical JSON sorts nested keys and preserves identical header bytes', () => {
  assert.equal(canonical({ b: [{ y: 1, x: 2 }], a: 'value' }), canonical({ a: 'value', b: [{ x: 2, y: 1 }] }));
  assert.throws(() => canonical({ value: NaN }), code('INVALID_NUMBER'));
  assert.throws(() => canonical({ value: undefined }), code('INVALID_OBJECT'));
  const { chain } = fixture();
  const reversed = Object.fromEntries(Object.entries(chain.tip.header).reverse());
  assert.equal(headerHash(reversed), chain.tip.hash);
});

test('wallet address is SHA-256 of the Ed25519 public key and signatures bind every field', () => {
  const { chain, a, b } = fixture();
  const publicKey = createPublicKey({ key: Buffer.from(a.publicKey, 'base64'), type: 'spki', format: 'der' });
  assert.equal(publicKey.asymmetricKeyType, 'ed25519');
  assert.equal(a.address, sha256(Buffer.from(a.publicKey, 'base64')));
  mine(chain, a);
  const transaction = createTransaction(a, b.address, 5, 1, 0);
  assert.throws(() => chain.addTransaction({ ...transaction, amount: 6 }), code('INVALID_SIGNATURE'));
  assert.throws(() => chain.addTransaction({ ...transaction, sender: b.address }), code('INVALID_SIGNATURE'));
  chain.addTransaction(transaction);
});

test('transactions reject fractional amounts, negative fees and extra unsigned fields', () => {
  const { chain, a, b } = fixture();
  assert.throws(() => createTransaction(a, b.address, 0.5, 0, 0), code('INVALID_NUMBER'));
  assert.throws(() => createTransaction(a, b.address, 1, -1, 0), code('INVALID_AMOUNT'));
  const transaction = createTransaction(a, b.address, 1, 0, 0);
  assert.throws(() => chain.addTransaction({ ...transaction, extra: true }), code('INVALID_FIELDS'));
});

test('mempool rejects a forged signature', () => {
  const { chain, a, b } = fixture();
  mine(chain, a);
  const transaction = createTransaction(a, b.address, 10, 1, 0);
  transaction.signature = Buffer.alloc(64).toString('base64');
  assert.throws(() => chain.addTransaction(transaction), code('INVALID_SIGNATURE'));
  assert.equal(chain.pending.length, 0);
});

test('mempool reserves pending funds and rejects a second full-balance spend', () => {
  const { chain, a, b, c } = fixture();
  mine(chain, a);
  chain.addTransaction(createTransaction(a, b.address, 49, 1, 0));
  assert.equal(chain.account(a.address).available, 0);
  assert.throws(() => chain.addTransaction(createTransaction(a, c.address, 49, 1, 1)), code('INSUFFICIENT_FUNDS'));
});

test('mempool rejects duplicate transfers and nonce gaps', () => {
  const { chain, a, b } = fixture();
  mine(chain, a);
  const transaction = createTransaction(a, b.address, 2, 0, 0);
  chain.addTransaction(transaction);
  assert.throws(() => chain.addTransaction(transaction), code('DUPLICATE'));
  assert.throws(() => chain.addTransaction(createTransaction(a, b.address, 2, 0, 2)), code('INVALID_NONCE'));
  chain.addTransaction(createTransaction(a, b.address, 2, 0, 1));
  assert.equal(chain.account(a.address).nextNonce, 2);
});

test('pending incoming money cannot be spent before confirmation', () => {
  const { chain, a, b, c } = fixture();
  mine(chain, a);
  chain.addTransaction(createTransaction(a, b.address, 10, 0, 0));
  assert.throws(() => chain.addTransaction(createTransaction(b, c.address, 1, 0, 0)), code('INSUFFICIENT_FUNDS'));
});

test('Merkle root for an even leaf count matches independently paired hashes', () => {
  const transactions = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }];
  const hashes = transactions.map(transactionId);
  const left = sha256(Buffer.from(hashes[0] + hashes[1], 'hex'));
  const right = sha256(Buffer.from(hashes[2] + hashes[3], 'hex'));
  assert.equal(merkleRoot(transactions), sha256(Buffer.from(left + right, 'hex')));
});

test('Merkle root duplicates the last hash for odd counts and handles empty/single lists', () => {
  const transactions = [{ a: 1 }, { a: 2 }, { a: 3 }];
  const hashes = transactions.map(transactionId);
  const left = sha256(Buffer.from(hashes[0] + hashes[1], 'hex'));
  const right = sha256(Buffer.from(hashes[2] + hashes[2], 'hex'));
  assert.equal(merkleRoot(transactions), sha256(Buffer.from(left + right, 'hex')));
  assert.equal(merkleRoot([]), sha256(Buffer.alloc(0)));
  assert.equal(merkleRoot([transactions[0]]), hashes[0]);
});

test('mining credits exactly reward plus fees and derives account balances', () => {
  const { chain, a, b } = fixture();
  mine(chain, a);
  chain.addTransaction(createTransaction(a, b.address, 10, 2, 0));
  const block = mine(chain, b);
  assert.equal(block.transactions[0].amount, 52);
  assert.equal(chain.account(a.address).balance, 38);
  assert.equal(chain.account(b.address).balance, 62);
  assert.equal(chain.pending.length, 0);
  assert.equal(validateChain(chain.blocks, chain.config).work, chain.work);
});

test('all nodes have the same immutable-by-validation genesis', () => {
  const first = fixture().chain;
  const second = fixture().chain;
  assert.deepEqual(first.blocks, second.blocks);
  second.blocks[0].header.timestamp++;
  assert.throws(() => validateChain(second.blocks, second.config), code('INVALID_GENESIS'));
});

test('changing an amount in an old confirmed transaction is detected', () => {
  const { chain, a, b } = fixture();
  mine(chain, a);
  chain.addTransaction(createTransaction(a, b.address, 10, 1, 0));
  mine(chain, b);
  mine(chain, b);
  chain.blocks[2].transactions[1].amount++;
  assert.throws(() => validateChain(chain.blocks, chain.config), code('MERKLE_MISMATCH'));
});

test('remining a modified old block still breaks its successor link', () => {
  const { chain, a } = fixture();
  mine(chain, a);
  mine(chain, a);
  mine(chain, a);
  chain.blocks[1].header.timestamp++;
  chain.blocks[1] = mineBlock(chain.blocks[1]).block;
  assert.throws(() => validateChain(chain.blocks, chain.config), code('PREVIOUS_HASH_MISMATCH'));
});

test('incorrect stored hashes and invalid proofs of work are rejected', () => {
  const { chain, a } = fixture();
  const candidate = chain.candidate(a.address);
  const wrongHash = mineBlock(candidate).block;
  wrongHash.hash = 'f'.repeat(64);
  assert.throws(() => chain.addBlock(wrongHash), code('HASH_MISMATCH'));
  const wrongWork = clone(candidate);
  while (true) {
    wrongWork.hash = headerHash(wrongWork.header);
    if (!wrongWork.hash.startsWith('0')) break;
    wrongWork.header.nonce++;
  }
  assert.throws(() => chain.addBlock(wrongWork), code('INVALID_POW'));
});

test('block difficulty cannot be chosen by an attacker', () => {
  const { chain, a } = fixture();
  const block = chain.candidate(a.address);
  block.header.difficulty = 2;
  assert.throws(() => chain.addBlock(mineBlock(block).block), code('INVALID_DIFFICULTY'));
});

test('an inflated coinbase is rejected even after a valid Merkle root and PoW', () => {
  const { chain, a } = fixture();
  const block = chain.candidate(a.address);
  block.transactions[0].amount++;
  block.header.merkleRoot = merkleRoot(block.transactions);
  assert.throws(() => chain.addBlock(mineBlock(block).block), code('INVALID_REWARD'));
});

test('a block cannot contain a second coinbase', () => {
  const { chain, a } = fixture();
  const block = chain.candidate(a.address);
  block.transactions.push(clone(block.transactions[0]));
  block.header.merkleRoot = merkleRoot(block.transactions);
  assert.throws(() => chain.addBlock(mineBlock(block).block), code('INVALID_TYPE'));
});

test('block replay checks balances and nonces independently of mempool admission', () => {
  const { chain, a, b } = fixture();
  mine(chain, a);
  const candidate = chain.candidate(b.address);
  candidate.transactions.push(createTransaction(a, b.address, 51, 0, 0));
  candidate.header.merkleRoot = merkleRoot(candidate.transactions);
  assert.throws(() => chain.addBlock(mineBlock(candidate).block), code('INSUFFICIENT_FUNDS'));
  candidate.transactions[1] = createTransaction(a, b.address, 1, 0, 2);
  candidate.header.merkleRoot = merkleRoot(candidate.transactions);
  assert.throws(() => chain.addBlock(mineBlock(candidate).block), code('INVALID_NONCE'));
});

test('confirmed transfers cannot be replayed because their nonce is already consumed', () => {
  const { chain, a, b } = fixture();
  mine(chain, a);
  const transaction = createTransaction(a, b.address, 1, 0, 0);
  chain.addTransaction(transaction);
  mine(chain, b);
  assert.throws(() => chain.addTransaction(transaction), code('NONCE_TOO_LOW'));
});

test('retarget increases difficulty after fast windows and decreases it after slow windows', () => {
  const fast = fixture();
  for (let i = 1; i <= 3; i++) mine(fast.chain, fast.a, GENESIS_TIME + i);
  assert.equal(expectedDifficulty(fast.chain.blocks, fast.chain.config), 2);
  const slow = fixture({ initialDifficulty: 2 });
  for (let i = 1; i <= 3; i++) mine(slow.chain, slow.a, GENESIS_TIME + i * 10000);
  assert.equal(expectedDifficulty(slow.chain.blocks, slow.chain.config), 1);
});

test('retarget stays bounded and stable for target-duration windows', () => {
  const { chain, a } = fixture({ maximumDifficulty: 1 });
  for (let i = 1; i <= 6; i++) mine(chain, a, GENESIS_TIME + i);
  assert.equal(expectedDifficulty(chain.blocks, chain.config), 1);
  const normal = fixture();
  for (let i = 1; i <= 3; i++) mine(normal.chain, normal.a);
  assert.equal(expectedDifficulty(normal.chain.blocks, normal.chain.config), 1);
});

test('a shorter valid chain with greater cumulative work replaces a longer one', () => {
  const { chain: heavy, a } = fixture({ maximumDifficulty: 3 });
  const { chain: longer, b } = fixture({ maximumDifficulty: 3 });
  for (let i = 1; i <= 4; i++) mine(heavy, a, GENESIS_TIME + i);
  for (let i = 1; i <= 6; i++) mine(longer, b, GENESIS_TIME + i * 1000);
  assert(heavy.height < longer.height);
  assert(heavy.work > longer.work);
  assert.equal(longer.adoptChain(heavy.blocks).adopted, true);
  assert.equal(longer.tip.hash, heavy.tip.hash);
});

test('equal-work forks keep the current chain', () => {
  const { chain, a, b } = fixture();
  const other = new Blockchain(chain.config);
  mine(chain, a);
  mine(other, b);
  const tip = chain.tip.hash;
  assert.equal(chain.adoptChain(other.blocks).adopted, false);
  assert.equal(chain.tip.hash, tip);
});

test('a valid transaction from a discarded block returns to the mempool and is mined again', () => {
  const { chain, a, b, c } = fixture();
  mine(chain, a);
  const winner = fork(chain);
  const transaction = createTransaction(a, b.address, 5, 1, 0);
  chain.addTransaction(transaction);
  mine(chain, a);
  mine(winner, c);
  mine(winner, c);
  const result = chain.adoptChain(winner.blocks);
  assert.deepEqual(result.restored, [transactionId(transaction)]);
  assert.equal(chain.pending.length, 1);
  mine(chain, b);
  assert.equal(chain.pending.length, 0);
  assert.equal(chain.tip.transactions[1].signature, transaction.signature);
});

test('conflicting orphan transactions are rejected with an explicit reason', () => {
  const { chain, a, b, c } = fixture();
  mine(chain, a);
  const winner = fork(chain);
  chain.addTransaction(createTransaction(a, b.address, 5, 1, 0));
  mine(chain, a);
  winner.addTransaction(createTransaction(a, c.address, 5, 1, 0));
  mine(winner, c);
  mine(winner, c);
  const result = chain.adoptChain(winner.blocks);
  assert.equal(chain.pending.length, 0);
  assert.equal(result.rejected[0].code, 'NONCE_TOO_LOW');
});

test('chain and valid mempool survive disk reload; corrupted state is rejected', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pract1-storage-'));
  try {
    const filename = path.join(directory, 'chain.json');
    const { chain, a, b } = fixture();
    mine(chain, a);
    chain.addTransaction(createTransaction(a, b.address, 2, 1, 0));
    chain.save(filename);
    const restored = Blockchain.load(filename, chain.config);
    assert.deepEqual(restored.blocks, chain.blocks);
    assert.deepEqual(restored.pending, chain.pending);
    const saved = JSON.parse(fs.readFileSync(filename));
    saved.blocks[1].transactions[0].amount++;
    fs.writeFileSync(filename, JSON.stringify(saved));
    assert.throws(() => Blockchain.load(filename, chain.config), code('MERKLE_MISMATCH'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('byte-limited blocks choose the highest eligible fee and leave other transfers pending', () => {
  const { chain, a, b, c } = fixture({ maximumBlockBytes: 1024 });
  mine(chain, a);
  mine(chain, b);
  const low = createTransaction(a, c.address, 1, 1, 0);
  const high = createTransaction(b, c.address, 1, 5, 0);
  chain.addTransaction(low);
  chain.addTransaction(high);
  const block = mine(chain, c);
  assert(blockBytes(block) <= 1024);
  assert.equal(block.transactions.length, 2);
  assert.equal(transactionId(block.transactions[1]), transactionId(high));
  assert.equal(transactionId(chain.pending[0]), transactionId(low));
});

test('fee selection respects sender nonce dependencies', () => {
  const { chain, a, b } = fixture({ maximumBlockBytes: 1024 });
  mine(chain, a);
  const first = createTransaction(a, b.address, 1, 1, 0);
  const second = createTransaction(a, b.address, 1, 10, 1);
  chain.addTransaction(first);
  chain.addTransaction(second);
  assert.equal(transactionId(chain.candidate(b.address).transactions[1]), transactionId(first));
});

test('oversized peer blocks and future timestamps fail full validation', () => {
  const { chain, a, b } = fixture({ maximumBlockBytes: 1024 });
  mine(chain, a);
  const candidate = chain.candidate(a.address);
  candidate.transactions.push(createTransaction(a, b.address, 1, 0, 0), createTransaction(a, b.address, 1, 0, 1));
  candidate.header.merkleRoot = merkleRoot(candidate.transactions);
  assert.throws(() => chain.addBlock(mineBlock(candidate).block), code('BLOCK_TOO_LARGE'));
  const future = chain.candidate(a.address, Date.now() + chain.config.maximumFutureMilliseconds + 1000);
  assert.throws(() => chain.addBlock(mineBlock(future).block), code('INVALID_TIMESTAMP'));
});

test('Merkle proofs cover every even/odd position and reject tampered paths, leaves and indices', () => {
  const transactions = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }];
  const root = merkleRoot(transactions);
  for (let index = 0; index < transactions.length; index++) {
    const proof = merkleProof(transactions, index);
    assert.equal(verifyMerkleProof(transactions[index], proof, root), true);
    assert.equal(verifyMerkleProof({ a: 100 }, proof, root), false);
    assert.equal(verifyMerkleProof(transactions[index], { ...proof, index: 99 }, root), false);
  }
  const proof = merkleProof(transactions, 4);
  proof.siblings[0] = 'a'.repeat(64);
  assert.equal(verifyMerkleProof(transactions[4], proof, root), false);
});

test('a light client stores headers only and checks inclusion against its authenticated header', () => {
  const { chain, a, b } = fixture();
  mine(chain, a);
  chain.addTransaction(createTransaction(a, b.address, 1, 0, 0));
  mine(chain, b);
  const headers = chain.blocks.map(block => ({ header: block.header, hash: block.hash }));
  const light = new LightClient(headers, chain.config);
  const block = chain.tip;
  assert(!JSON.stringify(light.headers).includes('transactions'));
  assert.equal(light.verify(block.transactions[1], merkleProof(block.transactions, 1), 2, block.hash), true);
  assert.equal(light.verify({ ...block.transactions[1], amount: 2 }, merkleProof(block.transactions, 1), 2, block.hash), false);
  headers[1].header.nonce++;
  assert.throws(() => new LightClient(headers, chain.config), code('HASH_MISMATCH'));
});
