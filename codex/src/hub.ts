import { randomBytes } from 'node:crypto';
import type { PageActivity } from '@moben-ai/app-sdk';
import { TaskActivity } from './activity';
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
  | { kind: 'turnDone'; status: string }
  | { kind: 'activity'; state: PageActivity }
  | { kind: 'closed' };

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
type Live = { activity: TaskActivity; awaitingCompletion: boolean; latestTurnId: string | null; items: JsonValue[]; listeners: Set<EventQueue<LiveEvent>> };

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

  isRunning(threadId: string) {
    const live = this.live.get(threadId);
    // A runtime idle notification may precede the final item/turn event. Keep
    // its page subscribed, while activity() already clears the visible status.
    return !!live && (live.activity.running || live.awaitingCompletion);
  }
  activity(threadId: string): PageActivity {
    const live = this.live.get(threadId);
    if (!live?.activity.running) return 'idle';
    return this.pendingApprovals(threadId).length ? 'waitingApproval' : live.activity.state;
  }
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
      const live = this.entry(threadId);
      const revision = live.activity.revision;
      const { thread } = await this.codex.request('thread/read', { threadId });
      // A slow snapshot must not overwrite newer notifications.
      if (live.activity.revision === revision) this.applyStatus(threadId, thread?.status);
      return thread;
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
    const live = this.entry(threadId);
    const revision = live.activity.revision;
    const resumed = await this.codex.request('thread/resume', { threadId, excludeTurns: true });
    if (live.activity.revision === revision) this.applyStatus(threadId, resumed.thread?.status);
    this.threads.set(threadId, resumed.thread);
    this.loaded.add(threadId);
    this.remember(threadId, resumed);
  }

  /** Steers the running turn, or starts the next one when the task is idle. */
  async send(threadId: string, text: string) {
    await this.ensureLoaded(threadId);
    const turnId = this.live.get(threadId)?.activity.turnId;
    if (turnId) {
      try {
        await this.codex.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
        return;
      } catch (error) {
        // The turn ended in the meantime; the text starts the next one.
        if (this.live.get(threadId)?.activity.turnId === turnId) throw error;
      }
    }
    await this.startTurn(threadId, text);
  }

  decide(key: string, decision: Decision): Approval | null {
    const approval = this.approvals.get(key);
    if (!approval) return null;
    const previous = this.activity(approval.threadId);
    this.approvals.delete(key);
    ++this.entry(approval.threadId).activity.revision;
    this.codex.respond(approval.requestId, { decision });
    this.publishActivity(approval.threadId, previous);
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
    const previous = this.activity(threadId);
    if (!live.activity.start(turnId)) return;
    live.awaitingCompletion = true;
    this.rememberTurn(live);
    // An old approval cannot block a new turn.
    for (const approval of this.pendingApprovals(threadId))
      if (approval.turnId !== turnId) this.approvals.delete(approval.key);
    this.publishActivity(threadId, previous);
  }

  private rememberTurn(live: Live) {
    const turnId = live.activity.turnId;
    if (turnId && live.latestTurnId !== turnId) { live.items = []; live.latestTurnId = turnId; }
  }

  private entry(threadId: string): Live {
    let live = this.live.get(threadId);
    if (!live) this.live.set(threadId, live = { activity: new TaskActivity(), awaitingCompletion: false, latestTurnId: null, items: [], listeners: new Set() });
    return live;
  }

  private publishActivity(threadId: string, previous: PageActivity) {
    const state = this.activity(threadId);
    if (state !== previous) this.emit(threadId, { kind: 'activity', state });
  }

  private applyStatus(threadId: string, status: JsonValue) {
    const live = this.entry(threadId);
    const previous = this.activity(threadId);
    if (!live.activity.status(status)) return;
    if (!live.activity.running) {
      for (const approval of this.pendingApprovals(threadId)) this.approvals.delete(approval.key);
    }
    this.publishActivity(threadId, previous);
    if (status.type === 'notLoaded' || status.type === 'systemError') { live.awaitingCompletion = false; this.emit(threadId, { kind: 'closed' }); }
  }

  private emit(threadId: string, event: LiveEvent) {
    for (const queue of this.live.get(threadId)?.listeners ?? []) queue.push(event);
  }

  private onNotification(method: string, params: JsonValue) {
    const threadId = params?.threadId;
    if (typeof threadId !== 'string' || !threadId) return;
    const live = this.entry(threadId);
    const previous = this.activity(threadId);
    if (method === 'turn/started') {
      if (typeof params.turn?.id === 'string') this.beginTurn(threadId, params.turn.id);
    } else if (method === 'turn/completed') {
      const turnId = params.turn?.id;
      if (typeof turnId !== 'string' || live.latestTurnId && live.latestTurnId !== turnId) return;
      live.activity.stop(turnId);
      live.awaitingCompletion = false;
      for (const approval of this.pendingApprovals(threadId))
        if (approval.turnId === turnId) this.approvals.delete(approval.key);
      this.publishActivity(threadId, previous);
      this.emit(threadId, { kind: 'turnDone', status: params.turn.status });
    } else if (method === 'thread/status/changed') {
      this.applyStatus(threadId, params.status);
    } else if (method === 'thread/closed') {
      this.applyStatus(threadId, { type: 'notLoaded' });
    } else if (method === 'item/started') {
      if (!live.activity.started(params.turnId, params.item)) return;
      this.rememberTurn(live);
      this.publishActivity(threadId, previous);
    } else if (method === 'item/completed') {
      const item = params.item;
      const turnId = params.turnId ?? live.activity.turnId ?? live.latestTurnId;
      if (typeof item?.id !== 'string' || typeof item.type !== 'string' || typeof turnId !== 'string') return;
      if (live.activity.finished(turnId, item.id)) {
        this.rememberTurn(live);
        this.publishActivity(threadId, previous);
      }
      // Content and activity are separate: a final reply can arrive after an
      // idle notification without reviving work or replacing a newer turn.
      if (live.latestTurnId && live.latestTurnId !== turnId || live.items.some(saved => saved.id === item.id)) return;
      live.latestTurnId ??= turnId;
      ++live.activity.revision;
      if (live.items.length < 500) live.items.push(item);
      this.emit(threadId, { kind: 'item', item, turnId });
    } else if (['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryPartAdded'].includes(method)) {
      if (!live.activity.reasoning(params.turnId, params.itemId)) return;
      this.rememberTurn(live);
      this.publishActivity(threadId, previous);
    } else if (method === 'serverRequest/resolved') {
      for (const approval of this.pendingApprovals(threadId))
        if (String(approval.requestId) === String(params.requestId)) { this.approvals.delete(approval.key); ++live.activity.revision; }
      this.publishActivity(threadId, previous);
    }
  }

  private onRequest(request: ServerRequest) {
    const params = request.params ?? {};
    const kind = request.method === 'item/commandExecution/requestApproval' ? 'command'
      : request.method === 'item/fileChange/requestApproval' ? 'fileChange' : null;
    if (!kind || typeof params.threadId !== 'string' || !params.threadId) {
      // Questions, MCP prompts and permission profiles need the desktop app.
      this.codex.respondError(request.id, 'Not supported on Moben');
      return;
    }
    const live = this.entry(params.threadId);
    if (typeof params.turnId !== 'string' || live.activity.turnId && live.activity.turnId !== params.turnId) {
      this.codex.respondError(request.id, 'Approval belongs to an inactive turn');
      return;
    }
    if (!live.activity.turnId) this.beginTurn(params.threadId, params.turnId);
    if (!live.activity.running || live.activity.turnId !== params.turnId) {
      this.codex.respondError(request.id, 'Approval belongs to an inactive turn');
      return;
    }
    const previous = this.activity(params.threadId);
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
    ++live.activity.revision;
    this.publishActivity(approval.threadId, previous);
    this.emit(approval.threadId, { kind: 'approval', approval });
  }

  private onExit() {
    this.loaded.clear();
    this.approvals.clear();
    this.threads.clear();
    this.settings.clear();
    for (const [threadId, live] of this.live) {
      const running = live.activity.running || live.awaitingCompletion;
      live.activity.stop();
      live.awaitingCompletion = false;
      this.emit(threadId, { kind: 'activity', state: 'idle' });
      this.emit(threadId, running ? { kind: 'turnDone', status: 'failed' } : { kind: 'closed' });
    }
  }
}
