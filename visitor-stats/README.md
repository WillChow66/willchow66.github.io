# Homepage visitor map backend

Prepared and locally tested; **not deployed**. This is a separate Cloudflare Worker + D1 service for `https://willchow66.github.io`.

## What it counts

- `POST /hit` with an empty body records one accepted **page view**, never a unique person. Only the exact homepage Origin can write. DNT, Sec-GPC and recognizable crawler user agents skip counting.
- `GET /points` is public aggregate JSON: `{ "views": 0, "points": [] }` initially. Each point has `lon`, `lat`, `country`, `city`, `views`. Browser CORS permits the homepage only; no credentials or cookies are used.
- Geography comes only from Cloudflare's trusted `request.cf` metadata. Coordinates are approximate IP geolocation rounded to two decimal places. VPNs/proxies and missing metadata affect accuracy. Missing or invalid geography still increments the total but creates no dot.
- D1 stores the total and city/location counters only. It contains no names, visitor IDs, cookies, fingerprints, raw IP addresses, timestamps or individual visits. The schema contains no example visits. Worker code does not log requests or exceptions; Workers Observability and invocation logs are disabled in configuration.
- The API returns at most the 2,000 highest-count locations; city strings are capped at 80 characters. The total includes locations beyond that display limit and visits with unknown geography. Both counters update in one D1 transaction.

The optional native rate limiter targets 60 hits per IP/minute per Cloudflare location. Raw `CF-Connecting-IP` is read transiently and transformed into a SHA-256 key that changes each minute; that key is used only by the rate limiter, never stored in D1 or returned. This is abuse mitigation, not person identification or strict global accounting. Shared IPs can be limited together; rotating minute boundaries can allow bursts. CORS and user-agent filtering also do not prevent deliberate non-browser spoofing. Cloudflare operates its own network infrastructure; this application's settings do not control provider-wide processing.

## Deploy in your own Cloudflare account

Use Node.js 24 and current Wrangler (minimum 4.36 for the stable `ratelimits` configuration). Run from this directory. Login opens Cloudflare's browser authorization flow; never paste an API token into chat or commit it.

```sh
node --test worker.test.mjs
npx wrangler@latest login
npx wrangler@latest d1 create willchow66-visitor-map
```

Copy the real database UUID printed by `d1 create` into the empty `database_id` in `wrangler.toml`. Leave the binding named `DB`. The rate-limiter `namespace_id = "1001"` is a positive integer string you choose, not a provisioned resource UUID; change it if your account already uses that namespace for another limiter.

```sh
npx wrangler@latest d1 execute willchow66-visitor-map --remote --file=./schema.sql
npx wrangler@latest deploy
```

Set the homepage's visitor-statistics API base URL to the HTTPS Worker URL printed by deployment (without a trailing slash). Its frontend should send an empty `POST /hit`, then `GET /points`, using `credentials: "omit"` and respecting DNT/GPC before the counting request. A normal homepage load becomes the first genuine view; do not seed production with test hits.

Workers and D1 have Free plans with usage quotas. This implementation uses no paid-only database or Durable Object feature. The current native rate-binding documentation supplies no separate plan/pricing guarantee, so check whether your account accepts the binding during deployment. If it is unavailable, remove the `[[ratelimits]]` block and its settings; the Worker explicitly supports a missing binding, with rate limiting disabled. If a configured binding errors at runtime, `/hit` returns 503 without writing. Reaching Workers/D1 free quotas also interrupts statistics until quotas reset or the plan changes.

For local-only SQL initialization, use `npx wrangler@latest d1 execute willchow66-visitor-map --local --file=./schema.sql`. Local requests do not reliably have real Cloudflare geolocation. The automated tests use in-memory SQLite and never touch a remote account/database.

## Verification and primary references

`node --test worker.test.mjs` tests origin rejection before D1 access, CORS, privacy/crawler skips, empty streams and payload rejection, trusted metadata, unknown-geography totals, repeated-view aggregation, SQL parameter binding, real SQLite rollback, the output cap and rate-limit denial. It is a local logic/SQL check; live Cloudflare bindings and deployment are not yet verified.

- [Cloudflare request metadata](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [D1 batch transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Native Workers rate-limiting binding, syntax and limitations](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [D1 setup commands](https://developers.cloudflare.com/d1/get-started/)
- [D1 Free-plan pricing and quotas](https://developers.cloudflare.com/d1/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers logging configuration](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
