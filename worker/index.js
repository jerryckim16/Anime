// Seiyuu Compare — Cloudflare Worker L2 cache in front of AniList GraphQL.
//
// Why this exists:
//   AniList rate-limits per IP (90 req/min nominal, 30/min during degraded
//   periods). With many users hitting AniList directly, popular VAs can
//   trigger throttling and shared-IP networks (schools, offices) exhaust
//   their quota. This Worker gives all users a shared cache: the first
//   request for VA X triggers one AniList fetch; every other request for
//   that VA within the TTL is served from the edge.
//
// Endpoints:
//   GET /va/:id?page=N    → proxies Staff.characterMedia for one page
//   GET /search?q=...     → proxies the staff search query
//   OPTIONS *             → CORS preflight
//
// Caching strategy:
//   - caches.default (Cloudflare Cache API) keyed by the request URL.
//   - 24h max-age, 7d stale-while-revalidate. AniList VA data is stable.
//   - On AniList failure, serve stale cache if present (graceful degradation).
//
// Origin coalescing:
//   A module-level Map collapses concurrent identical requests on a
//   cold cache key so a thundering herd results in ONE upstream fetch.
//
// Deploy: see README.md in this directory.

const ANILIST_URL = "https://graphql.anilist.co";

// Tune from env at deploy time; sensible defaults for public launch scale.
const DEFAULT_CACHE_TTL_SECONDS = 24 * 60 * 60;      // 24h fresh
const DEFAULT_SWR_SECONDS = 7 * 24 * 60 * 60;        // 7d stale-while-revalidate

const SEARCH_QUERY = `
query ($search: String) {
  Page(perPage: 10) {
    staff(search: $search, sort: [SEARCH_MATCH]) {
      id
      name { full native }
      image { medium }
      primaryOccupations
      languageV2
    }
  }
}`;

const STAFF_QUERY = `
query ($id: Int, $page: Int) {
  Staff(id: $id) {
    id
    name { full native }
    image { large }
    languageV2
    favourites
    siteUrl
    characterMedia(perPage: 25, page: $page, sort: [START_DATE_DESC]) {
      pageInfo { hasNextPage currentPage }
      edges {
        characterRole
        characters { id name { full } image { medium } }
        node {
          id type format
          title { romaji english }
          startDate { year }
          coverImage { medium }
          siteUrl
        }
      }
    }
  }
}`;

const inFlight = new Map(); // origin request coalescing across concurrent hits

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") return corsPreflight(request, env);

        const url = new URL(request.url);
        try {
            if (url.pathname === "/search") return await handleSearch(url, request, env, ctx);
            const m = url.pathname.match(/^\/va\/(\d+)$/);
            if (m) return await handleVaPage(parseInt(m[1], 10), url, request, env, ctx);
            if (url.pathname === "/" || url.pathname === "/healthz") {
                return json({ ok: true, service: "seiyuu-compare-cache" }, 200, env);
            }
            return json({ error: "Not found" }, 404, env);
        } catch (err) {
            return json({ error: err.message || String(err) }, 500, env);
        }
    },
};

async function handleSearch(url, request, env, ctx) {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2) return json({ error: "q must be at least 2 chars" }, 400, env);

    // Normalize the cache key so "Kana Hanazawa" and "kana hanazawa" share a cache slot.
    const cacheKey = cacheKeyFor(url.origin, "search", q.toLowerCase());
    return await cachedOrFetch(cacheKey, request, ctx, env, async () => {
        const data = await anilistGql(SEARCH_QUERY, { search: q }, env);
        const staff = (data?.Page?.staff || []).filter(s =>
            (s.primaryOccupations || []).some(o => o.toLowerCase().includes("voice"))
        );
        return { staff };
    });
}

async function handleVaPage(id, url, request, env, ctx) {
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    if (!Number.isInteger(page) || page < 1 || page > 12) {
        return json({ error: "page must be 1..12" }, 400, env);
    }
    const cacheKey = cacheKeyFor(url.origin, "va", `${id}:${page}`);
    return await cachedOrFetch(cacheKey, request, ctx, env, async () => {
        const data = await anilistGql(STAFF_QUERY, { id, page }, env);
        if (!data?.Staff) throw new Error(`Staff ${id} not found`);
        return data;
    });
}

// Serve from Cache API on hit; otherwise fetch origin (coalesced), cache, and return.
// On upstream failure, fall back to a stale cached response if we have one.
async function cachedOrFetch(cacheKey, request, ctx, env, produce) {
    const cache = caches.default;
    const cacheRequest = new Request(cacheKey, { method: "GET" });

    // Cache hit → return immediately. Kick off a background revalidation only
    // if we're past the fresh window (SWR).
    const cached = await cache.match(cacheRequest);
    if (cached) {
        const age = parseInt(cached.headers.get("Age") || "0", 10);
        const ttl = Number(env?.CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS);
        if (age <= ttl) {
            return withCors(cached, request, env, { hit: "HIT" });
        }
        // Stale: background revalidate, return stale now.
        ctx.waitUntil(refreshAndStore(cacheKey, produce, env));
        return withCors(cached, request, env, { hit: "STALE" });
    }

    // Cold cache: coalesce concurrent misses to one upstream call.
    let pending = inFlight.get(cacheKey);
    if (!pending) {
        pending = (async () => {
            try {
                const payload = await produce();
                const body = JSON.stringify(payload);
                const response = new Response(body, {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        "Cache-Control": buildCacheControl(env),
                    },
                });
                ctx.waitUntil(cache.put(cacheRequest, response.clone()));
                return response;
            } finally {
                inFlight.delete(cacheKey);
            }
        })();
        inFlight.set(cacheKey, pending);
    }

    try {
        const response = await pending;
        return withCors(response.clone(), request, env, { hit: "MISS" });
    } catch (err) {
        // Last-ditch: if AniList is down but we have ANY cached copy (even stale past SWR), serve it.
        const stale = await cache.match(cacheRequest);
        if (stale) return withCors(stale, request, env, { hit: "STALE-ERROR" });
        throw err;
    }
}

async function refreshAndStore(cacheKey, produce, env) {
    try {
        const payload = await produce();
        const body = JSON.stringify(payload);
        const response = new Response(body, {
            status: 200,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": buildCacheControl(env),
            },
        });
        await caches.default.put(new Request(cacheKey, { method: "GET" }), response);
    } catch (_) { /* ignore; serve stale */ }
}

async function anilistGql(query, variables, env) {
    const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    };
    // Optional: register an AniList OAuth app and set ANILIST_APP_TOKEN to lift rate limits.
    if (env?.ANILIST_APP_TOKEN) {
        headers["Authorization"] = `Bearer ${env.ANILIST_APP_TOKEN}`;
    }

    const res = await fetch(ANILIST_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "3", 10);
        const err = new Error(`AniList rate limited (retry in ${retryAfter}s)`);
        err.status = 429;
        throw err;
    }
    const json = await res.json().catch(() => null);
    if (json?.errors?.length) {
        throw new Error(json.errors.map(e => e.message).filter(Boolean).join("; "));
    }
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    return json?.data;
}

function buildCacheControl(env) {
    const ttl = Number(env?.CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS);
    const swr = Number(env?.CACHE_SWR_SECONDS || DEFAULT_SWR_SECONDS);
    return `public, max-age=${ttl}, stale-while-revalidate=${swr}`;
}

function cacheKeyFor(origin, kind, key) {
    return `${origin}/__cache/${kind}/${encodeURIComponent(key)}`;
}

function corsOrigin(request, env) {
    const allow = (env?.ALLOWED_ORIGIN || "*").trim();
    if (allow === "*") return "*";
    const reqOrigin = request.headers.get("Origin");
    // If ALLOWED_ORIGIN is a comma-separated list, pick the match.
    const allowList = allow.split(",").map(s => s.trim()).filter(Boolean);
    return allowList.includes(reqOrigin) ? reqOrigin : allowList[0] || "*";
}

function corsHeaders(request, env, extras = {}) {
    return {
        "Access-Control-Allow-Origin": corsOrigin(request, env),
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
        ...extras,
    };
}

function corsPreflight(request, env) {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function withCors(response, request, env, { hit } = {}) {
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
    if (hit) headers.set("X-Cache", hit);
    return new Response(response.body, { status: response.status, headers });
}

function json(obj, status, env, request) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...(request ? corsHeaders(request, env) : { "Access-Control-Allow-Origin": "*" }),
        },
    });
}
