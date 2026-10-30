import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { LineConfig, CjkFont } from './config.js';
import type { ChatEngineLike, DrawnImage } from './chat.js';
import { isRecord } from './guards.js';
import { renderSvg } from './image.js';
import { renderPdf } from './document.js';

export interface LineMessage {
  channelId: string;
  messageId: string;
  senderId: string;
  text: string;
  contentType: string;
  channelKind?: unknown;
  senderName?: unknown;
  mentions?: unknown;
  replyTo?: unknown;
  unsent?: unknown;
  decryptFailed?: unknown;
}

export type LineRequest =
  | { type: 'ping' | 'pong' }
  | { type: 'chat:admins:get'; requestId: string; chatId: string }
  | { type: 'history:fetch'; requestId: string; chatId: string; limit: number; before?: string }
  | { type: 'message:send'; requestId: string; chatId: string; text: string; replyTo: string }
  | { type: 'message:send'; requestId: string; chatId: string; mediaId: string }
  | { type: 'chat:admin-token:consume'; requestId: string; chatId: string; token: string };

export interface SentEvent {
  type: 'sent';
  requestId: string;
  messageId?: unknown;
}

export interface AdminsEvent {
  type: 'chat:admins';
  requestId: string;
  chatId?: unknown;
  ownMemberId?: unknown;
}

interface HistoryEvent {
  type: 'history';
  requestId: string;
  chatId?: unknown;
  messages?: unknown;
  hasMore?: unknown;
  cursor?: unknown;
}

interface ConsumedEvent {
  type: 'chat:admin-token:consumed';
  requestId: string;
  chatId?: unknown;
}

type ResponseEvent = SentEvent | AdminsEvent | HistoryEvent | ConsumedEvent;
type PendingRequest = {
  type: ResponseEvent['type'];
  chatId: string;
  resolve(event: ResponseEvent): void;
  reject(error: Error): void;
};

interface WaitingMessage {
  message: LineMessage;
  queue: MessageQueue;
  /** Current admin token found in the text; ownership is proven only by consuming it. */
  token?: string;
  /** Certainly not addressed to the bot: only a followup judgement could answer it. */
  ambient: boolean;
}

interface MessageQueue {
  chatId: string;
  waiting: WaitingMessage[];
  active?: AbortController;
}

export type LineEvent =
  | { type: 'ping' | 'pong' }
  | { type: 'hello'; protocol?: unknown; capabilities?: unknown }
  | { type: 'auth:state'; state?: unknown }
  | { type: 'auth:ready'; profile?: unknown }
  | { type: 'sent' | 'chat:admins' | 'error'; requestId?: unknown; messageId?: unknown; chatId?: unknown; ownMemberId?: unknown }
  | { type: 'history'; requestId?: unknown; chatId?: unknown; messages?: unknown; hasMore?: unknown; cursor?: unknown }
  | { type: 'channels'; channels?: unknown }
  | { type: 'message'; message?: unknown }
  | { type: 'message:edit'; message?: unknown }
  | { type: 'message:unsend'; chatId?: unknown; messageId?: unknown }
  | { type: 'chat:admin-token'; requestId?: unknown; chatId?: unknown; token?: unknown }
  | { type: 'chat:admin-token:consumed'; requestId?: unknown; chatId?: unknown }
  | { type: 'chat:admin-token:changed'; chatId?: unknown };

function isLineEvent(value: unknown): value is LineEvent {
  if (value === null || typeof value !== 'object' || !('type' in value)) return false;
  switch (value.type) {
    case 'ping': case 'pong': case 'hello': case 'auth:state': case 'auth:ready':
    case 'sent': case 'chat:admins': case 'history': case 'error': case 'channels':
    case 'message': case 'message:edit': case 'message:unsend':
    case 'chat:admin-token': case 'chat:admin-token:consumed': case 'chat:admin-token:changed':
      return true;
    default:
      return false;
  }
}

function isMessage(value: unknown): value is LineMessage {
  return value !== null && typeof value === 'object' &&
    'channelId' in value && typeof value.channelId === 'string' &&
    'messageId' in value && typeof value.messageId === 'string' &&
    'senderId' in value && typeof value.senderId === 'string' &&
    'text' in value && typeof value.text === 'string' &&
    'contentType' in value && typeof value.contentType === 'string';
}

const REQUEST_TIMEOUT = 15_000;
const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;
const DEDUP_LIMIT = 10_000;
const ADMIN_TOKEN = /^chatadm_[A-Za-z0-9_-]{43}$/;

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function codeOf(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

const MEDIA_NOTICES: Record<string, string> = {
  image_unavailable: '目前無法傳送圖片。',
  image_unsafe: '這張圖沒有畫成功，請換個說法再試一次。',
  image_invalid: '這張圖沒有畫成功，請換個說法再試一次。',
  image_failed: '圖片沒有送出成功，請稍後再試。',
  image_rejected: '這張圖沒辦法畫，請換個主題或說法。',
  file_unavailable: '目前無法傳送檔案。',
  pdf_unavailable: '目前無法產生 PDF，可以改用 txt 或 md。',
  file_invalid: '檔案格式有誤，沒有送出。',
  file_failed: '檔案沒有送出成功，請稍後再試。',
  file_write_failed: '檔案沒有寫成功，請稍後再試。',
};

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(failure('cancelled'));
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(failure('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function splitText(text: string, maximum: number): string[] {
  if (typeof text !== 'string' || !text.trim()) throw failure('invalid_reply');
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maximum, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    if (end < text.length && !text.slice(end).trim()) {
      let lastContent = end - 1;
      while (lastContent >= offset && !text[lastContent].trim()) lastContent--;
      if (lastContent > offset && /[\uDC00-\uDFFF]/.test(text[lastContent]) && /[\uD800-\uDBFF]/.test(text[lastContent - 1])) lastContent--;
      if (lastContent <= offset || text.length - lastContent > maximum) throw failure('invalid_reply');
      end = lastContent;
    }
    if (end <= offset) throw failure('invalid_reply');
    const chunk = text.slice(offset, end);
    if (!chunk.trim()) throw failure('invalid_reply');
    chunks.push(chunk);
    offset = end;
  }
  return chunks;
}

export class ChatBot {
  config: { line: LineConfig; cjkFont?: CjkFont };
  engine: ChatEngineLike;
  log: (code: string) => void;
  allowed: Set<string>;
  pending: Map<string, PendingRequest>;
  identities: Map<string, string | Promise<string>>;
  jobs: Map<string, MessageQueue>;
  /** Media still uploading after its turn released the chat queue; sent in turn order per chat. */
  deliveries: Map<string, { tail: Promise<void>; controllers: Set<AbortController> }>;
  waiting: Set<WaitingMessage>;
  outstanding: number;
  seen: Map<string, boolean>;
  engaged: Set<string>;
  referenceAuthors: Map<string, { chatId: string; own: boolean }>;
  adminTokens: Map<string, string>;
  rateQueue: Promise<void>;
  lastSend: number;
  sendTimes: number[];
  queryQueue: Promise<void>;
  queryTimes: number[];
  stopped: boolean;
  started: boolean;
  ready: boolean;
  protocolReady: boolean;
  capabilities: Set<unknown>;
  closed: Promise<void>;
  resolveClosed: () => void;
  socket: WebSocket | undefined;
  heartbeat: NodeJS.Timeout | undefined;
  heartbeatDeadline: NodeJS.Timeout | undefined;
  reconnectTimer: NodeJS.Timeout | undefined;
  userId: string | undefined;
  channels: Set<string> | undefined;
  constructor({ config, engine, log = () => {} }: {
    config: { line: LineConfig; cjkFont?: CjkFont }; engine: ChatEngineLike; log?: (code: string) => void;
  }) {
    this.config = config;
    this.engine = engine;
    this.log = log;
    this.allowed = new Set(config.line.chats);
    this.pending = new Map();
    this.identities = new Map();
    this.jobs = new Map();
    this.deliveries = new Map();
    this.waiting = new Set();
    this.outstanding = 0;
    this.seen = new Map();
    this.engaged = new Set();
    this.referenceAuthors = new Map();
    this.adminTokens = new Map();
    this.rateQueue = Promise.resolve();
    this.lastSend = 0;
    this.sendTimes = [];
    this.queryQueue = Promise.resolve();
    this.queryTimes = [];
    this.stopped = false;
    this.started = false;
    this.ready = false;
    this.protocolReady = false;
    this.capabilities = new Set();
    let resolveClosed: () => void = () => {};
    this.closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    this.resolveClosed = resolveClosed;
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    let socket;
    try {
      socket = new WebSocket(this.config.line.url, {
        headers: { Authorization: `Bearer ${this.config.line.token}` },
        maxPayload: 1024 * 1024,
        handshakeTimeout: 10_000,
      });
    } catch {
      this.disconnect('connection_error');
      return;
    }
    this.socket = socket;
    const current = () => !this.stopped && this.socket === socket;
    socket.on('open', () => {
      if (!current()) return;
      this.log('connected');
      this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_INTERVAL);
    });
    socket.on('message', data => {
      if (!current()) return;
      try {
        this.receive(JSON.parse(data.toString()));
      } catch {
        this.log('invalid_frame');
      }
    });
    socket.on('error', () => {
      if (current()) this.disconnect('connection_error');
    });
    socket.on('close', () => {
      if (current()) this.disconnect('disconnected');
    });
  }

  disconnect(code: string): void {
    if (this.stopped) return;
    this.log(code);
    this.cleanupConnection();
    if (this.reconnectTimer) return;
    this.log('reconnect_scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 10_000);
  }

  cleanupConnection() {
    clearInterval(this.heartbeat);
    clearTimeout(this.heartbeatDeadline);
    this.heartbeat = undefined;
    this.heartbeatDeadline = undefined;
    this.protocolReady = false;
    this.capabilities.clear();
    this.invalidateAll();
    this.queryTimes = [];
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.cleanupConnection();
    this.seen.clear();
    this.log('stopped');
    this.resolveClosed();
  }

  invalidateAll() {
    this.ready = false;
    this.userId = undefined;
    this.channels = undefined;
    for (const chatId of [...this.jobs.keys(), ...this.deliveries.keys()]) this.cancelChat(chatId);
    this.identities.clear();
    this.engaged.clear();
    this.referenceAuthors.clear();
    this.adminTokens.clear();
    for (const request of [...this.pending.values()]) request.reject(failure('cancelled'));
    this.engine.clearAll();
  }

  cancelChat(chatId: string): void {
    const queue = this.jobs.get(chatId);
    if (queue) {
      this.jobs.delete(chatId);
      for (const entry of queue.waiting) this.waiting.delete(entry);
      this.outstanding -= queue.waiting.length + (queue.active ? 1 : 0);
      queue.waiting.length = 0;
      if (queue.active) queue.active.abort();
    }
    const delivery = this.deliveries.get(chatId);
    if (delivery) {
      this.deliveries.delete(chatId);
      for (const controller of delivery.controllers) controller.abort();
    }
    for (const request of [...this.pending.values()]) {
      if (request.chatId === chatId) request.reject(failure('cancelled'));
    }
    this.engine.clear(chatId);
    this.engaged.delete(chatId);
    this.identities.delete(chatId);
  }

  rememberAuthor(chatId: string, messageId: unknown, own: boolean): void {
    if (typeof messageId !== 'string' || !messageId) return;
    const key = JSON.stringify([chatId, messageId]);
    this.referenceAuthors.delete(key);
    this.referenceAuthors.set(key, { chatId, own });
    if (this.referenceAuthors.size > DEDUP_LIMIT) {
      const oldest = this.referenceAuthors.keys().next();
      if (!oldest.done) this.referenceAuthors.delete(oldest.value);
    }
  }

  knownAuthor(chatId: string, messageId: string): boolean | undefined {
    const key = JSON.stringify([chatId, messageId]);
    const author = this.referenceAuthors.get(key);
    if (author) {
      // Active references should survive unrelated traffic in busy chats.
      this.referenceAuthors.delete(key);
      this.referenceAuthors.set(key, author);
    }
    return author?.own;
  }

  isDirect(message: LineMessage, ownId: string): boolean {
    if (message.text.includes('語喵')) return true;
    if (Array.isArray(message.mentions) && message.mentions.some((mention: unknown) =>
      mention !== null && typeof mention === 'object' &&
      'userId' in mention && mention.userId === ownId &&
      'start' in mention && 'end' in mention &&
      typeof mention.start === 'number' && typeof mention.end === 'number' &&
      Number.isInteger(mention.start) && Number.isInteger(mention.end) &&
      mention.start >= 0 && mention.end > mention.start && mention.end <= message.text.length &&
      message.text[mention.start] === '@'
    )) return true;
    return typeof message.replyTo === 'string' &&
      this.knownAuthor(message.channelId, message.replyTo) === true;
  }

  async isHistoricalReply(message: LineMessage, ownId: string, signal: AbortSignal): Promise<boolean> {
    if (typeof message.replyTo !== 'string' || !message.replyTo) return false;
    const cached = this.knownAuthor(message.channelId, message.replyTo);
    if (cached !== undefined) return cached;
    const cursors = new Set<string>();
    let before: string | undefined;
    while (!signal.aborted) {
      const page = await this.request('history:fetch', {
        chatId: message.channelId, limit: 100, ...(before ? { before } : {}),
      }, 'history', signal);
      if (signal.aborted || !this.ready || (this.channels && !this.channels.has(message.channelId))) return false;
      if (page.type !== 'history' || page.chatId !== message.channelId ||
          !Array.isArray(page.messages) || typeof page.hasMore !== 'boolean') throw failure('invalid_history');
      for (const entry of page.messages) {
        if (!isRecord(entry) || entry.channelId !== message.channelId ||
            typeof entry.messageId !== 'string' || !entry.messageId.trim()) continue;
        if (entry.unsent) {
          this.referenceAuthors.delete(JSON.stringify([message.channelId, entry.messageId]));
        } else if (typeof entry.senderId === 'string' && entry.senderId.trim()) {
          this.rememberAuthor(message.channelId, entry.messageId, entry.senderId === ownId);
        }
      }
      const target: unknown = page.messages.find((entry: unknown) =>
        isRecord(entry) && entry.channelId === message.channelId && entry.messageId === message.replyTo);
      if (isRecord(target)) {
        return typeof target.senderId === 'string' && target.senderId === ownId && !target.unsent;
      }
      if (!page.hasMore) return false;
      if (typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor)) throw failure('invalid_history');
      before = page.cursor;
      cursors.add(before);
    }
    return false;
  }

  ping() {
    if (this.stopped || this.heartbeatDeadline) return;
    try {
      this.send({ type: 'ping' });
      this.heartbeatDeadline = setTimeout(() => {
        this.disconnect('heartbeat_timeout');
      }, HEARTBEAT_TIMEOUT);
    } catch {
      this.disconnect('connection_error');
    }
  }

  receive(event: unknown): void {
    if (this.stopped) return;
    if (!isLineEvent(event)) return;
    if (event.type === 'pong') {
      clearTimeout(this.heartbeatDeadline);
      this.heartbeatDeadline = undefined;
      return;
    }
    if (event.type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (event.type === 'hello') {
      if (event.protocol !== 2) {
        this.disconnect('unsupported_protocol');
        return;
      }
      this.protocolReady = true;
      this.capabilities = new Set(Array.isArray(event.capabilities) ? event.capabilities : []);
      return;
    }
    if (event.type === 'auth:state') {
      if (event.state !== 'ready') {
        this.invalidateAll();
        this.log('authentication_not_ready');
      }
      return;
    }
    if (event.type === 'auth:ready') {
      if (!this.protocolReady || !event.profile || typeof event.profile !== 'object' ||
          !('userId' in event.profile) || typeof event.profile.userId !== 'string' || !event.profile.userId) return;
      if (this.userId && this.userId !== event.profile.userId) this.invalidateAll();
      this.userId = event.profile.userId;
      this.ready = true;
      this.log('ready');
      return;
    }
    if (event.type === 'sent' || event.type === 'chat:admins' || event.type === 'history' ||
        event.type === 'chat:admin-token:consumed' || event.type === 'error') {
      if (typeof event.requestId !== 'string') return;
      const pending = this.pending.get(event.requestId);
      if (!pending) return;
      if (event.type === 'error') pending.reject(failure('line_request_failed'));
      else if (event.type === pending.type) {
        if (event.type === 'sent') this.rememberAuthor(pending.chatId, event.messageId, true);
        pending.resolve(event as ResponseEvent);
      }
      return;
    }
    if (event.type === 'chat:admin-token') {
      // Pushed frames carry no requestId; replacements arrive this way after each consumption.
      if (event.requestId === undefined && typeof event.chatId === 'string' && this.allowed.has(event.chatId) &&
          typeof event.token === 'string' && ADMIN_TOKEN.test(event.token)) {
        this.adminTokens.set(event.chatId, event.token);
      }
      return;
    }
    if (event.type === 'chat:admin-token:changed') {
      if (typeof event.chatId === 'string') this.adminTokens.delete(event.chatId);
      return;
    }
    if (event.type === 'channels' && Array.isArray(event.channels)) {
      const next = new Set(event.channels.flatMap((channel: unknown) =>
        channel !== null && typeof channel === 'object' && 'channelId' in channel &&
        typeof channel.channelId === 'string' ? [channel.channelId] : []));
      for (const chatId of new Set([...(this.channels ?? []), ...this.jobs.keys(), ...this.engaged,
        ...Array.from(this.referenceAuthors.values(), author => author.chatId)])) {
        if (!next.has(chatId)) this.cancelChat(chatId);
      }
      for (const chatId of this.adminTokens.keys()) if (!next.has(chatId)) this.adminTokens.delete(chatId);
      // Purge once rather than rescanning every author for each removed chat.
      for (const [key, author] of this.referenceAuthors) {
        if (!next.has(author.chatId)) this.referenceAuthors.delete(key);
      }
      this.channels = next;
      return;
    }
    if (!this.ready) return;
    if (event.type === 'message:edit' || event.type === 'message:unsend') {
      const changedMessage = event.type === 'message:edit' && event.message !== null &&
        typeof event.message === 'object' ? event.message : undefined;
      const chatId = event.type === 'message:edit'
        ? changedMessage && 'channelId' in changedMessage ? changedMessage.channelId : undefined
        : event.chatId;
      if (typeof chatId === 'string' && this.allowed.has(chatId)) {
        const messageId = event.type === 'message:edit'
          ? changedMessage && 'messageId' in changedMessage ? changedMessage.messageId : undefined
          : event.messageId;
        if (event.type === 'message:unsend' || (changedMessage && 'unsent' in changedMessage && changedMessage.unsent)) {
          this.referenceAuthors.delete(JSON.stringify([chatId, messageId]));
        }
        this.cancelChat(chatId);
      }
      return;
    }
    if (event.type !== 'message') return;
    const message = event.message;
    // Withdrawn snapshots may omit text or sender fields.
    if (isRecord(message) && typeof message.channelId === 'string' && typeof message.messageId === 'string' &&
        message.unsent && this.allowed.has(message.channelId)) {
      this.referenceAuthors.delete(JSON.stringify([message.channelId, message.messageId]));
      this.cancelChat(message.channelId);
      return;
    }
    if (!isMessage(message) || !this.allowed.has(message.channelId) || (this.channels && !this.channels.has(message.channelId))) return;
    // LINE.js normalizes text content type 0 to NONE, not TEXT.
    if (message.contentType !== 'NONE' || typeof message.text !== 'string' || !message.text.trim() || message.decryptFailed) return;
    if (typeof message.messageId !== 'string' || !message.messageId || typeof message.senderId !== 'string' || !message.senderId) return;
    const key = JSON.stringify([message.channelId, message.messageId]);
    if (this.seen.has(key)) return;
    this.seen.set(key, true);
    const oldest = this.seen.keys().next();
    if (this.seen.size > DEDUP_LIMIT && !oldest.done) this.seen.delete(oldest.value);
    const ownId = message.channelKind === 'square'
      ? this.config.line.ownMemberIds?.[message.channelId] ?? this.identities.get(message.channelId)
      : this.userId;
    if (typeof ownId === 'string') {
      this.rememberAuthor(message.channelId, message.messageId, message.senderId === ownId);
      if (message.senderId === ownId) return;
    }
    const adminToken = this.adminTokens.get(message.channelId);
    const token = adminToken && message.text.includes(adminToken) ? adminToken : undefined;
    const direct = token !== undefined ||
      (typeof ownId === 'string' ? this.isDirect(message, ownId) : message.text.includes('語喵'));
    const maybeReply = typeof message.replyTo === 'string' && message.replyTo !== '' &&
      this.knownAuthor(message.channelId, message.replyTo) !== false;
    // Pending work may engage the chat before this message is processed.
    if (!direct && !maybeReply && !this.engaged.has(message.channelId) && !this.jobs.has(message.channelId) &&
        !(typeof ownId !== 'string' && Array.isArray(message.mentions) && message.mentions.length > 0)) return;
    this.enqueue(message, token, direct, !direct && !maybeReply && typeof ownId === 'string');
  }

  enqueue(message: LineMessage, token: string | undefined, direct: boolean, ambient: boolean): void {
    if (this.stopped || !this.ready) return;
    const chatId = message.channelId;
    let queue = this.jobs.get(chatId);
    // Someone calling the bot should not wait behind chatter that most likely needs no answer.
    if (direct && queue) {
      for (let index = queue.waiting.length - 1; index >= 0; index--) {
        const entry = queue.waiting[index];
        if (!entry.ambient) continue;
        queue.waiting.splice(index, 1);
        this.waiting.delete(entry);
        this.outstanding--;
        this.log('queue_superseded');
      }
    }
    let victim: WaitingMessage | undefined;
    const chatCount = queue ? queue.waiting.length + (queue.active ? 1 : 0) : 0;
    if (chatCount >= this.config.line.maxPendingPerChat) {
      victim = queue?.waiting[0];
      if (!victim) {
        this.log('queue_full');
        return;
      }
    }
    if (!victim && this.outstanding >= this.config.line.maxPendingTotal) {
      victim = this.waiting.values().next().value;
      if (!victim) {
        this.log('queue_full');
        return;
      }
    }
    // Choose a viable admission before removing any existing payload.
    if (victim) {
      victim.queue.waiting.splice(victim.queue.waiting.indexOf(victim), 1);
      this.waiting.delete(victim);
      this.outstanding--;
      this.log('queue_evicted');
    }
    if (!queue) {
      queue = { chatId, waiting: [] };
      this.jobs.set(chatId, queue);
    }
    const entry: WaitingMessage = { message, queue, ambient, ...(token ? { token } : {}) };
    queue.waiting.push(entry);
    this.waiting.add(entry);
    this.outstanding++;
    this.processNext(queue);
  }

  processNext(queue: MessageQueue): void {
    if (queue.active || this.jobs.get(queue.chatId) !== queue) return;
    const entry = queue.waiting.shift();
    if (!entry) {
      this.jobs.delete(queue.chatId);
      return;
    }
    this.waiting.delete(entry);
    const controller = new AbortController();
    queue.active = controller;
    void this.reply(entry.message, controller, entry.token).catch((error: unknown) => {
      if (!controller.signal.aborted) this.log(codeOf(error) === 'identity_unavailable' ? 'identity_unavailable' : 'reply_failed');
    }).finally(() => {
      queue.active = undefined;
      // A cancelled owner must not release slots or remove a replacement queue.
      if (this.jobs.get(queue.chatId) !== queue) return;
      this.outstanding--;
      this.processNext(queue);
    });
  }

  async ownId(message: LineMessage, signal: AbortSignal): Promise<string | undefined> {
    if (message.channelKind !== 'square') return this.userId;
    const configured = this.config.line.ownMemberIds?.[message.channelId];
    if (configured) return configured;
    if (!this.capabilities.has('chat:admins')) throw failure('identity_unavailable');
    let identity = this.identities.get(message.channelId);
    if (!identity) {
      identity = this.request('chat:admins:get', { chatId: message.channelId }, 'chat:admins', signal).then(event => {
        if (event.type !== 'chat:admins' || event.chatId !== message.channelId || typeof event.ownMemberId !== 'string' || !event.ownMemberId) throw failure('identity_unavailable');
        if (this.identities.get(message.channelId) === identity) {
          this.identities.set(message.channelId, event.ownMemberId);
        }
        return event.ownMemberId;
      });
      this.identities.set(message.channelId, identity);
      identity.catch(() => {
        if (this.identities.get(message.channelId) === identity) this.identities.delete(message.channelId);
      });
    }
    return identity;
  }

  async consumeAdminToken(chatId: string, token: string, signal: AbortSignal): Promise<boolean> {
    if (!this.capabilities.has('chat:admin-token')) return false;
    try {
      const event = await this.request('chat:admin-token:consume', { chatId, token }, 'chat:admin-token:consumed', signal);
      return event.type === 'chat:admin-token:consumed' && event.chatId === chatId;
    } catch {
      if (!signal.aborted) this.log('admin_token_rejected');
      return false;
    }
  }

  async uploadImage(draw: (signal: AbortSignal) => Promise<DrawnImage>, signal: AbortSignal): Promise<string> {
    if (!this.capabilities.has('media:upload')) throw failure('image_unavailable');
    let image: DrawnImage;
    try { image = await draw(signal); }
    catch (error) { throw failure(signal.aborted ? 'cancelled' : codeOf(error) === 'IMAGE_REJECTED' ? 'image_rejected' : 'image_failed'); }
    return 'jpeg' in image
      ? this.upload(image.jpeg, { 'content-type': 'image/jpeg' }, 'image_failed', signal)
      : this.upload(renderSvg(image.svg, this.config.cjkFont), { 'content-type': 'image/png' }, 'image_failed', signal);
  }

  async uploadFile({ name, write }: { name: string; write: (signal: AbortSignal) => Promise<string> }, signal: AbortSignal): Promise<string> {
    if (!this.capabilities.has('media:upload')) throw failure('file_unavailable');
    const format = /^[^/\\\x00-\x1f\x7f]{1,100}\.(txt|md|csv|pdf)$/i.exec(name)?.[1].toLowerCase();
    if (!format) throw failure('file_invalid');
    // Check before paying for the body; only PDFs carry a font.
    const font = format === 'pdf' ? this.config.cjkFont : undefined;
    if (format === 'pdf' && !font) throw failure('pdf_unavailable');
    let content: string;
    try { content = await write(signal); }
    catch { throw failure(signal.aborted ? 'cancelled' : 'file_write_failed'); }
    // LINE.js accepts only UTF-8 text without control characters other than whitespace.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw failure('file_invalid');
    const headers = { 'x-file-name': encodeURIComponent(name) };
    if (!font) {
      return this.upload(Buffer.from(content), { ...headers, 'content-type': 'text/plain; charset=utf-8' }, 'file_failed', signal);
    }
    let pdf: Buffer<ArrayBuffer>;
    try { pdf = await renderPdf(content, font); }
    catch { throw failure('file_invalid'); }
    return this.upload(pdf, { ...headers, 'content-type': 'application/pdf' }, 'file_failed', signal);
  }

  async upload(body: Buffer<ArrayBuffer>, headers: Record<string, string>, failureCode: string, signal: AbortSignal): Promise<string> {
    const url = new URL('/api/media/upload', this.config.line.url);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    let result: unknown;
    try {
      // Same Bearer as /api/ws; Node's fetch sends no Origin, which the endpoint requires.
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, Authorization: `Bearer ${this.config.line.token}` },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
      });
      result = response.ok ? await response.json() : undefined;
    } catch {
      if (signal.aborted) throw failure('cancelled');
    }
    if (!isRecord(result) || typeof result.mediaId !== 'string') throw failure(failureCode);
    return result.mediaId;
  }

  async reply(message: LineMessage, controller: AbortController, token?: string): Promise<void> {
    const { signal } = controller;
    if (signal.aborted || !this.ready) return;
    const ownId = await this.ownId(message, signal);
    if (!ownId || signal.aborted) return;
    this.rememberAuthor(message.channelId, message.messageId, message.senderId === ownId);
    if (message.senderId === ownId) return;
    // The server's one-time redemption is the proof; text alone never grants ownership.
    const owner = token !== undefined && await this.consumeAdminToken(message.channelId, token, signal);
    if (signal.aborted) return;
    const direct = owner || this.isDirect(message, ownId) || await this.isHistoricalReply(message, ownId, signal);
    if (signal.aborted) return;
    if (!direct && !this.engaged.has(message.channelId)) return;
    const name = typeof message.senderName === 'string' ? message.senderName : message.senderId;
    const input = JSON.stringify({
      sender: { id: message.senderId, name },
      // Never forward the secret to the model or retained context.
      text: token === undefined ? message.text : message.text.replaceAll(token, '[權杖]'),
      ...(typeof message.replyTo === 'string' && message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(owner ? { verifiedOwner: true } : {}),
    });
    const result = await this.engine.prepare(message.channelId, input, signal,
      owner ? { followup: false, owner: true } : { followup: !direct });
    if (signal.aborted || !result) return;
    // Draw, render and upload while the acknowledging text goes out; upload IDs stay valid for ten minutes.
    const media = [
      result.draw === undefined ? undefined : this.uploadImage(result.draw, signal),
      result.file === undefined ? undefined : this.uploadFile(result.file, signal),
    ].filter(upload => upload !== undefined);
    for (const upload of media) upload.catch(() => {});
    const chunks = result.text.trim() ? splitText(result.text, this.config.line.textMaxLength) : [];
    for (const text of chunks) {
      await this.rateLimit(signal);
      if (signal.aborted || !this.ready) return;
      await this.request('message:send', { chatId: message.channelId, text, replyTo: message.messageId }, 'sent', signal);
    }
    if (signal.aborted || !this.ready) return;
    // Media can take minutes; the turn is retained once acknowledged so the chat queue can move on.
    result.commit();
    this.engaged.add(message.channelId);
    if (media.length > 0) this.deliver(message, media, controller);
  }

  /** Sends a turn's media after earlier turns' media in the same chat; cancelChat aborts it. */
  deliver(message: LineMessage, media: Promise<string>[], controller: AbortController): void {
    const chatId = message.channelId;
    const { signal } = controller;
    let delivery = this.deliveries.get(chatId);
    if (!delivery) {
      delivery = { tail: Promise.resolve(), controllers: new Set() };
      this.deliveries.set(chatId, delivery);
    }
    const current = delivery;
    current.controllers.add(controller);
    current.tail = current.tail.then(async () => {
      // A missing picture or file is reported in the chat so the request does not look ignored.
      for (const upload of media) {
        let payload: { chatId: string; mediaId: string } | { chatId: string; text: string; replyTo: string };
        try {
          payload = { chatId, mediaId: await upload };
        } catch (error) {
          if (signal.aborted) return;
          const code = codeOf(error) ?? '';
          if (!Object.hasOwn(MEDIA_NOTICES, code)) throw error;
          this.log(code);
          payload = { chatId, text: MEDIA_NOTICES[code], replyTo: message.messageId };
        }
        await this.rateLimit(signal);
        if (signal.aborted || !this.ready) return;
        await this.request('message:send', payload, 'sent', signal);
      }
    }).catch(() => {
      if (!signal.aborted) this.log('reply_failed');
    }).finally(() => {
      current.controllers.delete(controller);
      if (current.controllers.size === 0 && this.deliveries.get(chatId) === current) this.deliveries.delete(chatId);
    });
  }

  rateLimit(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(failure('cancelled'));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const cancel = () => reject(failure('cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    const slot = this.rateQueue.then(async () => {
      if (signal.aborted) throw failure('cancelled');
      // Permit short bursts without exceeding the server's rolling minute budget.
      while (true) {
        const now = Date.now();
        this.sendTimes = this.sendTimes.filter(time => now - time < 60_000);
        const minuteReady = this.sendTimes.length >= this.config.line.sendsPerMinute
          ? this.sendTimes[0] + 60_000 : 0;
        const remaining = Math.max(this.lastSend + 250, minuteReady) - now;
        if (remaining > 0) {
          await delay(remaining, signal);
          continue;
        }
        if (signal.aborted) throw failure('cancelled');
        this.lastSend = now;
        this.sendTimes.push(now);
        break;
      }
    });
    // Keep the FIFO chain intact; only the caller's wait ends early on cancellation.
    this.rateQueue = slot.then(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, error => {
      signal.removeEventListener('abort', cancel);
      reject(error);
    });
    return promise;
  }

  send(event: LineRequest): void {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) throw failure('disconnected');
    this.socket.send(JSON.stringify(event));
  }

  request(
    ...[type, payload, expectedType, signal]:
      | [type: 'chat:admins:get', payload: { chatId: string }, expectedType: 'chat:admins', signal: AbortSignal]
      | [type: 'history:fetch', payload: { chatId: string; limit: number; before?: string }, expectedType: 'history', signal: AbortSignal]
      | [type: 'message:send', payload: { chatId: string; text: string; replyTo: string } | { chatId: string; mediaId: string }, expectedType: 'sent', signal: AbortSignal]
      | [type: 'chat:admin-token:consume', payload: { chatId: string; token: string }, expectedType: 'chat:admin-token:consumed', signal: AbortSignal]
  ): Promise<ResponseEvent> {
    if (signal.aborted) return Promise.reject(failure('cancelled'));
    const requestId = randomUUID();
    const controller = new AbortController();
    return new Promise<ResponseEvent>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = <T>(callback: (value: T) => void, value: T): void => {
        controller.abort();
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.pending.delete(requestId);
        callback(value);
      };
      const cancel = () => finish(reject, failure('cancelled'));
      const upload = async () => {
        if (type !== 'message:send') {
          while (!controller.signal.aborted) {
            const now = Date.now();
            this.queryTimes = this.queryTimes.filter(time => now - time < 1000);
            if (this.queryTimes.length < 10) break;
            await delay(this.queryTimes[0] + 1000 - now, controller.signal);
          }
        }
        if (controller.signal.aborted) return;
        timer = setTimeout(() => finish(reject, failure('line_request_timeout')), REQUEST_TIMEOUT);
        try {
          if (type === 'message:send') this.send({ type, requestId, ...payload });
          else if (type === 'history:fetch') this.send({ type, requestId, ...payload });
          else if (type === 'chat:admin-token:consume') this.send({ type, requestId, ...payload });
          else this.send({ type, requestId, ...payload });
          if (type !== 'message:send') this.queryTimes.push(Date.now());
        } catch {
          finish(reject, failure('disconnected'));
        }
      };
      this.pending.set(requestId, {
        type: expectedType,
        chatId: payload.chatId,
        resolve: value => finish(resolve, value),
        reject: error => finish(reject, error),
      });
      signal.addEventListener('abort', cancel, { once: true });
      if (type === 'message:send') void upload();
      else {
        const slot = this.queryQueue.then(upload);
        this.queryQueue = slot.catch(() => {});
      }
    });
  }
}
