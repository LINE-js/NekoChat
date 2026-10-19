import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { parse } from 'yaml';
import { isRecord } from './guards.js';

export interface LineConfig {
  url: string;
  token: string;
  chats: string[];
  ownMemberIds: Record<string, string>;
  textMaxLength: number;
  sendsPerMinute: number;
  maxPendingPerChat: number;
  maxPendingTotal: number;
}

export interface ClaudeConfig {
  apiKey: string;
  model: string;
  contextTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface Config {
  line: LineConfig;
  claude: ClaudeConfig;
  personalityFile: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConfigError(message);
}


function integer(value: unknown, min: number, max: number, field: string): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max,
    `${field} 必須是 ${min}～${max} 的整數。`);
}

export async function loadConfig(filename = 'config.yaml'): Promise<{ config: Config; system: string }> {
  const path = resolve(filename);
  let file;
  let raw: unknown;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    requireValue(stat.isFile(), '設定檔必須是一般檔案。');
    requireValue(process.platform === 'win32' || (stat.mode & 0o077) === 0,
      '設定檔包含金鑰，請先執行 chmod 600 config.yaml（自訂路徑請替換檔名）。');
    const text = await file.readFile('utf8');
    raw = ['.yaml', '.yml'].includes(extname(path).toLowerCase())
      ? parse(text, { maxAliasCount: 0 })
      : JSON.parse(text);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('無法讀取設定檔：請確認檔案存在、不是符號連結，且為有效 JSON 或 YAML。');
  } finally {
    await file?.close();
  }

  requireValue(isRecord(raw), '設定必須是鍵值物件。');
  const { line, claude, personalityFile } = raw;
  requireValue(isRecord(line) && isRecord(claude), '缺少 line 或 claude 設定。');
  const { url: lineUrl, token, chats } = line;
  let url: URL;
  try {
    if (typeof lineUrl !== 'string') throw new Error();
    url = new URL(lineUrl);
  } catch { throw new ConfigError('line.url 必須是有效的 /api/ws WebSocket URL。'); }
  requireValue(['ws:', 'wss:'].includes(url.protocol) && url.pathname === '/api/ws'
    && !url.username && !url.password && !url.search && !url.hash, 'line.url 必須使用 ws/wss 的 /api/ws，不能夾帶帳密或查詢參數。');
  requireValue(url.protocol === 'wss:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    '非本機 LINE.js 連線必須使用 wss，以免洩漏 Bearer Token。');
  requireValue(typeof token === 'string' && /^[\x21-\x7e]+$/.test(token), '請填入 line.token：由 LINE.js 的 npm run cli -- token 產生。');
  requireValue(Array.isArray(chats) && chats.length > 0
    && chats.every((id: unknown): id is string => typeof id === 'string' && /^[ucrsm][A-Za-z0-9]{10,64}$/.test(id))
    && new Set(chats).size === chats.length, 'line.chats 必須填入不重複的授權聊天室 ID，不能留空。');
  const rawOwnMemberIds: unknown = line.ownMemberIds ?? {};
  const ownMemberIds: Record<string, string> = {};
  const ownMemberError = 'line.ownMemberIds 必須對應授權聊天室與有效的社群成員 ID。';
  requireValue(isRecord(rawOwnMemberIds), ownMemberError);
  for (const [chat, id] of Object.entries(rawOwnMemberIds)) {
    requireValue(chats.includes(chat) && typeof id === 'string' && /^p[A-Za-z0-9]{10,64}$/.test(id), ownMemberError);
    ownMemberIds[chat] = id;
  }
  const textMaxLength = line.textMaxLength ?? 8000;
  const sendsPerMinute = line.sendsPerMinute ?? 20;
  integer(textMaxLength, 2, 8000, 'line.textMaxLength');
  integer(sendsPerMinute, 1, 120, 'line.sendsPerMinute');
  const maxPendingPerChat = line.maxPendingPerChat === undefined ? 50 : line.maxPendingPerChat;
  const maxPendingTotal = line.maxPendingTotal === undefined ? 200 : line.maxPendingTotal;
  integer(maxPendingPerChat, 1, 10000, 'line.maxPendingPerChat');
  integer(maxPendingTotal, 1, 10000, 'line.maxPendingTotal');
  requireValue(maxPendingPerChat <= maxPendingTotal, 'line.maxPendingPerChat 不能大於 line.maxPendingTotal。');
  const { apiKey, model, contextTokens, maxOutputTokens, timeoutMs } = claude;
  requireValue(typeof apiKey === 'string' && /^[\x21-\x7e]+$/.test(apiKey), '請填入 claude.apiKey。');
  requireValue(typeof model === 'string' && model.trim().length > 0, '請填入 claude.model。');
  integer(contextTokens, 1, 100000, 'claude.contextTokens');
  integer(maxOutputTokens, 1, contextTokens - 1, 'claude.maxOutputTokens');
  integer(timeoutMs, 1000, 300000, 'claude.timeoutMs');
  requireValue(typeof personalityFile === 'string' && personalityFile.trim().length > 0,
    '請填入 personalityFile。');
  let system: string;
  try { system = await readFile(resolve(dirname(path), personalityFile), 'utf8'); }
  catch { throw new ConfigError('無法讀取 personalityFile 指定的個性檔案。'); }
  requireValue(system.trim().length > 0, 'personalityFile 不能是空白檔案。');
  const config: Config = {
    line: { url: lineUrl, token, chats, ownMemberIds, textMaxLength, sendsPerMinute, maxPendingPerChat, maxPendingTotal },
    claude: { apiKey, model, contextTokens, maxOutputTokens, timeoutMs },
    personalityFile,
  };
  return { config, system };
}
