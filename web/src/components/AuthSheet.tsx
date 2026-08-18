import { useId, useState } from 'react';
import { ApiError } from '../lib/api.js';
import { useAuth } from '../state/auth.js';
import { Sheet } from './Sheet.js';

type Mode = 'login' | 'signup';

interface AuthSheetProps {
  open: boolean;
  initialMode?: Mode;
  onClose: () => void;
}

/**
 * Sign-in / join form.
 *
 * Field-level errors come from the server's Zod `details` array rather than being
 * re-implemented client-side. Duplicating the password policy in the browser
 * guarantees the two definitions drift; the server is the only authority, and it
 * already returns per-field messages.
 */
export function AuthSheet({ open, initialMode = 'login', onClose }: AuthSheetProps) {
  const { signIn, register } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const ids = { email: useId(), name: useId(), password: useId() };

  const fieldError = (field: string): string | null =>
    error instanceof ApiError ? error.fieldError(field) : null;

  // A field-level message is already shown under its input; repeating it in the
  // banner is noise.
  const bannerError =
    error && !(error instanceof ApiError && Array.isArray(error.details))
      ? error.message
      : null;

  function reset() {
    setPassword('');
    setError(null);
  }

  function switchMode(next: Mode) {
    setMode(next);
    reset();
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (mode === 'login') await signIn(email, password);
      else await register(email, name, password);
      // Only clear on success — keeping the values on failure means the user
      // doesn't retype their email to fix a password typo.
      setEmail('');
      setName('');
      setPassword('');
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Something went wrong'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={mode === 'login' ? 'Sign In' : 'Join Us'}
      labelledBy="auth-title"
    >
      <form className="form" onSubmit={onSubmit} noValidate>
        <h2 id="auth-title" className="form__title">
          {mode === 'login' ? 'Welcome back' : 'Become a Member'}
        </h2>
        <p className="form__lede">
          {mode === 'login'
            ? 'Sign in to see your Bag and place an order.'
            : 'Create an account to save a Bag and check out.'}
        </p>

        {bannerError && (
          <p className="form__banner" role="alert">
            {bannerError}
          </p>
        )}

        <label className="field" htmlFor={ids.email}>
          <span className="field__label">Email</span>
          <input
            id={ids.email}
            className="field__input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={fieldError('email') ? true : undefined}
          />
          {fieldError('email') && (
            <span className="field__error">{fieldError('email')}</span>
          )}
        </label>

        {mode === 'signup' && (
          <label className="field" htmlFor={ids.name}>
            <span className="field__label">Name</span>
            <input
              id={ids.name}
              className="field__input"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={fieldError('name') ? true : undefined}
            />
            {fieldError('name') && (
              <span className="field__error">{fieldError('name')}</span>
            )}
          </label>
        )}

        <label className="field" htmlFor={ids.password}>
          <span className="field__label">Password</span>
          <input
            id={ids.password}
            className="field__input"
            type="password"
            /* Tells a password manager to offer a new password on signup and the
               saved one on login — the wrong hint here is why managers so often
               fail to fill or save. */
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={fieldError('password') ? true : undefined}
            aria-describedby={mode === 'signup' ? `${ids.password}-hint` : undefined}
          />
          {mode === 'signup' && !fieldError('password') && (
            <span id={`${ids.password}-hint`} className="field__hint">
              At least 12 characters. Length beats symbols — a passphrase works well.
            </span>
          )}
          {fieldError('password') && (
            <span className="field__error">{fieldError('password')}</span>
          )}
        </label>

        <button type="submit" className="btn btn--solid form__submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign In' : 'Join Us'}
        </button>

        <p className="form__switch">
          {mode === 'login' ? 'Not a Member?' : 'Already a Member?'}{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
          >
            {mode === 'login' ? 'Join Us' : 'Sign In'}
          </button>
        </p>
      </form>
    </Sheet>
  );
}
