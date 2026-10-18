import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const REQUEST_TIMEOUT = 15_000;
const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;
const DEDUP_LIMIT = 10_000;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function delay(ms, signal) {
  if (signal.aborted) return Promise.reject(failure('cancelled'));
  return new Promise((resolve, reject) => {
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

function splitText(text, maximum) {
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
  constructor({ config, engine, log = () => {} }) {
    this.config = config;
    this.engine = engine;
    this.log = log;
    this.allowed = new Set(config.line.chats);
    this.pending = new Map();
    this.identities = new Map();
    this.jobs = new Map();
    this.queues = new Map();
    this.seen = new Map();
    this.engaged = new Set();
    this.ownMessages = new Map();
    this.rateQueue = Promise.resolve();
    this.lastSend = 0;
    this.stopped = false;
    this.started = false;
    this.ready = false;
    this.protocolReady = false;
    this.capabilities = new Set();
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
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

  disconnect(code) {
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
    this.ownMessages.clear();
    for (const request of [...this.pending.values()]) request.reject(failure('cancelled'));
    this.engine.clearAll();
  }

  cancelChat(chatId) {
    for (const job of this.jobs.get(chatId) ?? []) job.abort();
    this.engine.clear(chatId);
    this.engaged.delete(chatId);
    this.identities.delete(chatId);
  }

  rememberOwn(chatId, messageId) {
    if (typeof messageId !== 'string' || !messageId) return;
    this.ownMessages.set(JSON.stringify([chatId, messageId]), chatId);
    if (this.ownMessages.size > DEDUP_LIMIT) this.ownMessages.delete(this.ownMessages.keys().next().value);
  }

  isDirect(message, ownId) {
    if (message.text.includes('語喵')) return true;
    if (Array.isArray(message.mentions) && message.mentions.some(mention =>
      mention?.userId === ownId &&
      Number.isInteger(mention.start) && Number.isInteger(mention.end) &&
      mention.start >= 0 && mention.end > mention.start && mention.end <= message.text.length &&
      message.text[mention.start] === '@'
    )) return true;
    return typeof message.replyTo === 'string' &&
      this.ownMessages.has(JSON.stringify([message.channelId, message.replyTo]));
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

  receive(event) {
    if (!event || typeof event !== 'object') return;
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
      if (!this.protocolReady || typeof event.profile?.userId !== 'string' || !event.profile.userId) return;
      if (this.userId && this.userId !== event.profile.userId) this.invalidateAll();
      this.userId = event.profile.userId;
      this.ready = true;
      this.log('ready');
      return;
    }
    if (event.type === 'sent' || event.type === 'chat:admins' || event.type === 'error') {
      const pending = this.pending.get(event.requestId);
      if (!pending) return;
      if (event.type === 'error') pending.reject(failure('line_request_failed'));
      else if (event.type === pending.type) {
        if (event.type === 'sent') this.rememberOwn(pending.chatId, event.messageId);
        pending.resolve(event);
      }
      return;
    }
    if (event.type === 'channels' && Array.isArray(event.channels)) {
      const next = new Set(event.channels.map(channel => channel.channelId));
      for (const chatId of new Set([...(this.channels ?? []), ...this.jobs.keys(), ...this.engaged, ...this.ownMessages.values()])) {
        if (!next.has(chatId)) {
          this.cancelChat(chatId);
          for (const [key, ownChatId] of this.ownMessages) {
            if (ownChatId === chatId) this.ownMessages.delete(key);
          }
        }
      }
      this.channels = next;
      return;
    }
    if (!this.ready) return;
    if (event.type === 'message:edit' || event.type === 'message:unsend') {
      const chatId = event.type === 'message:edit' ? event.message?.channelId : event.chatId;
      if (this.allowed.has(chatId)) {
        const messageId = event.type === 'message:edit' ? event.message?.messageId : event.messageId;
        if (event.type === 'message:unsend') this.ownMessages.delete(JSON.stringify([chatId, messageId]));
        this.cancelChat(chatId);
      }
      return;
    }
    if (event.type !== 'message') return;
    const message = event.message;
    if (!message || !this.allowed.has(message.channelId) || (this.channels && !this.channels.has(message.channelId))) return;
    if (message.contentType !== 'TEXT' || typeof message.text !== 'string' || !message.text.trim() || message.unsent || message.decryptFailed) return;
    if (typeof message.messageId !== 'string' || !message.messageId || typeof message.senderId !== 'string' || !message.senderId) return;
    const key = JSON.stringify([message.channelId, message.messageId]);
    if (this.seen.has(key)) return;
    this.seen.set(key, true);
    if (this.seen.size > DEDUP_LIMIT) this.seen.delete(this.seen.keys().next().value);
    this.enqueue(message);
  }

  enqueue(message) {
    const chatId = message.channelId;
    const controller = new AbortController();
    let jobs = this.jobs.get(chatId);
    if (!jobs) this.jobs.set(chatId, jobs = new Set());
    jobs.add(controller);
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const work = previous.then(() => this.reply(message, controller.signal)).catch(error => {
      if (!controller.signal.aborted) this.log(error?.code === 'identity_unavailable' ? 'identity_unavailable' : 'reply_failed');
    }).finally(() => {
      jobs.delete(controller);
      if (!jobs.size && this.jobs.get(chatId) === jobs) this.jobs.delete(chatId);
      if (this.queues.get(chatId) === work) this.queues.delete(chatId);
    });
    this.queues.set(chatId, work);
  }

  async ownId(message, signal) {
    if (message.channelKind !== 'square') return this.userId;
    const configured = this.config.line.ownMemberIds?.[message.channelId];
    if (configured) return configured;
    if (!this.capabilities.has('chat:admins')) throw failure('identity_unavailable');
    let identity = this.identities.get(message.channelId);
    if (!identity) {
      identity = this.request('chat:admins:get', { chatId: message.channelId }, 'chat:admins', signal).then(event => {
        if (event.chatId !== message.channelId || typeof event.ownMemberId !== 'string' || !event.ownMemberId) throw failure('identity_unavailable');
        return event.ownMemberId;
      });
      this.identities.set(message.channelId, identity);
      identity.catch(() => {
        if (this.identities.get(message.channelId) === identity) this.identities.delete(message.channelId);
      });
    }
    return identity;
  }

  async reply(message, signal) {
    if (signal.aborted || !this.ready) return;
    const ownId = await this.ownId(message, signal);
    if (!ownId || signal.aborted) return;
    if (message.senderId === ownId) {
      this.rememberOwn(message.channelId, message.messageId);
      return;
    }
    const direct = this.isDirect(message, ownId);
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

  rateLimit(signal) {
    const slot = this.rateQueue.then(async () => {
      if (signal.aborted) throw failure('cancelled');
      const interval = Math.max(250, Math.ceil(60_000 / this.config.line.sendsPerMinute));
      const remaining = this.lastSend + interval - Date.now();
      if (remaining > 0) await delay(remaining, signal);
      if (signal.aborted) throw failure('cancelled');
      this.lastSend = Date.now();
    });
    this.rateQueue = slot.catch(() => {});
    return slot;
  }

  send(event) {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) throw failure('disconnected');
    this.socket.send(JSON.stringify(event));
  }

  request(type, payload, expectedType, signal) {
    if (signal.aborted) return Promise.reject(failure('cancelled'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.pending.delete(requestId);
        callback(value);
      };
      const cancel = () => finish(reject, failure('cancelled'));
      const timer = setTimeout(() => finish(reject, failure('line_request_timeout')), REQUEST_TIMEOUT);
      this.pending.set(requestId, {
        type: expectedType,
        chatId: payload.chatId,
        resolve: value => finish(resolve, value),
        reject: error => finish(reject, error),
      });
      signal.addEventListener('abort', cancel, { once: true });
      try {
        this.send({ type, requestId, ...payload });
      } catch {
        finish(reject, failure('disconnected'));
      }
    });
  }
}
