import { mkdirSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/** Settings and the instance lock; outside the package so upgrades keep them. */
export const STATE_DIR = join(homedir(), '.moben-codex');
// The OS frees a listening socket when its process dies, so a crash cannot
// leave a lock that looks held, the way a PID file can.
const LOCK_PATH = process.platform === 'win32'
  ? `\\\\.\\pipe\\moben-codex-${userInfo().username}`
  : join(STATE_DIR, 'run.sock');

const QUERY_TIMEOUT_MS = 2000;

export type InstanceInfo = { pid: number; startedAt: string; status: string };

/** What the running instance reports; 'unresponsive' if it holds the lock but does not answer. */
export function queryInstance(): Promise<InstanceInfo | 'unresponsive' | null> {
  return new Promise(resolve => {
    let connected = false;
    let data = '';
    const socket = createConnection(LOCK_PATH);
    const done = (value: InstanceInfo | 'unresponsive' | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(connected ? 'unresponsive' : null), QUERY_TIMEOUT_MS);
    socket.on('connect', () => { connected = true; });
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => {
      try { done(JSON.parse(data)); } catch { done('unresponsive'); }
    });
    socket.on('error', () => done(null));
  });
}

/**
 * Takes the single-instance lock and answers status queries on it. Returns
 * null while another instance holds it.
 */
export async function acquireInstance(info: () => InstanceInfo): Promise<Server | null> {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = createServer(socket => {
      socket.on('error', () => {}); // A querier that hung up early.
      socket.end(JSON.stringify(info()));
    });
    const error = await new Promise<NodeJS.ErrnoException | null>(resolve => {
      server.once('error', resolve);
      server.listen(LOCK_PATH, () => resolve(null));
    });
    if (!error) {
      server.unref();
      return server;
    }
    if (error.code !== 'EADDRINUSE') throw error;
    if (await queryInstance()) return null;
    // Left by a process that died: nothing listens on it any more.
    if (process.platform !== 'win32') rmSync(LOCK_PATH, { force: true });
  }
  return null;
}
