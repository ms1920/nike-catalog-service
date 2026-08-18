import { normalizeEmail, type Session, type User } from '../domain/user.js';

/**
 * Identity persistence boundary.
 *
 * Users and sessions are separated behind one interface because they are written
 * together on login and read together on every authenticated request, but they
 * have very different lifecycles: users are durable, sessions are disposable and
 * expire. A SQL implementation would put them in two tables with a foreign key
 * and a TTL index on the session table.
 */
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(user: User): Promise<User>;
  updatePasswordHash(id: string, passwordHash: string): Promise<User | null>;

  createSession(session: Session): Promise<Session>;
  /** Looks up by token *hash*; the raw token is never persisted. */
  findSessionByTokenHash(tokenHash: string): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<boolean>;
  /** Invalidates every session for a user — used on password change. */
  deleteSessionsForUser(userId: string): Promise<number>;
  countUsers(): Promise<number>;
}

export interface UserSnapshot {
  users: User[];
  sessions: Session[];
}

export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, User>();
  private readonly emailIndex = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<() => void>();

  constructor(seed: User[] = []) {
    this.hydrate({ users: seed, sessions: [] });
  }

  /** In-memory-only change notification for the persistence layer. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  hydrate(snapshot: UserSnapshot): void {
    this.users.clear();
    this.emailIndex.clear();
    this.sessions.clear();

    for (const user of snapshot.users) {
      this.users.set(user.id, { ...user });
      this.emailIndex.set(normalizeEmail(user.email), user.id);
    }
    for (const session of snapshot.sessions) {
      this.sessions.set(session.tokenHash, { ...session });
    }
  }

  snapshot(): UserSnapshot {
    return {
      users: [...this.users.values()].map((u) => ({ ...u })),
      sessions: [...this.sessions.values()].map((s) => ({ ...s })),
    };
  }

  async findById(id: string): Promise<User | null> {
    const found = this.users.get(id);
    return found ? { ...found } : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const id = this.emailIndex.get(normalizeEmail(email));
    if (!id) return null;
    return this.findById(id);
  }

  async create(user: User): Promise<User> {
    this.users.set(user.id, { ...user });
    this.emailIndex.set(normalizeEmail(user.email), user.id);
    this.notify();
    return { ...user };
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<User | null> {
    const existing = this.users.get(id);
    if (!existing) return null;
    const updated: User = {
      ...existing,
      passwordHash,
      updatedAt: new Date().toISOString(),
    };
    this.users.set(id, updated);
    this.notify();
    return { ...updated };
  }

  async createSession(session: Session): Promise<Session> {
    this.sessions.set(session.tokenHash, { ...session });
    this.notify();
    return { ...session };
  }

  async findSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const found = this.sessions.get(tokenHash);
    return found ? { ...found } : null;
  }

  async deleteSession(tokenHash: string): Promise<boolean> {
    const removed = this.sessions.delete(tokenHash);
    if (removed) this.notify();
    return removed;
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(hash);
        removed += 1;
      }
    }
    if (removed > 0) this.notify();
    return removed;
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }
}
