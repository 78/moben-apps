import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexHub } from '../src/hub';

const threadId = 'thread';
function fixture() {
  const hub = new CodexHub();
  const notify = (method: string, params: any) => hub.codex.emit('notification', method, { threadId, ...params });
  const start = (id = 'turn') => notify('turn/started', { turn: { id } });
  const begin = (id: string, type = 'commandExecution', turnId = 'turn') => notify('item/started', { turnId, item: { id, type, status: 'inProgress' } });
  const finish = (id: string, type = 'commandExecution', turnId = 'turn') => notify('item/completed', { turnId, item: { id, type, status: 'completed' } });
  const status = (flags: string[] = []) => notify('thread/status/changed', { status: { type: 'active', activeFlags: flags } });
  return { hub, notify, start, begin, finish, status, state: () => hub.activity(threadId) };
}

test('only reasoning lifecycle or delta events establish thinking; unknown work stays waiting', () => {
  const f = fixture(); f.start(); assert.equal(f.state(), 'waiting');
  f.begin('unknown', 'futureItem'); assert.equal(f.state(), 'waiting');
  f.begin('reason', 'reasoning'); assert.equal(f.state(), 'thinking');
  f.finish('reason', 'reasoning'); assert.equal(f.state(), 'waiting');
  // Late deltas and duplicate starts cannot revive a completed reasoning item.
  f.notify('item/reasoning/summaryTextDelta', { turnId: 'turn', itemId: 'reason', delta: 'late' });
  f.begin('reason', 'reasoning'); assert.equal(f.state(), 'waiting');
  f.notify('item/reasoning/textDelta', { turnId: 'turn', itemId: 'new-reason', delta: 'not sent to status' });
  assert.equal(f.state(), 'thinking');
  f.notify('thread/status/changed', { status: { type: 'futureState' } });
  assert.equal(f.state(), 'waiting');
});

test('parallel tools and reasoning retain the highest supported active phase until it finishes', () => {
  const f = fixture(); f.start();
  f.begin('reason', 'reasoning'); f.begin('shell'); f.begin('mcp', 'mcpToolCall');
  assert.equal(f.state(), 'executing');
  f.finish('shell'); assert.equal(f.state(), 'executing');
  f.finish('mcp', 'mcpToolCall'); assert.equal(f.state(), 'thinking');
  f.finish('reason', 'reasoning'); assert.equal(f.state(), 'waiting');
  for (const kind of ['fileChange', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration']) {
    f.begin(kind, kind); assert.equal(f.state(), 'executing');
    f.finish(kind, kind); assert.equal(f.state(), 'waiting');
  }
});

test('upstream approval and input flags outrank work and restore it when cleared', () => {
  const f = fixture(); f.start(); f.begin('shell');
  f.status(['waitingOnUserInput']); assert.equal(f.state(), 'waitingInput');
  f.status(['waitingOnApproval', 'waitingOnUserInput']); assert.equal(f.state(), 'waitingApproval');
  f.status(['waitingOnUserInput']); assert.equal(f.state(), 'waitingInput');
  f.status(); assert.equal(f.state(), 'executing');
  f.status(['futureFlag']); assert.equal(f.state(), 'waiting');
  f.notify('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(f.state(), 'idle'); assert.equal(f.hub.isRunning(threadId), true);
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.equal(f.hub.isRunning(threadId), false);
});

test('parallel approval requests stay blocked until all are resolved or answered', t => {
  const f = fixture(); f.start(); f.begin('shell');
  t.mock.method(f.hub.codex, 'respond', () => {});
  t.mock.method(f.hub.codex, 'respondError', () => {});
  const request = (id: number, turnId = 'turn') => f.hub.codex.emit('request', { id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'echo hello' } });
  request(1); request(2); assert.equal(f.state(), 'waitingApproval');
  f.notify('serverRequest/resolved', { requestId: 1 }); assert.equal(f.state(), 'waitingApproval');
  const remaining = f.hub.pendingApprovals(threadId)[0];
  f.hub.decide(remaining.key, 'accept'); assert.equal(f.state(), 'executing');
  request(3); f.start('next'); assert.equal(f.state(), 'waiting');
  assert.deepEqual(f.hub.pendingApprovals(threadId), []);
  request(4, 'turn'); assert.equal(f.state(), 'waiting');
  assert.deepEqual(f.hub.pendingApprovals(threadId), []);
});

test('late events from older turns cannot change or finish a newer turn', () => {
  const f = fixture(); f.start('old'); f.begin('old-reason', 'reasoning', 'old');
  f.start('new'); f.begin('new-shell', 'commandExecution', 'new');
  f.finish('old-reason', 'reasoning', 'old');
  f.notify('turn/completed', { turn: { id: 'old', status: 'completed' } });
  f.start('old'); assert.equal(f.state(), 'executing');
  assert.equal(f.hub.latestTurn(threadId), 'new');
  f.notify('turn/completed', { turn: { id: 'new', status: 'completed' } });
  assert.equal(f.state(), 'idle');
  f.begin('late', 'reasoning', 'new'); assert.equal(f.state(), 'idle');
  assert.deepEqual(f.hub.recentItems(threadId), []);
});

test('closing or reopening a page preserves live evidence while disconnect clears it', () => {
  const f = fixture(); f.start(); f.begin('reason', 'reasoning');
  const first = f.hub.subscribe(threadId); first.close();
  const second = f.hub.subscribe(threadId);
  assert.equal(f.state(), 'thinking');
  f.hub.codex.emit('exit'); assert.equal(f.state(), 'idle');
  f.begin('late', 'reasoning'); assert.equal(f.state(), 'idle');
  second.close();
  f.start('next'); f.begin('mcp', 'mcpToolCall', 'next');
  f.notify('thread/closed', {}); assert.equal(f.state(), 'idle');
});

test('idle preceding turn completion still delivers its terminal event', async () => {
  const f = fixture(); f.start();
  const queue = f.hub.subscribe(threadId);
  f.notify('thread/status/changed', { status: { type: 'idle' } });
  f.notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
  queue.close(); const events = [];
  for await (const event of queue) events.push(event);
  assert.ok(events.some(event => event.kind === 'turnDone' && event.status === 'interrupted'));
  assert.equal(f.state(), 'idle');
});

test('a reopening snapshot restores blocking state but cannot overwrite newer notifications', async t => {
  const f = fixture();
  t.mock.method(f.hub.codex, 'request', async () => ({ thread: { id: threadId, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } }));
  await f.hub.read(threadId); assert.equal(f.state(), 'waitingInput');
  // A late start/RPC response for this active turn keeps the known blocking flag.
  f.start(); assert.equal(f.state(), 'waitingInput');
  f.status(); f.begin('reason', 'reasoning');
  let release!: (value: any) => void;
  t.mock.method(f.hub.codex, 'request', () => new Promise(resolve => { release = resolve; }));
  const read = f.hub.read(threadId);
  f.begin('shell'); assert.equal(f.state(), 'executing');
  release({ thread: { id: threadId, status: { type: 'idle' } } });
  await read; assert.equal(f.state(), 'executing');
});

test('completed item tombstones and overflow fall back safely without unbounded tracking', () => {
  const f = fixture(); f.start();
  f.finish('done'); f.begin('done'); assert.equal(f.state(), 'waiting');
  for (let i = 0; i < 520; ++i) f.begin(`parallel-${i}`);
  assert.equal(f.state(), 'waiting');
  f.begin('reason', 'reasoning'); assert.equal(f.state(), 'waiting');
  f.start('next'); f.begin('reason-next', 'reasoning', 'next'); assert.equal(f.state(), 'thinking');
});


test('approval requests and answers invalidate older status snapshots', async t => {
  const f = fixture(); f.start(); f.begin('shell');
  t.mock.method(f.hub.codex, 'respond', () => {});
  let release!: (value: any) => void;
  t.mock.method(f.hub.codex, 'request', () => new Promise(resolve => { release = resolve; }));
  const first = f.hub.read(threadId);
  f.hub.codex.emit('request', { id: 77, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn', command: 'echo hello' } });
  release({ thread: { id: threadId, status: { type: 'idle' } } });
  await first; assert.equal(f.state(), 'waitingApproval');
  assert.equal(f.hub.pendingApprovals(threadId).length, 1);
  const second = f.hub.read(threadId);
  f.hub.decide(f.hub.pendingApprovals(threadId)[0].key, 'accept');
  release({ thread: { id: threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
  await second; assert.equal(f.state(), 'executing');
});


test('an active snapshot cannot let an old approval revive a completed turn', t => {
  const f = fixture(); f.start('old');
  f.notify('turn/completed', { turn: { id: 'old', status: 'completed' } });
  f.status();
  t.mock.method(f.hub.codex, 'respondError', () => {});
  const request = (id: number, turnId: string) => f.hub.codex.emit('request', { id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'echo hello' } });
  request(1, 'old'); assert.deepEqual(f.hub.pendingApprovals(threadId), []);
  assert.equal(f.state(), 'waiting');
  request(2, 'new'); assert.equal(f.state(), 'waitingApproval');
  assert.equal(f.hub.latestTurn(threadId), 'new');
});


test('a late final reply is retained without reviving activity or polluting a newer turn', () => {
  const f = fixture(); f.start();
  f.notify('thread/status/changed', { status: { type: 'idle' } });
  f.notify('item/completed', { turnId: 'turn', item: { id: 'final', type: 'agentMessage', text: 'Done' } });
  assert.equal(f.state(), 'idle');
  assert.deepEqual(f.hub.recentItems(threadId).map(item => item.text), ['Done']);
  f.start('next');
  f.notify('item/completed', { turnId: 'turn', item: { id: 'old', type: 'agentMessage', text: 'Old reply' } });
  assert.deepEqual(f.hub.recentItems(threadId), []);
  assert.equal(f.state(), 'waiting');
});


test('idle clears the footer but keeps the page subscribed until the final turn event', async () => {
  const f = fixture(); f.start(); const queue = f.hub.subscribe(threadId);
  f.notify('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(f.state(), 'idle'); assert.equal(f.hub.isRunning(threadId), true);
  f.notify('item/completed', { turnId: 'turn', item: { id: 'final', type: 'agentMessage', text: 'Last reply' } });
  assert.equal(f.state(), 'idle');
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.equal(f.hub.isRunning(threadId), false);
  queue.close(); const events = []; for await (const event of queue) events.push(event);
  assert.ok(events.findIndex(event => event.kind === 'item') < events.findIndex(event => event.kind === 'turnDone'));
});
