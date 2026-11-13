import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../scripts/demo.js';

test('three independent HTTP nodes propagate data, restart, resolve a fork and restore its transfer', { timeout: 45000 }, async () => {
  const report = await runDemo({ quiet: true, saveReport: false });
  assert.equal(report.passed, true);
  assert.equal(report.steps.length, 8);
  assert.equal(report.steps.find(step => step.name === 'light_client_proof').result.tamperedRejected, true);
});
