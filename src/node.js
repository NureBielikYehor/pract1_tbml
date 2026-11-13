import http from 'node:http';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { Blockchain, validateChain } from './blockchain.js';
import { address, canonical, ChainError, clone, integer, requireCondition } from './common.js';
import { expectedDifficulty } from './block.js';
import { createTransaction, transactionId } from './transaction.js';
import { createWallet, loadWallet, saveWallet } from './wallet.js';
import { merkleProof } from './merkle.js';

export async function requestJson(url, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(new URL(url).pathname === '/mine' ? 120000 : 15000),
  });
  const result = await response.json();
  if (!response.ok) throw new ChainError(result.code ?? 'HTTP_ERROR', result.message ?? 'HTTP ' + response.status);
  return result;
}

export function peerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ChainError('INVALID_PEER', 'Expected a loopback HTTP URL'); }
  requireCondition(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
  'INVALID_PEER', 'Peers must be local HTTP nodes without credentials or paths');
  return url.origin;
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    requireCondition(length <= 65536, 'REQUEST_TOO_LARGE', 'Request exceeds 64 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ChainError('INVALID_JSON', 'Request must contain valid JSON'); }
}

export class BlockchainNode {
  constructor({ directory, peers = [], consensus = {}, syncMilliseconds = 3000 }) {
    this.directory = directory;
    this.filename = path.join(directory, 'chain.json');
    this.chain = Blockchain.load(this.filename, consensus);
    this.peers = new Set(peers.map(peerUrl));
    this.syncMilliseconds = syncMilliseconds;
    this.activeWorker = null;
    this.syncing = null;
    this.closed = false;
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  persist() { this.chain.save(this.filename); }

  commit(change) {
    const previous = { blocks: this.chain.blocks, pending: this.chain.pending,
      state: this.chain.state, work: this.chain.work };
    try {
      const result = change();
      this.persist();
      return result;
    } catch (error) {
      Object.assign(this.chain, previous);
      throw error;
    }
  }

  status() {
    return {
      url: this.url, pid: process.pid, height: this.chain.height, tip: this.chain.tip.hash,
      work: this.chain.work.toString(), pending: this.chain.pending.length,
      difficulty: expectedDifficulty(this.chain.blocks, this.chain.config), peers: [...this.peers],
    };
  }

  async listen(port = 4101) {
    this.persist();
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', resolve);
    });
    this.url = 'http://127.0.0.1:' + this.server.address().port;
    this.peers.delete(this.url);
    this.timer = setInterval(() => this.sync().catch(error => console.error(error.message)), this.syncMilliseconds);
    this.timer.unref();
    return this.url;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.activeWorker) await this.activeWorker.terminate();
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }

  async broadcast(endpoint, value) {
    if (this.closed) return [];
    return Promise.allSettled([...this.peers].map(peer => requestJson(peer + endpoint, 'POST', value)));
  }

  acceptTransaction(transaction) {
    const id = this.commit(() => this.chain.addTransaction(transaction));
    void this.broadcast('/transactions', transaction);
    return { accepted: true, id, transaction };
  }

  async mine(miner) {
    requireCondition(!this.activeWorker, 'MINING_BUSY', 'This node is already mining');
    const candidate = this.chain.candidate(miner);
    const previousHash = this.chain.tip.hash;
    const worker = new Worker(new URL('./pow-worker.js', import.meta.url), { workerData: candidate });
    this.activeWorker = worker;
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.result));
        worker.once('error', reject);
        worker.once('exit', code => {
          if (code !== 0) reject(new ChainError('MINING_ABORTED', 'Mining worker stopped'));
        });
      });
      requireCondition(this.chain.tip.hash === previousHash, 'STALE_WORK', 'Chain changed while mining; retry on the new tip');
      this.commit(() => this.chain.addBlock(result.block));
      void this.broadcast('/blocks', result.block);
      return { ...result, work: this.chain.work.toString() };
    } finally {
      this.activeWorker = null;
      await worker.terminate();
    }
  }

  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.synchronize();
    try { return await this.syncing; }
    finally { this.syncing = null; }
  }

  async synchronize() {
    const responses = await Promise.allSettled([...this.peers].map(peer => requestJson(peer + '/chain')));
    let best = null;
    let bestWork = this.chain.work;
    const errors = [];
    for (const response of responses) {
      if (response.status !== 'fulfilled') {
        errors.push(response.reason.message);
        continue;
      }
      try {
        const candidate = response.value;
        requireCondition(canonical(candidate.consensus) === canonical(this.chain.config), 'INVALID_CONFIG', 'Peer uses different consensus rules');
        const { work } = validateChain(candidate.blocks, this.chain.config);
        if (work > bestWork) {
          best = candidate.blocks;
          bestWork = work;
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
    // adoptChain compares again against the current tip after all network awaits.
    const result = best ? this.commit(() => this.chain.adoptChain(best)) : { adopted: false, restored: [], rejected: [] };
    if (result.adopted) {
      void this.broadcast('/blocks', this.chain.tip);
      for (const transaction of this.chain.pending) void this.broadcast('/transactions', transaction);
    }
    // Repair missed/out-of-order gossip after reconnection without replacing accepted nonce conflicts.
    const pools = await Promise.allSettled([...this.peers].map(peer => requestJson(peer + '/mempool')));
    const candidates = pools.filter(pool => pool.status === 'fulfilled' && Array.isArray(pool.value?.transactions))
      .flatMap(pool => pool.value.transactions)
      .filter(transaction => transaction && typeof transaction === 'object')
      .sort((a, b) => a.nonce - b.nonce);
    const synchronizedTransactions = [];
    for (const transaction of candidates) {
      try {
        synchronizedTransactions.push(this.commit(() => this.chain.addTransaction(transaction)));
      } catch (error) {
        if (!(error instanceof ChainError)) throw error;
      }
    }
    return { ...result, synchronizedTransactions, errors, ...this.status() };
  }

  async route(request, url) {
    const method = request.method;
    const pathname = url.pathname;
    if (method === 'GET' && pathname === '/status') return this.status();
    if (method === 'GET' && pathname === '/chain') {
      return { consensus: this.chain.config, blocks: clone(this.chain.blocks), work: this.chain.work.toString() };
    }
    if (method === 'GET' && pathname === '/headers') {
      return { consensus: this.chain.config, headers: this.chain.blocks.map(block => ({ header: block.header, hash: block.hash })) };
    }
    if (method === 'GET' && pathname === '/mempool') return { transactions: clone(this.chain.pending) };
    if (method === 'GET' && pathname.startsWith('/balance/')) return this.chain.account(pathname.slice('/balance/'.length));
    if (method === 'GET' && pathname === '/validate') {
      const { work } = validateChain(this.chain.blocks, this.chain.config);
      return { valid: true, blocks: this.chain.blocks.length, work: work.toString() };
    }
    if (method === 'GET' && pathname === '/proof') {
      const height = Number(url.searchParams.get('height'));
      const index = Number(url.searchParams.get('index'));
      requireCondition(url.searchParams.has('height') && url.searchParams.has('index') && integer(height) &&
        height < this.chain.blocks.length, 'INVALID_INDEX', 'Invalid block height');
      const block = this.chain.blocks[height];
      return { height, blockHash: block.hash, transaction: block.transactions[index], proof: merkleProof(block.transactions, index) };
    }
    if (method === 'POST' && pathname === '/wallets') {
      const wallet = createWallet();
      const filename = path.join(this.directory, 'wallets', wallet.address + '.json');
      saveWallet(wallet, filename);
      return { address: wallet.address, publicKey: wallet.publicKey, file: path.resolve(filename) };
    }
    if (method === 'POST' && pathname === '/transactions') return this.acceptTransaction(await readBody(request));
    if (method === 'POST' && pathname === '/send') {
      const body = await readBody(request);
      requireCondition(address(body.sender), 'INVALID_ADDRESS', 'Invalid sender');
      const wallet = loadWallet(path.join(this.directory, 'wallets', body.sender + '.json'));
      const nonce = body.nonce ?? this.chain.account(body.sender).nextNonce;
      return this.acceptTransaction(createTransaction(wallet, body.recipient, body.amount, body.fee ?? 0, nonce));
    }
    if (method === 'POST' && pathname === '/mine') return this.mine((await readBody(request)).miner);
    if (method === 'POST' && pathname === '/sync') return this.sync();
    if (method === 'POST' && pathname === '/peers') {
      const peer = peerUrl((await readBody(request)).url);
      if (peer !== this.url) this.peers.add(peer);
      return { peers: [...this.peers] };
    }
    if (method === 'PUT' && pathname === '/peers') {
      const body = await readBody(request);
      requireCondition(Array.isArray(body.peers), 'INVALID_PEER', 'Expected an array of peer URLs');
      const peers = new Set(body.peers.map(peerUrl));
      peers.delete(this.url);
      this.peers = peers;
      return { peers: [...this.peers] };
    }
    throw new ChainError('NOT_FOUND', 'Unknown API route');
  }

  async handle(request, response) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, this.url);
      if (request.method === 'POST' && url.pathname === '/blocks') {
        const block = await readBody(request);
        if (this.chain.blocks.some(item => item.hash === block.hash)) {
          response.end(JSON.stringify({ accepted: true, known: true }));
          return;
        }
        if (block.header?.previousHash === this.chain.tip.hash) {
          this.commit(() => this.chain.addBlock(block));
          void this.broadcast('/blocks', block);
        } else {
          await this.sync();
          requireCondition(this.chain.blocks.some(item => item.hash === block.hash),
            'FORK_NOT_ADOPTED', 'Block is not on a valid chain with greater cumulative work');
        }
        response.end(JSON.stringify({ accepted: true, ...this.status() }));
        return;
      }
      const result = await this.route(request, url);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = error.code === 'NOT_FOUND' ? 404 : 400;
      response.end(JSON.stringify({ code: error.code ?? 'NODE_ERROR', message: error.message }));
    }
  }
}
