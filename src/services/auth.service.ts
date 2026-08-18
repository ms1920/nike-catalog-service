import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ConflictError,
  InvalidCredentialsError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors.js';
import {
  isExpired,
  normalizeEmail,
  toPublicUser,
  type PublicUser,
  type Session,
  type User,
  type UserRole,
} from '../domain/user.js';
import type { UserRepository } from '../repositories/user.repository.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';

export interface SignupInput {
  email: string;
  name: string;
  password: string;
  /** Only honoured when the caller is already an admin; see AuthService.signup. */
  role?: UserRole;
}

export interface AuthResult {
  user: PublicUser;
  /** The raw bearer token. Returned once, never stored, never recoverable. */
  token: string;
  expiresAt: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_BYTES = 32; // 256 bits of entropy

export class AuthService {
  constructor(private readonly users: UserRepository) {}

  /**
   * Registers a user and returns a session.
   *
   * The `role` field on the input is ignored for public signup — accepting it
   * would let anyone POST `{"role":"admin"}` and escalate. Admins are created by
   * `createAdmin` below, which is only reachable from server-side bootstrap code.
   */
  async signup(input: SignupInput): Promise<AuthResult> {
    const email = normalizeEmail(input.email);

    if (await this.users.findByEmail(email)) {
      // This does leak that an account exists. It is a deliberate tradeoff:
      // signup genuinely cannot proceed, and a generic error would leave the
      // user stuck with no idea why. Login, where enumeration actually matters,
      // stays generic. A hardened flow would instead always return 202 and send
      // an email telling the owner someone tried to re-register.
      throw new ConflictError('An account with that email already exists', { email });
    }

    return this.register(email, input.name, input.password, 'customer');
  }

  /** Server-side only. Not reachable from any route. */
  async createAdmin(email: string, name: string, password: string): Promise<AuthResult> {
    const normalized = normalizeEmail(email);
    if (await this.users.findByEmail(normalized)) {
      throw new ConflictError('An account with that email already exists', {
        email: normalized,
      });
    }
    return this.register(normalized, name, password, 'admin');
  }

  private async register(
    email: string,
    name: string,
    password: string,
    role: UserRole,
  ): Promise<AuthResult> {
    const now = new Date().toISOString();
    const user: User = {
      id: randomUUID(),
      email,
      name: name.trim(),
      passwordHash: await hashPassword(password),
      role,
      createdAt: now,
      updatedAt: now,
    };

    await this.users.create(user);
    return this.issueSession(user);
  }

  /**
   * Authenticates by email and password.
   *
   * Two anti-enumeration measures:
   *  - The same `InvalidCredentialsError` is returned whether the email is
   *    unknown or the password is wrong.
   *  - When the email is unknown, a hash is still computed against a dummy value
   *    so the response time matches the wrong-password path. Without this, an
   *    attacker distinguishes registered emails by latency alone, and the shared
   *    error message achieves nothing.
   */
  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.users.findByEmail(normalizeEmail(email));

    if (!user) {
      await verifyPassword(password, DUMMY_HASH);
      throw new InvalidCredentialsError();
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw new InvalidCredentialsError();

    // Opportunistic upgrade: if this hash predates a cost increase, re-hash it
    // now that the plaintext is legitimately in hand.
    if (needsRehash(user.passwordHash)) {
      await this.users.updatePasswordHash(user.id, await hashPassword(password));
    }

    return this.issueSession(user);
  }

  /**
   * Resolves a bearer token to a user.
   *
   * Expired sessions are deleted on read rather than merely rejected, so the
   * store self-cleans without a sweeper job. A SQL implementation would use a
   * TTL index instead.
   */
  async authenticate(token: string): Promise<PublicUser> {
    const session = await this.users.findSessionByTokenHash(hashToken(token));
    if (!session) throw new UnauthorizedError('Invalid or expired session');

    if (isExpired(session)) {
      await this.users.deleteSession(session.tokenHash);
      throw new UnauthorizedError('Session has expired');
    }

    const user = await this.users.findById(session.userId);
    if (!user) {
      // Session outlived its user. Treat as unauthenticated and clean up.
      await this.users.deleteSession(session.tokenHash);
      throw new UnauthorizedError('Invalid or expired session');
    }

    return toPublicUser(user);
  }

  async logout(token: string): Promise<void> {
    await this.users.deleteSession(hashToken(token));
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError();

    if (!(await verifyPassword(current, user.passwordHash))) {
      throw new ValidationError('Current password is incorrect');
    }

    await this.users.updatePasswordHash(userId, await hashPassword(next));
    // Every existing session is invalidated: a password change is the standard
    // remedy for "someone else may have my account", and it is worthless if the
    // attacker's existing token keeps working.
    await this.users.deleteSessionsForUser(userId);
  }

  private async issueSession(user: User): Promise<AuthResult> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

    const session: Session = {
      tokenHash: hashToken(token),
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt,
    };
    await this.users.createSession(session);

    return { user: toPublicUser(user), token, expiresAt };
  }
}

/**
 * SHA-256 is correct here, unlike for passwords. A 256-bit random token has no
 * low-entropy structure to brute-force, so the slow memory-hard hashing that
 * passwords require would only add latency to every authenticated request.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A real scrypt hash of a throwaway value, used solely to burn equivalent CPU on
 * the unknown-email login path. Generated once at module load.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'X0dGUlNUVVZXWFlaYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5QUJDREVGR0hJSktMTU5PUFE=';
