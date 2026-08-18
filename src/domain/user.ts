/**
 * Identity domain.
 *
 * The central rule encoded here is the split between `User` and `PublicUser`.
 * `User` carries `passwordHash` and never leaves the service layer; `PublicUser`
 * is the only shape the HTTP layer is allowed to serialise. Making that a type
 * distinction rather than a convention means an accidental `res.json(user)`
 * fails to compile instead of leaking a password hash to a client.
 */

export const USER_ROLES = ['customer', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface User {
  id: string;
  /** Always stored lower-cased and trimmed — see `normalizeEmail`. */
  email: string;
  name: string;
  /** Encoded scrypt string: `scrypt$N$r$p$salt$hash`. Never serialise this. */
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

/** The only user projection the API may return. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
  };
}

/**
 * Emails are compared case-insensitively, so they are normalised once on the way
 * in rather than lower-cased at each comparison site. Doing it per-comparison is
 * how "Alice@x.com" and "alice@x.com" end up as two accounts.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A bearer session.
 *
 * `tokenHash` holds a SHA-256 of the token, not the token itself. If the session
 * store is ever dumped, the contents cannot be replayed as credentials — the
 * same reasoning that applies to password storage applies to long-lived tokens.
 */
export interface Session {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export function isExpired(session: Session, now = new Date()): boolean {
  return new Date(session.expiresAt).getTime() <= now.getTime();
}
