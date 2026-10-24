#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect } from '@moben-ai/app-sdk';
import { acquireInstance, queryInstance, type InstanceInfo } from './instance';

const HELP = `Usage: moben-codex [command]

  run         Connect to Moben and keep running in this terminal (the default)
  status      Show whether it is running
  login       Log in to Moben on this computer (also: logout, whoami)
`;

const describe = (info: InstanceInfo) => `pid ${info.pid}, ${info.status}, since ${info.startedAt}`;

/** Where `moben login` saves its key; the same lookup as the SDK. */
function loggedIn() {
  if (process.env.MOBEN_DEVELOPER_KEY) return true;
  const dir = process.env.MOBEN_CONFIG_DIR
    || (process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'moben')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'moben'));
  return existsSync(join(dir, 'credentials.json'));
}

async function run() {
  if (!loggedIn()) {
    console.error('Not logged in to Moben on this computer. Run `moben-codex login` first.');
    process.exitCode = 1;
    return;
  }
  const startedAt = new Date().toISOString();
  let status = 'starting';
  const lock = await acquireInstance(() => ({ pid: process.pid, startedAt, status }));
  if (!lock) {
    const other = await queryInstance();
    console.error(`moben-codex is already running${other && other !== 'unresponsive' ? ` (${describe(other)})` : ''}.`);
    process.exitCode = 1;
    return;
  }
  const { app, hub } = await import('./app');
  let connection: ReturnType<typeof connect> | undefined;
  let exiting = false;
  const shutdown = (code: number) => {
    // A second Ctrl-C does not wait for the connection to close.
    if (exiting) process.exit(code);
    exiting = true;
    hub.codex.stop();
    void (connection?.close() ?? Promise.resolve()).finally(() => process.exit(code));
  };
  connection = connect(app, {
    onStatus: next => {
      status = next;
      // The cloud ended it: another process took over, the key was revoked, or the manifest was rejected.
      if (next === 'stopped' && !exiting) shutdown(1);
    },
  });
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

async function status() {
  const info = await queryInstance();
  if (info === null) console.log('Not running.');
  else if (info === 'unresponsive') console.log('Running, but not answering.');
  else console.log(`Running: ${describe(info)}.`);
}

/** The `moben` command of the bundled SDK, which a global install does not put on PATH. */
function moben(args: string[]) {
  let bin: string;
  try {
    const manifest = require.resolve('@moben-ai/app-sdk/package.json');
    bin = join(dirname(manifest), require(manifest).bin.moben);
  } catch {
    console.error('The Moben SDK that comes with moben-codex is missing; reinstall @moben-ai/codex.');
    process.exitCode = 1;
    return;
  }
  process.exitCode = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' }).status ?? 1;
}

async function main() {
  const [command = 'run', ...rest] = process.argv.slice(2);
  switch (command) {
    case 'run': return run();
    case 'status': return status();
    case 'login':
    case 'logout':
    case 'whoami':
      return moben([command, ...rest]);
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      console.error(HELP);
      process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
