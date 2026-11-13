import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class ChainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
  }
}

export function requireCondition(condition, code, message) {
  if (!condition) throw new ChainError(code, message);
}

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    requireCondition(Number.isSafeInteger(value), 'INVALID_NUMBER', 'Numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  requireCondition(value && Object.getPrototypeOf(value) === Object.prototype,
    'INVALID_OBJECT', 'Only plain JSON objects can be serialized');
  const entries = Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key]));
  return '{' + entries.join(',') + '}';
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function exactKeys(value, expected) {
  requireCondition(value && Object.getPrototypeOf(value) === Object.prototype,
    'INVALID_FIELDS', 'Expected a JSON object');
  requireCondition(Object.keys(value).sort().join(',') === [...expected].sort().join(','),
    'INVALID_FIELDS', 'Missing or unexpected fields');
}

export function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

export function address(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function addAmounts(a, b) {
  const result = a + b;
  requireCondition(integer(result), 'AMOUNT_OVERFLOW', 'Amount exceeds the supported integer range');
  return result;
}

export function writeJsonAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

export function clone(value) {
  return structuredClone(value);
}
