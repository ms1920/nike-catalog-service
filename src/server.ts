import { createApp } from './app.js';
import { loadConfig, usingDefaultDataKey } from './config.js';
import { Database } from './persistence/database.js';

const config = loadConfig();

const database = await Database.open({
  filePath: config.dataFile,
  passphrase: config.dataKey,
});

const app = createApp({
  config,
  repository: database.products,
  userRepository: database.users,
  cartRepository: database.carts,
});

const server = app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'server started',
      port: config.port,
      env: config.nodeEnv,
      authRequired: Boolean(config.apiKey),
      dataFile: config.dataFile,
    }),
  );

  if (usingDefaultDataKey(config)) {
    // Say this out loud rather than letting "it's encrypted" imply more than it
    // delivers: with the default key committed next to the ciphertext, anyone
    // with the repo can decrypt the file.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'datastore is using the committed default key — set DATA_KEY for real confidentiality',
      }),
    );
  }
});

/**
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * finish, flush any pending write to disk, then exit.
 *
 * The flush matters more than it looks. Writes are debounced, so without it a
 * mutation in the last few hundred milliseconds before shutdown would be
 * acknowledged to the client and then lost.
 */
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));

  server.close((err) => {
    database
      .close()
      .catch((reason: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'failed to flush datastore on shutdown',
            reason: reason instanceof Error ? reason.message : String(reason),
          }),
        );
      })
      .finally(() => {
        if (err) {
          console.error(
            JSON.stringify({ level: 'error', msg: 'shutdown failed', error: err.message }),
          );
          process.exit(1);
        }
        process.exit(0);
      });
  });

  // Backstop: never hang forever waiting on a stuck connection.
  setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', msg: 'forced shutdown after timeout' }));
    process.exit(1);
  }, 10_000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => shutdown(signal));
}
