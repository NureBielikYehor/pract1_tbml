import path from 'node:path';
import { connectAll, startNode, stopNode } from './processes.js';

const nodes = [];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all(nodes.map(stopNode));
}
process.once('SIGINT', () => close());
process.once('SIGTERM', () => close());

try {
  for (const port of [4101, 4102, 4103]) {
    if (closing) break;
    const node = await startNode(path.join('data', 'node-' + port), port);
    nodes.push(node);
    if (closing) {
      await stopNode(node);
      break;
    }
    node.child.once('exit', code => {
      if (!closing) {
        console.error('Node stopped unexpectedly, code ' + code);
        process.exitCode = 1;
        void close();
      }
    });
  }
  if (!closing) {
    await connectAll(nodes);
    console.log('Three independent nodes are ready. Stop the network with Ctrl+C.');
    for (const node of nodes) console.log(JSON.stringify({ url: node.url, pid: node.pid, data: node.directory }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await close();
}
