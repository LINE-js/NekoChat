import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { parse } from 'yaml';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireValue(condition, message) {
  if (!condition) throw new ConfigError(message);
}

function integer(value, min, max, field) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max,
    `${field} 必須是 ${min}～${max} 的整數。`);
}

export async function loadConfig(filename = 'config.yaml') {
  const path = resolve(filename);
  let file;
  let config;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    requireValue(stat.isFile(), '設定檔必須是一般檔案。');
    requireValue(process.platform === 'win32' || (stat.mode & 0o077) === 0,
      '設定檔包含金鑰，請先執行 chmod 600 config.yaml（自訂路徑請替換檔名）。');
    const text = await file.readFile('utf8');
    config = ['.yaml', '.yml'].includes(extname(path).toLowerCase())
      ? parse(text, { maxAliasCount: 0 })
      : JSON.parse(text);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('無法讀取設定檔：請確認檔案存在、不是符號連結，且為有效 JSON 或 YAML。');
  } finally {
    await file?.close();
  }

  requireValue(config && typeof config === 'object' && !Array.isArray(config), '設定必須是鍵值物件。');
  const { line, claude } = config;
  requireValue(line && typeof line === 'object' && claude && typeof claude === 'object', '缺少 line 或 claude 設定。');
  let url;
  try { url = new URL(line.url); } catch { throw new ConfigError('line.url 必須是有效的 /api/ws WebSocket URL。'); }
  requireValue(['ws:', 'wss:'].includes(url.protocol) && url.pathname === '/api/ws'
    && !url.username && !url.password && !url.search && !url.hash, 'line.url 必須使用 ws/wss 的 /api/ws，不能夾帶帳密或查詢參數。');
  requireValue(url.protocol === 'wss:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    '非本機 LINE.js 連線必須使用 wss，以免洩漏 Bearer Token。');
  requireValue(typeof line.token === 'string' && /^[\x21-\x7e]+$/.test(line.token), '請填入 line.token：由 LINE.js 的 npm run cli -- token 產生。');
  requireValue(Array.isArray(line.chats) && line.chats.length > 0
    && line.chats.every(id => typeof id === 'string' && /^[ucrsm][A-Za-z0-9]{10,64}$/.test(id))
    && new Set(line.chats).size === line.chats.length, 'line.chats 必須填入不重複的授權聊天室 ID，不能留空。');
  line.ownMemberIds ??= {};
  requireValue(line.ownMemberIds && typeof line.ownMemberIds === 'object' && !Array.isArray(line.ownMemberIds)
    && Object.entries(line.ownMemberIds).every(([chat, id]) => line.chats.includes(chat)
      && typeof id === 'string' && /^p[A-Za-z0-9]{10,64}$/.test(id)), 'line.ownMemberIds 必須對應授權聊天室與有效的社群成員 ID。');
  line.textMaxLength ??= 8000;
  line.sendsPerMinute ??= 20;
  integer(line.textMaxLength, 2, 8000, 'line.textMaxLength');
  integer(line.sendsPerMinute, 1, 120, 'line.sendsPerMinute');
  requireValue(typeof claude.apiKey === 'string' && /^[\x21-\x7e]+$/.test(claude.apiKey), '請填入 claude.apiKey。');
  requireValue(typeof claude.model === 'string' && claude.model.trim().length > 0, '請填入 claude.model。');
  integer(claude.contextTokens, 1, 100000, 'claude.contextTokens');
  integer(claude.maxOutputTokens, 1, claude.contextTokens - 1, 'claude.maxOutputTokens');
  integer(claude.timeoutMs, 1000, 300000, 'claude.timeoutMs');
  requireValue(typeof config.personalityFile === 'string' && config.personalityFile.trim().length > 0,
    '請填入 personalityFile。');
  let system;
  try { system = await readFile(resolve(dirname(path), config.personalityFile), 'utf8'); }
  catch { throw new ConfigError('無法讀取 personalityFile 指定的個性檔案。'); }
  requireValue(system.trim().length > 0, 'personalityFile 不能是空白檔案。');
  return { config, system };
}
