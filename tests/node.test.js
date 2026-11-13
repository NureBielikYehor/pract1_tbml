import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlockchainNode, peerUrl, requestJson } from '../src/node.js';
import { createTransaction } from '../src/transaction.js';
import { mine, fixture } from './helpers.js';

test('a failed disk write rolls back an accepted transaction in memory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pract1-rollback-'));
  try {
    const { chain, a, b } = fixture();
    mine(chain, a);
    const node = new BlockchainNode({ directory, consensus: chain.config });
    node.chain = chain;
    node.persist = () => { throw new Error('Simulated disk failure'); };
    assert.throws(() => node.acceptTransaction(createTransaction(a, b.address, 1, 0, 0)), /disk failure/);
    assert.equal(node.chain.pending.length, 0);
    assert.equal(node.chain.account(a.address).available, 50);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('synchronization recovers transactions whose gossip arrived out of nonce order', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pract1-mempool-sync-'));
  const nodes = [];
  try {
    const { chain, a, b } = fixture();
    mine(chain, a);
    for (let index = 0; index < 2; index++) {
      const node = new BlockchainNode({ directory: path.join(directory, String(index)), consensus: chain.config });
      node.chain.adoptChain(chain.blocks);
      await node.listen(0);
      nodes.push(node);
    }
    const first = createTransaction(a, b.address, 1, 0, 0);
    const second = createTransaction(a, b.address, 1, 0, 1);
    nodes[0].acceptTransaction(first);
    nodes[0].acceptTransaction(second);
    await assert.rejects(() => requestJson(nodes[1].url + '/transactions', 'POST', second),
      error => error.code === 'INVALID_NONCE');
    nodes[1].peers.add(nodes[0].url);
    await nodes[1].sync();
    assert.deepEqual(nodes[1].chain.pending.map(transaction => transaction.nonce), [0, 1]);
    assert.equal((await requestJson(nodes[1].url + '/validate')).valid, true);
    await assert.rejects(() => requestJson(nodes[1].url + '/transactions', 'POST', { invalid: true }),
      error => error.code === 'INVALID_FIELDS');
  } finally {
    await Promise.all(nodes.map(node => node.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('peer URLs are limited to local HTTP nodes', () => {
  assert.equal(peerUrl('http://127.0.0.1:4102'), 'http://127.0.0.1:4102');
  assert.throws(() => peerUrl('http://example.com'), error => error.code === 'INVALID_PEER');
  assert.throws(() => peerUrl('http://127.0.0.1:4102/private'), error => error.code === 'INVALID_PEER');
});
