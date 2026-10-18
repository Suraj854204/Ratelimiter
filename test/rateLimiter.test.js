'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const { createRateLimiter, InMemoryStore } = require('../src/rateLimiter');

// Spin up the app on an ephemeral port with a controllable clock.
async function setup() {
  const clock = { t: 1_000_000 };
  const store = new InMemoryStore({ now: () => clock.t, sweepIntervalMs: 0 });
  const app = createApp({ limiter: createRateLimiter({ store }) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = (method, path, headers = {}) =>
    fetch(base + path, { method, headers });

  return {
    clock,
    call,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function hit(call, n, method, path, headers) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await call(method, path, headers));
  return out;
}

const cases = [
  { tier: 'free', type: 'ai', method: 'POST', path: '/ai/generate', limit: 5 },
  { tier: 'free', type: 'read', method: 'GET', path: '/data/list', limit: 30 },
  { tier: 'paid', type: 'ai', method: 'POST', path: '/ai/summarise', limit: 30 },
  { tier: 'paid', type: 'read', method: 'GET', path: '/data/export', limit: 120 },
];

for (const c of cases) {
  test(`${c.tier}/${c.type}: allows ${c.limit}, rejects ${c.limit + 1}th with 429`, async () => {
    const { call, close } = await setup();
    try {
      const headers = { 'X-User-Tier': c.tier, 'X-User-Id': 'u1' };
      const allowed = await hit(call, c.limit, c.method, c.path, headers);
      assert.ok(allowed.every((r) => r.status === 200));
      assert.deepStrictEqual(await allowed[0].json(), { ok: true });

      const blocked = await call(c.method, c.path, headers);
      assert.strictEqual(blocked.status, 429);
      const body = await blocked.json();
      assert.deepStrictEqual(Object.keys(body).sort(), [
        'error', 'limit', 'retry_after_seconds', 'window_seconds',
      ]);
      assert.strictEqual(body.error, 'rate_limit_exceeded');
      assert.strictEqual(body.limit, c.limit);
      assert.strictEqual(body.window_seconds, 60);
    } finally {
      await close();
    }
  });
}

test('retry_after_seconds reflects time left in window and is never negative', async () => {
  const { call, clock, close } = await setup();
  try {
    const h = { 'X-User-Tier': 'free', 'X-User-Id': 'u1' };
    await hit(call, 5, 'POST', '/ai/generate', h);

    clock.t += 26_000; // 26s into the window -> 34s left
    let body = await (await call('POST', '/ai/generate', h)).json();
    assert.strictEqual(body.retry_after_seconds, 34);

    clock.t += 33_500; // 59.5s in -> 0.5s left, rounds up to 1
    body = await (await call('POST', '/ai/generate', h)).json();
    assert.strictEqual(body.retry_after_seconds, 1);
    assert.ok(body.retry_after_seconds >= 0);
  } finally {
    await close();
  }
});

test('limit resets once the window has elapsed', async () => {
  const { call, clock, close } = await setup();
  try {
    const h = { 'X-User-Tier': 'free', 'X-User-Id': 'u1' };
    await hit(call, 5, 'POST', '/ai/generate', h);
    assert.strictEqual((await call('POST', '/ai/generate', h)).status, 429);

    clock.t += 60_000;
    assert.strictEqual((await call('POST', '/ai/generate', h)).status, 200);
  } finally {
    await close();
  }
});

test('missing or invalid X-User-Tier is treated as free', async () => {
  const { call, close } = await setup();
  try {
    for (const headers of [
      { 'X-User-Id': 'a' },
      { 'X-User-Id': 'b', 'X-User-Tier': 'platinum' },
      { 'X-User-Id': 'c', 'X-User-Tier': '' },
    ]) {
      await hit(call, 5, 'POST', '/ai/generate', headers);
      const r = await call('POST', '/ai/generate', headers);
      assert.strictEqual(r.status, 429);
      assert.strictEqual((await r.json()).limit, 5);
    }
  } finally {
    await close();
  }
});

test('counters are isolated per user, per tier and per endpoint type', async () => {
  const { call, close } = await setup();
  try {
    const a = { 'X-User-Tier': 'free', 'X-User-Id': 'alice' };
    await hit(call, 5, 'POST', '/ai/generate', a);
    assert.strictEqual((await call('POST', '/ai/generate', a)).status, 429);

    // Same user, other endpoint type: unaffected.
    assert.strictEqual((await call('GET', '/data/list', a)).status, 200);
    // Different user: unaffected.
    assert.strictEqual(
      (await call('POST', '/ai/generate', { ...a, 'X-User-Id': 'bob' })).status, 200);
    // Same user, paid tier: own bucket.
    assert.strictEqual(
      (await call('POST', '/ai/generate', { ...a, 'X-User-Tier': 'paid' })).status, 200);
  } finally {
    await close();
  }
});

test('/ai/generate and /ai/summarise share one ai bucket', async () => {
  const { call, close } = await setup();
  try {
    const h = { 'X-User-Tier': 'free', 'X-User-Id': 'u1' };
    await hit(call, 3, 'POST', '/ai/generate', h);
    await hit(call, 2, 'POST', '/ai/summarise', h);
    assert.strictEqual((await call('POST', '/ai/generate', h)).status, 429);
  } finally {
    await close();
  }
});

test('concurrent burst never lets more than the limit through', async () => {
  const { call, close } = await setup();
  try {
    const h = { 'X-User-Tier': 'free', 'X-User-Id': 'u1' };
    const results = await Promise.all(
      Array.from({ length: 50 }, () => call('POST', '/ai/generate', h))
    );
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429).length;
    assert.strictEqual(ok, 5);
    assert.strictEqual(limited, 45);
  } finally {
    await close();
  }
});

test('rateLimit rejects unknown endpoint types at definition time', () => {
  const { rateLimit } = createRateLimiter({
    store: new InMemoryStore({ sweepIntervalMs: 0 }),
  });
  assert.throws(() => rateLimit('bogus'), /Unknown endpoint type/);
});

test('sweep removes expired entries', () => {
  const clock = { t: 0 };
  const store = new InMemoryStore({ now: () => clock.t, sweepIntervalMs: 0 });
  store.consume('k', 5, 60);
  assert.strictEqual(store.entries.size, 1);
  clock.t += 61_000;
  store.sweep();
  assert.strictEqual(store.entries.size, 0);
});
