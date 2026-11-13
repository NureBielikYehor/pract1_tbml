import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildBlock, GENESIS_TIME, headerHash, meetsDifficulty, mineBlock } from '../src/block.js';
import { integer, requireCondition, writeJsonAtomic } from '../src/common.js';
import { createCoinbase } from '../src/transaction.js';

const args = process.argv.slice(2);
requireCondition(args.length === 0 || (args.length === 2 && args[0] === '--runs'),
  'INVALID_ARGUMENT', 'Usage: npm run experiment -- --runs 10');
const runs = args.length ? Number(args[1]) : 10;
requireCondition(integer(runs, 10), 'INVALID_ARGUMENT', 'At least ten trials per difficulty are required');
const samples = [];
const summary = [];
const miner = 'a'.repeat(64);
const timestampBase = GENESIS_TIME + randomInt(1, 1000000000);

for (let i = 0; i < 3; i++) {
  mineBlock(buildBlock(1, '0'.repeat(64), [createCoinbase(miner, 50, 1)], 3, timestampBase + i));
}

for (const difficulty of [1, 2, 3, 4]) {
  const current = [];
  for (let trial = 0; trial < runs; trial++) {
    // Each trial has a different authenticated header, rather than reusing the same successful nonce.
    const timestamp = timestampBase + 100 + difficulty * runs + trial;
    const candidate = buildBlock(1, '0'.repeat(64), [createCoinbase(miner, 50, 1)], difficulty, timestamp);
    const cpuStarted = process.cpuUsage();
    const result = mineBlock(candidate);
    const cpu = process.cpuUsage(cpuStarted);
    assert.equal(headerHash(result.block.header), result.block.hash);
    assert(meetsDifficulty(result.block.hash, difficulty));
    const row = { difficulty, trial: trial + 1, milliseconds: result.milliseconds, attempts: result.attempts,
      cpuMilliseconds: (cpu.user + cpu.system) / 1000, header: result.block.header, hash: result.block.hash };
    current.push(row);
    samples.push(row);
  }
  const values = current.map(row => row.milliseconds).sort((a, b) => a - b);
  const mean = values.reduce((total, value) => total + value, 0) / runs;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (runs - 1);
  const middle = Math.floor(runs / 2);
  const median = runs % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  const row = { difficulty, runs, meanMilliseconds: mean, sampleStdMilliseconds: Math.sqrt(variance),
    minimumMilliseconds: values[0], maximumMilliseconds: values.at(-1), medianMilliseconds: median,
    meanAttempts: current.reduce((total, value) => total + value.attempts, 0) / runs };
  summary.push(row);
  console.log(JSON.stringify(row));
}

const ratios = summary.slice(1).map((row, index) => ({
  from: summary[index].difficulty, to: row.difficulty,
  measuredMeanRatio: row.meanMilliseconds / summary[index].meanMilliseconds,
  theoreticalWorkRatio: 16,
}));
const report = { executedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  processor: os.cpus()[0].model, methodology: 'Four difficulties, independent headers, warm-up excluded; wall time and CPU time measured',
  units: 'milliseconds', runsPerDifficulty: runs, samples, summary, ratios };
writeJsonAtomic('reports/experiment.json', report);
fs.writeFileSync('reports/experiment.csv', 'difficulty,trial,milliseconds,attempts,cpuMilliseconds,hash\n' +
  samples.map(row => [row.difficulty, row.trial, row.milliseconds, row.attempts, row.cpuMilliseconds, row.hash].join(',')).join('\n') + '\n');
const python = process.env.PYTHON ?? (fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3');
const plot = spawnSync(python, ['scripts/plot_experiment.py'], { stdio: 'inherit' });
if (plot.status !== 0) {
  console.error('Plotting failed. Install requirements.txt in .venv and rerun scripts/plot_experiment.py. Raw measurements are saved.');
  process.exitCode = 1;
} else {
  console.log('PASS: ' + samples.length + ' real trials; raw JSON, CSV and logarithmic plot saved in reports/');
}
