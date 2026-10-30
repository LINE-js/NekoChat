import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nekochat-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'config.json');
  await writeFile(join(directory, 'personality.md'), '使用繁體中文；個性參考。');
  const config = {
    line: { url: 'ws://127.0.0.1:3789/api/ws', token: 'local-test-token', chats: ['c0123456789abcdef'] },
    claude: { apiKey: 'private-test-value', model: 'test-model', contextTokens: 100000, maxOutputTokens: 4096, timeoutMs: 60000 },
    personalityFile: 'personality.md',
  };
  const save = () => writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  await save();
  return { directory, filename, config, save };
}

test('refuses missing or empty personality files', async t => {
  const { directory, filename } = await fixture(t);
  await writeFile(join(directory, 'personality.md'), '   ');
  await assert.rejects(loadConfig(filename), /personalityFile/);
  await rm(join(directory, 'personality.md'));
  await assert.rejects(loadConfig(filename), /personalityFile/);
});

test('refuses empty authorization scope and token without exposing credentials', async t => {
  const { filename, config, save } = await fixture(t);
  config.line.chats = [];
  await save();
  await assert.rejects(loadConfig(filename), (error: unknown) => error instanceof Error && /line.chats/.test(error.message) && !error.message.includes(config.claude.apiKey));
  config.line.token = '';
  await save();
  await assert.rejects(loadConfig(filename), /line.token/);
});

test('rejects token budget above 100K and output that consumes the whole window', async t => {
  const { filename, config, save } = await fixture(t);
  config.claude.contextTokens = 100001;
  await save();
  await assert.rejects(loadConfig(filename), /contextTokens/);
  config.claude.contextTokens = 100000;
  config.claude.maxOutputTokens = 100000;
  await save();
  await assert.rejects(loadConfig(filename), /maxOutputTokens/);
});

test('refuses cleartext remote credentials and non-bot endpoints', async t => {
  const { filename, config, save } = await fixture(t);
  for (const url of ['ws://example.com/api/ws', 'wss://example.com/ws', 'wss://example.com/api/ws?token=secret']) {
    config.line.url = url;
    await save();
    await assert.rejects(loadConfig(filename), /line.url|wss/);
  }
});

test('refuses symlink and group-readable credential files', { skip: process.platform === 'win32' }, async t => {
  const { directory, filename } = await fixture(t);
  const link = join(directory, 'linked.json');
  await symlink(filename, link);
  await assert.rejects(loadConfig(link), /符號連結/);
  await chmod(filename, 0o640);
  await assert.rejects(loadConfig(filename), /chmod 600/);
});


test('queue limits accept inclusive boundaries and reject invalid values or ordering', async t => {
  const { filename, config, save } = await fixture(t);
  const line: Record<string, unknown> = config.line;
  for (const value of [1, 10000]) {
    line.maxPendingPerChat = value;
    line.maxPendingTotal = value;
    await save();
    const loaded = await loadConfig(filename);
    assert.equal(loaded.config.line.maxPendingPerChat, value);
    assert.equal(loaded.config.line.maxPendingTotal, value);
  }
  for (const field of ['maxPendingPerChat', 'maxPendingTotal']) {
    for (const value of [0, -1, 10001, 1.5, '50', null, true]) {
      line.maxPendingPerChat = 50;
      line.maxPendingTotal = 200;
      line[field] = value;
      await save();
      await assert.rejects(loadConfig(filename), new RegExp(`line.${field}`));
    }
  }
  line.maxPendingPerChat = 201;
  line.maxPendingTotal = 200;
  await save();
  await assert.rejects(loadConfig(filename), /maxPendingPerChat.*maxPendingTotal/);
});

test('cjkFont resolves relative to the config and rejects unreadable files or unnamed collections', async t => {
  const { directory, filename, config, save } = await fixture(t);
  const raw: Record<string, unknown> = config;
  await writeFile(join(directory, 'font.ttf'), 'x');
  await writeFile(join(directory, 'fonts.ttc'), 'x');
  raw.cjkFont = { file: 'font.ttf' };
  await save();
  assert.deepEqual((await loadConfig(filename)).config.cjkFont, { file: join(directory, 'font.ttf') });
  raw.cjkFont = { file: 'fonts.ttc', name: 'Family-Regular' };
  await save();
  assert.deepEqual((await loadConfig(filename)).config.cjkFont, { file: join(directory, 'fonts.ttc'), name: 'Family-Regular' });
  for (const value of [{ file: 'fonts.ttc' }, { file: 'missing.ttf' }, { file: 'font.ttf', name: '' }, 'font.ttf']) {
    raw.cjkFont = value;
    await save();
    await assert.rejects(loadConfig(filename), /cjkFont/);
  }
});

test('provider picks the primary section, defaults keep old Claude configs, and OpenAI options are validated', async t => {
  const { filename, config, save } = await fixture(t);
  const raw: Record<string, unknown> = config;
  const section = config.claude;
  assert.equal((await loadConfig(filename)).config.provider, 'claude');
  raw.openai = { ...section, apiKey: 'private-openai-value', model: 'gpt-6-luna' };
  await save();
  const loaded = (await loadConfig(filename)).config;
  assert.equal(loaded.provider, 'openai');
  assert.deepEqual([loaded.openai?.imageModel, loaded.openai?.imageQuality, loaded.openai?.imageTimeoutMs, loaded.openai?.reasoningEffort],
    ['gpt-image-2.5-flare', 'medium', 120000, undefined]);
  raw.provider = 'claude';
  await save();
  assert.equal((await loadConfig(filename)).config.provider, 'claude');
  delete raw.claude;
  await save();
  await assert.rejects(loadConfig(filename), /provider/);
  for (const [field, value] of [['reasoningEffort', 'fast'], ['serviceTier', 'priority'], ['imageQuality', 'ultra'], ['imageTimeoutMs', 0], ['apiKey', '']] as const) {
    raw.provider = 'openai';
    raw.openai = { ...section, model: 'gpt-6-luna', [field]: value };
    await save();
    await assert.rejects(loadConfig(filename), (error: unknown) => error instanceof Error && error.message.includes(`openai.${field}`)
      && !error.message.includes(section.apiKey));
  }
  delete raw.openai;
  await save();
  await assert.rejects(loadConfig(filename), /openai 或 claude/);
});
