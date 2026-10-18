import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatEngine, ChatError } from '../src/chat.js';

const claude = {
  apiKey: 'test-secret-key',
  model: 'claude-haiku-5-5',
  contextTokens: 100,
  maxOutputTokens: 10,
  timeoutMs: 1_000,
};

function harness({ count = () => 20, generate, config = {} } = {}) {
  const calls = [];
  const engine = new ChatEngine({
    claude: { ...claude, ...config },
    system: 'Always be a helpful cat.',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      const call = { url, options, body };
      calls.push(call);
      if (url.endsWith('/count_tokens')) {
        const result = await count(body, calls);
        return result instanceof Response ? result : Response.json({ input_tokens: result });
      }
      const result = generate ? await generate(body, calls) : {
        content: [{ type: 'text', text: `answer:${body.messages.at(-1).content}` }],
        stop_reason: 'end_turn',
      };
      return result instanceof Response ? result : Response.json(result);
    },
  });
  return {
    engine,
    calls,
    generations: () => calls.filter((call) => call.url.endsWith('/messages')),
  };
}

function hasCode(code, status) {
  return (error) => {
    assert.ok(error instanceof ChatError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.ok(!JSON.stringify(error).includes(claude.apiKey));
    return true;
  };
}

test('accepts the exact input plus reserved-output context boundary', async () => {
  const { engine, generations } = harness({ count: () => 90 });
  const turn = await engine.prepare('chat', 'hello');
  turn.commit();
  assert.equal(generations().length, 1);
  await engine.prepare('chat', 'next');
  assert.equal(generations()[1].body.messages[0].content, 'hello');
});

test('drops only the oldest complete pair and counts the retained request', async () => {
  const { engine, calls, generations } = harness({ count: (body) => body.messages.length * 20 });
  (await engine.prepare('chat', 'first')).commit();
  (await engine.prepare('chat', 'second')).commit();
  const third = await engine.prepare('chat', 'third');
  const expected = [
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'answer:second' },
    { role: 'user', content: 'third' },
  ];
  assert.deepEqual(generations()[2].body.messages, expected);
  assert.ok(calls.some((call) => call.url.endsWith('/count_tokens') &&
    JSON.stringify(call.body.messages) === JSON.stringify(expected)));
  third.commit();
  await engine.prepare('chat', 'fourth');
  assert.deepEqual(generations()[3].body.messages.map((message) => message.content), [
    'third', 'answer:third', 'fourth',
  ]);
});

test('can discard all history while preserving the newest input', async () => {
  const { engine, generations } = harness({ count: (body) => body.messages.length === 1 ? 20 : 95 });
  (await engine.prepare('chat', 'old')).commit();
  await engine.prepare('chat', 'new');
  assert.deepEqual(generations()[1].body.messages, [{ role: 'user', content: 'new' }]);
});

test('oversized system plus current input never generates or truncates', async () => {
  const { engine, calls, generations } = harness({ count: () => 91 });
  await assert.rejects(engine.prepare('chat', 'keep the complete input'), hasCode('CONTEXT_TOO_LARGE'));
  assert.equal(generations().length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.messages[0].content, 'keep the complete input');
  assert.equal(calls[0].body.system, 'Always be a helpful cat.');
});

test('oversized current input still fails after every old pair is removed', async () => {
  const { engine, generations } = harness({
    count: (body) => body.messages.at(-1).content === 'oversized' ? 91 : 20,
  });
  (await engine.prepare('chat', 'old')).commit();
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
  (await engine.prepare('a', 'committed')).commit();
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
  first.commit();
  first.commit();
  stale.commit();
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
    pending.commit();
    fresh.commit();
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
  pending.commit();
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
  let fetchSignal;
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
  assert.equal(fetchSignal.aborted, true);
});

test('joins text response blocks without losing their contents', async () => {
  const { engine } = harness({ generate: () => ({
    content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
    stop_reason: 'end_turn',
  }) });
  assert.equal((await engine.prepare('chat', 'hello')).text, 'first\nsecond');
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
    const { engine, generations } = harness({ generate: () => fail ? result : {
      content: [{ type: 'text', text: 'good' }], stop_reason: 'end_turn',
    } });
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

function followupResult(shouldReply, reply) {
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

function followupHarness(options = {}) {
  return harness({
    ...options,
    generate: (body, calls) => body.tools
      ? (options.generate ?? (() => followupResult(true, '自然的回答')))(body, calls)
      : { content: [{ type: 'text', text: '先前的回答' }], stop_reason: 'end_turn' },
  });
}

test('unrelated followups return null without contaminating or trimming history', async () => {
  const { engine, generations } = followupHarness({
    generate: () => followupResult(false, ''),
    count: (body) => body.tools && body.messages.length > 3 ? 95 : 20,
  });
  (await engine.prepare('chat', 'first')).commit();
  (await engine.prepare('chat', 'second')).commit();
  assert.equal(await engine.prepare('chat', 'unrelated', undefined, { followup: true }), null);
  await engine.prepare('chat', 'direct');
  assert.deepEqual(generations().at(-1).body.messages.map((message) => message.content), [
    'first', '先前的回答', 'second', '先前的回答', 'direct',
  ]);
});

test('relevant followups commit only plain reply text and remain transactional', async () => {
  const { engine, generations } = followupHarness();
  (await engine.prepare('chat', 'first')).commit();
  const uncommitted = await engine.prepare('chat', 'not sent', undefined, { followup: true });
  assert.equal(uncommitted.text, '自然的回答');
  const turn = await engine.prepare('chat', 'followup', undefined, { followup: true });
  assert.deepEqual(generations()[2].body.messages.map((message) => message.content), [
    'first', '先前的回答', 'followup',
  ]);
  turn.commit();
  turn.commit();
  uncommitted.commit();
  await engine.prepare('chat', 'direct');
  const direct = generations().at(-1).body;
  assert.deepEqual(direct.messages.map((message) => message.content), [
    'first', '先前的回答', 'followup', '自然的回答', 'direct',
  ]);
  assert.equal(direct.tools, undefined);
  assert.equal(direct.tool_choice, undefined);
  assert.equal(direct.system, 'Always be a helpful cat.');
});

test('followups without retained conversational evidence stay silent without generating', async () => {
  const { engine, calls, generations } = followupHarness({
    count: (body) => body.tools && body.messages.length > 1 ? 95 : 20,
  });
  assert.equal(await engine.prepare('empty', 'hello', undefined, { followup: true }), null);
  assert.equal(calls.length, 0);
  (await engine.prepare('chat', 'first')).commit();
  assert.equal(await engine.prepare('chat', 'followup', undefined, { followup: true }), null);
  assert.equal(generations().length, 1);
  await engine.prepare('chat', 'direct');
  assert.equal(generations().at(-1).body.messages[0].content, 'first');
  engine.clear('chat');
  const before = calls.length;
  assert.equal(await engine.prepare('chat', 'after clear', undefined, { followup: true }), null);
  assert.equal(calls.length, before);
});

test('followup counts include identical decision system, tools and choice at the 100K boundary', async () => {
  const { engine, calls, generations } = followupHarness({
    config: { contextTokens: 100_000, maxOutputTokens: 1_000 },
    count: (body) => body.tools ? 99_000 : 20,
  });
  (await engine.prepare('chat', 'first')).commit();
  await engine.prepare('chat', 'followup', undefined, { followup: true });
  const generated = generations().at(-1).body;
  const counted = calls.findLast((call) => call.url.endsWith('/count_tokens')).body;
  const { max_tokens, cache_control, ...input } = generated;
  assert.equal(max_tokens, 1_000);
  assert.deepEqual(counted, input);
});

test('oversized followup decision overhead never generates and preserves prior history', async () => {
  const { engine, calls, generations } = followupHarness({
    config: { contextTokens: 100_000, maxOutputTokens: 1_000 },
    count: (body) => body.tools ? 99_001 : 20,
  });
  (await engine.prepare('chat', 'first')).commit();
  await assert.rejects(
    engine.prepare('chat', 'followup', undefined, { followup: true }),
    hasCode('CONTEXT_TOO_LARGE'),
  );
  assert.equal(generations().length, 1);
  const counts = calls.filter((call) => call.url.endsWith('/count_tokens') && call.body.tools);
  assert.deepEqual(counts.map((call) => call.body.messages.length), [3, 1]);
  assert.deepEqual(counts[0].body.tools, counts[1].body.tools);
  assert.deepEqual(counts[0].body.tool_choice, counts[1].body.tool_choice);
  await engine.prepare('chat', 'direct');
  assert.equal(generations().at(-1).body.messages[0].content, 'first');
});

test('malformed followup decisions fail closed and never enter history', async () => {
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
  for (const result of failures) {
    const { engine, generations } = followupHarness({ generate: () => result });
    (await engine.prepare('chat', 'first')).commit();
    await assert.rejects(
      engine.prepare('chat', 'bad followup', undefined, { followup: true }),
      hasCode('INVALID_RESPONSE'),
    );
    await engine.prepare('chat', 'direct');
    assert.deepEqual(generations().at(-1).body.messages.map((message) => message.content), [
      'first', '先前的回答', 'direct',
    ]);
  }
});

test('truncated followup decisions return safe OUTPUT_TRUNCATED errors', async () => {
  const { engine } = followupHarness({
    generate: () => ({ ...followupResult(true, 'partial'), stop_reason: 'max_tokens' }),
  });
  (await engine.prepare('chat', 'first')).commit();
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
  (await engine.prepare('chat', 'first')).commit();
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
  assert.deepEqual(generations().at(-1).body.messages.map((message) => message.content), [
    'first', '先前的回答', 'direct',
  ]);
});

test('aborting after a followup prepare invalidates its commit', async () => {
  const { engine, generations } = followupHarness();
  (await engine.prepare('chat', 'first')).commit();
  const controller = new AbortController();
  const turn = await engine.prepare('chat', 'followup', controller.signal, { followup: true });
  controller.abort();
  turn.commit();
  await engine.prepare('chat', 'direct');
  assert.deepEqual(generations().at(-1).body.messages.map((message) => message.content), [
    'first', '先前的回答', 'direct',
  ]);
});
