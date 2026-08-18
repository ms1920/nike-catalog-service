import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  type ScryptOptions,
} from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * An encrypted JSON file used as the datastore.
 *
 * ## What the encryption actually buys you
 *
 * Be clear-eyed about this, because it is easy to oversell. The data file is
 * committed to the repository, and the key is derived from a passphrase that — by
 * default — is also in the repository. Anyone with the repo therefore has both
 * the ciphertext and the key. That means this is **not** confidentiality against
 * someone who can read the repo.
 *
 * What it does provide, honestly stated:
 *
 *  - **Tamper detection.** AES-GCM is authenticated encryption. Editing a byte of
 *    the file makes decryption fail loudly instead of silently loading corrupted
 *    or maliciously altered records.
 *  - **Opacity at rest.** Emails and order history are not sitting in plaintext
 *    to be grepped, casually browsed in a diff, or scraped by a tool that wanders
 *    through the working tree.
 *  - **Real protection when the key is not in the repo.** Set `DATA_KEY` in the
 *    environment and the committed file becomes genuinely undecryptable without
 *    it. That is the intended production posture, and the reason the passphrase
 *    is a parameter rather than a hard-coded constant.
 *
 * The load-bearing protection for the most sensitive field is elsewhere:
 * passwords are scrypt-hashed *before* they ever reach this file, so decrypting
 * the store still yields no usable credentials.
 *
 * ## Format
 *
 * A JSON envelope, so the parameters travel with the data and can be upgraded
 * without a migration:
 *
 * ```json
 * { "version": 1, "kdf": { "name": "scrypt", "N": 16384, "r": 8, "p": 1,
 *   "salt": "base64" }, "iv": "base64", "authTag": "base64", "data": "base64" }
 * ```
 */

const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // 96-bit nonce, the GCM standard
const SALT_LENGTH = 16;

/**
 * Lower cost than password hashing (which uses N=32768) on purpose: this runs
 * once at startup for a key we already assume the holder possesses, so there is
 * no brute-force threat model to defend against here. Password hashing defends
 * against exactly that, hence the higher cost there.
 */
const KDF = { N: 16384, r: 8, p: 1 } as const;

interface Envelope {
  version: number;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
  authTag: string;
  data: string;
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  const options: ScryptOptions = { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export class StoreDecryptionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StoreDecryptionError';
  }
}

export class EncryptedJsonStore<T> {
  private flushTimer: NodeJS.Timeout | null = null;
  private pending: (() => T) | null = null;
  /** Serialises writes so two flushes cannot interleave on the same file. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly passphrase: string,
    /** Debounce window. Bursts of mutations collapse into one disk write. */
    private readonly debounceMs = 250,
  ) {}

  /** Returns null when the file does not exist yet (first run). */
  async load(): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (error) {
      throw new StoreDecryptionError(`${this.filePath} is not valid JSON`, error);
    }

    if (envelope.version !== ENVELOPE_VERSION) {
      throw new StoreDecryptionError(
        `Unsupported store version ${envelope.version}; expected ${ENVELOPE_VERSION}`,
      );
    }

    const salt = Buffer.from(envelope.kdf.salt, 'base64');
    const key = await deriveKey(this.passphrase, salt);

    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        // Throws if the auth tag does not verify — this is the tamper check.
        decipher.final(),
      ]).toString('utf8');

      return JSON.parse(plaintext) as T;
    } catch (error) {
      throw new StoreDecryptionError(
        `Could not decrypt ${this.filePath}. Either DATA_KEY is wrong or the file has been modified.`,
        error,
      );
    }
  }

  /**
   * Queues a save. The snapshot is taken lazily at flush time so a burst of
   * mutations results in one write of the final state, not one write each.
   */
  scheduleSave(snapshot: () => T): void {
    this.pending = snapshot;
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.debounceMs);
    // Do not hold the event loop open purely for a pending write.
    this.flushTimer.unref?.();
  }

  /** Writes any pending state immediately. Call before shutdown. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const snapshot = this.pending;
    if (!snapshot) return;
    this.pending = null;

    const data = snapshot();
    this.writeChain = this.writeChain.then(() => this.write(data));
    return this.writeChain;
  }

  private async write(value: T): Promise<void> {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = await deriveKey(this.passphrase, salt);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);

    const envelope: Envelope = {
      version: ENVELOPE_VERSION,
      kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      data: ciphertext.toString('base64'),
    };

    await mkdir(dirname(this.filePath), { recursive: true });

    // Write-then-rename. A crash mid-write would otherwise leave a truncated
    // file that fails its auth tag, losing everything; rename is atomic on POSIX,
    // so the real path always holds a complete, valid envelope.
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }
}
