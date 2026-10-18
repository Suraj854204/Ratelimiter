'use strict';

// Context-aware rate limiter.
//
// - Rules are a plain lookup table: RULES[tier][endpointType].
// - Usage lives in a Map in process memory (fixed window per key).
// - The endpoint type comes from a tag attached to the route when it is
//   defined (see rateLimit('ai')), never from the URL string.

const WINDOW_SECONDS = 60;

const RULES = Object.freeze({
  free: Object.freeze({
    ai: Object.freeze({ limit: 5, windowSeconds: WINDOW_SECONDS }),
    read: Object.freeze({ limit: 30, windowSeconds: WINDOW_SECONDS }),
  }),
  paid: Object.freeze({
    ai: Object.freeze({ limit: 30, windowSeconds: WINDOW_SECONDS }),
    read: Object.freeze({ limit: 120, windowSeconds: WINDOW_SECONDS }),
  }),
});

const ENDPOINT_TYPES = Object.freeze(['ai', 'read']);

// Missing or unrecognised X-User-Tier header => 'free'.
function resolveTier(req) {
  const raw = req.get('X-User-Tier');
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (value === 'free' || value === 'paid') return value;
  }
  return 'free';
}

// Who is the caller? Prefer an explicit X-User-Id header; fall back to the
// client IP so anonymous callers are still limited individually.
function resolveUserId(req) {
  const id = req.get('X-User-Id');
  if (typeof id === 'string' && id.trim() !== '') return id.trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || 'anonymous';
}

// In-memory fixed-window store.
//
// consume() is fully synchronous (no await between reading and writing the
// counter), so on Node's single-threaded event loop concurrent requests can
// never interleave inside the check-and-increment and corrupt the count.
class InMemoryStore {
  constructor({ now = Date.now, sweepIntervalMs = 60_000 } = {}) {
    this.now = now;
    this.entries = new Map(); // key -> { count, windowStart, windowMs }
    this.timer = null;
    if (sweepIntervalMs > 0) {
      this.timer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.timer.unref(); // never keep the process alive just for cleanup
    }
  }

  // Try to count one request against `key`.
  // Returns { allowed: boolean, retryAfterSeconds: number }.
  consume(key, limit, windowSeconds) {
    const windowMs = windowSeconds * 1000;
    const t = this.now();
    let entry = this.entries.get(key);

    // New key, or the previous window has fully elapsed: start a fresh window.
    if (!entry || t - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: t, windowMs };
      this.entries.set(key, entry);
    }

    if (entry.count >= limit) {
      const remainingMs = entry.windowStart + windowMs - t;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(0, Math.ceil(remainingMs / 1000)),
      };
    }

    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  // Drop expired entries so memory does not grow with every caller seen.
  sweep() {
    const t = this.now();
    for (const [key, entry] of this.entries) {
      if (t - entry.windowStart >= entry.windowMs) this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// Build the middleware factory around a store.
//
//   const { rateLimit } = createRateLimiter();
//   app.post('/ai/generate', rateLimit('ai'), handler);
//
// rateLimit(type) is the route-level tag: the endpoint type is bound when the
// route is defined, so the URL is never inspected.
function createRateLimiter({ store = new InMemoryStore(), rules = RULES } = {}) {
  function rateLimit(endpointType) {
    if (!ENDPOINT_TYPES.includes(endpointType)) {
      throw new Error(
        `Unknown endpoint type "${endpointType}". Expected one of: ${ENDPOINT_TYPES.join(', ')}`
      );
    }

    return function rateLimitMiddleware(req, res, next) {
      const tier = resolveTier(req);
      const userId = resolveUserId(req);
      const { limit, windowSeconds } = rules[tier][endpointType];

      const key = `${userId}|${tier}|${endpointType}`;
      const result = store.consume(key, limit, windowSeconds);

      if (!result.allowed) {
        return res.status(429).json({
          error: 'rate_limit_exceeded',
          limit,
          window_seconds: windowSeconds,
          retry_after_seconds: result.retryAfterSeconds,
        });
      }
      return next();
    };
  }

  return { rateLimit, store };
}

module.exports = {
  RULES,
  ENDPOINT_TYPES,
  InMemoryStore,
  createRateLimiter,
  resolveTier,
  resolveUserId,
};