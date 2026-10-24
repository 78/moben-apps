import { basename } from 'node:path';
import { md } from '@moben-ai/app-sdk';
import type { JsonValue } from './codex';

export type Labels = {
  you: string; edited: string; added: string; deleted: string; declined: string;
  more: string; output: string; compacted: string;
  read: string; search: string; list: string; webSearch: string;
};

const MESSAGE_LIMIT = 1500;
const USER_LIMIT = 300;

export const clip = (value: string, limit: number) =>
  Array.from(value).length > limit ? `${Array.from(value).slice(0, limit).join('')}…` : value;

// Roughly one small-font line at the default text size; wide characters may still wrap.
const STEP_CHARS = 40;

/** The command as typed: without the login-shell wrapper and its quoting. */
export const commandText = (command: unknown) => {
  const line = String(command ?? '');
  const wrapped = line.match(/^\/bin\/(?:ba|z)?sh -lc ([\s\S]*)$/);
  if (!wrapped) return line;
  const body = wrapped[1];
  if (body.startsWith("'") && body.endsWith("'")) return body.slice(1, -1).replace(/'"'"'|'\\''/g, "'");
  if (body.startsWith('"') && body.endsWith('"')) return body.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return body;
};

/**
 * What the user typed, as plain text. The desktop composer turns pasted URLs
 * into [url](url) or <url>; the device shows the label once.
 */
export const userText = (item: JsonValue) => {
  let text = (item.content ?? [])
    .filter((part: JsonValue) => part.type === 'text').map((part: JsonValue) => part.text).join('\n');
  // The desktop records question replies as an internal envelope. Only the
  // user's answers belong on the device, before the normal display limit.
  const reply = text.trim().match(/^<send_user_message_question_reply>([\s\S]*?)(?:<\/send_user_message_question_reply>)?$/);
  if (reply) {
    try {
      const answers: unknown = JSON.parse(reply[1]);
      text = Array.isArray(answers)
        ? answers.flatMap(answer => typeof answer?.answer === 'string' ? [answer.answer] : []).join('\n')
        : '';
    } catch {
      // A malformed internal reply must not expose its payload as user text.
      return '';
    }
  }
  return text
    .replace(/<(https?:\/\/[^\s>]+)>/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .trim();
};

/**
 * Codex writes Markdown; keep it, but drop HTML comments (page metadata and
 * Action Sheet declarations) and links that would act, so repository content
 * cannot forge an approval button.
 */
function safeMarkdown(value: string) {
  return value
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/\]\(\s*(action:|#action-sheet)/gi, '\\]($1');
}

/** Long texts end with a link to the item page. */
function withMore(body: string, limit: number, link: string, label: string) {
  if (Array.from(body).length <= limit) return body;
  return `${clip(body, limit)}\n\n${md.link(label, link)}`;
}

/** Codex's parsed actions read better than the shell line; fall back to it. */
function commandSummary(item: JsonValue, labels: Labels) {
  const actions = (item.commandActions ?? []) as JsonValue[];
  const described = actions.map(action =>
    action.type === 'read' ? `${labels.read} ${action.name ?? basename(String(action.path))}`
      : action.type === 'search' ? `${labels.search} ${action.query ?? action.path ?? ''}`
        : action.type === 'listFiles' ? `${labels.list} ${action.path ? basename(String(action.path)) : '.'}`
          : '');
  if (described.length && described.every(Boolean)) return described.join(' · ');
  return commandText(item.command);
}

// Work steps (commands, edits, tools) are quote lines: the device sets them in
// its small font, and consecutive steps share one block. Symbols used in them
// must exist in the device glyph fonts.
const STEP = '> ';
const isStep = (block: string) => block.startsWith(STEP);

/** Blank line between blocks, except between consecutive steps. */
export const separator = (previous: string, next: string) =>
  !previous || (isStep(previous) && isStep(next)) ? '' : '\n';

// Block starts that a label written in front would turn into plain text.
const BLOCK_START = /^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||```|~~~|<!--|\$\$)/;

/** Puts label before a reply: inline before a paragraph, else on its own line. */
export const labelReply = (label: string, block: string) =>
  `${md.bold(label)}${BLOCK_START.test(block) ? '\n' : ''}${block}`;

/** One item as Markdown, or '' for items not shown. */
export function renderItem(item: JsonValue, labels: Labels, itemUrl: (id: string) => string): string {
  if (item.status === 'inProgress') return '';
  switch (item.type) {
    case 'userMessage': {
      const text = userText(item);
      if (!text) return '';
      const shown = clip(text, USER_LIMIT);
      return `${md.bold(labels.you)}${md.text(shown).replace(/\n+/g, ' ')}`;
    }
    case 'agentMessage': {
      const text = safeMarkdown(String(item.text ?? '').trim());
      return text ? withMore(text, MESSAGE_LIMIT, itemUrl(item.id), labels.more) : '';
    }
    case 'commandExecution': {
      const failed = item.status === 'declined' ? ` ${labels.declined}`
        : typeof item.exitCode === 'number' && item.exitCode !== 0 ? ` ✗ ${item.exitCode}` : '';
      const command = clip(commandSummary(item, labels).replace(/\s+/g, ' '), STEP_CHARS);
      const line = `${STEP}\\> ${md.text(command)}${failed}`;
      return failed && item.aggregatedOutput ? `${line} ${md.link(labels.output, itemUrl(item.id))}` : line;
    }
    case 'fileChange': {
      const changes = (item.changes ?? []) as JsonValue[];
      if (!changes.length) return '';
      const kind = (change: JsonValue) => change.kind?.type === 'add' ? labels.added
        : change.kind?.type === 'delete' ? labels.deleted : labels.edited;
      const names = changes.slice(0, 4).map(change => `${kind(change)} ${basename(String(change.path))}`).join(' · ');
      const rest = changes.length > 4 ? ` +${changes.length - 4}` : '';
      const declined = item.status === 'declined' ? ` ${labels.declined}` : '';
      return `${STEP}${md.text(names)}${rest}${declined}`;
    }
    case 'mcpToolCall':
      return `${STEP}⚙ ${md.text(`${item.server}.${item.tool}`)}`;
    case 'webSearch':
      return item.query ? `${STEP}${md.text(`${labels.webSearch}${clip(String(item.query), STEP_CHARS)}`)}` : '';
    case 'contextCompaction':
      return `${STEP}— ${md.text(labels.compacted)} —`;
    default:
      return '';
  }
}

/** Full text for the item page: agent messages and command output link to it. */
export function renderItemDetail(item: JsonValue): string {
  if (item.type === 'agentMessage') return safeMarkdown(String(item.text ?? ''));
  if (item.type === 'commandExecution') {
    const output = clip(String(item.aggregatedOutput ?? ''), 12000).replace(/```/g, '`\u200b``');
    return `${md.text(commandText(item.command))}\n\n\`\`\`\n${output}\n\`\`\``;
  }
  return '';
}
