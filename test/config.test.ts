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
