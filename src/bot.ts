import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { LineConfig } from './config.js';
import type { ChatEngineLike } from './chat.js';
import { isRecord } from './guards.js';

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
  | { type: 'message:send'; requestId: string; chatId: string; text: string; replyTo: string };

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

type ResponseEvent = SentEvent | AdminsEvent | HistoryEvent;
type PendingRequest = {
  type: ResponseEvent['type'];
  chatId: string;
  resolve(event: ResponseEvent): void;
  reject(error: Error): void;
};

interface WaitingMessage {
  message: LineMessage;
  queue: MessageQueue;
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
  | { type: 'message:unsend'; chatId?: unknown; messageId?: unknown };

function isLineEvent(value: unknown): value is LineEvent {
  if (value === null || typeof value !== 'object' || !('type' in value)) return false;
  switch (value.type) {
    case 'ping': case 'pong': case 'hello': case 'auth:state': case 'auth:ready':
    case 'sent': case 'chat:admins': case 'history': case 'error': case 'channels':
    case 'message': case 'message:edit': case 'message:unsend':
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

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

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
  config: { line: LineConfig };
  engine: ChatEngineLike;
  log: (code: string) => void;
  allowed: Set<string>;
  pending: Map<string, PendingRequest>;
  identities: Map<string, string | Promise<string>>;
  jobs: Map<string, MessageQueue>;
  waiting: Set<WaitingMessage>;
  outstanding: number;
  seen: Map<string, boolean>;
  engaged: Set<string>;
  referenceAuthors: Map<string, { chatId: string; own: boolean }>;
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
    config: { line: LineConfig }; engine: ChatEngineLike; log?: (code: string) => void;
  }) {
    this.config = config;
    this.engine = engine;
    this.log = log;
    this.allowed = new Set(config.line.chats);
    this.pending = new Map();
    this.identities = new Map();
    this.jobs = new Map();
    this.waiting = new Set();
    this.outstanding = 0;
    this.seen = new Map();
    this.engaged = new Set();
    this.referenceAuthors = new Map();
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
    for (const chatId of this.jobs.keys()) this.cancelChat(chatId);
    this.identities.clear();
    this.engaged.clear();
    this.referenceAuthors.clear();
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
    const oldest = this.referenceAuthors.keys().next();
    if (this.referenceAuthors.size > DEDUP_LIMIT && !oldest.done) this.referenceAuthors.delete(oldest.value);
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
    if (event.type === 'sent' || event.type === 'chat:admins' || event.type === 'history' || event.type === 'error') {
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
    if (event.type === 'channels' && Array.isArray(event.channels)) {
      const next = new Set(event.channels.flatMap((channel: unknown) =>
        channel !== null && typeof channel === 'object' && 'channelId' in channel &&
        typeof channel.channelId === 'string' ? [channel.channelId] : []));
      for (const chatId of new Set([...(this.channels ?? []), ...this.jobs.keys(), ...this.engaged,
        ...Array.from(this.referenceAuthors.values(), author => author.chatId)])) {
        if (!next.has(chatId)) {
          this.cancelChat(chatId);
          for (const [key, author] of this.referenceAuthors) {
            if (author.chatId === chatId) this.referenceAuthors.delete(key);
          }
        }
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
    if (typeof ownId === 'string' && message.senderId === ownId) {
      this.rememberAuthor(message.channelId, message.messageId, true);
      return;
    }
    this.enqueue(message);
  }

  enqueue(message: LineMessage): void {
    if (this.stopped || !this.ready) return;
    const chatId = message.channelId;
    let queue = this.jobs.get(chatId);
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
    const entry = { message, queue };
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
    void this.reply(entry.message, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) this.log(error !== null && typeof error === 'object' &&
        'code' in error && error.code === 'identity_unavailable' ? 'identity_unavailable' : 'reply_failed');
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

  async reply(message: LineMessage, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.ready) return;
    const ownId = await this.ownId(message, signal);
    if (!ownId || signal.aborted) return;
    this.rememberAuthor(message.channelId, message.messageId, message.senderId === ownId);
    if (message.senderId === ownId) return;
    const direct = this.isDirect(message, ownId) || await this.isHistoricalReply(message, ownId, signal);
    if (signal.aborted) return;
    if (!direct && !this.engaged.has(message.channelId)) return;
    const name = typeof message.senderName === 'string' ? message.senderName : message.senderId;
    const input = JSON.stringify({
      sender: { id: message.senderId, name }, text: message.text,
      ...(typeof message.replyTo === 'string' && message.replyTo ? { replyTo: message.replyTo } : {}),
    });
    const result = await this.engine.prepare(message.channelId, input, signal, { followup: !direct });
    if (signal.aborted || !result) return;
    const chunks = splitText(result.text, this.config.line.textMaxLength);
    for (const text of chunks) {
      await this.rateLimit(signal);
      if (signal.aborted || !this.ready) return;
      await this.request('message:send', { chatId: message.channelId, text, replyTo: message.messageId }, 'sent', signal);
    }
    if (!signal.aborted && this.ready) {
      result.commit();
      this.engaged.add(message.channelId);
    }
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
      | [type: 'message:send', payload: { chatId: string; text: string; replyTo: string }, expectedType: 'sent', signal: AbortSignal]
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
