// main.ts — the forge entrypoint.
//
// Lifecycle (the make.fun wire contract):
//   1. bind an ephemeral port (listen(0); never 8080 — the env owns it),
//   2. POST {"port": n} to $MAKEFUN_ENV_URL/register,
//   3. serve from the in-memory store,
//   4. long-poll GET $MAKEFUN_ENV_URL/done with exponential backoff
//      (250 ms -> 2,000 ms) and exit 0 when done:true.
//
// With MAKEFUN_ENV_URL unset the server listens on $PORT (or an ephemeral
// port) and stays up, for local testing against the kit's sdk runner.

import { createForgeServer } from './lib/http.ts';
import { Store } from './lib/store.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const explicitPort = process.env.PORT !== undefined ? Number(process.env.PORT) : 0;

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pollDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    const body = await getJson(`${envUrl}/done`);
    if (body !== null && body.done === true) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(2000, delay * 2);
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createForgeServer(store);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(explicitPort, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not bind'));
        return;
      }
      resolve(address.port);
    });
  });

  if (envUrl === '') {
    // Local testing mode: stay up until killed.
    return;
  }

  const registered = await postJson(`${envUrl}/register`, { port });
  if (registered.status !== 200) {
    throw new Error(`register failed: HTTP ${registered.status} ${registered.text}`);
  }
  await pollDone();
  server.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
