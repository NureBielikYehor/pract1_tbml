import { parentPort, workerData } from 'node:worker_threads';
import { mineBlock } from './block.js';

try {
  parentPort.postMessage({ result: mineBlock(workerData) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
