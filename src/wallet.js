import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonical, requireCondition, sha256 } from './common.js';

export function publicIdentity(publicKey) {
  const bytes = publicKey.export({ format: 'der', type: 'spki' });
  return { address: sha256(bytes), publicKey: bytes.toString('base64') };
}

export function createWallet() {
  const keys = generateKeyPairSync('ed25519');
  return {
    ...publicIdentity(keys.publicKey),
    privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

export function saveWallet(wallet, filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(wallet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export function loadWallet(filename) {
  const wallet = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const key = createPrivateKey({ key: Buffer.from(wallet.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  requireCondition(key.asymmetricKeyType === 'ed25519', 'INVALID_KEY', 'Expected an Ed25519 key');
  const identity = publicIdentity(createPublicKey(key));
  requireCondition(identity.address === wallet.address && identity.publicKey === wallet.publicKey,
    'INVALID_KEY', 'Wallet public and private keys do not match');
  return wallet;
}

export function signObject(value, privateKey) {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(canonical(value)), key).toString('base64');
}

export function verifyObject(value, publicKey, signature, sender) {
  try {
    if (typeof publicKey !== 'string' || publicKey.length > 128 || typeof signature !== 'string') return false;
    const bytes = Buffer.from(publicKey, 'base64');
    const signatureBytes = Buffer.from(signature, 'base64');
    if (bytes.toString('base64') !== publicKey || signatureBytes.toString('base64') !== signature) return false;
    if (signatureBytes.length !== 64 || sha256(bytes) !== sender) return false;
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    if (!key.export({ format: 'der', type: 'spki' }).equals(bytes)) return false;
    return verify(null, Buffer.from(canonical(value)), key, signatureBytes);
  } catch {
    return false;
  }
}
