// Seiyuu Compare — anime voice actor comparison
// Data source: AniList GraphQL API (https://docs.anilist.co/)
// Build: v2 — characterMedia query must NOT pass `type:` (not a valid arg on Staff.characterMedia).
//        Filter ANIME client-side via media.type === "ANIME".

const ANILIST_URL = "https://graphql.anilist.co";

// Optional: a Cloudflare Worker that sits in front of AniList and provides a
// shared 24h edge cache. When set (after deploying worker/ to Cloudflare),
// the client goes through the Worker first, and falls back to AniList direct
// if the Worker is unreachable. Leave empty to keep today's direct-AniList
// behavior. See worker/README.md for deploy instructions.
const WORKER_URL = "";

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
    characterMedia(perPage: 50, page: $page, sort: [START_DATE_DESC]) {
      pageInfo { hasNextPage currentPage }
      edges {
        characterRole
        characters {
          id
          name { full }
          image { medium }
        }
        node {
          id
          type
          format
          title { romaji english }
          startDate { year }
          coverImage { medium }
          siteUrl
        }
      }
    }
  }
}`;

// Hard cap of 20 pages = up to 1000 character roles per VA. Only applies to
// the live-fetch fallback (VAs not in the pre-baked top-500 manifest). Most
// VAs short-circuit after 1–3 pages via hasNextPage; the cap only kicks in
// for very prolific seiyuu, where we still walk back far enough to cover
// their entire TV career. The pre-baked static files from scripts/prebake.mjs
// go further (MAX_PAGES=40) since they run offline with no user waiting.
const MAX_PAGES = 20;

const state = {
    left: null,   // { staff, roles }
    right: null,
    loading: false,
};

// ---------- Utilities ----------

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v; // only used for trusted strings
        else if (k.startsWith("on") && typeof v === "function") {
            node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v !== null && v !== undefined && v !== false) {
            node.setAttribute(k, v);
        }
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
}

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

function showError(message) {
    const banner = $("#error-banner");
    banner.textContent = message;
    banner.hidden = false;
    setTimeout(() => { banner.hidden = true; }, 8000);
}

function setLoading(on) {
    state.loading = on;
    $("#loading").hidden = !on;
}

// ---------- IndexedDB cache (L1) ----------
//
// Stores recently-fetched VA role lists and search results locally so repeat
// visits hit zero network. AniList voice-actor career data is stable, so long
// TTLs are safe and dramatically reduce upstream load.

const DB_NAME = "seiyuu-compare";
const DB_VERSION = 1;
const STORE_VA_ROLES = "va_roles";  // key: staff id (Number), value: { staff, roles }
const STORE_SEARCHES = "searches";  // key: normalized query (String), value: results[]

const TTL_VA_ROLES_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const TTL_SEARCHES_MS = 24 * 60 * 60 * 1000;      // 24 hours

let dbPromise = null;
function openCacheDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            return reject(new Error("IndexedDB not available"));
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_VA_ROLES)) db.createObjectStore(STORE_VA_ROLES);
            if (!db.objectStoreNames.contains(STORE_SEARCHES)) db.createObjectStore(STORE_SEARCHES);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }).catch(err => {
        // Fall back to no-cache (private browsing, disabled storage, etc.) — never throw.
        console.warn("IndexedDB unavailable, cache disabled:", err && err.message);
        return null;
    });
    return dbPromise;
}

async function cacheGet(store, key, ttlMs) {
    const db = await openCacheDb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(store, "readonly");
            const req = tx.objectStore(store).get(key);
            req.onsuccess = () => {
                const entry = req.result;
                if (!entry) return resolve(null);
                if (Date.now() - entry.fetchedAt > ttlMs) return resolve(null);
                resolve(entry);
            };
            req.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
    });
}

async function cachePut(store, key, value) {
    const db = await openCacheDb();
    if (!db) return;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(store, "readwrite");
            tx.objectStore(store).put({ value, fetchedAt: Date.now() }, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch (_) { resolve(); }
    });
}

// ---------- AniList ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// In-flight request dedup: collapse concurrent identical queries to a single fetch.
// Keyed by query+variables; entries are removed when the underlying promise settles.
const inFlightGql = new Map();

function gql(query, variables, opts = {}) {
    const key = JSON.stringify({ q: query, v: variables || {} });
    const existing = inFlightGql.get(key);
    if (existing) return existing;
    const promise = _gqlRequest(query, variables, opts)
        .finally(() => { inFlightGql.delete(key); });
    inFlightGql.set(key, promise);
    return promise;
}

async function _gqlRequest(query, variables, { retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await fetch(ANILIST_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                body: JSON.stringify({ query, variables }),
            });
        } catch (err) {
            // fetch() rejects with a bare TypeError ("Failed to fetch") on
            // network-level failures: throttled connection, DNS miss, ad
            // blocker, AniList briefly down, etc. Back off and retry; only
            // after all retries are exhausted do we surface a readable error.
            if (attempt < retries) {
                await sleep(1500 * (attempt + 1));
                continue;
            }
            throw new Error(
                "Couldn't reach AniList. It's usually rate-limiting or briefly " +
                "unavailable — wait ~30 seconds and try again."
            );
        }

        // Honor AniList's rate limit: retry after Retry-After seconds before surfacing the error.
        if (res.status === 429 && attempt < retries) {
            const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
            await sleep(Math.max(1, retryAfter) * 1000);
            continue;
        }
        if (res.status === 429) {
            const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
            throw new Error(`Rate limited by AniList. Try again in ${retryAfter}s.`);
        }

        // AniList returns a JSON body with detailed GraphQL errors even on 4xx.
        let json = null;
        try { json = await res.json(); } catch (_) { /* non-JSON body */ }

        if (json && json.errors && json.errors.length) {
            const msg = json.errors.map(e => e.message).filter(Boolean).join("; ");
            throw new Error(msg || `AniList GraphQL error (HTTP ${res.status})`);
        }
        if (!res.ok) {
            throw new Error(`AniList HTTP ${res.status}`);
        }
        return json.data;
    }
}

// Worker helpers — return the same data shapes as the equivalent AniList calls
// would, after filtering. If the Worker is unconfigured or unreachable, callers
// fall back to gql() directly. `null` means "try the fallback".

// Pre-baked search manifest (data/va-manifest.json). Populated by the weekly
// .github/workflows/prebake.yml alongside data/va/<id>.json. Lets the client
// resolve name searches without hitting the Worker or AniList when the query
// matches any of the ~500 cached VAs. Loaded once per session, cached in
// memory. Rows look like:
//     { id, full, native, language, image, favourites }
let manifestPromise = null;
function loadManifest() {
    if (manifestPromise) return manifestPromise;
    manifestPromise = fetch("./data/va-manifest.json", { cache: "default" })
        .then(res => res.ok ? res.json() : [])
        .then(rows => Array.isArray(rows) ? rows : [])
        .catch(() => []); // 404, network, parse error → return [] so the remote path still runs.
    return manifestPromise;
}

// Normalizes a string for substring matching: lowercase + strip diacritics.
// Used for both query and manifest rows so "Saori Hayami" matches "saori hayami",
// "SAORI HAYAMI", "Sáori Háyami", etc.
function normalizeForSearch(s) {
    return (s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

// Scores a manifest row against a normalized query. Higher = better match.
// Returns 0 if the row doesn't match at all.
function scoreManifestRow(row, q) {
    const full = normalizeForSearch(row.full);
    const native = normalizeForSearch(row.native);
    // Starts-with wins (3), word-boundary contains next (2), plain contains last (1).
    if (full.startsWith(q) || native.startsWith(q)) return 3;
    if (new RegExp(`\\b${escapeRegex(q)}`).test(full + " " + native)) return 2;
    if (full.includes(q) || native.includes(q)) return 1;
    return 0;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Converts a flat manifest row to the same shape the remote search returns,
// so downstream renderSearchResults / selectStaff don't need to know where
// results came from.
function manifestRowToStaff(row) {
    return {
        id: row.id,
        name: { full: row.full, native: row.native },
        image: { medium: row.image },
        languageV2: row.language,
    };
}

async function searchManifest(query) {
    const manifest = await loadManifest();
    if (!manifest.length) return [];
    const q = normalizeForSearch(query);
    if (!q) return [];
    const scored = [];
    for (const row of manifest) {
        const score = scoreManifestRow(row, q);
        if (score > 0) scored.push({ row, score });
    }
    // Primary by score DESC, tie-break by favourites DESC (already the
    // manifest's natural order — preserving it gives popular VAs the nudge).
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.row.favourites || 0) - (a.row.favourites || 0);
    });
    return scored.slice(0, 10).map(s => manifestRowToStaff(s.row));
}

// Pre-baked static snapshots — the weekly .github/workflows/prebake.yml
// populates data/va/<id>.json on GitHub Pages. Popular VAs resolve with ZERO
// live infrastructure cost: the CDN serves the file, we never hit the Worker
// or AniList. Returns null (and caller falls through) if the file is absent.
async function prebakedVaFetch(id) {
    try {
        const res = await fetch(`./data/va/${id}.json`, { cache: "default" });
        if (!res.ok) return null;
        const payload = await res.json();
        if (!payload || !payload.staff || !Array.isArray(payload.roles)) return null;
        return payload;
    } catch (_) { return null; }
}

async function workerSearch(query) {
    if (!WORKER_URL) return null;
    try {
        const res = await fetch(`${WORKER_URL}/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) return null;
        const body = await res.json();
        return Array.isArray(body.staff) ? body.staff : null;
    } catch (_) { return null; }
}

async function workerVaPage(id, page) {
    if (!WORKER_URL) return null;
    try {
        const res = await fetch(`${WORKER_URL}/va/${id}?page=${page}`);
        if (!res.ok) return null;
        return await res.json(); // { Staff: {...} }
    } catch (_) { return null; }
}

async function searchStaff(query) {
    const normalized = query.trim().toLowerCase();

    // L0: local manifest. If any of the ~500 pre-baked VAs matches, we're done
    // without any network at all. The manifest covers ~95% of real searches by
    // the power-law distribution of VA popularity.
    const local = await searchManifest(query);
    if (local.length) return local;

    const cached = await cacheGet(STORE_SEARCHES, normalized, TTL_SEARCHES_MS);
    if (cached) return cached.value;

    // L2: try the Worker first. It has a shared 24h cache for all users.
    let results = await workerSearch(query);

    // L3: fall through to AniList direct if the Worker is down / not configured.
    if (!results) {
        const data = await gql(SEARCH_QUERY, { search: query });
        results = data.Page.staff.filter(s =>
            (s.primaryOccupations || []).some(o => o.toLowerCase().includes("voice"))
        );
    }

    cachePut(STORE_SEARCHES, normalized, results).catch(() => {});
    return results;
}

async function loadStaffRoles(id) {
    // L1 cache: return a hit immediately and tag it so the UI can show a "from cache" chip.
    const cached = await cacheGet(STORE_VA_ROLES, id, TTL_VA_ROLES_MS);
    if (cached) {
        return { ...cached.value, cachedAt: cached.fetchedAt };
    }

    // Pre-baked static snapshot: popular VAs ship as data/va/<id>.json on
    // GitHub Pages. No network hop to AniList or the Worker on a hit.
    const prebaked = await prebakedVaFetch(id);
    if (prebaked) {
        const result = { staff: prebaked.staff, roles: prebaked.roles };
        cachePut(STORE_VA_ROLES, id, result).catch(() => {});
        return result;
    }

    let staff = null;
    const roles = [];
    let page = 1;
    let hasNext = true;

    const PER_PAGE = 50; // matches characterMedia(perPage: 50) in STAFF_QUERY; halves pagination vs prior 25
    const THROTTLE_MS = 700; // keeps us well under AniList's 30 req/min when loading two VAs back-to-back

    while (hasNext && page <= MAX_PAGES) {
        // L2: try the Worker per-page. Each page cached independently on the
        // edge, so two users paginating through different VAs share the same
        // cache for pages they have in common.
        let data = await workerVaPage(id, page);
        if (!data) data = await gql(STAFF_QUERY, { id, page });
        const s = data.Staff;
        if (!s) throw new Error(`Voice actor ${id} not found.`);
        if (!staff) staff = {
            id: s.id,
            name: s.name,
            image: s.image,
            language: s.languageV2,
            favourites: s.favourites,
            siteUrl: s.siteUrl,
        };

        const edges = (s.characterMedia && s.characterMedia.edges) || [];
        for (const edge of edges) {
            const media = edge.node;
            if (!media || media.type !== "ANIME") continue;
            if (!media.startDate || !media.startDate.year) continue;
            const characters = edge.characters || [];
            if (!characters.length) continue;
            for (const character of characters) {
                roles.push({
                    year: media.startDate.year,
                    animeId: media.id,
                    animeTitle: media.title.english || media.title.romaji,
                    animeCover: media.coverImage && media.coverImage.medium,
                    animeUrl: media.siteUrl,
                    animeFormat: media.format,
                    characterName: character.name.full,
                    characterImage: character.image && character.image.medium,
                    role: edge.characterRole, // MAIN | SUPPORTING | BACKGROUND
                });
            }
        }

        // Stop as soon as AniList signals no more pages OR the current page came back short.
        // Short-circuiting on short pages halves request count for most VAs and prevents
        // rate-limit failures when the second voice actor is picked.
        const pageInfo = (s.characterMedia && s.characterMedia.pageInfo) || {};
        hasNext = !!pageInfo.hasNextPage && edges.length >= PER_PAGE;
        page += 1;

        if (hasNext) await sleep(THROTTLE_MS);
    }

    // Deduplicate (same character + anime can repeat across pages occasionally)
    const seen = new Set();
    const unique = roles.filter(r => {
        const key = `${r.animeId}::${r.characterName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const result = { staff, roles: unique };
    cachePut(STORE_VA_ROLES, id, result).catch(() => {});
    return result;
}

// ---------- Search UI ----------

function setupSearchPanel(side) {
    const panel = $(`.va-panel[data-side="${side}"]`);
    const input = $(".search-input", panel);
    const list = $(".search-results", panel);

    const runSearch = debounce(async (query) => {
        const trimmed = query.trim();
        if (trimmed.length < 2) {
            // Require at least 2 chars before firing an AniList query.
            // Single-letter searches return noise and waste rate-limit budget.
            list.hidden = true;
            list.innerHTML = "";
            return;
        }
        try {
            const results = await searchStaff(trimmed);
            renderSearchResults(list, results, side);
        } catch (err) {
            console.error(err);
            showError(err.message);
        }
    }, 450);

    input.addEventListener("input", e => runSearch(e.target.value));
    input.addEventListener("focus", () => {
        if (list.children.length) list.hidden = false;
    });

    // Hide dropdown when clicking outside
    document.addEventListener("click", e => {
        if (!panel.contains(e.target)) list.hidden = true;
    });
}

function renderSearchResults(list, results, side) {
    list.innerHTML = "";
    if (!results.length) {
        list.appendChild(el("li", {}, el("span", { class: "result-empty" }, "No voice actors found.")));
    } else {
        for (const s of results) {
            const li = el("li", { onclick: () => selectStaff(side, s.id) },
                el("img", { src: (s.image && s.image.medium) || "", alt: "" }),
                el("div", {},
                    el("div", { class: "result-name" }, s.name.full),
                    s.name.native ? el("div", { class: "result-native" },
                        `${s.name.native}${s.languageV2 ? " · " + s.languageV2 : ""}`) : null,
                ),
            );
            list.appendChild(li);
        }
    }
    list.hidden = false;
}

// ---------- Selection / panels ----------

async function selectStaff(side, id) {
    const panel = $(`.va-panel[data-side="${side}"]`);
    $(".search-results", panel).hidden = true;
    $(".search-input", panel).value = "";

    const card = $(".va-card", panel);
    card.className = "va-card";
    card.innerHTML = "";
    card.appendChild(el("p", { class: "empty-text" }, "Loading..."));

    setLoading(true);
    try {
        const result = await loadStaffRoles(id);
        state[side] = result;
        renderVaCard(panel, result);
        renderTimeline();
        updateHash();
    } catch (err) {
        console.error(err);
        showError(err.message);
        card.innerHTML = "";
        card.classList.add("empty");
        card.appendChild(el("p", { class: "empty-text" }, "Failed to load. Try again."));
    } finally {
        setLoading(false);
    }
}

function renderVaCard(panel, data) {
    const { staff, roles, cachedAt } = data;
    const card = $(".va-card", panel);
    card.className = "va-card";
    card.innerHTML = "";

    const animeCount = new Set(roles.map(r => r.animeId)).size;
    const charCount = new Set(roles.map(r => `${r.animeId}::${r.characterName}`)).size;

    card.appendChild(el("img", {
        class: "va-img",
        src: (staff.image && staff.image.large) || "",
        alt: staff.name.full,
    }));
    card.appendChild(el("div", { class: "va-meta" },
        el("div", { class: "va-name-row" },
            el("span", { class: "va-name" }, staff.name.full),
            cachedAt ? el("span", {
                class: "cache-chip",
                title: `Loaded from local cache, fetched ${new Date(cachedAt).toLocaleString()}`,
            }, `cached · ${formatAgo(cachedAt)}`) : null,
        ),
        staff.name.native ? el("div", { class: "va-native" }, staff.name.native) : null,
        el("div", { class: "va-stats" },
            `${animeCount} anime · ${charCount} characters` +
            (staff.language ? ` · ${staff.language} VA` : "")),
        staff.siteUrl ? el("a", {
            class: "va-link",
            href: staff.siteUrl,
            target: "_blank",
            rel: "noopener",
        }, "View on AniList") : null,
    ));
}

function formatAgo(ts) {
    const sec = Math.max(0, (Date.now() - ts) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
}

// ---------- Timeline ----------

function renderTimeline() {
    if (!state.left || !state.right) {
        $("#overlap-counter").hidden = true;
        return;
    }

    const section = $("#timeline-section");
    const timeline = $("#timeline");
    timeline.innerHTML = "";

    // Group roles by year per side
    const leftByYear = groupByYear(state.left.roles);
    const rightByYear = groupByYear(state.right.roles);

    // Compute overlap anime IDs (same anime appears in both careers)
    const leftAnime = new Set(state.left.roles.map(r => r.animeId));
    const rightAnime = new Set(state.right.roles.map(r => r.animeId));
    const overlap = new Set([...leftAnime].filter(id => rightAnime.has(id)));

    renderOverlapCounter(overlap.size);

    // Union of all years, descending
    const years = Array.from(new Set([
        ...Object.keys(leftByYear),
        ...Object.keys(rightByYear),
    ])).map(Number).sort((a, b) => b - a);

    if (!years.length) {
        timeline.appendChild(el("p", { class: "year-cell-empty" },
            "Neither voice actor has dated anime credits."));
        section.hidden = false;
        return;
    }

    for (const year of years) {
        const row = el("div", { class: "year-row" },
            el("div", { class: "year-label" }, String(year)),
            renderYearCell(leftByYear[year] || [], overlap, "year-cell year-cell-left"),
            renderYearCell(rightByYear[year] || [], overlap, "year-cell year-cell-right"),
        );
        timeline.appendChild(row);
    }

    section.hidden = false;
}

function renderOverlapCounter(count) {
    const el = $("#overlap-counter");
    $("#overlap-count").textContent = String(count);
    el.classList.toggle("zero", count === 0);
    el.hidden = false;
}

function groupByYear(roles) {
    const out = {};
    for (const r of roles) {
        if (!out[r.year]) out[r.year] = [];
        out[r.year].push(r);
    }
    // Sort each year so MAIN roles come first, then alphabetical
    for (const year of Object.keys(out)) {
        out[year].sort((a, b) => {
            const rank = r => r.role === "MAIN" ? 0 : r.role === "SUPPORTING" ? 1 : 2;
            const d = rank(a) - rank(b);
            if (d) return d;
            return (a.animeTitle || "").localeCompare(b.animeTitle || "");
        });
    }
    return out;
}

function renderYearCell(roles, overlapSet, className) {
    const cell = el("div", { class: className });
    if (!roles.length) {
        cell.appendChild(el("p", { class: "year-cell-empty" }, "—"));
        return cell;
    }
    for (const r of roles) {
        const isOverlap = overlapSet.has(r.animeId);
        const card = el("div", { class: "role-card" + (isOverlap ? " overlap" : "") },
            el("img", { src: r.animeCover || "", alt: "", loading: "lazy" }),
            el("div", { class: "role-info" },
                el("div", { class: "role-anime" },
                    r.animeUrl
                        ? el("a", { href: r.animeUrl, target: "_blank", rel: "noopener" }, r.animeTitle)
                        : r.animeTitle,
                    isOverlap ? el("span", { class: "overlap-tag" }, "Overlap") : null,
                ),
                el("div", { class: "role-character" }, r.characterName),
                el("div", { class: "role-meta" },
                    `${(r.role || "").toLowerCase()}${r.animeFormat ? " · " + r.animeFormat.replace("_", " ") : ""}`),
            ),
        );
        cell.appendChild(card);
    }
    return cell;
}

// ---------- URL hash sharing ----------

function updateHash() {
    const a = state.left ? state.left.staff.id : "";
    const b = state.right ? state.right.staff.id : "";
    const hash = a || b ? `#${a}-${b}` : "";
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
}

function loadFromHash() {
    const m = (location.hash || "").match(/^#(\d*)-(\d*)$/);
    if (!m) return;
    const [, a, b] = m;
    if (a) selectStaff("left", parseInt(a, 10));
    if (b) selectStaff("right", parseInt(b, 10));
}

// ---------- Init ----------

setupSearchPanel("left");
setupSearchPanel("right");
loadFromHash();
