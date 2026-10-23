import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { AppRequestError, createAppTranslator, defineApp, md, page, type AppContext } from '@moben-ai/app-sdk';
import { CodexError, type JsonValue } from './codex';
import { CodexHub, type Approval, type Decision, type LiveEvent } from './hub';
import { STATE_DIR } from './instance';
import { version as VERSION } from '../package.json';
import { clip, labelReply, renderItem, renderItemDetail, separator, userText, type Labels } from './render';
import {
  SETTINGS_FIELDS, STANDARD_TIER, SettingsStore,
  type ModelInfo, type SettingsField, type TaskSettings,
} from './settings';

const text = createAppTranslator({
  en: {
    title: 'Codex',
    newTask: 'New task',
    noTasks: 'No tasks yet.',
    running: 'running',
    minutes: '{n} min ago',
    hours: '{n} h ago',
    days: '{n} d ago',
    justNow: 'just now',
    pickProject: 'Choose a project',
    noProjects: 'No recent projects. Start a task in Codex on the computer first.',
    newTaskHint: 'Say the task, release to start',
    newTaskBody: 'Hold the voice key and say what Codex should do in {dir}.',
    taskHint: 'Say the next instruction',
    working: 'Codex is working…',
    idleNote: '(Hold the voice key for the next instruction)',
    openOnDesktop: 'This task is open in Codex on the computer, and Codex lets only one place write to it. Continue there, or quit Codex on the computer and try again.',
    codexFailed: 'Codex error: {message}',
    turnCompleted: '(Done · hold the voice key for the next instruction)',
    turnInterrupted: '(Stopped · hold the voice key for the next instruction)',
    turnFailed: '(The turn failed · hold the voice key to try again)',
    approvalTitle: 'Approval needed',
    approvalCommand: 'Run: {command}',
    approvalFiles: 'Change files',
    approve: 'Review',
    allow: 'Allow',
    allowSession: 'Allow for this task',
    deny: 'Deny',
    allowed: 'Allowed',
    denied: 'Denied',
    approvalFirst: 'Answer the approval first',
    emptySpeech: 'Nothing was recognized. Try again.',
    unknownProject: 'Unknown project',
    settingsTitle: 'Task settings',
    settingLine: '{field}: ',
    settingsNote: '(Applies from the next turn)',
    model: 'Model',
    effort: 'Reasoning',
    serviceTier: 'Speed',
    effort_low: 'Low',
    effort_medium: 'Medium',
    effort_high: 'High',
    effort_xhigh: 'Extra high',
    effort_max: 'Max',
    effort_ultra: 'Ultra',
    tier_default: 'Standard',
    tier_priority: 'Fast',
    you: 'You: ',
    ai: 'AI: ',
    edited: 'edit',
    added: 'add',
    deleted: 'delete',
    declined: '(declined)',
    more: 'Full text',
    output: 'Output',
    compacted: 'context compacted',
    interrupted: 'interrupted',
    read: 'read',
    search: 'search',
    list: 'list',
    webSearch: 'web search: ',
    itemMissing: 'This item is no longer available.',
    earlierTurns: 'Earlier turns',
    previousTurn: 'Previous turn',
    nextTurn: 'Next turn',
    noPrompt: '(no text)',
    failed: 'failed',
    turnsOmitted: 'Older turns are on the computer.',
    turnTrimmed: 'This turn is long; its earlier steps are left out. See the full turn on the computer.',
    turnMissing: 'This turn is no longer available.',
  },
  'zh-CN': {
    title: 'Codex',
    newTask: '新任务',
    noTasks: '还没有任务。',
    running: '运行中',
    minutes: '{n} 分钟前',
    hours: '{n} 小时前',
    days: '{n} 天前',
    justNow: '刚刚',
    pickProject: '选择项目',
    noProjects: '没有最近的项目。请先在电脑上的 Codex 里开始一个任务。',
    newTaskHint: '说出任务，松开开始',
    newTaskBody: '按住语音键，说出要 Codex 在 {dir} 里做什么。',
    taskHint: '说出下一步指令',
    working: 'Codex 正在工作…',
    idleNote: '（按住语音键给出下一步指令）',
    openOnDesktop: '这个任务正在电脑上的 Codex 里打开，Codex 只允许一处写入。请在电脑上继续，或退出电脑上的 Codex 后再试。',
    codexFailed: 'Codex 出错：{message}',
    turnCompleted: '（本轮完成，按住语音键给出下一步指令）',
    turnInterrupted: '（已停止，按住语音键给出下一步指令）',
    turnFailed: '（本轮失败，按住语音键重试）',
    approvalTitle: '需要审批',
    approvalCommand: '运行：{command}',
    approvalFiles: '修改文件',
    approve: '审批',
    allow: '允许',
    allowSession: '本任务内都允许',
    deny: '拒绝',
    allowed: '已允许',
    denied: '已拒绝',
    approvalFirst: '请先处理审批',
    emptySpeech: '没有识别到内容，请再说一次。',
    unknownProject: '未知项目',
    settingsTitle: '任务设置',
    settingLine: '{field}：',
    settingsNote: '（从下一轮开始生效）',
    model: '模型',
    effort: '思考',
    serviceTier: '速度',
    effort_low: '低',
    effort_medium: '中',
    effort_high: '高',
    effort_xhigh: '超高',
    effort_max: '极高',
    effort_ultra: '最高',
    tier_default: '标准',
    tier_priority: '快速',
    you: '你：',
    ai: 'AI：',
    edited: '修改',
    added: '新增',
    deleted: '删除',
    declined: '（已拒绝）',
    more: '查看全文',
    output: '查看输出',
    compacted: '上下文已压缩',
    interrupted: '已中断',
    read: '读取',
    search: '搜索',
    list: '列出',
    webSearch: '搜索网页：',
    itemMissing: '这条内容已不存在。',
    earlierTurns: '更早的记录',
    previousTurn: '上一轮',
    nextTurn: '下一轮',
    noPrompt: '（没有文字）',
    failed: '失败',
    turnsOmitted: '更早的轮次请在电脑上查看。',
    turnTrimmed: '这一轮较长，前面的步骤已省略，完整内容请在电脑上查看。',
    turnMissing: '这一轮的记录已不存在。',
  },
});

export const hub = new CodexHub();
const store = new SettingsStore(hub.codex, join(STATE_DIR, 'settings.json'));
const TURN_BYTES = 48 * 1024;
const DIRECTORY_TURNS = 200;
const LISTED_TASKS = 50;

/** Shows Codex's own failure on the device instead of the SDK's generic message. */
async function viaCodex<T>(ctx: AppContext, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof CodexError)) throw error;
    // Another app-server (usually the desktop app) holds the thread.
    if (error.message.includes('already has an active writer')) throw new AppRequestError(409, text(ctx, 'openOnDesktop'));
    throw new AppRequestError(409, text(ctx, 'codexFailed', { message: clip(error.message, 160) }));
  }
}

const labels = (ctx: AppContext): Labels => ({
  you: text(ctx, 'you'), edited: text(ctx, 'edited'), added: text(ctx, 'added'),
  deleted: text(ctx, 'deleted'), declined: text(ctx, 'declined'), more: text(ctx, 'more'),
  output: text(ctx, 'output'), compacted: text(ctx, 'compacted'),
  read: text(ctx, 'read'), search: text(ctx, 'search'), list: text(ctx, 'list'), webSearch: text(ctx, 'webSearch'),
});

const ago = (ctx: AppContext, seconds: number) => {
  const minutes = Math.floor((Date.now() / 1000 - seconds) / 60);
  if (minutes < 1) return text(ctx, 'justNow');
  if (minutes < 60) return text(ctx, 'minutes', { n: minutes });
  if (minutes < 48 * 60) return text(ctx, 'hours', { n: Math.floor(minutes / 60) });
  return text(ctx, 'days', { n: Math.floor(minutes / 1440) });
};

const taskTitle = (thread: { name?: string | null; preview?: string | null }) =>
  clip((thread.name || thread.preview || 'Codex').replace(/\s+/g, ' ').trim(), 24);

const dirKey = (cwd: string) => Buffer.from(cwd).toString('base64url');

const MAX_PROJECTS = 20;
const PROJECTS_TTL_MS = 5 * 60 * 1000;
let projectsCache: { at: number; dirs: string[] } | null = null;

/** Directories of past tasks, most recently used first; reading all history takes a few seconds. */
async function recentProjects(): Promise<string[]> {
  if (projectsCache && Date.now() - projectsCache.at < PROJECTS_TTL_MS) return projectsCache.dirs;
  const dirs: string[] = [];
  let cursor: string | null = null, seen = 0;
  do {
    const list: any = await hub.codex.request('thread/list', { limit: 100, sortKey: 'updated_at', cursor });
    for (const thread of list.data)
      if (thread.cwd && !dirs.includes(thread.cwd) && existsSync(thread.cwd)) dirs.push(thread.cwd);
    seen += list.data.length;
    cursor = list.nextCursor ?? null;
  } while (cursor && dirs.length < MAX_PROJECTS && seen < 5000);
  projectsCache = { at: Date.now(), dirs: dirs.slice(0, MAX_PROJECTS) };
  return projectsCache.dirs;
}

async function projectFor(ctx: AppContext): Promise<string> {
  const cwd = Buffer.from(ctx.params.dir ?? '', 'base64url').toString();
  if (!(await recentProjects()).includes(cwd)) throw new AppRequestError(404, text(ctx, 'unknownProject'));
  return cwd;
}

type MessageKey = Parameters<typeof text>[1];
// Codex may add levels and tiers; unknown ones show their id.
const EFFORT_LABELS: Record<string, MessageKey> = {
  low: 'effort_low', medium: 'effort_medium', high: 'effort_high',
  xhigh: 'effort_xhigh', max: 'effort_max', ultra: 'effort_ultra',
};
const TIER_LABELS: Record<string, MessageKey> = { [STANDARD_TIER]: 'tier_default', priority: 'tier_priority' };
// The device shows at most this many Action Sheet items.
const SHEET_ITEMS = 10;

type SettingOption = { value: string; label: string };

function settingOptions(ctx: AppContext, models: ModelInfo[], model: ModelInfo): Record<SettingsField, SettingOption[]> {
  return {
    model: models.slice(0, SHEET_ITEMS).map(m => ({ value: m.id, label: m.name })),
    effort: model.efforts.slice(0, SHEET_ITEMS).map(effort =>
      ({ value: effort, label: EFFORT_LABELS[effort] ? text(ctx, EFFORT_LABELS[effort]) : effort })),
    serviceTier: [{ id: STANDARD_TIER, name: STANDARD_TIER }, ...model.tiers].slice(0, SHEET_ITEMS).map(tier =>
      ({ value: tier.id, label: TIER_LABELS[tier.id] ? text(ctx, TIER_LABELS[tier.id]) : tier.name })),
  };
}

async function describeSettings(ctx: AppContext, settings: TaskSettings) {
  const models = await store.models();
  const model = models.find(m => m.id === settings.model)!;
  const options = settingOptions(ctx, models, model);
  const label = (field: SettingsField) =>
    options[field].find(option => option.value === settings[field])?.label ?? settings[field];
  return { options, label };
}

// Action Sheet ids are lowercase.
const sheetId = (field: SettingsField) => `set-${field.toLowerCase()}`;

/** One line per setting; each opens a menu whose items call `${actionBase}/<field>/<value>`. */
async function settingsMarkdown(ctx: AppContext, actionBase: string, settings: TaskSettings) {
  const { options, label } = await describeSettings(ctx, settings);
  const sheets = SETTINGS_FIELDS.map(field => md.actionSheet({
    id: sheetId(field),
    title: text(ctx, field),
    items: options[field].map(option => ({
      text: `${option.value === settings[field] ? '✓ ' : ''}${option.label}`,
      url: `action:${ctx.url(`${actionBase}/${field}/${encodeURIComponent(option.value)}`)}`,
    })),
  }));
  const lines = SETTINGS_FIELDS.map(field =>
    `${md.text(text(ctx, 'settingLine', { field: text(ctx, field) }))}${md.actionSheetLink(label(field), sheetId(field))}`);
  // Declarations take no space on the device, but blank lines between them would.
  return `${sheets.join('\n')}\n${lines.join('\n')}`;
}

async function settingsSummary(ctx: AppContext, settings: TaskSettings) {
  const { label } = await describeSettings(ctx, settings);
  return SETTINGS_FIELDS.map(label).join(' · ');
}

/** What the thread's next turn will use. */
async function threadSettings(threadId: string, thread: JsonValue) {
  return store.resolve(...hub.settingsLayers(threadId),
    { model: thread.model ?? undefined, effort: thread.reasoningEffort ?? undefined }, await store.defaults());
}

async function settingChange(ctx: AppContext) {
  const field = ctx.params.field as SettingsField;
  const value = ctx.params.value;
  if (!SETTINGS_FIELDS.includes(field) || !(await store.isValid(field, value))) throw new AppRequestError(400, 'Bad setting');
  return { [field]: value };
}

function approvalBlock(ctx: AppContext, approval: Approval) {
  const base = `/t/${approval.threadId}/approve/${approval.key}`;
  const what = approval.kind === 'command'
    ? text(ctx, 'approvalCommand', { command: clip(approval.summary.replace(/\s+/g, ' '), 120) })
    : text(ctx, 'approvalFiles');
  const sheet = md.actionSheet({
    id: `approve-${approval.key}`,
    title: text(ctx, 'approvalTitle'),
    items: [
      { text: text(ctx, 'allow'), url: `action:${ctx.url(`${base}/accept`)}` },
      { text: text(ctx, 'allowSession'), url: `action:${ctx.url(`${base}/acceptForSession`)}` },
      { text: text(ctx, 'deny'), url: `action:${ctx.url(`${base}/decline`)}` },
    ],
  });
  const reason = approval.reason ? `\n\n${md.text(clip(approval.reason, 200))}` : '';
  return `${sheet}\n\n${md.bold(text(ctx, 'approvalTitle'))}\n\n${md.text(what)}${reason}\n\n${md.actionSheetLink(text(ctx, 'approve'), `approve-${approval.key}`)}`;
}

/**
 * The turn the task page shows: the one this app-server saw last, or else the
 * newest in the rollout. index equals turns.length for a turn the rollout does
 * not hold yet; turns before index are earlier turns. live: hub.recentItems()
 * belong to the shown turn.
 */
function shownTurn(threadId: string, turns: any[]): { index: number; live: boolean } {
  const latest = hub.latestTurn(threadId);
  if (latest) {
    const index = turns.findIndex(turn => turn.id === latest);
    if (index < 0) return { index: turns.length, live: true };
    if (index === turns.length - 1) return { index, live: true };
  }
  return { index: Math.max(turns.length - 1, 0), live: false };
}

/** When the turn started, and how it ended unless it completed. */
function turnMeta(ctx: AppContext, turn: any) {
  const parts = typeof turn.startedAt === 'number' ? [ago(ctx, turn.startedAt)] : [];
  if (turn.status === 'interrupted') parts.push(text(ctx, 'interrupted'));
  else if (turn.status === 'failed') parts.push(text(ctx, 'failed'));
  return parts.join(' · ');
}

/** Page text; role marks the user's messages and Codex's replies, not status lines. */
type Block = { text: string; role?: 'user' | 'reply' };

/** A completed item once per page, or null when already shown or not shown at all. */
function itemBlock(ctx: AppContext, threadId: string, item: JsonValue, seen: Set<string>): Block | null {
  if (item.status === 'inProgress' || seen.has(item.id)) return null;
  seen.add(item.id);
  const markdown = renderItem(item, labels(ctx), id => ctx.url(`/t/${threadId}/i/${id}`));
  return markdown ? { text: markdown, role: item.type === 'userMessage' ? 'user' : 'reply' } : null;
}

/** One turn's completed items as blocks. */
function turnBlocks(ctx: AppContext, threadId: string, turn: any, seen: Set<string>) {
  const blocks = (turn?.items ?? []).map((item: JsonValue) => itemBlock(ctx, threadId, item, seen)).filter(Boolean) as Block[];
  if (turn?.status === 'interrupted') blocks.push({ text: `> — ${md.text(text(ctx, 'interrupted'))} —` });
  return blocks;
}

/**
 * Emits blocks as lines, with a blank line where separator() wants one, and
 * labels the first reply after each message of the user.
 */
class BlockWriter {
  private last = '';
  private awaitingReply = false;
  constructor(private readonly replyLabel: string) {}
  write(block: Block) {
    const labelled = block.role === 'reply' && this.awaitingReply ? labelReply(this.replyLabel, block.text) : block.text;
    if (block.role) this.awaitingReply = block.role === 'user';
    const out = `${separator(this.last, block.text)}${labelled}\n`;
    this.last = block.text;
    return out;
  }
}

/** The newest blocks within the budget, noting any left out. */
function turnMarkdown(ctx: AppContext, blocks: Block[], writer: BlockWriter) {
  let bytes = 0, start = blocks.length;
  while (start > 0 && bytes + Buffer.byteLength(blocks[start - 1].text) < TURN_BYTES) bytes += Buffer.byteLength(blocks[--start].text);
  const kept = blocks.slice(start);
  if (start > 0) kept.unshift({ text: `> ${md.text(text(ctx, 'turnTrimmed'))}` });
  return kept.map(block => writer.write(block)).join('');
}

function liveMarkdown(ctx: AppContext, threadId: string, event: LiveEvent, seen: Set<string>): Block | null {
  if (event.kind === 'item') return itemBlock(ctx, threadId, event.item, seen);
  if (event.kind === 'approval') return { text: approvalBlock(ctx, event.approval) };
  if (event.kind === 'approvalDone') return { text: md.text(text(ctx, event.decision === 'decline' ? 'denied' : 'allowed')) };
  return null;
}

export const app = defineApp({
  manifest: {
    manifestVersion: 1, id: 'codex', name: 'Codex', version: VERSION, entry: '/', permissions: [],
    description: 'Follow and steer Codex tasks on your computer by voice.',
    locales: { 'zh-CN': { name: 'Codex', description: '用语音跟进和指挥电脑上的 Codex 任务。' } },
    agent: {
      instructions: 'This app shows Codex coding tasks running on the user\'s computer. Task pages take voice instructions directly; answer questions about what is visible on the page.',
      tools: [],
    },
  },
  pages: {
    '/': async ctx => {
      const threads = await hub.list(LISTED_TASKS);
      const builder = page(ctx, { title: text(ctx, 'title'), refresh: { intervalSeconds: 60 } })
        .heading(text(ctx, 'title'))
        .raw(md.link(`+ ${text(ctx, 'newTask')}`, ctx.url('/new')));
      if (!threads.length) return builder.paragraph(text(ctx, 'noTasks')).toString();
      // Paragraphs, not list items: wrapped list lines are not indented.
      return builder.raw(threads.map(thread => {
        const state = hub.isRunning(thread.id) ? `${text(ctx, 'running')} · ` : '';
        const meta = `${state}${ago(ctx, thread.updatedAt)} · ${basename(thread.cwd ?? '')}`;
        return `${md.link(taskTitle(thread), ctx.url(`/t/${thread.id}`))}\n> ${md.text(meta)}`;
      }).join('\n\n')).toString();
    },
    '/new': async ctx => {
      const dirs = await recentProjects();
      const builder = page(ctx, { title: text(ctx, 'pickProject'), navigation: { parentPage: ctx.url('/') } })
        .heading(text(ctx, 'pickProject'));
      if (!dirs.length) return builder.paragraph(text(ctx, 'noProjects')).toString();
      // Replace: the task created there then returns straight to the task list.
      return builder.raw(dirs.map(dir =>
        `${md.link(basename(dir), `${ctx.url(`/new/${dirKey(dir)}`)}#history=replace`)}\n> ${md.text(clip(dir.replace(homedir(), '~'), 40))}`).join('\n\n')).toString();
    },
    '/new/:dir': async ctx => {
      const cwd = await projectFor(ctx);
      const settings = await settingsMarkdown(ctx, `/new/${ctx.params.dir}/set`, await store.forNewTask());
      return page(ctx, {
        title: basename(cwd),
        navigation: { parentPage: ctx.url('/new') },
        voice: { mode: 'capture', url: ctx.url(`/new/${ctx.params.dir}/voice`), hint: text(ctx, 'newTaskHint') },
      }).heading(`${text(ctx, 'newTask')} · ${basename(cwd)}`)
        .paragraph(text(ctx, 'newTaskBody', { dir: basename(cwd) }))
        .raw(settings)
        .raw(`> ${md.text(cwd.replace(homedir(), '~'))}`).toString();
    },
    '/t/:id': async function* (ctx) {
      const threadId = ctx.params.id;
      // Subscribe before reading so nothing between the two is lost.
      const events = hub.subscribe(threadId);
      ctx.signal.addEventListener('abort', () => events.close(), { once: true });
      try {
        const thread = await hub.read(threadId);
        const turns = thread.turns ?? [];
        const shown = shownTurn(threadId, turns);
        const summary = await settingsSummary(ctx, await threadSettings(threadId, thread));
        // Only the latest turn: earlier ones are a link away, and the whole task is on the computer.
        const earlier = shown.index > 0
          ? `\n> ${md.link(text(ctx, 'earlierTurns'), ctx.url(`/t/${threadId}/h`))}` : '';
        yield page(ctx, {
          title: taskTitle(thread),
          interaction: { follow: true },
          navigation: { parentPage: ctx.url('/') },
          voice: { mode: 'capture', url: ctx.url(`/t/${threadId}/voice`), hint: text(ctx, 'taskHint') },
        }).raw(`# ${md.text(taskTitle(thread))}\n`
          + `> ${md.text(`${ago(ctx, thread.updatedAt)} · ${basename(thread.cwd ?? '')}`)}\n`
          + `> ${md.link(summary, ctx.url(`/t/${threadId}/settings`))}${earlier}`).toString();
        const seen = new Set<string>();
        const writer = new BlockWriter(text(ctx, 'ai'));
        const body = turnMarkdown(ctx, turnBlocks(ctx, threadId, turns[shown.index], seen), writer);
        if (body) yield body;
        for (const item of shown.live ? hub.recentItems(threadId) : []) {
          const block = itemBlock(ctx, threadId, item, seen);
          if (block) yield writer.write(block);
        }
        for (const approval of hub.pendingApprovals(threadId)) yield writer.write({ text: approvalBlock(ctx, approval) });
        if (!hub.isRunning(threadId)) {
          yield `\n> ${md.text(text(ctx, 'idleNote'))}\n`;
          return;
        }
        yield writer.write({ text: `> ${md.text(text(ctx, 'working'))}` });
        for await (const event of events) {
          if (event.kind === 'turnDone') {
            if (hub.isRunning(threadId)) continue; // A steer started the next turn.
            const ended = event.status === 'completed' ? 'turnCompleted'
              : event.status === 'interrupted' ? 'turnInterrupted' : 'turnFailed';
            yield `\n> ${md.text(text(ctx, ended))}\n`;
            return;
          }
          const block = liveMarkdown(ctx, threadId, event, seen);
          if (block) yield writer.write(block);
        }
      } finally {
        events.close();
      }
    },
    '/t/:id/settings': async ctx => {
      const threadId = ctx.params.id;
      const thread = await hub.read(threadId);
      const settings = await settingsMarkdown(ctx, `/t/${threadId}/set`, await threadSettings(threadId, thread));
      return page(ctx, {
        title: text(ctx, 'settingsTitle'),
        interaction: { startMode: 'select' },
        navigation: { parentPage: ctx.url(`/t/${threadId}`) },
      }).heading(text(ctx, 'settingsTitle'))
        .raw(settings)
        .raw(`> ${md.text(text(ctx, 'settingsNote'))}`).toString();
    },
    '/t/:id/h': async ctx => {
      const threadId = ctx.params.id;
      const thread = await hub.read(threadId);
      const turns = thread.turns ?? [];
      const earlier = shownTurn(threadId, turns).index;
      const builder = page(ctx, { title: text(ctx, 'earlierTurns'), navigation: { parentPage: ctx.url(`/t/${threadId}`) } })
        .heading(text(ctx, 'earlierTurns'));
      // Newest first; turn n is turns[n - 1].
      const entries: string[] = [];
      for (let n = earlier; n > Math.max(earlier - DIRECTORY_TURNS, 0); n--) {
        const turn = turns[n - 1];
        const prompt = (turn.items ?? []).filter((item: any) => item.type === 'userMessage').map(userText).find(Boolean);
        const label = prompt ? clip(prompt.replace(/\s+/g, ' '), 60) : text(ctx, 'noPrompt');
        const meta = turnMeta(ctx, turn);
        entries.push(`${md.link(label, ctx.url(`/t/${threadId}/h/${n}`))}${meta ? `\n> ${md.text(meta)}` : ''}`);
      }
      if (earlier > DIRECTORY_TURNS) entries.push(`> ${md.text(text(ctx, 'turnsOmitted'))}`);
      return builder.raw(entries.join('\n\n')).toString();
    },
    '/t/:id/h/:n': async ctx => {
      const threadId = ctx.params.id;
      const thread = await hub.read(threadId);
      const turns = thread.turns ?? [];
      const earlier = shownTurn(threadId, turns).index;
      const n = Number(ctx.params.n);
      if (!Number.isInteger(n) || n < 1 || n > earlier) throw new AppRequestError(404, text(ctx, 'turnMissing'));
      const turn = turns[n - 1];
      // Replace between turns, so the menu key returns to the directory.
      const turnUrl = (at: number) => `${ctx.url(`/t/${threadId}/h/${at}`)}#history=replace`;
      const links = [
        ...(n > 1 ? [md.link(text(ctx, 'previousTurn'), turnUrl(n - 1))] : []),
        ...(n < earlier ? [md.link(text(ctx, 'nextTurn'), turnUrl(n + 1))] : []),
      ].join(' · ');
      const meta = turnMeta(ctx, turn);
      const body = turnMarkdown(ctx, turnBlocks(ctx, threadId, turn, new Set()), new BlockWriter(text(ctx, 'ai')));
      const builder = page(ctx, { title: taskTitle(thread), navigation: { parentPage: ctx.url(`/t/${threadId}/h`) } });
      if (meta) builder.raw(`> ${md.text(meta)}`);
      builder.raw(body);
      if (links) builder.raw(`> ${links}`);
      return builder.toString();
    },
    '/t/:id/i/:item': async ctx => {
      const thread = await hub.read(ctx.params.id);
      const item = (thread.turns ?? []).flatMap((turn: any) => turn.items ?? []).find((it: any) => it.id === ctx.params.item);
      const builder = page(ctx, { title: taskTitle(thread), navigation: { parentPage: ctx.url(`/t/${ctx.params.id}`) } });
      const body = item ? renderItemDetail(item) : '';
      return (body ? builder.raw(body) : builder.paragraph(text(ctx, 'itemMissing'))).toString();
    },
  },
  actions: {
    '/t/:id/approve/:key/:decision': async ctx => {
      const decision = ctx.params.decision as Decision;
      if (!['accept', 'acceptForSession', 'decline'].includes(decision)) throw new AppRequestError(400, 'Bad decision');
      // Only this task's approvals: a key from another task must not be answered.
      // One already answered or expired just shows the task again.
      if (hub.pendingApprovals(ctx.params.id).some(approval => approval.key === ctx.params.key)) {
        hub.decide(ctx.params.key, decision);
      }
      return ctx.renderPage(`/t/${ctx.params.id}`, { startMode: 'read' });
    },
    '/new/:dir/set/:field/:value': async ctx => {
      store.saveForNewTasks(await settingChange(ctx));
      return ctx.renderPage(`/new/${ctx.params.dir}`, { startMode: 'select' });
    },
    '/t/:id/set/:field/:value': ctx => viaCodex(ctx, async () => {
      const threadId = ctx.params.id;
      const change = await settingChange(ctx);
      // Send all three, so a new model never keeps an effort it lacks.
      hub.changeSettings(threadId, await store.resolve(change, await threadSettings(threadId, await hub.read(threadId))));
      return ctx.renderPage(`/t/${threadId}/settings`, { startMode: 'select' });
    }),
  },
  tools: {},
  voice: {
    '/t/:id/voice': {
      input: 'text',
      handler: (ctx, speech) => viaCodex(ctx, async () => {
        const threadId = ctx.params.id;
        if (hub.pendingApprovals(threadId).length) throw new AppRequestError(409, text(ctx, 'approvalFirst'));
        // Before the speech ends, so a refusal reaches the device while it records.
        await hub.ensureLoaded(threadId);
        const { transcript } = await speech.done;
        if (!transcript.trim()) throw new AppRequestError(422, text(ctx, 'emptySpeech'));
        await hub.send(threadId, transcript.trim());
      }),
    },
    '/new/:dir/voice': {
      input: 'text',
      handler: (ctx, speech) => viaCodex(ctx, async () => {
        const cwd = await projectFor(ctx);
        const { transcript } = await speech.done;
        if (!transcript.trim()) throw new AppRequestError(422, text(ctx, 'emptySpeech'));
        const threadId = await hub.startTask(cwd, transcript.trim(), await store.forNewTask());
        return ctx.renderPage(`/t/${threadId}`, { startMode: 'read' });
      }),
    },
  },
});
