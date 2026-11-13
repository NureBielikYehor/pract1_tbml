import { fork } from 'node:child_process';
import { once } from 'node:events';
import { requestJson } from '../src/node.js';

export function startNode(directory, port = 0) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('../index.js', import.meta.url), ['node', '--port', String(port), '--data', directory], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Node startup timed out: ' + output));
    }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error('Node exited before ready, code ' + code + ': ' + output));
    });
    child.once('message', message => {
      if (message.ready) {
        clearTimeout(timeout);
        resolve({ child, url: message.url, pid: message.pid, directory, output: () => output });
      }
    });
  });
}

export async function stopNode(node) {
  if (!node || node.child.exitCode !== null || node.child.signalCode !== null) return;
  const stopped = once(node.child, 'exit');
  node.child.kill('SIGTERM');
  const force = setTimeout(() => node.child.kill('SIGKILL'), 3000);
  await stopped;
  clearTimeout(force);
}

export async function connectAll(nodes) {
  await Promise.all(nodes.map(node => requestJson(node.url + '/peers', 'PUT', {
    peers: nodes.filter(other => other.url !== node.url).map(other => other.url),
  })));
}

export async function waitFor(predicate, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + description);
}

export async function statuses(nodes) {
  return Promise.all(nodes.map(node => requestJson(node.url + '/status')));
}
