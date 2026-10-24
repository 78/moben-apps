import assert from 'node:assert/strict';
import test from 'node:test';
import { EventQueue, type Approval, type LiveEvent } from '../src/hub';
import { SettingsStore } from '../src/settings';

const drain = () => new Promise(resolve => setImmediate(resolve));

test('Codex reports temporary activity and never writes a fixed working line', async t => {
  t.mock.method(SettingsStore.prototype as any, 'load', () => ({}));
  const { app, hub } = await import('../src/app');
  t.mock.method(hub, 'read', async () => ({ id: 'task', cwd: process.cwd(), updatedAt: Date.now() / 1000 }));
  t.mock.method(hub, 'turns', async () => ({ data: [], nextCursor: null }));
  t.mock.method(hub, 'latestTurn', () => 'turn');
  t.mock.method(hub, 'recentItems', () => []);
  t.mock.method(hub.codex, 'request', async (method: string) => {
    if (method === 'model/list') return { data: [{ id: 'model', displayName: 'Model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high', serviceTiers: [], isDefault: true }] };
    if (method === 'config/read') return { config: {} };
    throw new Error(`Unexpected request ${method}`);
  });
  let running = true;
  let approvals: Approval[] = [];
  t.mock.method(hub, 'isRunning', () => running);
  t.mock.method(hub, 'pendingApprovals', () => approvals);
  let work: 'waiting' | 'thinking' | 'executing' | 'waitingInput' = 'waiting';
  t.mock.method(hub, 'activity', () => !running ? 'idle' : approvals.length ? 'waitingApproval' : work);
  let queue = new EventQueue<LiveEvent>();
  t.mock.method(hub, 'subscribe', () => queue);
  const states: string[] = [];
  const controller = new AbortController();
  const ctx: any = {
    appId: 'local.codex', mountPath: '/apps/local.codex', locale: 'en', timezone: 'UTC',
    client: { protocol: 3 }, params: { id: 'task' }, signal: controller.signal,
    currentPage: { url: '/apps/local.codex/t/task' }, query: new URLSearchParams(),
    url: (path: string) => `/apps/local.codex${path}`, setActivity: (state: string) => states.push(state),
  };
  const iterator = app.pages['/t/:id'](ctx);
  const chunks = [(await iterator.next()).value];
  let next = iterator.next(); await drain();
  assert.equal(states.at(-1), 'waiting');
  work = 'thinking'; queue.push({ kind: 'activity', state: 'thinking' }); await drain();
  assert.equal(states.at(-1), 'thinking');
  work = 'executing'; queue.push({ kind: 'activity', state: 'executing' }); await drain();
  assert.equal(states.at(-1), 'executing');
  const approval: Approval = { key: 'approve', threadId: 'task', turnId: 'turn', kind: 'command', summary: 'echo hello', requestId: 1 };
  approvals = [approval]; queue.push({ kind: 'approval', approval });
  chunks.push((await next).value);
  assert.equal(states.at(-1), 'waitingApproval');
  approvals = []; next = iterator.next(); queue.push({ kind: 'approvalDone', decision: 'accept' });
  chunks.push((await next).value);
  assert.equal(states.at(-1), 'executing');
  next = iterator.next(); work = 'waitingInput'; queue.push({ kind: 'activity', state: 'waitingInput' }); await drain();
  assert.equal(states.at(-1), 'waitingInput');
  work = 'waiting'; queue.push({ kind: 'activity', state: 'waiting' }); await drain();
  assert.equal(states.at(-1), 'waiting');
  running = false; queue.push({ kind: 'turnDone', status: 'completed' });
  chunks.push((await next).value);
  assert.equal(states.at(-1), 'idle');
  assert.equal((await iterator.next()).done, true);
  assert.doesNotMatch(chunks.join(''), /Codex is working|Codex 正在工作/);
  assert.match(chunks.join(''), /Done/);
  // Leaving an active page clears the state and closes its subscription.
  running = true; queue = new EventQueue<LiveEvent>(); states.length = 0;
  const cancelled = app.pages['/t/:id'](ctx);
  await cancelled.next(); const waiting = cancelled.next(); await drain();
  assert.equal(states.at(-1), 'waiting');
  controller.abort();
  assert.equal((await waiting).done, true);
  assert.equal(states.at(-1), 'idle');
});
