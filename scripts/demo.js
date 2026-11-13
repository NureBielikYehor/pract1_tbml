import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LightClient } from '../src/light-client.js';
import { requestJson } from '../src/node.js';
import { writeJsonAtomic } from '../src/common.js';
import { transactionId } from '../src/transaction.js';
import { connectAll, startNode, statuses, stopNode, waitFor } from './processes.js';

export async function runDemo({ quiet = false, saveReport = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pract1-network-'));
  const nodes = [];
  const steps = [];
  function record(name, result) {
    steps.push({ name, result });
    if (!quiet) console.log(JSON.stringify({ step: name, ...result }, null, 2));
  }
  async function agree(expectedHash) {
    await waitFor(async () => (await statuses(nodes)).every(item => item.tip === expectedHash), 'three matching chain tips');
  }
  try {
    for (let i = 0; i < 3; i++) nodes.push(await startNode(path.join(directory, 'node-' + i)));
    assert.equal(new Set(nodes.map(node => node.pid)).size, 3);
    await connectAll(nodes);
    record('three_processes', { nodes: await statuses(nodes) });

    const a = await requestJson(nodes[0].url + '/wallets', 'POST', {});
    const b = await requestJson(nodes[1].url + '/wallets', 'POST', {});
    const first = await requestJson(nodes[0].url + '/mine', 'POST', { miner: a.address });
    await agree(first.block.hash);
    const submitted = await requestJson(nodes[0].url + '/send', 'POST', {
      sender: a.address, recipient: b.address, amount: 10, fee: 2,
    });
    await waitFor(async () => (await statuses(nodes)).every(item => item.pending === 1), 'transaction propagation');
    record('transaction_propagation', { transaction: submitted.id, nodes: await statuses(nodes) });

    const second = await requestJson(nodes[1].url + '/mine', 'POST', { miner: b.address });
    await agree(second.block.hash);
    assert.equal((await requestJson(nodes[0].url + '/balance/' + a.address)).balance, 38);
    assert.equal((await requestJson(nodes[0].url + '/balance/' + b.address)).balance, 62);
    record('block_propagation', { nodes: await statuses(nodes), senderBalance: 38, recipientAndMinerBalance: 62 });

    const beforeRestart = await requestJson(nodes[2].url + '/status');
    const oldPid = nodes[2].pid;
    await stopNode(nodes[2]);
    nodes[2] = await startNode(path.join(directory, 'node-2'));
    const afterRestart = await requestJson(nodes[2].url + '/status');
    assert.equal(afterRestart.tip, beforeRestart.tip);
    assert.notEqual(nodes[2].pid, oldPid);
    await connectAll(nodes);
    record('restart_from_disk', { oldPid, newPid: nodes[2].pid, tipBefore: beforeRestart.tip, tipAfter: afterRestart.tip });

    await Promise.all(nodes.map(node => requestJson(node.url + '/peers', 'PUT', { peers: [] })));
    const orphan = await requestJson(nodes[0].url + '/send', 'POST', {
      sender: a.address, recipient: b.address, amount: 7, fee: 1,
    });
    const losing = await requestJson(nodes[0].url + '/mine', 'POST', { miner: a.address });
    const winnerFirst = await requestJson(nodes[1].url + '/mine', 'POST', { miner: b.address });
    const winnerTip = await requestJson(nodes[1].url + '/mine', 'POST', { miner: b.address });
    assert.notEqual(losing.block.hash, winnerFirst.block.hash);
    record('isolated_forks', { nodes: await statuses(nodes), orphanTransaction: orphan.id, winningTip: winnerTip.block.hash });

    await connectAll(nodes);
    const reorganization = await requestJson(nodes[0].url + '/sync', 'POST', {});
    await Promise.all(nodes.map(node => requestJson(node.url + '/sync', 'POST', {})));
    await agree(winnerTip.block.hash);
    await waitFor(async () => {
      const mempool = await requestJson(nodes[0].url + '/mempool');
      return mempool.transactions.some(transaction => transactionId(transaction) === orphan.id);
    }, 'orphan transaction returning to the mempool');
    record('heavier_chain_adopted', { nodes: await statuses(nodes), reorganization, restoredTransaction: orphan.id });

    // Explicitly submit if a peer received the restored transaction before finishing its reorganization.
    const winnerPool = await requestJson(nodes[1].url + '/mempool');
    if (!winnerPool.transactions.some(transaction => transactionId(transaction) === orphan.id)) {
      await requestJson(nodes[1].url + '/transactions', 'POST', orphan.transaction);
    }
    const final = await requestJson(nodes[1].url + '/mine', 'POST', { miner: b.address });
    await agree(final.block.hash);
    assert(final.block.transactions.some(transaction => transactionId(transaction) === orphan.id));
    const validations = await Promise.all(nodes.map(node => requestJson(node.url + '/validate')));
    assert(validations.every(result => result.valid));
    record('orphan_reconfirmed', { transaction: orphan.id, height: final.block.header.height,
      finalHash: final.block.hash, nodes: await statuses(nodes), validations });

    const headerResponse = await requestJson(nodes[0].url + '/headers');
    const client = new LightClient(headerResponse.headers, headerResponse.consensus);
    const payload = await requestJson(nodes[0].url + '/proof?height=' + final.block.header.height + '&index=1');
    assert.equal(client.verify(payload.transaction, payload.proof, payload.height, payload.blockHash), true);
    assert.equal(client.verify({ ...payload.transaction, amount: payload.transaction.amount + 1 },
      payload.proof, payload.height, payload.blockHash), false);
    if (saveReport) client.save('reports/light-client.json');
    record('light_client_proof', { storedHeaders: client.headers.length, storedFullBlocks: 0,
      authentic: true, tamperedRejected: true, blockHash: payload.blockHash });

    const report = { executedAt: new Date().toISOString(), passed: true, steps };
    if (saveReport) writeJsonAtomic('reports/network-demo.json', report);
    return report;
  } finally {
    await Promise.all(nodes.map(stopNode));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDemo().then(() => console.log('PASS: three processes, propagation, restart, fork, orphan recovery and light-client proof'))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
