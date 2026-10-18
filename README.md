# Context-Aware Rate Limiter

A small Express service whose middleware enforces different rate limits depending on **who is calling** (the `X-User-Tier` header) and **what they are calling** (a tag attached to each route). State is held entirely in process memory.



Quick check once deployed:

```
curl -i -X POST https://<your-deployment>/ai/generate -H "X-User-Tier: free" -H "X-User-Id: demo"
```

Send it six times and the sixth response is a `429`.

## How to run

You need Node.js 18 or newer. From the project folder, run `npm install` once, then `npm start`. The server listens on the port in the `PORT` environment variable, or 3000 if it is unset. To run the test suite, use `npm test`; it uses Node's built-in test runner and a fake clock, so it finishes in about a second and never has to wait for a real 60-second window.

The four required routes are `POST /ai/generate`, `POST /ai/summarise`, `GET /data/list` and `GET /data/export`. Each returns `{"ok": true}` with status 200 when the request is allowed. There is also a `GET /health` route that is deliberately not rate limited; it exists only so a hosting platform can check that the process is alive.

Callers identify themselves with two optional headers. `X-User-Tier` is `free` or `paid`. `X-User-Id` is an opaque user identifier; if it is missing, the client IP address is used instead.

The enforced limits, all over a 60-second window:

| Tier | `ai` endpoints | `read` endpoints |
|------|----------------|------------------|
| free | 5              | 30               |
| paid | 30             | 120              |

A rejected request gets HTTP 429 with a body such as:

```json
{
  "error": "rate_limit_exceeded",
  "limit": 5,
  "window_seconds": 60,
  "retry_after_seconds": 34
}
```

## Design decisions

**The endpoint type is a route tag, not something derived from the URL.** The middleware is produced by a factory, `rateLimit('ai')` or `rateLimit('read')`, and that call is written into the route definition itself (`app.post('/ai/generate', rateLimit('ai'), handler)`). The type is therefore bound when the route is declared, and the middleware never looks at `req.path` or `req.url`. This means a route can be renamed or moved without changing its limits, and a URL that merely looks like an AI route cannot accidentally be treated as one. The factory also throws immediately if given an unknown type, so a typo in a tag fails at startup rather than silently applying no limit.

**Rules are data, not branching logic.** The four limits live in one frozen lookup table indexed by tier and then endpoint type. The middleware resolves a tier, takes the endpoint type it was built with, and reads the rule from the table. Changing a limit, or adding a tier or a type, is a one-line edit and does not touch the enforcement code.

**Fixed window counters.** Each key holds a request count and the timestamp at which its window began. On every request the middleware checks whether the window has elapsed; if so, the count restarts from zero and a new window begins at the current time. I chose this over a sliding window or token bucket because the specification describes exactly "N requests per 60 seconds" with a reset when the window elapses, and a fixed window gives `retry_after_seconds` a precise and easy-to-verify meaning: the time left until the current window ends. It also needs only two numbers per key.

**The key is user, tier and endpoint type.** The key has the form `userId|tier|endpointType`. Including the endpoint type means exhausting your AI quota does not stop you from reading lists, and the two AI routes deliberately share one bucket because the limit belongs to the type, not the individual route. Including the tier means a user who upgrades starts with a fresh bucket for the paid rules rather than inheriting a half-used free one.

**Tier and user resolution fail safe.** A missing, empty or unrecognised `X-User-Tier` value is treated as `free`, the strictest tier. The header is trimmed and compared case-insensitively, so `Paid` and ` paid ` work. A caller can only ever gain from claiming `paid` falsely, which is a limitation discussed below, but a malformed value never grants anything extra.

**`retry_after_seconds` is rounded up and clamped.** The remaining time is computed at the moment of rejection as window end minus now, rounded up to a whole second, and clamped at zero. Rounding up means a client that waits exactly that long will not be rejected again for a fraction of a second. The clamp guarantees the value is never negative even if the clock moved unexpectedly.

**Concurrency safety comes from keeping the check-and-increment synchronous.** The store's `consume` method reads the entry, decides, and increments with no `await` in between. Node runs JavaScript on a single thread, so two requests can never interleave inside that method, and a burst of simultaneous requests cannot push the count past the limit. One test fires 50 parallel requests at a limit of 5 and asserts that exactly 5 succeed. This guarantee would need to be revisited if the store ever became asynchronous (for example, a network-backed store).

**Expired entries are swept.** Without cleanup, every distinct caller ever seen would stay in the map forever. A background timer removes entries whose window has elapsed once a minute. The timer is unreferenced so it never keeps the process alive on its own.

**The clock is injectable.** The store accepts a `now` function. Production uses `Date.now`; tests use a controllable counter, which is how window resets and exact `retry_after_seconds` values are tested without sleeping.

## Limitations

**State is lost on restart and not shared between processes.** Everything lives in one process's memory. If the process restarts or is redeployed, every counter resets, so a caller who was rate limited is immediately free again. If the service runs as several instances behind a load balancer, or Node's cluster mode, each instance counts separately, so a caller can get up to N times the intended limit by being spread across N instances. The specification forbids external state, so this is inherent to the approach; a shared store would be the fix in production.

**The tier header is trusted.** Anyone can send `X-User-Tier: paid` and receive the paid limits. A real system would derive the tier from an authenticated session or a signed token, not a client-supplied header. This implementation follows the specification, which defines the header as the source of truth.

**The user identifier is also client-supplied, and the IP fallback has weaknesses.** A caller can rotate `X-User-Id` values to obtain a fresh bucket each time and bypass the limit entirely. When no id is sent, the IP address is used, but behind a reverse proxy or load balancer every request may appear to come from the proxy's address unless Express's `trust proxy` setting is configured. In that case all anonymous users would share a single bucket and could block each other. Conversely, many real users behind one corporate NAT share one IP and one bucket.

**Fixed windows allow bursts at the boundary.** A caller can use their full allowance at the end of one window and again at the start of the next, briefly sending up to twice the limit within a short span. A sliding window or token bucket would smooth this out at the cost of more state per key.

**Memory is bounded only by the sweep, not by a hard cap.** Entries are removed only after their window elapses. A flood of requests with many unique `X-User-Id` values could grow the map quickly between sweeps and exhaust memory before cleanup runs. There is no maximum size or eviction policy.

**Time depends on the wall clock.** The store uses `Date.now`, which can jump if the system clock is adjusted. A backwards jump could extend a window; a forward jump could end one early. A monotonic clock would be more robust.

**Rejected requests are not logged or reported.** There is no logging, metrics, or `Retry-After` response header, so an operator cannot easily see who is being limited, and standards-aware HTTP clients do not get the header they might expect.
