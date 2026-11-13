import fs from 'node:fs';
import path from 'node:path';
import { BlockchainNode, requestJson } from './node.js';
import { createWallet, loadWallet, saveWallet } from './wallet.js';
import { createTransaction } from './transaction.js';
import { LightClient } from './light-client.js';
import { integer, requireCondition } from './common.js';

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    requireCondition(args[index].startsWith('--') && args[index + 1] !== undefined,
      'INVALID_ARGUMENT', 'Options require --name value pairs');
    result[args[index].slice(2)] = args[index + 1];
  }
  return result;
}

export async function runCli(args = process.argv.slice(2)) {
  const [command = 'help', ...rest] = args;
  const flags = options(rest);
  const base = flags.url ?? 'http://127.0.0.1:4101';
  let result;
  if (command === 'node') {
    const port = Number(flags.port ?? 4101);
    requireCondition(integer(port) && port <= 65535, 'INVALID_PORT', 'Port must be between 0 and 65535');
    const node = new BlockchainNode({ directory: flags.data ?? path.join('data', 'node-' + port),
      peers: flags.peers ? flags.peers.split(',') : [] });
    const url = await node.listen(port);
    console.log(JSON.stringify({ ready: true, url, pid: process.pid, height: node.chain.height }));
    process.send?.({ ready: true, url, pid: process.pid });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await node.close();
      process.exit(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (command === 'wallet') {
    const wallet = createWallet();
    const filename = flags.out ?? path.join('data', 'wallets', wallet.address + '.json');
    saveWallet(wallet, filename);
    result = { address: wallet.address, publicKey: wallet.publicKey, file: path.resolve(filename) };
  } else if (command === 'send') {
    requireCondition(flags.wallet && flags.to && flags.amount, 'INVALID_ARGUMENT', 'send requires --wallet, --to and --amount');
    const wallet = loadWallet(flags.wallet);
    const account = await requestJson(base + '/balance/' + wallet.address);
    const transaction = createTransaction(wallet, flags.to, Number(flags.amount), Number(flags.fee ?? 0),
      flags.nonce === undefined ? account.nextNonce : Number(flags.nonce));
    result = await requestJson(base + '/transactions', 'POST', transaction);
  } else if (command === 'mine') {
    result = await requestJson(base + '/mine', 'POST', { miner: flags.miner });
  } else if (command === 'balance') {
    result = await requestJson(base + '/balance/' + flags.address);
  } else if (['status', 'chain', 'mempool', 'validate', 'headers'].includes(command)) {
    result = await requestJson(base + '/' + command);
  } else if (command === 'peer') {
    result = await requestJson(base + '/peers', 'POST', { url: flags.add });
  } else if (command === 'sync') {
    result = await requestJson(base + '/sync', 'POST', {});
  } else if (command === 'proof') {
    result = await requestJson(base + '/proof?height=' + flags.height + '&index=' + flags.index);
  } else if (command === 'light-sync') {
    const saved = await requestJson(base + '/headers');
    const client = new LightClient(saved.headers);
    client.save(flags.file ?? 'data/light-client.json');
    result = { headers: client.headers.length, file: flags.file ?? 'data/light-client.json' };
  } else if (command === 'verify-proof') {
    const saved = JSON.parse(fs.readFileSync(flags.file ?? 'data/light-client.json', 'utf8'));
    const client = new LightClient(saved.headers);
    const payload = await requestJson(base + '/proof?height=' + flags.height + '&index=' + flags.index);
    result = { valid: client.verify(payload.transaction, payload.proof, payload.height, payload.blockHash) };
    if (!result.valid) process.exitCode = 1;
  } else {
    requireCondition(command === 'help', 'INVALID_COMMAND', 'Unknown command ' + command);
    result = { commands: ['node', 'wallet', 'send', 'mine', 'chain', 'balance', 'validate', 'peer',
      'sync', 'status', 'mempool', 'headers', 'proof', 'light-sync', 'verify-proof'],
    usage: 'node index.js COMMAND --option value; see README.md for complete examples' };
  }
  console.log(JSON.stringify(result, null, 2));
}
