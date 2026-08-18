import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EncryptedJsonStore,
  StoreDecryptionError,
} from '../src/persistence/encrypted-store.js';

interface Doc {
  users: Array<{ email: string; passwordHash: string }>;
  note: string;
}

const dirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nike-store-'));
  dirs.push(dir);
  return join(dir, 'store.enc.json');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sample: Doc = {
  users: [
    { email: 'shopper@example.com', passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==' },
  ],
  note: 'plaintext marker',
};

describe('EncryptedJsonStore', () => {
  it('returns null when the file does not exist yet', async () => {
    const store = new EncryptedJsonStore<Doc>(await tempFile(), 'key', 0);
    await expect(store.load()).resolves.toBeNull();
  });

  it('round-trips a document', async () => {
    const path = await tempFile();
    const store = new EncryptedJsonStore<Doc>(path, 'correct key', 0);

    store.scheduleSave(() => sample);
    await store.flush();

    const reloaded = await new EncryptedJsonStore<Doc>(path, 'correct key', 0).load();
    expect(reloaded).toEqual(sample);
  });

  it('writes no plaintext to disk', async () => {
    const path = await tempFile();
    const store = new EncryptedJsonStore<Doc>(path, 'correct key', 0);
    store.scheduleSave(() => sample);
    await store.flush();

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('shopper@example.com');
    expect(raw).not.toContain('plaintext marker');

    // Only the envelope metadata is legible.
    const envelope = JSON.parse(raw);
    expect(Object.keys(envelope).sort()).toEqual([
      'authTag',
      'data',
      'iv',
      'kdf',
      'version',
    ]);
  });

  it('fails to decrypt with the wrong passphrase', async () => {
    const path = await tempFile();
    const store = new EncryptedJsonStore<Doc>(path, 'correct key', 0);
    store.scheduleSave(() => sample);
    await store.flush();

    const wrong = new EncryptedJsonStore<Doc>(path, 'wrong key', 0);
    await expect(wrong.load()).rejects.toBeInstanceOf(StoreDecryptionError);
  });

  it('detects tampering with the ciphertext', async () => {
    // This is what authenticated encryption buys: a modified file is rejected
    // rather than silently decrypted into garbage or attacker-chosen data.
    const path = await tempFile();
    const store = new EncryptedJsonStore<Doc>(path, 'key', 0);
    store.scheduleSave(() => sample);
    await store.flush();

    const envelope = JSON.parse(await readFile(path, 'utf8'));
    const chars = [...(envelope.data as string)];
    chars[10] = chars[10] === 'A' ? 'B' : 'A';
    envelope.data = chars.join('');
    await writeFile(path, JSON.stringify(envelope));

    await expect(new EncryptedJsonStore<Doc>(path, 'key', 0).load()).rejects.toBeInstanceOf(
      StoreDecryptionError,
    );
  });

  it('detects a swapped auth tag', async () => {
    const path = await tempFile();
    const store = new EncryptedJsonStore<Doc>(path, 'key', 0);
    store.scheduleSave(() => sample);
    await store.flush();

    const envelope = JSON.parse(await readFile(path, 'utf8'));
    envelope.authTag = Buffer.alloc(16).toString('base64');
    await writeFile(path, JSON.stringify(envelope));

    await expect(new EncryptedJsonStore<Doc>(path, 'key', 0).load()).rejects.toBeInstanceOf(
      StoreDecryptionError,
    );
  });

  it('uses a fresh salt and IV on every write', async () => {
    // Reusing a GCM nonce with the same key is a catastrophic failure mode, so
    // this is worth pinning rather than assuming.
    const path = await tempFile();
    const store = new EncryptedJsonStore<Doc>(path, 'key', 0);

    store.scheduleSave(() => sample);
    await store.flush();
    const first = JSON.parse(await readFile(path, 'utf8'));

    store.scheduleSave(() => sample);
    await store.flush();
    const second = JSON.parse(await readFile(path, 'utf8'));

    expect(second.iv).not.toBe(first.iv);
    expect(second.kdf.salt).not.toBe(first.kdf.salt);
    // Same plaintext, different ciphertext — no deterministic-encryption leak.
    expect(second.data).not.toBe(first.data);
  });

  it('rejects an unsupported envelope version', async () => {
    const path = await tempFile();
    await writeFile(
      path,
      JSON.stringify({ version: 99, kdf: {}, iv: '', authTag: '', data: '' }),
    );

    await expect(new EncryptedJsonStore<Doc>(path, 'key', 0).load()).rejects.toThrow(
      /Unsupported store version/,
    );
  });

  it('rejects a file that is not JSON', async () => {
    const path = await tempFile();
    await writeFile(path, 'not json at all');

    await expect(new EncryptedJsonStore<Doc>(path, 'key', 0).load()).rejects.toBeInstanceOf(
      StoreDecryptionError,
    );
  });

  it('coalesces a burst of saves into one write', async () => {
    const path = await tempFile();
    const store = new EncryptedJsonStore<Doc>(path, 'key', 20);

    let snapshots = 0;
    for (let i = 0; i < 25; i += 1) {
      store.scheduleSave(() => {
        snapshots += 1;
        return { ...sample, note: `write ${i}` };
      });
    }
    await store.flush();

    // One snapshot taken, not 25 — and it holds the final state.
    expect(snapshots).toBe(1);
    const reloaded = await new EncryptedJsonStore<Doc>(path, 'key', 0).load();
    expect(reloaded?.note).toBe('write 24');
  });

  it('leaves no temp file behind', async () => {
    const path = await tempFile();
    const store = new EncryptedJsonStore<Doc>(path, 'key', 0);
    store.scheduleSave(() => sample);
    await store.flush();

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(path, '..'));
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
  });

  it('flush is a no-op when nothing is pending', async () => {
    const store = new EncryptedJsonStore<Doc>(await tempFile(), 'key', 0);
    await expect(store.flush()).resolves.toBeUndefined();
  });
});
