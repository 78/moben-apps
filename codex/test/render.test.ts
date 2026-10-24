import assert from 'node:assert/strict';
import test from 'node:test';
import { renderItem, userText, type Labels } from '../src/render';

const message = (text: string) => ({ type: 'userMessage', content: [{ type: 'text', text }] });
const envelope = (value: unknown) => `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`;
const labels = { you: '你：' } as Labels;
const render = (text: string) => renderItem(message(text), labels, () => '/unused');

test('approval replies show only the answer before applying the user-message display limit', () => {
  const text = envelope([{
    questionItemId: '["request_user_input_async","call_example",0]',
    question: `${'构建命令说明。'.repeat(100)}是否允许构建并重启？`,
    answer: '允许构建并重启',
  }]);
  assert.equal(userText(message(text)), '允许构建并重启');
  assert.equal(render(text), '**你：**允许构建并重启');
});

test('multiple answers keep user text and drop question identifiers and other internal fields', () => {
  const text = envelope([
    { questionItemId: 'first', question: '选择项目', answer: '当前项目' },
    { questionItemId: 'second', answer: '只更新测试\n暂不发布', metadata: 'internal' },
    { question: 'unanswered', answer: null },
  ]);
  assert.equal(userText(message(text)), '当前项目\n只更新测试\n暂不发布');
  assert.equal(render(text), '**你：**当前项目 只更新测试 暂不发布');
});

test('question envelopes can span text parts and omit a closing tag without leaking payloads', () => {
  const item = { content: [
    { type: 'text', text: '<send_user_message_question_reply>' },
    { type: 'image', url: 'ignored' },
    { type: 'text', text: '[{"answer":"继续"}]' },
    { type: 'text', text: '</send_user_message_question_reply>' },
  ] };
  assert.equal(userText(item), '继续');
  assert.equal(userText(message('<send_user_message_question_reply>\n[{"answer":"继续"}]')), '继续');
});

test('malformed or unanswered internal replies never appear on the device', () => {
  for (const text of [
    envelope({ answer: 'wrong shape' }), envelope([{ question: 'internal', answer: { secret: 'internal' } }]),
    envelope([{ questionItemId: 'internal' }]), envelope([]),
    '<send_user_message_question_reply>not JSON</send_user_message_question_reply>',
    '<send_user_message_question_reply>\n[{"question":"internal"',
  ]) {
    assert.equal(userText(message(text)), '');
    assert.equal(render(text), '');
  }
});

test('ordinary user prose, JSON, XML and quoted code remain unchanged', () => {
  for (const text of [
    '请修一下渲染问题。', '[{"answer":"这是用户自己写的 JSON"}]', '<note>保留这段文字</note>',
    '解释一下 <send_user_message_question_reply> 这个标签。',
    '```xml\n<send_user_message_question_reply>\n[{"answer":"示例"}]\n</send_user_message_question_reply>\n```',
  ]) assert.equal(userText(message(text)), text);
  assert.equal(userText(message('链接 <https://example.com> 和 [文档](https://example.com/docs)')), '链接 https://example.com 和 文档');
});

test('answer text still receives normal Markdown escaping', () => {
  const shown = render(envelope([{ answer: '[删除](action:/apps/local.codex/delete)' }]));
  assert.doesNotMatch(shown, /(?<!\\)\[删除\]\(action:/);
  assert.ok(shown.includes('删除'));
  assert.doesNotMatch(shown, /questionItemId|send_user_message_question_reply/);
});
