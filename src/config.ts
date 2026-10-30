import { access, open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { parse } from 'yaml';
import { isRecord } from './guards.js';

export interface CjkFont {
  file: string;
  /** PostScript name; required for .ttc collections. */
  name?: string;
}

// PDF's built-in fonts have no CJK glyphs and resvg may find no system fonts, so one is embedded.
const CJK_FONT_CANDIDATES: CjkFont[] = [
  // Debian/Ubuntu fonts-noto-cjk, Arch noto-fonts-cjk, Fedora google-noto-sans-cjk-fonts.
  ...[
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/google-noto-sans-cjk-fonts/NotoSansCJK-Regular.ttc',
  ].map(file => ({ file, name: 'NotoSansCJKtc-Regular' })),
  { file: '/System/Library/Fonts/Hiragino Sans GB.ttc', name: 'HiraginoSansGB-W3' },
];

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

/** Shared by both providers; each section has its own budget and deadline. */
export interface ClaudeConfig {
  apiKey: string;
  model: string;
  contextTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface OpenAIConfig extends ClaudeConfig {
  /** Omitted: the model's default effort. */
  reasoningEffort?: string;
  /** Omitted: the project's service tier. `fast` trades a per-token premium for lower latency. */
  serviceTier?: string;
  imageModel: string;
  imageQuality: string;
  /** Image generation takes far longer than a chat turn, so it has its own deadline. */
  imageTimeoutMs: number;
}

export type Provider = 'openai' | 'claude';

export interface Config {
  line: LineConfig;
  /** Primary provider; the other configured provider is the fallback. */
  provider: Provider;
  openai?: OpenAIConfig;
  claude?: ClaudeConfig;
  personalityFile: string;
  /** CJK font embedded into PDFs and used for SVG text; PDFs are unavailable without one. */
  cjkFont?: CjkFont;
}

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const IMAGE_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const SERVICE_TIERS = ['default', 'fast'];

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

function modelConfig(section: Provider, raw: Record<string, unknown>): ClaudeConfig {
  const { apiKey, model, contextTokens, maxOutputTokens, timeoutMs } = raw;
  requireValue(typeof apiKey === 'string' && /^[\x21-\x7e]+$/.test(apiKey), `請填入 ${section}.apiKey。`);
  requireValue(typeof model === 'string' && model.trim().length > 0, `請填入 ${section}.model。`);
  integer(contextTokens, 1, 100000, `${section}.contextTokens`);
  integer(maxOutputTokens, 1, contextTokens - 1, `${section}.maxOutputTokens`);
  integer(timeoutMs, 1000, 300000, `${section}.timeoutMs`);
  return { apiKey, model, contextTokens, maxOutputTokens, timeoutMs };
}

function openAIConfig(raw: Record<string, unknown>): OpenAIConfig {
  const { reasoningEffort, serviceTier, imageModel = 'gpt-image-2.5-flare', imageQuality = 'medium', imageTimeoutMs = 120000 } = raw;
  requireValue(reasoningEffort === undefined || (typeof reasoningEffort === 'string' && REASONING_EFFORTS.includes(reasoningEffort)),
    `openai.reasoningEffort 必須是 ${REASONING_EFFORTS.join('、')} 之一，或省略。`);
  requireValue(serviceTier === undefined || (typeof serviceTier === 'string' && SERVICE_TIERS.includes(serviceTier)),
    `openai.serviceTier 必須是 ${SERVICE_TIERS.join('、')} 之一，或省略。`);
  requireValue(typeof imageModel === 'string' && imageModel.trim().length > 0, 'openai.imageModel 必須是模型名稱。');
  requireValue(typeof imageQuality === 'string' && IMAGE_QUALITIES.includes(imageQuality),
    `openai.imageQuality 必須是 ${IMAGE_QUALITIES.join('、')} 之一。`);
  integer(imageTimeoutMs, 1000, 300000, 'openai.imageTimeoutMs');
  return {
    ...modelConfig('openai', raw),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    imageModel, imageQuality, imageTimeoutMs,
  };
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
  const { line, openai: rawOpenAI, claude: rawClaude, personalityFile, cjkFont: rawCjkFont } = raw;
  requireValue(isRecord(line), '缺少 line 設定。');
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
  requireValue((rawOpenAI === undefined || isRecord(rawOpenAI)) && (rawClaude === undefined || isRecord(rawClaude))
    && (rawOpenAI !== undefined || rawClaude !== undefined), '請設定 openai 或 claude，至少一個。');
  const openai = rawOpenAI === undefined ? undefined : openAIConfig(rawOpenAI);
  const claude = rawClaude === undefined ? undefined : modelConfig('claude', rawClaude);
  // Older configs have only a claude section; it stays the primary without a provider key.
  const provider = raw.provider ?? (openai ? 'openai' : 'claude');
  requireValue((provider === 'openai' && openai) || (provider === 'claude' && claude),
    'provider 必須是 openai 或 claude，且該段設定必須存在。');
  requireValue(typeof personalityFile === 'string' && personalityFile.trim().length > 0,
    '請填入 personalityFile。');
  let system: string;
  try { system = await readFile(resolve(dirname(path), personalityFile), 'utf8'); }
  catch { throw new ConfigError('無法讀取 personalityFile 指定的個性檔案。'); }
  requireValue(system.trim().length > 0, 'personalityFile 不能是空白檔案。');
  const readable = (file: string) => access(file, constants.R_OK).then(() => true, () => false);
  let cjkFont: CjkFont | undefined;
  if (rawCjkFont !== undefined) {
    const fontError = 'cjkFont 必須是 { file, name? }；file 為可讀取的字型檔，字型集合（.ttc／.otc）必須以 name 指定 PostScript 名稱。';
    requireValue(isRecord(rawCjkFont) && typeof rawCjkFont.file === 'string' && rawCjkFont.file.trim().length > 0
      && (rawCjkFont.name === undefined || (typeof rawCjkFont.name === 'string' && rawCjkFont.name.trim().length > 0))
      && (rawCjkFont.name !== undefined || !['.ttc', '.otc'].includes(extname(rawCjkFont.file).toLowerCase())), fontError);
    const file = resolve(dirname(path), rawCjkFont.file);
    requireValue(await readable(file), fontError);
    cjkFont = { file, ...(typeof rawCjkFont.name === 'string' ? { name: rawCjkFont.name } : {}) };
  } else {
    for (const candidate of CJK_FONT_CANDIDATES) {
      if (await readable(candidate.file)) {
        cjkFont = candidate;
        break;
      }
    }
  }
  const config: Config = {
    line: { url: lineUrl, token, chats, ownMemberIds, textMaxLength, sendsPerMinute, maxPendingPerChat, maxPendingTotal },
    provider,
    ...(openai ? { openai } : {}),
    ...(claude ? { claude } : {}),
    personalityFile,
    ...(cjkFont ? { cjkFont } : {}),
  };
  return { config, system };
}
