import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Blockchain, validateChain } from '../src/blockchain.js';
import { mineBlock } from '../src/block.js';
import { clone, writeJsonAtomic } from '../src/common.js';
import { createTransaction } from '../src/transaction.js';
import { createWallet } from '../src/wallet.js';

function expectRejection(name, action, attack, expectedCode) {
  let caught;
  try { action(); } catch (error) { caught = error; }
  assert(caught, 'Attack was accepted: ' + name);
  assert.equal(caught.code, expectedCode);
  return { attack: name, attackerAction: attack, rejected: true, code: caught.code, message: caught.message };
}

export function runAttacks({ saveReport = true, quiet = false } = {}) {
  const a = createWallet();
  const b = createWallet();
  const c = createWallet();
  const chain = new Blockchain();
  function mine(owner) {
    const candidate = chain.candidate(owner.address, chain.tip.header.timestamp + 1000);
    chain.addBlock(mineBlock(candidate).block);
  }
  mine(a);
  const confirmed = createTransaction(a, b.address, 10, 2, 0);
  chain.addTransaction(confirmed);
  mine(b);
  mine(b);
  const results = [];

  const changedAmount = clone(chain.blocks);
  changedAmount[2].transactions[1].amount = 100;
  results.push(expectRejection('old_transaction_amount', () => validateChain(changedAmount, chain.config),
    { block: 2, originalAmount: 10, changedAmount: 100 }, 'MERKLE_MISMATCH'));

  const rehashed = clone(chain.blocks);
  rehashed[2].header.timestamp++;
  const originalHash = rehashed[2].hash;
  rehashed[2] = mineBlock(rehashed[2]).block;
  results.push(expectRejection('old_block_remined', () => validateChain(rehashed, chain.config),
    { changedField: 'timestamp', originalHash, recomputedHash: rehashed[2].hash, validPowRecomputed: true },
    'PREVIOUS_HASH_MISMATCH'));

  const forged = createTransaction(a, c.address, 1, 0, chain.account(a.address).nextNonce);
  forged.signature = Buffer.alloc(64).toString('base64');
  results.push(expectRejection('forged_signature', () => chain.addTransaction(forged),
    { sender: a.address, forgedSignature: forged.signature }, 'INVALID_SIGNATURE'));

  const fullBalance = chain.account(a.address).balance;
  const nonce = chain.account(a.address).nextNonce;
  chain.addTransaction(createTransaction(a, b.address, fullBalance - 1, 1, nonce));
  results.push(expectRejection('double_spend',
    () => chain.addTransaction(createTransaction(a, c.address, fullBalance - 1, 1, nonce + 1)),
    { confirmedBalance: fullBalance, firstTotalSpend: fullBalance, secondTotalSpend: fullBalance,
      availableAfterFirst: chain.account(a.address).available }, 'INSUFFICIENT_FUNDS'));

  results.push(expectRejection('confirmed_transaction_replay', () => chain.addTransaction(confirmed),
    { replayedNonce: confirmed.nonce, confirmedNextNonce: chain.account(a.address).confirmedNonce }, 'NONCE_TOO_LOW'));

  const report = { executedAt: new Date().toISOString(), passed: true, attacks: results };
  if (saveReport) writeJsonAtomic('reports/attacks.json', report);
  if (!quiet) for (const result of results) console.log(JSON.stringify(result, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runAttacks(); console.log('PASS: all five required attacks rejected'); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
