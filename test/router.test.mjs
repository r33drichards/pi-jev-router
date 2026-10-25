import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pack, offlineMeter, Router, Coordinator, MODEL, LIMIT, parseDecision, typeSafeAdapter, isStop } from '../dist/index.js';
const entry = (id, text = id) => ({ id, speaker: 'synthetic', text });
const incoming = (id, text = id, channel = '#synthetic') => ({ ...entry(id, text), channel });
const snapshot = (message = incoming('new')) => ({ incoming: message, busy: true, channelHistory: [], piContext: [] });
const answer = (action = 'queue', confidence = 1) => ({ model: MODEL, answers: { route: { type: 'choice', choice: action, confidence, probabilities: { ignore: 0, queue: 0, interrupt: 0, [action]: 1 } } } });
const mock = fn => ({ mode: 'mock', classify: fn });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('empty history stays empty, overhead reserved, exact boundary accepted', () => {
  const s = snapshot(); const overhead = pack(s).overhead;
  assert.equal(pack(s, offlineMeter, overhead).units, overhead);
  assert.throws(() => pack(s, offlineMeter, overhead - 1));
  assert.deepEqual(pack(s).request.state.channelHistory, []);
  assert.throws(() => pack(s, offlineMeter, LIMIT + 1));
  assert.throws(() => pack(s, { ...offlineMeter, request: () => NaN }));
});
test('50/50 newest complete suffix, no borrowing from empty side', () => {
  const s = snapshot(); s.channelHistory = Array.from({ length: 100 }, (_, i) => entry(String(i), 'x'.repeat(1000)));
  const p = pack(s);
  assert(p.units <= LIMIT);
  assert(p.units <= p.overhead + p.allowancePerSide);
  const selected = p.request.state.channelHistory;
  assert(selected.length > 0 && selected.length < 100);
  assert.deepEqual(selected, s.channelHistory.slice(-selected.length));
  assert.deepEqual(p.request.state.piContext, []);
});
test('Unicode, escaping, huge newest entries and huge incoming never truncate or overflow', () => {
  for (const text of ['🧑🏽‍💻漢字', '\u0000"\\\n', '\ud800', 'a'.repeat(100_000)]) {
    const s = snapshot(); s.channelHistory = [entry('old'), entry('last', text.repeat(100))]; s.piContext = [entry('pi', 'safe')];
    const p = pack(s); assert(p.units <= LIMIT);
    for (const e of p.request.state.channelHistory) assert.deepEqual(e, s.channelHistory.find(x => x.id === e.id));
  }
  assert.equal(pack({ ...snapshot(), channelHistory: [entry('small'), entry('large', 'x'.repeat(100_000))] }).request.state.channelHistory.length, 0);
  assert.throws(() => pack(snapshot(incoming('huge', '🦊'.repeat(20_000)))));
});
test('both halves fill without crossing envelope, randomized Unicode boundaries', () => {
  for (let n = 1; n < 70; n++) {
    const s = snapshot(); s.channelHistory = Array.from({ length: n }, (_, i) => entry(String(i), '🦊漢\n'.repeat(n))); s.piContext = [...s.channelHistory];
    const p = pack(s, offlineMeter, 3000 + n * 100);
    assert(p.units <= 3000 + n * 100);
    for (const side of ['channelHistory', 'piContext']) {
      const isolated = structuredClone(p.request); isolated.state.channelHistory = []; isolated.state.piContext = []; isolated.state[side] = p.request.state[side];
      assert(offlineMeter.request(isolated) - p.overhead <= p.allowancePerSide);
    }
  }
});
test('malformed, wrong model, low confidence, contradictory probabilities fail closed', () => {
  for (const raw of [null, {}, 'queue', { ...answer(), model: 'other' }, answer('queue', 0.79)]) assert.equal(parseDecision(raw).action, 'ignore');
  for (const probabilities of [{ ignore: 0, queue: 0.3, interrupt: 0.7 }, { ignore: 0, queue: 1.1, interrupt: -0.1 }, { ignore: 0, queue: 1 }, { ignore: 0, queue: 1, interrupt: 0, extra: 0 }]) {
    const a = answer(); a.answers.route.probabilities = probabilities; assert.equal(parseDecision(a).reason, 'malformed');
  }
  assert.equal(parseDecision(answer('interrupt')).action, 'interrupt');
});
test('default and unverified live modes never invoke transport; commands bypass mocks too', async () => {
  let calls = 0; const transport = async () => { calls++; return answer(); };
  assert.equal((await new Router().decide(snapshot())).reason, 'disabled');
  assert.equal((await new Router({ enableLive: true, adapter: typeSafeAdapter(transport, true) }).decide(snapshot())).reason, 'live-not-ready');
  await assert.rejects(() => typeSafeAdapter(transport).classify(pack(snapshot()).request, new AbortController().signal));
  const router = new Router({ adapter: mock(transport) });
  for (const text of [',stop', ',help', ' ,STOP now', ',unknown']) assert.equal((await router.decide(snapshot(incoming('cmd', text)))).reason, 'host-command');
  assert.equal(calls, 0); assert(!isStop(',stopper')); assert(isStop(',stop now'));
});
test('timeouts, rejected/synchronous transports, cancellation, over-budget fail closed', async () => {
  let signal;
  const router = new Router({ timeoutMs: 5, adapter: mock((_r, s) => { signal = s; return new Promise(() => {}); }) });
  assert.equal((await router.decide(snapshot())).reason, 'timeout'); assert(signal.aborted);
  assert.equal((await new Router({ adapter: mock(() => { throw Error('synthetic'); }) }).decide(snapshot())).reason, 'error');
  const controller = new AbortController(); controller.abort(); assert.equal((await router.decide(snapshot(), controller.signal)).reason, 'cancelled');
  assert.equal((await router.decide(snapshot(incoming('large', 'x'.repeat(40_000))))).reason, 'error');
});
function harness(adapter) {
  const events = []; const generations = new Map();
  const host = {
    invalidate: (channel, generation) => { generations.set(channel, generation); events.push('invalidate'); },
    stop: async () => { events.push('stop'); },
    command: async message => { events.push(message.text); },
    snapshot: async message => snapshot(message),
    apply: async (decision, message, generation) => { if ((generations.get(message.channel) ?? 0) === generation) events.push(`${decision.action}:${message.id}`); },
  };
  return { host, events, coordinator: new Coordinator(new Router({ adapter, timeoutMs: 100 }), host) };
}
test('same-channel arrivals classify and apply FIFO; channels proceed independently', async () => {
  const gate = deferred(); const started = deferred(); const seen = [];
  const h = harness(mock(async request => { seen.push(request.state.incoming.id); if (request.state.incoming.id === 'a') { started.resolve(); await gate.promise; } return answer(); }));
  const a = h.coordinator.receive(incoming('a')); const b = h.coordinator.receive(incoming('b')); await started.promise;
  await h.coordinator.receive(incoming('c', 'c', '#other')); assert.deepEqual(seen, ['a', 'c']);
  gate.resolve(); await Promise.all([a, b]); assert.deepEqual(h.events, ['queue:c', 'queue:a', 'queue:b']);
});
test('stop bypasses pending inference, invalidates queued work; late result cannot insert', async () => {
  const gate = deferred(); const started = deferred();
  const h = harness(mock(async () => { started.resolve(); await gate.promise; return answer('interrupt'); }));
  const a = h.coordinator.receive(incoming('a')); const b = h.coordinator.receive(incoming('b')); await started.promise;
  await h.coordinator.receive(incoming('stop', ',stop')); gate.resolve();
  assert.equal((await a).reason, 'superseded'); assert.equal((await b).reason, 'superseded');
  assert.deepEqual(h.events, ['invalidate', 'stop']);
  await h.coordinator.receive(incoming('help', ',help')); assert.equal(h.events.at(-1), ',help');
});
test('stop failure blocks future insertion; host failures do not reject ordinary arrivals', async () => {
  const h = harness(mock(async () => answer())); h.host.stop = async () => { throw Error('synthetic'); };
  await assert.rejects(h.coordinator.receive(incoming('stop', ',stop')));
  assert.equal((await h.coordinator.receive(incoming('later'))).reason, 'host-error');
  assert(!h.events.some(e => e.startsWith('queue:')));
});
test('bounded pending queue sheds load', async () => {
  const gate = deferred(); const h = harness(mock(async () => { await gate.promise; return answer(); }));
  const coordinator = new Coordinator(new Router({ adapter: mock(async () => { await gate.promise; return answer(); }) }), h.host, 1);
  const first = coordinator.receive(incoming('a')); assert.equal((await coordinator.receive(incoming('b'))).reason, 'overloaded'); gate.resolve(); await first;
});
test('host generation fence prevents submission after an in-flight interrupt abort', async () => {
  const abortBarrier = deferred(); const entered = deferred(); const events = []; let generation = 0;
  const host = {
    invalidate: (_channel, next) => { generation = next; },
    stop: async () => { events.push('stop'); },
    command: async () => {}, snapshot: async message => snapshot(message),
    apply: async (_decision, message, expected) => {
      entered.resolve(); await abortBarrier.promise;
      if (expected === generation) events.push(message.id);
    },
  };
  const coordinator = new Coordinator(new Router({ adapter: mock(async () => answer('interrupt')) }), host);
  const first = coordinator.receive(incoming('first')); await entered.promise;
  await coordinator.receive(incoming('stop', ',stop')); abortBarrier.resolve(); await first;
  assert.deepEqual(events, ['stop']);
});
test('new arrivals wait for the stop barrier', async () => {
  const stopped = deferred(); const h = harness(mock(async () => answer()));
  h.host.stop = async () => { h.events.push('stop-start'); await stopped.promise; h.events.push('stop-done'); };
  const stop = h.coordinator.receive(incoming('stop', ',stop'));
  const next = h.coordinator.receive(incoming('next'));
  await Promise.resolve(); assert.deepEqual(h.events, ['invalidate', 'stop-start']);
  stopped.resolve(); await Promise.all([stop, next]);
  assert.deepEqual(h.events, ['invalidate', 'stop-start', 'stop-done', 'queue:next']);
});
