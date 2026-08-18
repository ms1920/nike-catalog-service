/**
 * Configuration is read from the environment exactly once, at startup, and
 * passed explicitly to whatever needs it. Nothing deeper in the codebase reads
 * `process.env` directly — that keeps modules testable and makes the full set
 * of knobs discoverable in one place.
 */
export interface Config {
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  /** When set, mutating routes require `x-api-key`. Unset = open (local dev). */
  apiKey: string | undefined;
  defaultPageSize: number;
  maxPageSize: number;
  /** Path to the encrypted datastore. */
  dataFile: string;
  /** Passphrase the datastore key is derived from. */
  dataKey: string;
}

/**
 * Default passphrase for the encrypted datastore.
 *
 * This constant is committed, which means the repository contains both the
 * ciphertext and the key — so by itself this is obfuscation and tamper
 * detection, not confidentiality. It is a deliberate default so that a fresh
 * clone runs with no setup.
 *
 * Set `DATA_KEY` in the environment and the committed file becomes genuinely
 * undecryptable without it. That is the intended posture for anything real, and
 * the server logs a warning while this default is in use.
 */
const DEFAULT_DATA_KEY = 'nike-catalog-local-development-key';

export function usingDefaultDataKey(config: Config): boolean {
  return config.dataKey === DEFAULT_DATA_KEY;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Environment variable ${name} must be a positive integer, got '${raw}'`,
    );
  }
  return parsed;
}

export function loadConfig(): Config {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as Config['nodeEnv'];

  return {
    port: intFromEnv('PORT', 3000),
    nodeEnv,
    apiKey: process.env.API_KEY,
    defaultPageSize: intFromEnv('DEFAULT_PAGE_SIZE', 20),
    // Hard ceiling so a client cannot ask for `pageSize=1000000` and use the
    // API as a denial-of-service vector against itself.
    maxPageSize: intFromEnv('MAX_PAGE_SIZE', 100),
    dataFile: process.env.DATA_FILE ?? 'data/store.enc.json',
    dataKey: process.env.DATA_KEY ?? DEFAULT_DATA_KEY,
  };
}
