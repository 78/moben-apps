import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { version } from '../package.json';

// The CLI bundled with the ChatGPT desktop app; CODEX_BIN or `codex` on PATH override it.
const BUNDLED = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const codexBinary = () => process.env.CODEX_BIN || (existsSync(BUNDLED) ? BUNDLED : 'codex');

export type JsonValue = any;
export type ServerRequest = { id: number | string; method: string; params: JsonValue };

type Pending = { resolve: (value: JsonValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class CodexError extends Error {}

const REQUEST_TIMEOUT_MS = 30000;

/**
 * A private `codex app-server` over stdio. It uses the user's own Codex
 * configuration (approval policy, sandbox, reviewer); only the model, effort
 * and speed chosen on the device are passed with a task's turns. Emits
 * `notification` (method, params) and `request` (ServerRequest, which must be
 * answered with respond()).
 */
export class CodexServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<void> | null = null;
  private stopped = false;

  start(): Promise<void> {
    // A failed start must not stick: the next request launches a fresh app-server.
    this.ready ??= this.launch().catch(error => {
      this.child?.kill();
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }

  async request(method: string, params: JsonValue): Promise<JsonValue> {
    await this.start();
    return this.send(method, params);
  }

  respond(id: number | string, result: JsonValue) {
    this.write({ id, result });
  }

  respondError(id: number | string, message: string) {
    this.write({ id, error: { code: -32000, message } });
  }

  private async launch() {
    // The app-server exits when its stdin closes, so it never outlives this process.
    const child = spawn(codexBinary(), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.on('data', data => {
      const text = String(data).trim();
      // A CLI older than the desktop app warns about its newer config keys on every start.
      if (text && !text.includes('unrecognized configuration')) console.error(`[codex] ${text.slice(0, 500)}`);
    });
    child.stdin.on('error', () => {}); // EPIPE after exit; onExit reports it.
    child.on('error', error => {
      console.error(`[codex] ${error.message}`);
      this.onExit(child, null);
    });
    child.on('exit', code => this.onExit(child, code));
    createInterface({ input: child.stdout }).on('line', line => this.onLine(line));
    await this.send('initialize', { clientInfo: { name: 'moben_codex', title: 'Moben Codex', version } });
    this.write({ method: 'initialized' });
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CodexError('Codex stopped'));
    }
    this.pending.clear();
    this.emit('exit');
    if (this.stopped) return;
    console.error(`[codex] app-server exited (${code}); restarting on next request`);
  }

  private send(method: string, params: JsonValue): Promise<JsonValue> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexError(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private write(message: JsonValue) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string) {
    let message: JsonValue;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexError(message.error.message ?? 'Codex error'));
      else pending.resolve(message.result);
    } else if (message.id !== undefined) {
      const request: ServerRequest = { id: message.id, method: message.method, params: message.params };
      if (!this.emit('request', request)) this.respondError(request.id, 'Not supported');
    } else if (message.method) {
      this.emit('notification', message.method, message.params);
    }
  }
}
