import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Hand-rolled promise wrapper rather than `promisify(scrypt)`.
 *
 * `scrypt` is overloaded, and `promisify`'s types resolve to the 3-argument form,
 * so the options object carrying N/r/p would not typecheck. Wrapping explicitly
 * keeps the cost parameters type-safe.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing with scrypt from `node:crypto`.
 *
 * Why scrypt and not something else:
 *  - It is memory-hard, so attacking it with GPUs/ASICs is far more expensive
 *    than a plain hash. SHA-256 of a password, salted or not, is not acceptable
 *    for credential storage.
 *  - It ships in Node's standard library, so there is no native-module build step
 *    and no dependency to keep patched. bcrypt/argon2 are fine choices too;
 *    argon2id would be the modern first pick if a dependency were acceptable.
 *
 * Three properties this implementation deliberately has:
 *
 *  1. **A unique random salt per password.** Two users with the same password get
 *     different hashes, so one cracked hash reveals nothing about the other, and
 *     precomputed rainbow tables are useless.
 *  2. **Parameters stored inside the hash string.** The encoded form carries N, r
 *     and p, so the cost can be raised later without invalidating existing
 *     hashes — old ones keep verifying against their own recorded parameters and
 *     can be transparently re-hashed on next successful login.
 *  3. **Constant-time comparison.** `timingSafeEqual`, never `===`. String
 *     equality short-circuits on the first differing byte, and that timing
 *     difference is measurable enough to leak hash contents.
 */

/** CPU/memory cost. 2^15 with r=8 needs ~32 MB per hash. */
const N = 32768;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * scrypt's memory use is roughly 128 * N * r bytes. Node's default `maxmem` is
 * 32 MB, which this configuration sits exactly at, so it is raised explicitly
 * rather than left to trip an opaque `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`.
 */
const MAX_MEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  });

  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Verifies a password against an encoded hash.
 *
 * Returns false rather than throwing on a malformed stored hash: a corrupt record
 * should fail the login, not surface a 500 that tells an attacker their input
 * reached the hashing path.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const storedN = Number.parseInt(parts[1] ?? '', 10);
  const storedR = Number.parseInt(parts[2] ?? '', 10);
  const storedP = Number.parseInt(parts[3] ?? '', 10);
  if (
    !Number.isInteger(storedN) ||
    !Number.isInteger(storedR) ||
    !Number.isInteger(storedP)
  ) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64');
    expected = Buffer.from(parts[5] ?? '', 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, expected.length, {
      N: storedN,
      r: storedR,
      p: storedP,
      maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }

  // Length is checked first because timingSafeEqual throws on a mismatch. The
  // length of a hash is not a secret, so this leaks nothing useful.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** True when a stored hash was produced with weaker parameters than current policy. */
export function needsRehash(encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number.parseInt(parts[1] ?? '', 10) < N;
}
