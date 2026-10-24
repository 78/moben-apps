import { randomBytes } from 'node:crypto';
import { CodexServer, type JsonValue, type ServerRequest } from './codex';
import { commandText } from './render';
import type { SettingsChoice, TaskSettings } from './settings';

export type Approval = {
  key: string;
  threadId: string;
  turnId: string;
  kind: 'command' | 'fileChange';
  summary: string;
  reason?: string;
  requestId: number | string;
};

export type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export const DECISIONS: Decision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];

export type TurnsView = 'notLoaded' | 'summary' | 'full';
export type TurnPage = { data: JsonValue[]; nextCursor: string | null };

export type LiveEvent =
  | { kind: 'item'; item: JsonValue; turnId: string }
  | { kind: 'approval'; approval: Approval }
  | { kind: 'approvalDone'; decision: Decision }
  | { kind: 'turnDone'; status: string };

/** Push-based async iterator; a page stream reads it until it returns. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(item: T) { if (!this.closed) { this.items.push(item); this.wake?.(); } }
  close() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift() as T;
      if (this.closed) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

// items: completed items of turn latestTurnId, which the rollout file may not
// hold yet when a page opens right after the turn starts. turnId is set only
// while that turn runs.
type Live = { turnId: string | null; latestTurnId: string | null; items: JsonValue[]; listeners: Set<EventQueue<LiveEvent>> };

export class CodexHub {
  readonly codex = new CodexServer();
  private live = new Map<string, Live>();
  // Threads this app-server has started or resumed; others belong to another
  // process (the desktop app) and are only read.
  private loaded = new Set<string>();
  private approvals = new Map<string, Approval>();
  // Threads from thread/start and thread/resume, for when thread/read fails.
  private threads = new Map<string, JsonValue>();
  // Settings Codex reported for loaded threads; thread/read lacks the speed.
  private settings = new Map<string, SettingsChoice>();
  // Device changes waiting for the thread's next turn/start; a steer cannot change them.
  private pending = new Map<string, SettingsChoice>();

  constructor() {
    this.codex.on('notification', (method: string, params: JsonValue) => this.onNotification(method, params));
    this.codex.on('request', (request: ServerRequest) => this.onRequest(request));
    this.codex.on('exit', () => this.onExit());
  }

  isRunning(threadId: string) { return !!this.live.get(threadId)?.turnId; }
  pendingApprovals(threadId: string) { return [...this.approvals.values()].filter(a => a.threadId === threadId); }

  subscribe(threadId: string): EventQueue<LiveEvent> {
    const queue = new EventQueue<LiveEvent>();
    this.entry(threadId).listeners.add(queue);
    const close = queue.close.bind(queue);
    queue.close = () => { this.live.get(threadId)?.listeners.delete(queue); close(); };
    return queue;
  }

  /** The most recently updated threads. */
  async list(limit: number): Promise<JsonValue[]> {
    const { data } = await this.codex.request('thread/list', { limit, sortKey: 'updated_at' });
    // thread/list can repeat a thread across its sort buckets.
    return data.filter((thread: JsonValue, index: number) =>
      data.findIndex((other: JsonValue) => other.id === thread.id) === index);
  }

  /** The latest turn this app-server has seen, running or not. */
  latestTurn(threadId: string): string | null { return this.live.get(threadId)?.latestTurnId ?? null; }

  /** Completed items of latestTurn(). */
  recentItems(threadId: string): JsonValue[] { return this.live.get(threadId)?.items ?? []; }

  /** The thread's metadata, without its turns. */
  async read(threadId: string) {
    try {
      return (await this.codex.request('thread/read', { threadId })).thread;
    } catch (error) {
      // A new thread's rollout stays empty until Codex flushes its first items.
      const known = this.threads.get(threadId);
      if (!known) throw error;
      return known;
    }
  }

  /** One page of the thread's turns, newest first. */
  async turns(threadId: string, limit: number, itemsView: TurnsView, cursor: string | null = null): Promise<TurnPage> {
    try {
      const page = await this.codex.request('thread/turns/list', { threadId, limit, sortDirection: 'desc', itemsView, cursor });
      return { data: page.data ?? [], nextCursor: page.nextCursor ?? null };
    } catch (error) {
      if (!this.threads.has(threadId)) throw error;
      return { data: [], nextCursor: null };
    }
  }

  /**
   * Completed items of one turn in order, at most max of the newest; more
   * tells whether older ones were left out.
   */
  async turnItems(threadId: string, turnId: string, max: number): Promise<{ items: JsonValue[]; more: boolean }> {
    const items: JsonValue[] = [];
    let cursor: string | null = null;
    do {
      let page: JsonValue;
      try {
        page = await this.codex.request('thread/items/list', { threadId, turnId, sortDirection: 'desc', limit: 100, cursor });
      } catch (error) {
        if (!this.threads.has(threadId)) throw error;
        break;
      }
      for (const entry of page.data ?? []) items.push(entry.item);
      cursor = page.nextCursor ?? null;
    } while (cursor && items.length < max);
    return { items: items.slice(0, max).reverse(), more: !!cursor || items.length > max };
  }

  /** Starts a new task in cwd with the user's first instruction. */
  async startTask(cwd: string, text: string, settings: TaskSettings): Promise<string> {
    const started = await this.codex.request('thread/start', {
      cwd,
      model: settings.model,
      serviceTier: settings.serviceTier,
      // thread/start has no effort parameter; config overrides apply to this thread only.
      config: { model_reasoning_effort: settings.effort },
    });
    const threadId = started.thread.id as string;
    this.threads.set(threadId, { ...started.thread, preview: started.thread.preview || text, updatedAt: Math.floor(Date.now() / 1000) });
    this.loaded.add(threadId);
    this.remember(threadId, started);
    await this.startTurn(threadId, text);
    return threadId;
  }

  /** Settings known for the thread, newest first: pending, then reported by Codex. */
  settingsLayers(threadId: string): SettingsChoice[] {
    return [this.pending.get(threadId) ?? {}, this.settings.get(threadId) ?? {}];
  }

  /** Applies the change from the thread's next turn on. */
  changeSettings(threadId: string, change: SettingsChoice) {
    this.pending.set(threadId, { ...this.pending.get(threadId), ...change });
  }

  /** Resumes the thread in this app-server; fails while another Codex writes to it. */
  async ensureLoaded(threadId: string) {
    if (this.loaded.has(threadId)) return;
    const resumed = await this.codex.request('thread/resume', { threadId, excludeTurns: true });
    this.threads.set(threadId, resumed.thread);
    this.loaded.add(threadId);
    this.remember(threadId, resumed);
  }

  /** Steers the running turn, or starts the next one when the task is idle. */
  async send(threadId: string, text: string) {
    await this.ensureLoaded(threadId);
    const turnId = this.live.get(threadId)?.turnId;
    if (turnId) {
      try {
        await this.codex.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
        return;
      } catch (error) {
        // The turn ended in the meantime; the text starts the next one.
        if (this.live.get(threadId)?.turnId === turnId) throw error;
      }
    }
    await this.startTurn(threadId, text);
  }

  decide(key: string, decision: Decision): Approval | null {
    const approval = this.approvals.get(key);
    if (!approval) return null;
    this.approvals.delete(key);
    this.codex.respond(approval.requestId, { decision });
    this.emit(approval.threadId, { kind: 'approvalDone', decision });
    return approval;
  }

  private async startTurn(threadId: string, text: string) {
    // turn/start keeps these for the following turns too.
    const change = this.pending.get(threadId) ?? {};
    const result = await this.codex.request('turn/start', { threadId, input: [{ type: 'text', text }], ...change });
    if (this.pending.get(threadId) === change) this.pending.delete(threadId);
    this.settings.set(threadId, { ...this.settings.get(threadId), ...change });
    // Set before replying to the device, whose page stream reopens at once.
    this.beginTurn(threadId, result.turn.id);
  }

  /** Keeps what Codex reports in a thread/start or thread/resume response. */
  private remember(threadId: string, response: JsonValue) {
    this.settings.set(threadId, {
      model: response.model ?? undefined,
      effort: response.reasoningEffort ?? undefined,
      serviceTier: response.serviceTier ?? undefined,
    });
  }

  private beginTurn(threadId: string, turnId: string) {
    const live = this.entry(threadId);
    if (live.turnId === turnId) return;
    live.turnId = turnId;
    if (live.latestTurnId !== turnId) live.items = [];
    live.latestTurnId = turnId;
  }

  private entry(threadId: string): Live {
    let live = this.live.get(threadId);
    if (!live) this.live.set(threadId, live = { turnId: null, latestTurnId: null, items: [], listeners: new Set() });
    return live;
  }

  private emit(threadId: string, event: LiveEvent) {
    for (const queue of this.live.get(threadId)?.listeners ?? []) queue.push(event);
  }

  private onNotification(method: string, params: JsonValue) {
    const threadId = params?.threadId as string | undefined;
    if (!threadId) return;
    if (method === 'turn/started') {
      this.beginTurn(threadId, params.turn.id);
    } else if (method === 'turn/completed') {
      const live = this.entry(threadId);
      if (live.turnId === params.turn.id) live.turnId = null;
      for (const approval of this.pendingApprovals(threadId))
        if (approval.turnId === params.turn.id) this.approvals.delete(approval.key);
      this.emit(threadId, { kind: 'turnDone', status: params.turn.status });
    } else if (method === 'item/completed') {
      const live = this.entry(threadId);
      if (live.items.length < 500) live.items.push(params.item);
      this.emit(threadId, { kind: 'item', item: params.item, turnId: params.turnId ?? live.latestTurnId ?? '' });
    }
  }

  private onRequest(request: ServerRequest) {
    const params = request.params ?? {};
    const kind = request.method === 'item/commandExecution/requestApproval' ? 'command'
      : request.method === 'item/fileChange/requestApproval' ? 'fileChange' : null;
    if (!kind || !params.threadId) {
      // Questions, MCP prompts and permission profiles need the desktop app.
      this.codex.respondError(request.id, 'Not supported on Moben');
      return;
    }
    const approval: Approval = {
      key: randomBytes(6).toString('hex'),
      threadId: params.threadId,
      turnId: params.turnId,
      kind,
      summary: kind === 'command' ? commandText(params.command) : '',
      reason: params.reason ?? undefined,
      requestId: request.id,
    };
    this.approvals.set(approval.key, approval);
    this.emit(approval.threadId, { kind: 'approval', approval });
  }

  private onExit() {
    this.loaded.clear();
    this.approvals.clear();
    this.threads.clear();
    this.settings.clear();
    for (const [threadId, live] of this.live) {
      if (!live.turnId) continue;
      live.turnId = null;
      this.emit(threadId, { kind: 'turnDone', status: 'failed' });
    }
  }
}
