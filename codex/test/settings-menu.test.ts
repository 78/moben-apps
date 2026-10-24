import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApp } from '@moben-ai/app-sdk/dist/local';
import { SettingsStore } from '../src/settings';

test('new-task menus keep defaults and changed choices through SDK page validation', async t => {
  // Do not read or overwrite the user's settings, or start a real Codex server.
  t.mock.method(SettingsStore.prototype as any, 'load', () => ({}));
  t.mock.method(SettingsStore.prototype, 'saveForNewTasks', function (this: any, change) {
    this.saved = { ...this.saved, ...change };
  });
  const { app, hub } = await import('../src/app');
  const cwd = process.cwd();
  const models = Array.from({ length: 12 }, (_, index) => ({
    id: `model-${index}`, displayName: `Model ${index}`, isDefault: index === 0,
    supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })),
    defaultReasoningEffort: 'medium', serviceTiers: [{ id: 'priority', name: 'Fast' }],
  }));
  t.mock.method(hub.codex, 'request', async (method: string) => {
    if (method === 'thread/list') return { data: [{ cwd }] };
    if (method === 'model/list') return { data: models };
    if (method === 'config/read') return { config: { model: 'model-2', model_reasoning_effort: 'high', service_tier: 'priority' } };
    throw new Error(`Unexpected Codex request: ${method}`);
  });
  const path = `/new/${Buffer.from(cwd).toString('base64url')}`;
  for (const locale of ['en', 'zh-CN']) {
    const local = new LocalApp(app, { locale });
    const verify = (markdown: string, expected: string[]) => {
      const sheets = markdown.split('\n').filter(line => line.startsWith('<!-- moben:action-sheet '))
        .map(line => JSON.parse(line.slice('<!-- moben:action-sheet '.length, -' -->'.length)));
      assert.equal(sheets.length, 3);
      for (const [index, sheet] of sheets.entries()) {
        assert.ok(sheet.items.length <= 10);
        const selected = sheet.items.filter((item: any) => item.selected);
        assert.equal(selected.length, 1);
        assert.ok(selected[0].url.endsWith(expected[index]), selected[0].url);
        assert.ok(selected[0].text.startsWith('✓ '));
      }
    };
    // Reset saved choices in memory for each locale.
    const initial = await local.action(`${path}/set/model/model-2`, path);
    const defaults = await local.page(path);
    assert.deepEqual(defaults.issues, []);
    verify(defaults.markdown, ['/model/model-2', '/effort/high', '/serviceTier/priority']);
    assert.ok(initial.markdown);
    // The selected model lies beyond the ten-item menu cap; it must stay visible.
    await local.action(`${path}/set/model/model-11`, path);
    const changed = await local.page(path);
    assert.deepEqual(changed.issues, []);
    verify(changed.markdown, ['/model/model-11', '/effort/high', '/serviceTier/priority']);
    await local.action(`${path}/set/effort/low`, path);
    await local.action(`${path}/set/serviceTier/default`, path);
    const other = await local.page(path);
    verify(other.markdown, ['/model/model-11', '/effort/low', '/serviceTier/default']);
    // Restore defaults in memory only for the next locale.
    await local.action(`${path}/set/effort/high`, path);
    await local.action(`${path}/set/serviceTier/priority`, path);
  }
});
