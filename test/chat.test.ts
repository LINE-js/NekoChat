import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { Transform, TransformCallback } from 'node:stream';
import { createGzip, gunzipSync } from 'node:zlib';
import { ChatEngine, ChatError } from '../src/chat.js';
import { isRecord } from '../src/guards.js';
import type { ChatFetchOptions, ChatMessage, PreparedTurn } from '../src/chat.js';
import type { ClaudeConfig } from '../src/config.js';

interface RequestBody {
  model: string;
  system: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
  messages: ChatMessage[];
  tools?: unknown;
  tool_choice?: unknown;
  max_tokens?: unknown;
  cache_control?: unknown;
}

interface FetchCall {
  url: string;
  options: ChatFetchOptions;
  body: RequestBody;
}

interface HarnessOptions {
  count?: (body: RequestBody, calls: FetchCall[]) => unknown | Promise<unknown>;
  generate?: (body: RequestBody, calls: FetchCall[]) => unknown | Promise<unknown>;
  config?: Partial<ClaudeConfig>;
}

function parseRequest(body: string): RequestBody {
  const value: unknown = JSON.parse(body);
  assert.ok(value !== null && typeof value === 'object');
  assert.ok('model' in value && typeof value.model === 'string');
  assert.ok('system' in value && Array.isArray(value.system));
  const system: RequestBody['system'] = value.system.map((block: unknown) => {
    assert.ok(block !== null && typeof block === 'object');
    assert.ok('type' in block && block.type === 'text');
    assert.ok('text' in block && typeof block.text === 'string' && block.text.length > 0);
    return {
      type: block.type,
      text: block.text,
      ...('cache_control' in block ? { cache_control: block.cache_control as { type: 'ephemeral' } } : {}),
    };
  });
  assert.ok('messages' in value && Array.isArray(value.messages));
  const messages: ChatMessage[] = value.messages.map((message: unknown) => {
    assert.ok(message !== null && typeof message === 'object');
    assert.ok('role' in message && (message.role === 'user' || message.role === 'assistant'));
    assert.ok('content' in message && typeof message.content === 'string');
    return { role: message.role, content: message.content };
  });
  return {
    model: value.model,
    system,
    messages,
    ...('tools' in value ? { tools: value.tools } : {}),
    ...('tool_choice' in value ? { tool_choice: value.tool_choice } : {}),
    ...('max_tokens' in value ? { max_tokens: value.max_tokens } : {}),
    ...('cache_control' in value ? { cache_control: value.cache_control } : {}),
  };
}

const claude = {
  apiKey: 'test-secret-key',
  model: 'claude-haiku-5-5',
  contextTokens: 100,
  maxOutputTokens: 10,
  timeoutMs: 1_000,
};

function harness({ count = () => 20, generate, config = {} }: HarnessOptions = {}) {
  const calls: FetchCall[] = [];
  const engine = new ChatEngine({
    claude: { ...claude, ...config },
    system: 'Always be a helpful cat.',
    fetchImpl: async (url, options) => {
      const json = options.headers['content-encoding'] === 'gzip'
        ? gunzipSync(options.body).toString('utf8')
        : typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString('utf8');
      const body = parseRequest(json);
      const call = { url, options, body };
      calls.push(call);
      if (url.endsWith('/count_tokens')) {
        const result = await count(body, calls);
        return result instanceof Response ? result : Response.json({ input_tokens: result });
      }
      const result = generate ? await generate(body, calls)
        : followupResult(true, `answer:${body.messages.at(-1)?.content}`);
      return result instanceof Response ? result : Response.json(result);
    },
  });
  return {
    engine,
    calls,
    generations: () => calls.filter((call) => call.url.endsWith('/messages')),
  };
}

function hasCode(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof ChatError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.ok(!JSON.stringify(error).includes(claude.apiKey));
    return true;
  };
}

function requireTurn(turn: PreparedTurn | null): PreparedTurn {
  assert.ok(turn);
  return turn;
}

test('accepts the exact input plus reserved-output context boundary', async () => {
  const { engine, generations } = harness({ count: () => 90 });
  const turn = await engine.prepare('chat', 'hello');
  requireTurn(turn).commit();
  assert.equal(generations().length, 1);
  await engine.prepare('chat', 'next');
  assert.equal(generations()[1].body.messages[0].content, 'hello');
});

test('drops only the oldest complete pair and counts the retained request', async () => {
  const { engine, calls, generations } = harness({ count: (body) => body.messages.length * 20 });
  requireTurn((await engine.prepare('chat', 'first'))).commit();
  requireTurn((await engine.prepare('chat', 'second'))).commit();
  const third = await engine.prepare('chat', 'third');
  const expected = [
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'answer:second' },
    { role: 'user', content: 'third' },
  ];
  assert.deepEqual(generations()[2].body.messages, expected);
  assert.ok(calls.some((call) => call.url.endsWith('/count_tokens') &&
    JSON.stringify(call.body.messages) === JSON.stringify(expected)));
  requireTurn(third).commit();
  await engine.prepare('chat', 'fourth');
  assert.deepEqual(generations()[3].body.messages.map((message) => message.content), [
    'third', 'answer:third', 'fourth',
  ]);
});

test('64-pair overflow drops only turn0 with two count requests', async () => {
  const { engine, calls, generations } = harness({
    count: (body) => body.messages.at(-1)?.content === 'turn64' &&
      body.messages.length > 127 ? 91 : 90,
  });
  for (let turn = 0; turn < 64; turn++) {
    requireTurn((await engine.prepare('chat', `turn${turn}`))).commit();
  }
  calls.length = 0;
  const turn = await engine.prepare('chat', 'turn64');
  const counts = calls.filter((call) => call.url.endsWith('/count_tokens'));
  assert.equal(counts.length, 2);
  assert.equal(counts[0].body.messages.length, 129);
  assert.equal(counts[1].body.messages.length, 127);
  const generated = generations()[0].body;
  assert.equal(generated.messages[0].content, 'turn1');
  assert.equal(generated.messages.at(-1)?.content, 'turn64');
  assert.deepEqual(generated.messages, counts[1].body.messages);
  assert.deepEqual(generated.system, counts[1].body.system);
  requireTurn(turn).commit();
  await engine.prepare('chat', 'next');
  assert.equal(generations().at(-1)?.body.messages[0].content, 'turn1');
});

test('minimal trimming handles every boundary without counting a candidate twice', async () => {
  for (const pairCount of [1, 2, 3, 8]) {
    for (let dropped = 1; dropped <= pairCount; dropped++) {
      const retainedLength = (pairCount - dropped) * 2 + 1;
      const { engine, calls, generations } = harness({
        count: (body) => body.messages.at(-1)?.content === 'next' &&
          body.messages.length > retainedLength ? 91 : 90,
      });
      for (let turn = 0; turn < pairCount; turn++) {
        requireTurn((await engine.prepare('chat', `turn${turn}`))).commit();
      }
      calls.length = 0;
      await engine.prepare('chat', 'next');
      const counts = calls.filter((call) => call.url.endsWith('/count_tokens'));
      const lengths = counts.map((call) => call.body.messages.length);
      assert.equal(new Set(lengths).size, lengths.length);
      const generated = generations()[0].body;
      assert.deepEqual(generated.messages.map((message) => message.content), [
        ...Array.from({ length: pairCount - dropped }, (_, turn) => [
          `turn${turn + dropped}`, `answer:turn${turn + dropped}`,
        ]).flat(),
        'next',
      ]);
      assert.ok(counts.some(({ body }) =>
        JSON.stringify(body.system) === JSON.stringify(generated.system) &&
        JSON.stringify(body.messages) === JSON.stringify(generated.messages)));
    }
  }
});

test('measured trim probes preserve the newest fitting history with uneven pair sizes', async () => {
  for (const weights of [
    [10, 10, 10, 10, 10, 10, 10, 10],
    [20, 1, 1, 1, 1, 1, 1, 1],
    [1, 20, 1, 1, 1, 1, 1, 1],
    [0, 0, 10, 0, 20, 0, 10, 0],
  ]) {
    for (let boundary = 0; boundary <= weights.length; boundary++) {
      const retainedTokens = weights.slice(boundary).reduce((sum, weight) => sum + weight, 0);
      const { engine, calls, generations } = harness({
        count: body => body.messages.at(-1)?.content === 'overflow'
          ? 90 - retainedTokens + weights.slice(weights.length - (body.messages.length - 1) / 2)
            .reduce((sum, weight) => sum + weight, 0)
          : 20,
      });
      for (let turn = 0; turn < weights.length; turn++) {
        requireTurn(await engine.prepare('chat', `turn${turn}`)).commit();
      }
      calls.length = 0;
      const result = await engine.prepare('chat', 'overflow');
      const firstFit = Array.from({ length: weights.length + 1 }, (_, dropped) => dropped)
        .find(dropped => weights.slice(dropped).reduce((sum, weight) => sum + weight, 0) <= retainedTokens)!;
      const expected = [
        ...weights.slice(firstFit).flatMap((_, index) => [
          `turn${firstFit + index}`, `answer:turn${firstFit + index}`,
        ]),
        'overflow',
      ];
      assert.deepEqual(generations()[0].body.messages.map(message => message.content), expected);
      const counts = calls.filter(call => call.url.endsWith('/count_tokens'));
      const lengths = counts.map(call => call.body.messages.length);
      assert.equal(new Set(lengths).size, lengths.length);
      assert.ok(lengths.includes(expected.length));
      requireTurn(result).commit();
      await engine.prepare('chat', 'next');
      assert.deepEqual(generations()[1].body.messages.map(message => message.content), [
        ...expected, 'answer:overflow', 'next',
      ]);
    }
  }
});

test('failed trimming counts never generate or change committed history', async () => {
  for (const failedLength of [7, 1, 3]) {
    for (const failure of [NaN, new Response('upstream failure', { status: 429 })]) {
      const { engine, calls, generations } = harness({
        count: (body) => {
          if (body.messages.at(-1)?.content !== 'next') return 20;
          if (body.messages.length === failedLength) return failure;
          return body.messages.length === 1 ? 20 : 91;
        },
      });
      for (let turn = 0; turn < 4; turn++) {
        requireTurn((await engine.prepare('chat', `turn${turn}`))).commit();
      }
      calls.length = 0;
      await assert.rejects(engine.prepare('chat', 'next'), hasCode(
        'COUNT_FAILED', failure instanceof Response ? 429 : undefined,
      ));
      assert.equal(generations().length, 0);
      await engine.prepare('chat', 'small');
      assert.deepEqual(generations()[0].body.messages.map((message) => message.content), [
        'turn0', 'answer:turn0', 'turn1', 'answer:turn1',
        'turn2', 'answer:turn2', 'turn3', 'answer:turn3', 'small',
      ]);
    }
  }
});

test('abort and timeout during trimming preserve committed history', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const code of ['ABORTED', 'TIMEOUT']) {
    for (const stoppedLength of [7, 1, 3]) {
      const controller = new AbortController();
      const { engine, calls, generations } = harness({
        count: (body) => {
          if (body.messages.at(-1)?.content !== 'next') return 20;
          if (body.messages.length === stoppedLength) {
            if (code === 'ABORTED') controller.abort();
            else t.mock.timers.tick(claude.timeoutMs);
          }
          return body.messages.length === 1 ? 20 : 91;
        },
      });
      for (let turn = 0; turn < 4; turn++) {
        requireTurn((await engine.prepare('chat', `turn${turn}`))).commit();
      }
      calls.length = 0;
      await assert.rejects(engine.prepare('chat', 'next', controller.signal), hasCode(code));
      assert.equal(generations().length, 0);
      await engine.prepare('chat', 'small');
      assert.equal(generations()[0].body.messages[0].content, 'turn0');
      assert.equal(generations()[0].body.messages.length, 9);
    }
  }
});

test('oversized current input is counted intact without repeating trim boundaries', async () => {
  const input = 'keep the complete oversized input';
  const { engine, calls, generations } = harness({
    count: (body) => body.messages.at(-1)?.content === input ? 91 : 20,
  });
  for (const turn of ['first', 'second']) {
    requireTurn((await engine.prepare('chat', turn))).commit();
  }
  calls.length = 0;
  await assert.rejects(engine.prepare('chat', input), hasCode('CONTEXT_TOO_LARGE'));
  assert.equal(generations().length, 0);
  assert.deepEqual(calls.map(({ body }) => body.messages.length), [5, 3, 1]);
  for (const { body } of calls) {
    assert.equal(body.messages.at(-1)?.content, input);
    assert.deepEqual(body.system, calls[0].body.system);
  }
  await engine.prepare('chat', 'small');
  assert.equal(generations()[0].body.messages[0].content, 'first');
});

test('can discard all history while preserving the newest input', async () => {
  const { engine, generations } = harness({ count: (body) => body.messages.length === 1 ? 20 : 95 });
  requireTurn((await engine.prepare('chat', 'old'))).commit();
  await engine.prepare('chat', 'new');
  assert.deepEqual(generations()[1].body.messages, [{ role: 'user', content: 'new' }]);
});

test('oversized system plus current input never generates or truncates', async () => {
  const { engine, calls, generations } = harness({ count: () => 91 });
  await assert.rejects(engine.prepare('chat', 'keep the complete input'), hasCode('CONTEXT_TOO_LARGE'));
  assert.equal(generations().length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.messages[0].content, 'keep the complete input');
});

test('oversized current input still fails after every old pair is removed', async () => {
  const { engine, generations } = harness({
    count: (body) => body.messages.at(-1)?.content === 'oversized' ? 91 : 20,
  });
  requireTurn((await engine.prepare('chat', 'old'))).commit();
  await assert.rejects(engine.prepare('chat', 'oversized'), hasCode('CONTEXT_TOO_LARGE'));
  assert.equal(generations().length, 1);
  await engine.prepare('chat', 'small');
  assert.equal(generations()[1].body.messages[0].content, 'old');
});

test('count HTTP failure prevents generation and exposes only safe status and code', async () => {
  const { engine, generations } = harness({
    count: () => new Response(`upstream ${claude.apiKey}`, { status: 429 }),
  });
  await assert.rejects(engine.prepare('chat', 'hello'), hasCode('COUNT_FAILED', 429));
  assert.equal(generations().length, 0);
});

test('invalid counts never permit generation', async () => {
  for (const count of [-1, 1.5, '20', null]) {
    const { engine, generations } = harness({ count: () => count });
    await assert.rejects(engine.prepare('chat', 'hello'), hasCode('COUNT_FAILED'));
    assert.equal(generations().length, 0);
  }
});

test('network errors cannot leak upstream messages or keys', async () => {
  const { engine } = harness({ count: () => { throw new Error(`network ${claude.apiKey}`); } });
  await assert.rejects(engine.prepare('chat', 'hello'), hasCode('COUNT_FAILED'));
});

test('history is isolated by chat and uncommitted turns are never included', async () => {
  const { engine, generations } = harness();
  requireTurn((await engine.prepare('a', 'committed'))).commit();
  await engine.prepare('b', 'other');
  await engine.prepare('a', 'uncommitted');
  await engine.prepare('a', 'next');
  assert.deepEqual(generations()[1].body.messages, [{ role: 'user', content: 'other' }]);
  assert.deepEqual(generations()[3].body.messages.map((message) => message.content), [
    'committed', 'answer:committed', 'next',
  ]);
});

test('commit is idempotent and a concurrently prepared stale turn cannot replace history', async () => {
  const { engine, generations } = harness();
  const first = await engine.prepare('chat', 'first');
  const stale = await engine.prepare('chat', 'stale');
  requireTurn(first).commit();
  requireTurn(first).commit();
  requireTurn(stale).commit();
  await engine.prepare('chat', 'next');
  assert.deepEqual(generations()[2].body.messages.map((message) => message.content), [
    'first', 'answer:first', 'next',
  ]);
});

test('clear and clearAll invalidate outstanding commits even after chat recreation', async () => {
  for (const clearAll of [false, true]) {
    const { engine, generations } = harness();
    const pending = await engine.prepare('chat', 'old');
    if (clearAll) engine.clearAll();
    else engine.clear('chat');
    const fresh = await engine.prepare('chat', 'fresh');
    requireTurn(pending).commit();
    requireTurn(fresh).commit();
    await engine.prepare('chat', 'next');
    assert.deepEqual(generations()[2].body.messages.map((message) => message.content), [
      'fresh', 'answer:fresh', 'next',
    ]);
  }
});

test('aborting after prepare prevents committing a reply that was not sent', async () => {
  const { engine, generations } = harness();
  const controller = new AbortController();
  const pending = await engine.prepare('chat', 'cancelled', controller.signal);
  controller.abort();
  requireTurn(pending).commit();
  await engine.prepare('chat', 'next');
  assert.deepEqual(generations()[1].body.messages, [{ role: 'user', content: 'next' }]);
});

test('pre-aborted and in-flight cancelled requests return safe ABORTED errors', async () => {
  const controller = new AbortController();
  const { engine, calls } = harness();
  controller.abort();
  await assert.rejects(engine.prepare('chat', 'hello', controller.signal), hasCode('ABORTED'));
  assert.equal(calls.length, 0);

  const active = new AbortController();
  const cancelling = new ChatEngine({
    claude, system: 'cat',
    fetchImpl: async () => {
      active.abort();
      throw new Error(`upstream ${claude.apiKey}`);
    },
  });
  await assert.rejects(cancelling.prepare('chat', 'hello', active.signal), hasCode('ABORTED'));
});

test('timeout aborts the fetch and returns a safe TIMEOUT error', async () => {
  let fetchSignal: AbortSignal | undefined;
  const engine = new ChatEngine({
    claude: { ...claude, timeoutMs: 10 },
    system: 'cat',
    fetchImpl: async (_url, { signal }) => {
      fetchSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error(claude.apiKey)), { once: true });
      });
    },
  });
  await assert.rejects(engine.prepare('chat', 'hello'), hasCode('TIMEOUT'));
  assert.ok(fetchSignal);
  assert.equal(fetchSignal.aborted, true);
});

for (const code of ['ABORTED', 'TIMEOUT']) {
  test(`${code} settles before a pending compression callback and destroys its stream`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const probe = createGzip();
    const prototype = Object.getPrototypeOf(probe) as Transform;
    probe.destroy();
    let stream: Transform | undefined;
    let complete: TransformCallback | undefined;
    let completed = false;
    t.mock.method(prototype, '_transform', function (
      this: Transform, _chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback,
    ) {
      stream = this;
      complete = () => {
        if (completed) return;
        completed = true;
        callback();
      };
    });
    t.after(() => complete?.());
    const { engine, calls } = harness();
    const controller = new AbortController();
    let settled = false;
    const outcome = engine.prepare('chat', '中文'.repeat(10_000), controller.signal).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    assert.ok(stream);
    assert.ok(complete);
    if (code === 'ABORTED') controller.abort();
    else t.mock.timers.tick(claude.timeoutMs);
    // One event-loop turn is a condition barrier, not a compression-duration threshold.
    await setImmediate();
    assert.equal(completed, false);
    assert.equal(settled, true);
    assert.equal(stream.destroyed, true);
    hasCode(code)(await outcome);
    assert.equal(calls.length, 0);
    complete();
    assert.equal(calls.length, 0);
    await engine.prepare('chat', 'next');
    assert.deepEqual(calls.at(-1)?.body.messages, [{ role: 'user', content: 'next' }]);
  });
}

test('gzip preserves large UTF8 JSON requests and small requests stay uncompressed', async () => {
  const { engine, calls } = harness();
  await engine.prepare('small', 'hello');
  assert.ok(calls.every(({ options }) => typeof options.body === 'string' &&
    options.headers['content-encoding'] === undefined));
  calls.length = 0;
  const input = '中文🐱'.repeat(1_000);
  await engine.prepare('large', input);
  assert.equal(calls.length, 2);
  for (const { options, body } of calls) {
    assert.equal(options.headers['content-encoding'], 'gzip');
    assert.ok(typeof options.body !== 'string');
    const json = gunzipSync(options.body).toString('utf8');
    assert.ok(options.body.byteLength < Buffer.byteLength(json));
    assert.equal(body.messages[0]?.content, input);
    assert.deepEqual(JSON.parse(json).messages, [{ role: 'user', content: input }]);
  }
});

test('compression uses the UTF8 byte gate and skips payloads that would not shrink', async (t) => {
  const probe = createGzip();
  const prototype = Object.getPrototypeOf(probe) as Transform;
  probe.destroy();
  let compressed = 0;
  t.mock.method(prototype, '_transform', function (
    this: Transform, chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback,
  ) {
    // Return the original bytes: deterministic non-shrinking output, including the flush.
    if (chunk.byteLength) {
      compressed++;
      this.push(chunk);
    }
    callback();
  });
  const { engine, calls } = harness();
  const input = '中'.repeat(1_000);
  await engine.prepare('chat', input);
  assert.equal(compressed, 2);
  for (const { options, body } of calls) {
    assert.equal(typeof options.body, 'string');
    assert.equal(options.headers['content-encoding'], undefined);
    assert.equal(body.messages[0]?.content, input);
    assert.ok(typeof options.body === 'string' && options.body.length < 4096);
    assert.ok(Buffer.byteLength(options.body) >= 4096);
  }
});

test('HTTP failures stop unfinished response transfers without waiting for their bodies', { timeout: 5_000 }, async (t) => {
  for (const endpoint of ['count_tokens', 'messages']) {
    const closed = Promise.withResolvers<void>();
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Drain the upload before responding. */ }
      if (request.url?.endsWith(`/${endpoint}`)) {
        response.on('close', closed.resolve);
        response.writeHead(429, { 'content-type': 'text/plain' });
        response.write('an unfinished upstream error body');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 20 }));
      }
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const engine = new ChatEngine({
      claude,
      system: 'cat',
      fetchImpl: (url, options) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, options),
    });
    await assert.rejects(
      engine.prepare('chat', 'hello'),
      hasCode(endpoint === 'count_tokens' ? 'COUNT_FAILED' : 'GENERATION_FAILED', 429),
    );
    await closed.promise;
  }
});


test('failed, truncated, blank and nontext output are never retained', async () => {
  const failures = [
    { result: new Response(claude.apiKey, { status: 503 }), code: 'GENERATION_FAILED', status: 503 },
    { result: { content: [{ type: 'text', text: 'unfinished' }], stop_reason: 'max_tokens' }, code: 'OUTPUT_TRUNCATED' },
    { result: { content: [] }, code: 'INVALID_RESPONSE' },
    { result: { content: [{ type: 'text', text: '   ' }] }, code: 'INVALID_RESPONSE' },
    { result: { content: [{ type: 'tool_use', id: 'tool' }] }, code: 'INVALID_RESPONSE' },
    { result: { content: [{ type: 'text', text: 'partial' }, { type: 'tool_use' }] }, code: 'INVALID_RESPONSE' },
  ];
  for (const { result, code, status } of failures) {
    let fail = true;
    const { engine, generations } = harness({
      generate: () => fail ? result : followupResult(true, 'good'),
    });
    await assert.rejects(engine.prepare('chat', 'failed input'), hasCode(code, status));
    fail = false;
    await engine.prepare('chat', 'next');
    assert.deepEqual(generations()[1].body.messages, [{ role: 'user', content: 'next' }]);
  }
});

test('hard context ceiling cannot be configured above 100000 tokens', () => {
  assert.throws(() => new ChatEngine({
    claude: { ...claude, contextTokens: 100_001 }, system: 'cat',
  }), hasCode('INVALID_CONFIG'));
});

function followupResult(shouldReply: boolean, reply: string) {
  return {
    stop_reason: 'tool_use',
    content: [{
      type: 'tool_use',
      id: 'toolu_decision',
      name: 'conversation_reply',
      input: { shouldReply, reply },
    }],
  };
}

function followupHarness(options: HarnessOptions = {}) {
  return harness({
    ...options,
    generate: (body, calls) => isSeedTurn(body)
      ? followupResult(true, '先前的回答')
      : (options.generate ?? (() => followupResult(true, '自然的回答')))(body, calls),
  });
}

function isSeedTurn(body: RequestBody): boolean {
  return /^(first|second|direct|turn\d+)$/.test(body.messages.at(-1)?.content ?? '');
}

for (const followup of [false, true]) {
  test(`declined replies preserve history (followup=${followup})`, async () => {
    const { engine, generations } = followupHarness({
      generate: () => followupResult(false, ''),
      count: (body) => !isSeedTurn(body) && body.messages.length > 3 ? 95 : 20,
    });
    if (!followup) {
      assert.equal(await engine.prepare('chat', '語喵剛剛說了什麼，你知道嗎？'), null);
      assert.equal(await engine.prepare('chat', 'ordinary', undefined, { followup: true }), null);
      assert.equal(generations().length, 1);
    }
    requireTurn(await engine.prepare('chat', 'first')).commit();
    requireTurn(await engine.prepare('chat', 'second')).commit();
    assert.equal(await engine.prepare('chat', 'unrelated', undefined, { followup }), null);
    await engine.prepare('chat', 'direct');
    assert.deepEqual(generations().at(-1)?.body.messages.map((message) => message.content), [
      'first', '先前的回答', 'second', '先前的回答', 'direct',
    ]);
  });
}

test('relevant followups commit only plain reply text and remain transactional', async () => {
  const { engine, generations } = followupHarness();
  requireTurn((await engine.prepare('chat', 'first'))).commit();
  const uncommitted = await engine.prepare('chat', 'not sent', undefined, { followup: true });
  assert.ok(uncommitted);
  assert.equal(uncommitted.text, '自然的回答');
  const turn = await engine.prepare('chat', 'followup', undefined, { followup: true });
  assert.ok(turn);
  assert.deepEqual(generations()[2].body.messages.map((message) => message.content), [
    'first', '先前的回答', 'followup',
  ]);
  requireTurn(turn).commit();
  requireTurn(turn).commit();
  requireTurn(uncommitted).commit();
  await engine.prepare('chat', 'direct');
  const direct = generations().at(-1)?.body;
  assert.ok(direct);
  assert.deepEqual(direct.messages.map((message) => message.content), [
    'first', '先前的回答', 'followup', '自然的回答', 'direct',
  ]);
});

test('followups without retained conversational evidence stay silent without generating', async () => {
  const { engine, calls, generations } = followupHarness({
    count: (body) => !isSeedTurn(body) && body.messages.length > 1 ? 95 : 20,
  });
  assert.equal(await engine.prepare('empty', 'hello', undefined, { followup: true }), null);
  assert.equal(calls.length, 0);
  requireTurn((await engine.prepare('chat', 'first'))).commit();
  assert.equal(await engine.prepare('chat', 'followup', undefined, { followup: true }), null);
  assert.equal(generations().length, 1);
  await engine.prepare('chat', 'direct');
  assert.equal(generations().at(-1)?.body.messages[0].content, 'first');
  engine.clear('chat');
  const before = calls.length;
  assert.equal(await engine.prepare('chat', 'after clear', undefined, { followup: true }), null);
  assert.equal(calls.length, before);
});

test('followup trimming retains minimal evidence or stays silent without changing history', async () => {
  for (const dropped of [1, 2, 4]) {
    const { engine, calls, generations } = followupHarness({
      count: (body) => !isSeedTurn(body) && body.messages.length > (4 - dropped) * 2 + 1 ? 91 : 20,
    });
    for (let turn = 0; turn < 4; turn++) {
      requireTurn((await engine.prepare('chat', `turn${turn}`))).commit();
    }
    calls.length = 0;
    const turn = await engine.prepare('chat', 'followup', undefined, { followup: true });
    const counts = calls.filter((call) => call.url.endsWith('/count_tokens'));
    const lengths = counts.map(({ body }) => body.messages.length);
    assert.equal(new Set(lengths).size, lengths.length);
    if (dropped === 4) {
      assert.equal(turn, null);
      assert.equal(generations().length, 0);
    } else {
      assert.ok(turn);
      const generated = generations()[0].body;
      assert.equal(generated.messages[0].content, `turn${dropped}`);
      assert.equal(generated.messages.length, (4 - dropped) * 2 + 1);
      assert.ok(counts.some(({ body }) => JSON.stringify(body) === JSON.stringify({
        model: generated.model,
        system: generated.system,
        messages: generated.messages,
        tools: generated.tools,
        tool_choice: generated.tool_choice,
      })));
      requireTurn(turn).commit();
    }
    await engine.prepare('chat', 'direct');
    assert.equal(generations().at(-1)?.body.messages[0].content, `turn${dropped === 4 ? 0 : dropped}`);
  }
});

test('followup counts include identical decision system, tools and choice at the 100K boundary', async () => {
  const { engine, calls, generations } = followupHarness({
    config: { contextTokens: 100_000, maxOutputTokens: 1_000 },
    count: (body) => !isSeedTurn(body) ? 99_000 : 20,
  });
  requireTurn((await engine.prepare('chat', 'first'))).commit();
  await engine.prepare('chat', 'followup', undefined, { followup: true });
  const generated = generations().at(-1)?.body;
  const counted = calls.findLast((call) => call.url.endsWith('/count_tokens'))?.body;
  assert.ok(generated);
  assert.ok(counted);
  const { max_tokens, cache_control, ...input } = generated;
  assert.equal(max_tokens, 1_000);
  assert.deepEqual(counted, input);
});

test('oversized followup decision overhead never generates and preserves prior history', async () => {
  const { engine, calls, generations } = followupHarness({
    config: { contextTokens: 100_000, maxOutputTokens: 1_000 },
    count: (body) => !isSeedTurn(body) ? 99_001 : 20,
  });
  requireTurn((await engine.prepare('chat', 'first'))).commit();
  await assert.rejects(
    engine.prepare('chat', 'followup', undefined, { followup: true }),
    hasCode('CONTEXT_TOO_LARGE'),
  );
  assert.equal(generations().length, 1);
  const counts = calls.filter((call) => call.url.endsWith('/count_tokens') && !isSeedTurn(call.body));
  assert.deepEqual(counts.map((call) => call.body.messages.length), [3, 1]);
  assert.deepEqual(counts[0].body.tools, counts[1].body.tools);
  assert.deepEqual(counts[0].body.tool_choice, counts[1].body.tool_choice);
  await engine.prepare('chat', 'direct');
  assert.equal(generations().at(-1)?.body.messages[0].content, 'first');
});

test('malformed decisions fail closed and never enter history for either trigger mode', async () => {
  const valid = followupResult(true, 'reply');
  const block = valid.content[0];
  const invalidInputs = [
    null, [], {}, { shouldReply: true }, { reply: 'reply' },
    { shouldReply: 'true', reply: 'reply' }, { shouldReply: 1, reply: 'reply' },
    { shouldReply: true, reply: null }, { shouldReply: true, reply: '   ' },
    { shouldReply: true, reply: 'reply', extra: 'control' },
    { shouldReply: false, reply: 'must not leak' },
  ];
  const failures = [
    ...invalidInputs.map((input) => ({ ...valid, content: [{ ...block, input }] })),
    { ...valid, stop_reason: 'end_turn' },
    { ...valid, stop_reason: 'refusal' },
    { ...valid, stop_reason: undefined },
    { ...valid, content: [] },
    { ...valid, content: [block, block] },
    { ...valid, content: [{ type: 'text', text: 'control' }, block] },
    { ...valid, content: [{ ...block, type: 'text' }] },
    { ...valid, content: [{ ...block, name: 'other' }] },
    { ...valid, content: [{ ...block, id: '' }] },
  ];
  for (const followup of [false, true]) {
    for (const result of failures) {
      const { engine, generations } = followupHarness({ generate: () => result });
      requireTurn(await engine.prepare('chat', 'first')).commit();
      await assert.rejects(
        engine.prepare('chat', 'bad decision', undefined, { followup }),
        hasCode('INVALID_RESPONSE'),
      );
      await engine.prepare('chat', 'direct');
      assert.deepEqual(generations().at(-1)?.body.messages.map((message) => message.content), [
        'first', '先前的回答', 'direct',
      ]);
    }
  }
});

test('truncated followup decisions return safe OUTPUT_TRUNCATED errors', async () => {
  const { engine } = followupHarness({
    generate: () => ({ ...followupResult(true, 'partial'), stop_reason: 'max_tokens' }),
  });
  requireTurn((await engine.prepare('chat', 'first'))).commit();
  await assert.rejects(
    engine.prepare('chat', 'followup', undefined, { followup: true }),
    hasCode('OUTPUT_TRUNCATED'),
  );
});

test('followup cancellation before and during generation never commits a decision', async () => {
  const active = new AbortController();
  const { engine, calls, generations } = followupHarness({
    generate: () => {
      active.abort();
      return followupResult(true, 'must not send');
    },
  });
  requireTurn((await engine.prepare('chat', 'first'))).commit();
  const preAborted = new AbortController();
  preAborted.abort();
  const before = calls.length;
  await assert.rejects(
    engine.prepare('chat', 'pre-aborted', preAborted.signal, { followup: true }),
    hasCode('ABORTED'),
  );
  assert.equal(calls.length, before);
  await assert.rejects(
    engine.prepare('chat', 'in-flight', active.signal, { followup: true }),
    hasCode('ABORTED'),
  );
  await engine.prepare('chat', 'direct');
  assert.deepEqual(generations().at(-1)?.body.messages.map((message) => message.content), [
    'first', '先前的回答', 'direct',
  ]);
});

test('aborting after a followup prepare invalidates its commit', async () => {
  const { engine, generations } = followupHarness();
  requireTurn((await engine.prepare('chat', 'first'))).commit();
  const controller = new AbortController();
  const turn = await engine.prepare('chat', 'followup', controller.signal, { followup: true });
  assert.ok(turn);
  controller.abort();
  requireTurn(turn).commit();
  await engine.prepare('chat', 'direct');
  assert.deepEqual(generations().at(-1)?.body.messages.map((message) => message.content), [
    'first', '先前的回答', 'direct',
  ]);
});

test('owner turns must reply while ordinary followups may stay silent', async () => {
  let reply = true;
  const { engine } = harness({ generate: () => followupResult(reply, reply ? 'yes' : '') });
  requireTurn(await engine.prepare('chat', 'owner', undefined, { owner: true })).commit();
  reply = false;
  await assert.rejects(engine.prepare('chat', 'owner again', undefined, { owner: true }), hasCode('INVALID_RESPONSE'));
  assert.equal(await engine.prepare('chat', 'member', undefined, { followup: true }), null);
});

test('draw decisions acknowledge first, then draw with the decision context in a second request', async () => {
  let input: Record<string, unknown> = { shouldReply: true, reply: '', draw: '一隻灰貓' };
  let drawn: unknown = { svg: '<svg/>' };
  const { engine, generations } = harness({ generate: body => ({
    stop_reason: 'tool_use',
    content: [isRecord(body.tool_choice) && body.tool_choice.name === 'draw_svg'
      ? { type: 'tool_use', id: 'toolu_draw', name: 'draw_svg', input: drawn }
      : { type: 'tool_use', id: 'toolu_image', name: 'conversation_reply', input }],
  }) });
  const turn = requireTurn(await engine.prepare('chat', 'draw'));
  // An empty reply still yields an acknowledgement so the member knows drawing started.
  assert.equal(turn.text, '收到，正在畫圖，請稍等。');
  assert.ok(turn.draw);
  assert.equal(generations().length, 1);
  assert.equal(await turn.draw(new AbortController().signal), '<svg/>');
  const request = generations()[1].body;
  assert.deepEqual(request.messages.map(message => message.content), ['draw']);
  assert.match(request.system.at(-1)?.text ?? '', /一隻灰貓/);
  turn.commit();
  for (const bad of [{ svg: ' ' }, {}, 'x']) {
    drawn = bad;
    await assert.rejects(turn.draw(new AbortController().signal), hasCode('INVALID_RESPONSE'));
  }
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(turn.draw(aborted.signal), hasCode('ABORTED'));
  input = { shouldReply: true, reply: 'next' };
  requireTurn(await engine.prepare('chat', 'again'));
  assert.deepEqual(generations().at(-1)?.body.messages.map(message => message.content),
    ['draw', '收到，正在畫圖，請稍等。\n（附上一張圖片）', 'again']);
  for (const bad of [
    { shouldReply: false, reply: '', draw: 'x' },
    { shouldReply: true, reply: 'x', draw: ' ' },
    { shouldReply: true, reply: 'x', draw: 1 },
  ]) {
    input = bad;
    await assert.rejects(engine.prepare('chat', 'bad'), hasCode('INVALID_RESPONSE'));
  }
});

test('file decisions acknowledge first, then write the body in a second request', async () => {
  let input: Record<string, unknown> = { shouldReply: true, reply: '', draw: '圖', file: { name: 'a.pdf', description: '會議紀錄' } };
  let body: unknown = { content: '第一行' };
  const { engine, generations } = harness({ generate: request => ({
    stop_reason: 'tool_use',
    content: [isRecord(request.tool_choice) && request.tool_choice.name === 'write_file'
      ? { type: 'tool_use', id: 'toolu_write', name: 'write_file', input: body }
      : { type: 'tool_use', id: 'toolu_file', name: 'conversation_reply', input }],
  }) });
  const turn = requireTurn(await engine.prepare('chat', 'make'));
  // The file acknowledgement wins when both a picture and a file were requested.
  assert.deepEqual([turn.text, typeof turn.draw, turn.file?.name], ['收到，正在準備檔案，請稍等。', 'function', 'a.pdf']);
  assert.ok(turn.file);
  assert.equal(generations().length, 1);
  assert.equal(await turn.file.write(new AbortController().signal), '第一行');
  const system = generations()[1].body.system.at(-1)?.text ?? '';
  assert.match(system, /"a\.pdf"/);
  assert.match(system, /會議紀錄/);
  assert.match(system, /do not use Markdown/);
  body = { content: '' };
  await assert.rejects(turn.file.write(new AbortController().signal), hasCode('INVALID_RESPONSE'));
  turn.commit();
  input = { shouldReply: true, reply: 'next' };
  requireTurn(await engine.prepare('chat', 'again'));
  assert.deepEqual(generations().at(-1)?.body.messages.map(message => message.content),
    ['make', '收到，正在準備檔案，請稍等。\n（附上一張圖片）\n（附上檔案 a.pdf）', 'again']);
  for (const file of [{ name: 'a.txt', description: ' ' }, { name: 'a.txt' }, { name: 1, description: 'x' }, { name: 'a.txt', description: 'x', extra: 1 }, 'a.txt']) {
    input = { shouldReply: true, reply: '', file };
    await assert.rejects(engine.prepare('chat', 'bad'), hasCode('INVALID_RESPONSE'));
  }
  input = { shouldReply: false, reply: '', file: { name: 'a.txt', description: 'x' } };
  await assert.rejects(engine.prepare('chat', 'bad'), hasCode('INVALID_RESPONSE'));
});
