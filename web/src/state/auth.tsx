import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  fetchMe,
  loadStoredToken,
  login as apiLogin,
  logout as apiLogout,
  setUnauthorizedHandler,
  signup as apiSignup,
  storeToken,
  type PublicUser,
} from '../lib/api.js';

interface AuthState {
  user: PublicUser | null;
  /** True until the stored token has been checked, so the UI can avoid flicker. */
  initialising: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Owns the session.
 *
 * The token itself is not held in React state — `localStorage` is the single
 * source of truth and the API client reads it per request. Keeping a second copy
 * here would reintroduce exactly the desync that made the UI claim to be signed
 * in while requests went out anonymous.
 *
 * On mount it rehydrates from the stored token and validates it against
 * `/auth/me`. Validating rather than trusting matters: a token can be expired,
 * revoked, or belong to a server that has since restarted and lost its sessions.
 * A UI that renders a signed-in header off a stale string and then 401s on the
 * first real action is worse than one that starts signed out.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [initialising, setInitialising] = useState(true);

  // Any authed request that 401s clears the session, so a server restart or an
  // expired token resolves to "signed out" rather than a UI that lies.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!loadStoredToken()) {
      setInitialising(false);
      return;
    }

    const controller = new AbortController();

    fetchMe(controller.signal)
      .then((me) => setUser(me))
      .catch(() => {
        // `send` already cleared the token on a 401; this covers other failures.
        storeToken(null);
        setUser(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setInitialising(false);
      });

    return () => controller.abort();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await apiLogin(email, password);
    storeToken(result.token);
    setUser(result.user);
  }, []);

  const register = useCallback(async (email: string, name: string, password: string) => {
    const result = await apiSignup(email, name, password);
    storeToken(result.token);
    setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } catch (error) {
      // A failed server-side revoke must not trap the user in a signed-in UI.
      // Local state is cleared regardless; the token expires on its own.
      if (!(error instanceof ApiError)) throw error;
    } finally {
      storeToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, initialising, signIn, register, signOut }),
    [user, initialising, signIn, register, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
