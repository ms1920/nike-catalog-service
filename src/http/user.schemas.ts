import { z } from 'zod';
import { USER_ROLES } from '../domain/user.js';

/**
 * Schemas for the user resource — both the entity itself and the requests that
 * operate on it.
 *
 * The entity schema is not decoration. Since state is loaded from an encrypted
 * file on disk, the decrypted document is untrusted input in exactly the same way
 * a request body is: it can be hand-edited and re-encrypted, or written by an
 * older version of this code. Validating it on load means a malformed record
 * fails at startup with a precise path rather than surfacing as a confusing
 * runtime error three layers deep.
 */

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

/** Matches the encoded form produced by `services/password.ts`. */
const passwordHashSchema = z
  .string()
  .regex(
    /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
    'must be an encoded scrypt hash',
  );

export const userEntitySchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string().min(1),
    passwordHash: passwordHashSchema,
    role: z.enum(USER_ROLES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const sessionEntitySchema = z
  .object({
    // SHA-256 hex. The raw token is never stored.
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/, 'must be a SHA-256 hex digest'),
    userId: z.string().uuid(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Email validation is intentionally Zod's `.email()` and nothing cleverer.
 * Hand-rolled email regexes reject valid addresses (plus-addressing, new TLDs,
 * quoted locals) far more often than they catch anything useful. The real
 * validation of an email address is sending mail to it.
 */
export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254) // RFC 5321 maximum path length
  .email('must be a valid email address')
  .transform((value) => value.toLowerCase());

/**
 * Password policy: length only.
 *
 * A 12-character minimum with no composition rules follows current NIST guidance
 * (SP 800-63B). Forcing a symbol and a digit pushes users toward `Password1!`,
 * which is weaker than a long passphrase and far more likely to be reused. The
 * 200-character ceiling is a denial-of-service guard, not a policy: scrypt cost
 * scales with input length, so unbounded passwords are an attack vector.
 */
export const passwordSchema = z
  .string()
  .min(12, 'must be at least 12 characters')
  .max(200, 'must be at most 200 characters');

/**
 * `.strict()` throughout is load-bearing for security, not tidiness: it is what
 * rejects `{"role":"admin"}` smuggled into a registration body instead of
 * silently ignoring it.
 */
export const createUserSchema = z
  .object({
    email: emailSchema,
    name: z.string().trim().min(1, 'is required').max(100),
    password: passwordSchema,
  })
  .strict();

export const createSessionSchema = z
  .object({
    email: emailSchema,
    // Not `passwordSchema`: applying the length policy at sign-in would reject a
    // legitimate older password and, worse, reveal the policy to an attacker
    // probing with short strings. Any non-empty string gets checked properly.
    password: z.string().min(1, 'is required').max(200),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'is required').max(200),
    newPassword: passwordSchema,
  })
  .strict()
  .refine((body) => body.currentPassword !== body.newPassword, {
    message: 'New password must differ from the current one',
    path: ['newPassword'],
  });

export type CreateUserBody = z.infer<typeof createUserSchema>;
export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
