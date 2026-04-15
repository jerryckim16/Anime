# Seiyuu Compare — Cloudflare Worker L2 cache

A tiny edge proxy that sits between the browser and AniList GraphQL. All users
share one cache; a voice actor viewed 500 times today triggers roughly **one**
upstream AniList request instead of 500.

## Endpoints

| Method | Path                  | Purpose                                            |
|--------|-----------------------|----------------------------------------------------|
| GET    | `/search?q=<query>`   | Voice-actor search (proxies the AniList search)    |
| GET    | `/va/<id>?page=<n>`   | One page of a VA's `characterMedia` (n = 1..12)    |
| GET    | `/healthz`            | Liveness probe                                     |
| OPTIONS| `*`                   | CORS preflight                                     |

Responses include an `X-Cache: HIT|MISS|STALE|STALE-ERROR` header so you can
verify caching in DevTools.

## Deploy

```bash
# One-time: install wrangler and log in
npm install -g wrangler
wrangler login

# Deploy this worker
cd worker/
wrangler deploy
```

Wrangler will print the production URL, e.g. `https://seiyuu-compare-cache.<you>.workers.dev`.

### Configure CORS

Edit `wrangler.toml` → `ALLOWED_ORIGIN` to the origin(s) of your site.
For GitHub Pages it's usually `https://<user>.github.io`. Comma-separate
for multiple. Use `"*"` only during local development.

### Optional: raise upstream rate limits with an app token

AniList's registered OAuth apps get the full 90 req/min quota even during
degraded periods. Register one at <https://anilist.co/settings/developer>,
mint a client-credentials token, and:

```bash
wrangler secret put ANILIST_APP_TOKEN
# paste the token when prompted
```

The Worker picks it up automatically via `env.ANILIST_APP_TOKEN`.

## Local development

```bash
cd worker/
wrangler dev
# serves on http://127.0.0.1:8787
```

Then point `app.js`'s `WORKER_URL` at `http://127.0.0.1:8787` while developing.

## Smoke tests

```bash
# First hit should be MISS, second HIT
curl -s -D - "https://<worker>.workers.dev/va/95269" -o /dev/null | grep -i x-cache
curl -s -D - "https://<worker>.workers.dev/va/95269" -o /dev/null | grep -i x-cache

# Search
curl -s "https://<worker>.workers.dev/search?q=hanazawa" | jq '.staff[0].name.full'

# Hammer the same key to verify origin coalescing (should see 1-2 upstream fetches in logs)
for i in $(seq 1 50); do curl -s -o /dev/null "https://<worker>.workers.dev/va/95269" & done; wait
```

## Cache behavior

- **TTL** (`CACHE_TTL_SECONDS`, default 24h): within this window responses are
  returned instantly from Cloudflare's edge cache. No upstream fetch.
- **Stale-while-revalidate** (`CACHE_SWR_SECONDS`, default 7d): after TTL the
  stale payload is returned immediately and a background refresh is kicked off.
- **Stale on error**: if AniList is unreachable but we have *any* cached copy,
  the Worker serves it (tagged `X-Cache: STALE-ERROR`) rather than failing the
  end user.
- **Origin coalescing**: an in-memory `Map` collapses concurrent identical
  requests on a cold key. Viral spikes produce one upstream fetch per VA, not N.

## Cost

Cloudflare Workers free plan includes 100k requests/day and unlimited
`caches.default` reads. At the selected "hundreds-to-low-thousands of users per
day" scale this is free indefinitely.
