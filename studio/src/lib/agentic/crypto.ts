// crypto.ts — encrypt provider API keys at rest.
//
// Design
// ------
//   * AES-256-GCM (authenticated encryption) with a random 12-byte IV per
//     record. The IV and the auth tag travel with the ciphertext.
//   * The master key comes from `AGENTSCOPE_SECRET_KEY` when it is set.
//     Otherwise a random 32-byte key is generated once and stored next to the
//     SQLite database in `db/.secret-key` (mode 0600 on POSIX).
//   * The plaintext key NEVER leaves this module: callers get the ciphertext
//     for storage and the plaintext only inside the server process.
//   * If the master key is lost the stored secrets cannot be decrypted — the
//     store then reports "missing key" instead of silently returning garbage.
//
// The key file is never written to the repository (see .gitignore) and is
// never included in a build artefact.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedSecret {
  /** base64 ciphertext */
  cipher: string;
  /** base64 initialisation vector */
  iv: string;
  /** base64 GCM auth tag */
  tag: string;
}

export class SecretKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyUnavailableError';
  }
}

let cachedKey: Buffer | null = null;
let cachedKeySource: string | null = null;

/**
 * Absolute path of the SQLite database file (DATABASE_URL="file:...").
 * Returns null when the datasource is not a local SQLite file.
 */
export function databaseFilePath(): string | null {
  const raw = (process.env.DATABASE_URL ?? '').trim();
  if (!raw) return null;
  if (!raw.startsWith('file:')) return null;
  const target = raw.slice('file:'.length).trim();
  if (!target) return null;
  if (path.isAbsolute(target)) return target;
  // Prisma resolves relative sqlite paths against the schema directory.
  const schemaDir = path.join(process.cwd(), 'prisma');
  return path.resolve(schemaDir, target);
}

/** Directory that holds the SQLite database (used for the key file). */
function secretKeyDir(): string {
  const dbFile = databaseFilePath();
  if (dbFile) return path.dirname(dbFile);
  return path.join(process.cwd(), 'db');
}

function keyFilePath(): string {
  return path.join(secretKeyDir(), '.secret-key');
}

function deriveFromPassphrase(passphrase: string): Buffer {
  // scrypt with a fixed salt: deterministic so the same passphrase always
  // unlocks the stored secrets after a restart.
  return crypto.scryptSync(passphrase, 'agentscope-studio-provider-key-v1', KEY_BYTES);
}

/**
 * Load (or create) the master key.
 * Throws SecretKeyUnavailableError when the key file cannot be created.
 */
export function loadMasterKey(): { key: Buffer; source: string } {
  if (cachedKey) return { key: cachedKey, source: cachedKeySource ?? 'unknown' };

  const fromEnv = (process.env.AGENTSCOPE_SECRET_KEY ?? '').trim();
  if (fromEnv) {
    const key = deriveFromPassphrase(fromEnv);
    cachedKey = key;
    cachedKeySource = 'env:AGENTSCOPE_SECRET_KEY';
    return { key, source: cachedKeySource };
  }

  const file = keyFilePath();
  try {
    if (fs.existsSync(file)) {
      const hex = fs.readFileSync(file, 'utf-8').trim();
      if (hex.length !== KEY_BYTES * 2) {
        throw new SecretKeyUnavailableError(
          `Secret key file "${file}" is corrupt (expected ${KEY_BYTES * 2} hex chars). ` +
            'Set AGENTSCOPE_SECRET_KEY or delete the file to regenerate it (stored provider keys will be lost).'
        );
      }
      const key = Buffer.from(hex, 'hex');
      cachedKey = key;
      cachedKeySource = `file:${file}`;
      return { key, source: cachedKeySource };
    }
  } catch (err) {
    if (err instanceof SecretKeyUnavailableError) throw err;
    // fall through and try to create a new key
  }

  const key = crypto.randomBytes(KEY_BYTES);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // chmod is a no-op on Windows
    }
  } catch (err) {
    throw new SecretKeyUnavailableError(
      `Cannot create the secret key file "${file}". ` +
        'Set AGENTSCOPE_SECRET_KEY to an environment variable instead. ' +
        `(${(err as Error)?.message ?? 'unknown error'})`
    );
  }
  cachedKey = key;
  cachedKeySource = `file:${file}`;
  return { key, source: cachedKeySource };
}

/** Forget the cached key (used by tests that rotate the key). */
export function resetMasterKeyCache(): void {
  cachedKey = null;
  cachedKeySource = null;
}

/** Encrypt a plaintext secret. */
export function encryptSecret(plaintext: string): EncryptedSecret {
  if (!plaintext) {
    return { cipher: '', iv: '', tag: '' };
  }
  const { key } = loadMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/** Decrypt a secret. Throws when the payload is tampered with. */
export function decryptSecret(payload: EncryptedSecret): string {
  if (!payload?.cipher) return '';
  const { key } = loadMasterKey();
  const decipher = crypto.createDecipheriv(
    ALGO,
    key,
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(payload.cipher, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf-8');
}

/** Pack an encrypted secret into the single string stored in the database. */
export function packSecret(payload: EncryptedSecret): string {
  if (!payload.cipher) return '';
  return `v1.${payload.iv}.${payload.tag}.${payload.cipher}`;
}

/** Unpack the database representation of an encrypted secret. */
export function unpackSecret(packed: string): EncryptedSecret {
  if (!packed) return { cipher: '', iv: '', tag: '' };
  const parts = packed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted secret payload');
  }
  return { iv: parts[1], tag: parts[2], cipher: parts[3] };
}

/**
 * A non-reversible hint that lets the UI show "•••• abcd" without ever
 * receiving the key itself.
 */
export function keyHint(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length);
  return `••••${trimmed.slice(-4)}`;
}

/** Reset the module state (test helper). */
export function __resetCryptoForTests(): void {
  resetMasterKeyCache();
}
