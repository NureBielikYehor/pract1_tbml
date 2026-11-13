import { addAmounts, address, canonical, exactKeys, integer, requireCondition, sha256 } from './common.js';
import { signObject, verifyObject } from './wallet.js';

const FIELDS = ['type', 'sender', 'recipient', 'amount', 'fee', 'nonce', 'publicKey', 'signature'];

export function transactionBody(transaction) {
  const { signature, ...body } = transaction;
  return body;
}

export function transactionId(transaction) {
  return sha256(canonical(transaction));
}

export function createTransaction(wallet, recipient, amount, fee, nonce) {
  const body = { type: 'transfer', sender: wallet.address, recipient, amount, fee, nonce, publicKey: wallet.publicKey };
  const transaction = { ...body, signature: signObject(body, wallet.privateKey) };
  validateTransfer(transaction);
  return transaction;
}

export function createCoinbase(recipient, amount, height) {
  return { type: 'coinbase', sender: 'COINBASE', recipient, amount, fee: 0, nonce: height, publicKey: null, signature: null };
}

export function validateTransfer(transaction) {
  exactKeys(transaction, FIELDS);
  requireCondition(transaction.type === 'transfer', 'INVALID_TYPE', 'Expected a signed transfer');
  requireCondition(address(transaction.sender) && address(transaction.recipient), 'INVALID_ADDRESS', 'Invalid address');
  requireCondition(integer(transaction.amount, 1) && integer(transaction.fee) && integer(transaction.nonce),
    'INVALID_AMOUNT', 'Amount must be positive; fee and nonce must be nonnegative integers');
  addAmounts(transaction.amount, transaction.fee);
  requireCondition(verifyObject(transactionBody(transaction), transaction.publicKey, transaction.signature, transaction.sender),
    'INVALID_SIGNATURE', 'Signature or sender public key is invalid');
}

export function validateCoinbase(transaction, height, expectedAmount) {
  exactKeys(transaction, FIELDS);
  requireCondition(transaction.type === 'coinbase' && transaction.sender === 'COINBASE' &&
    address(transaction.recipient) && transaction.amount === expectedAmount && transaction.fee === 0 &&
    transaction.nonce === height && transaction.publicKey === null && transaction.signature === null,
  'INVALID_REWARD', 'Coinbase must pay exactly the fixed reward and block fees');
}
