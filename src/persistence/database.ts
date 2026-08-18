import type { Product } from '../domain/product.js';
import type { Session, User } from '../domain/user.js';
import type { Cart, IdempotencyRecord, InventoryHold, Order } from '../domain/cart.js';
import { InMemoryProductRepository } from '../repositories/in-memory-product.repository.js';
import { InMemoryUserRepository } from '../repositories/user.repository.js';
import { InMemoryCartRepository } from '../repositories/cart.repository.js';
import { z } from 'zod';
import { seedProducts } from '../seed/products.js';
import { sessionEntitySchema, userEntitySchema } from '../http/user.schemas.js';
import { EncryptedJsonStore, StoreDecryptionError } from './encrypted-store.js';

/**
 * The persisted document.
 *
 * `schema` is a version marker so a future shape change can be migrated rather
 * than silently misread. Everything is a plain array: JSON has no Map, and
 * flattening here keeps the on-disk shape obvious to anyone who decrypts it.
 */
export interface PersistedDocument {
  schema: number;
  savedAt: string;
  products: Product[];
  users: User[];
  sessions: Session[];
  carts: Cart[];
  orders: Order[];
  holds: InventoryHold[];
  idempotency: IdempotencyRecord[];
}

const SCHEMA_VERSION = 2;

export interface DatabaseOptions {
  filePath: string;
  passphrase: string;
  /** Products to install when the file does not exist yet. */
  seed?: Product[];
}

/**
 * Owns the three in-memory repositories and keeps them mirrored to an encrypted
 * file on disk.
 *
 * The repositories stay the source of truth in memory and remain synchronous to
 * read; the file is a write-behind mirror, refreshed on a debounce after any
 * mutation. Reads never touch the disk, so request latency is unchanged.
 *
 * Products are persisted alongside user data rather than re-seeded on every boot.
 * They have to be: checkout decrements inventory, so re-seeding would resurrect
 * stock that has already been sold and leave order history contradicting the
 * catalog. `npm run db:reset` deletes the file to get a clean fixture back.
 */
export class Database {
  readonly products: InMemoryProductRepository;
  readonly users: InMemoryUserRepository;
  readonly carts: InMemoryCartRepository;

  private readonly store: EncryptedJsonStore<PersistedDocument>;
  private readonly unsubscribes: Array<() => void> = [];

  private constructor(
    store: EncryptedJsonStore<PersistedDocument>,
    products: InMemoryProductRepository,
    users: InMemoryUserRepository,
    carts: InMemoryCartRepository,
  ) {
    this.store = store;
    this.products = products;
    this.users = users;
    this.carts = carts;

    const save = () => this.store.scheduleSave(() => this.snapshot());
    this.unsubscribes.push(
      this.products.onChange(save),
      this.users.onChange(save),
      this.carts.onChange(save),
    );
  }

  static async open(options: DatabaseOptions): Promise<Database> {
    const store = new EncryptedJsonStore<PersistedDocument>(
      options.filePath,
      options.passphrase,
    );

    let document: PersistedDocument | null = null;
    try {
      document = await store.load();
    } catch (error) {
      if (error instanceof StoreDecryptionError) {
        // Fail loudly. Silently starting with an empty database would look like
        // "all my data vanished" and would then overwrite the existing file with
        // that empty state on the first write — turning a recoverable key mistake
        // into permanent data loss.
        throw new Error(
          `${error.message}\n\n` +
            'Refusing to start so the existing file is not overwritten. Either set ' +
            'DATA_KEY to the correct value, or run `npm run db:reset` to discard it.',
          { cause: error },
        );
      }
      throw error;
    }

    const products = new InMemoryProductRepository();
    const users = new InMemoryUserRepository();
    const carts = new InMemoryCartRepository();

    if (document) {
      if (document.schema !== SCHEMA_VERSION) {
        throw new Error(
          `Store schema ${document.schema} is not supported (expected ${SCHEMA_VERSION}).`,
        );
      }
      validatePersistedDocument(document);

      products.hydrate(document.products);
      users.hydrate({ users: document.users, sessions: document.sessions });
      carts.hydrate({
        carts: document.carts,
        orders: document.orders,
        holds: document.holds ?? [],
        idempotency: document.idempotency ?? [],
      });
    } else {
      // First run: install the catalog fixture and write it straight away, so the
      // file exists even if no mutation ever happens.
      products.hydrate(options.seed ?? seedProducts);
    }

    const database = new Database(store, products, users, carts);
    if (!document) await database.flush();

    return database;
  }

  private snapshot(): PersistedDocument {
    const userSnapshot = this.users.snapshot();
    const cartSnapshot = this.carts.snapshot();

    return {
      schema: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      products: this.products.snapshot(),
      users: userSnapshot.users,
      sessions: userSnapshot.sessions,
      carts: cartSnapshot.carts,
      orders: cartSnapshot.orders,
      holds: cartSnapshot.holds,
      idempotency: cartSnapshot.idempotency,
    };
  }

  /** Forces any pending write to disk. Call before process exit. */
  async flush(): Promise<void> {
    this.store.scheduleSave(() => this.snapshot());
    await this.store.flush();
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    await this.flush();
  }
}

/**
 * Validates the decrypted document before it is loaded.
 *
 * The file is untrusted input in the same way a request body is: it can be
 * hand-edited and re-encrypted, or written by a different version of this code.
 * Checking it here means a malformed record fails at startup naming the exact
 * path, rather than surfacing later as a confusing error three layers deep — or
 * worse, as a user row with no password hash that quietly breaks sign-in.
 *
 * Only the identity records are validated in full. They are the ones with security
 * consequences if malformed, and validating every product on every boot would add
 * startup cost for records the catalog code already tolerates loosely.
 */
function validatePersistedDocument(document: PersistedDocument): void {
  const users = z.array(userEntitySchema).safeParse(document.users);
  if (!users.success) {
    throw new Error(
      `Persisted user records are invalid: ${users.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    );
  }

  const sessions = z.array(sessionEntitySchema).safeParse(document.sessions);
  if (!sessions.success) {
    throw new Error(
      `Persisted session records are invalid: ${sessions.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    );
  }
}
