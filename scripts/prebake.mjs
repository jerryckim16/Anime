#!/usr/bin/env node
// Pre-bake the top-N most popular voice actors into static JSON files under
// data/va/<id>.json, plus a slim index at data/va-manifest.json that powers
// client-side search against the cached set.
//
// GitHub Pages serves both globally at edge speed, so common sessions
// (people always looking up Kana Hanazawa / Mamoru Miyano) hit zero live
// infrastructure: no Worker, no AniList call, no IndexedDB miss.
//
// Run manually:
//   node scripts/prebake.mjs
//
// Or let the weekly GitHub Action (.github/workflows/prebake.yml) handle it.
//
// Output shape matches what the browser produces in loadStaffRoles():
//   data/va/<id>.json: { staff: {...}, roles: [...], generatedAt: <ISO8601> }
//   data/va-manifest.json: [ { id, full, native, language, image, favourites }, ... ]
//
// Tuning knobs (via env):
//   ANILIST_APP_TOKEN — optional bearer token for higher rate limits
//   TOP_N              — how many voice actors to enumerate by favourites (default 500)
//   MAX_PAGES          — hard safety cap per VA (default 40 → 1000 roles; paginate until hasNextPage=false)
//   THROTTLE_MS        — inter-request delay (default 1500 to stay well below the 30 req/min degraded limit)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PINNED_FILE = resolve(REPO_ROOT, "data/popular-vas.json");
const OUT_DIR = resolve(REPO_ROOT, "data/va");
const MANIFEST_FILE = resolve(REPO_ROOT, "data/va-manifest.json");

const ANILIST_URL = "https://graphql.anilist.co";
const TOP_N = parseInt(process.env.TOP_N || "500", 10);
// Page.staff accepts perPage up to 50. AniList's Staff.characterMedia
// silently caps at 25 — asking for 50 still returns 25 but advances offset
// by 50, so we'd skip edges [25..49] on page 2. Use 25 for characterMedia.
const ENUM_PER_PAGE = 50;
const MEDIA_PER_PAGE = 25;
// Intentionally generous: the prebake walks the entire career, relying on
// AniList's pageInfo.hasNextPage. MAX_PAGES is a runaway-loop safety net only.
// Even the most prolific seiyuu (Tomokazu Sugita, Houko Kuwashima) are well
// under 1000 character roles.
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "40", 10);
const THROTTLE_MS = parseInt(process.env.THROTTLE_MS || "1500", 10);

// Enumerates staff sorted by favourites so we can pick the top-N voice actors.
// AniList has no server-side `occupation:` filter, so we over-fetch staff and
// filter client-side on primaryOccupations.
const STAFF_LIST_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
    staff(sort: [FAVOURITES_DESC]) {
      id
      name { full native }
      image { medium }
      primaryOccupations
      languageV2
      favourites
    }
  }
}`;

const STAFF_QUERY = `
query ($id: Int, $page: Int, $perPage: Int) {
  Staff(id: $id) {
    id
    name { full native }
    image { large medium }
    languageV2
    favourites
    primaryOccupations
    siteUrl
    characterMedia(perPage: $perPage, page: $page, sort: [START_DATE_DESC]) {
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, variables, { retries = 3 } = {}) {
    const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    };
    if (process.env.ANILIST_APP_TOKEN) {
        headers["Authorization"] = `Bearer ${process.env.ANILIST_APP_TOKEN}`;
    }
    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await fetch(ANILIST_URL, {
                method: "POST",
                headers,
                body: JSON.stringify({ query, variables }),
            });
        } catch (err) {
            if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
            throw err;
        }
        if (res.status === 429 && attempt < retries) {
            const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
            console.warn(`  429 rate limited, sleeping ${retryAfter}s`);
            await sleep(retryAfter * 1000);
            continue;
        }
        const json = await res.json().catch(() => null);
        if (json?.errors?.length) {
            throw new Error(json.errors.map(e => e.message).join("; "));
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return json.data;
    }
}

function isVoiceActor(staff) {
    return (staff?.primaryOccupations || []).some(o => o.toLowerCase().includes("voice"));
}

// Paginate Page.staff until we collect `target` voice actors. Returns manifest
// rows (not just IDs) so we don't need to re-query these fields later.
async function enumeratePopularVoiceActors(target) {
    const rows = [];
    let page = 1;
    while (rows.length < target) {
        process.stdout.write(`enum page ${page} ... `);
        const data = await gql(STAFF_LIST_QUERY, { page, perPage: ENUM_PER_PAGE });
        const staff = data?.Page?.staff || [];
        const pageInfo = data?.Page?.pageInfo || {};
        let added = 0;
        for (const s of staff) {
            if (!isVoiceActor(s)) continue;
            rows.push({
                id: s.id,
                full: s.name?.full || "",
                native: s.name?.native || "",
                language: s.languageV2 || "",
                image: s.image?.medium || "",
                favourites: s.favourites || 0,
            });
            added += 1;
            if (rows.length >= target) break;
        }
        console.log(`+${added} (total ${rows.length})`);
        if (!pageInfo.hasNextPage) break;
        page += 1;
        await sleep(THROTTLE_MS);
    }
    return rows;
}

// Fetches all pages (up to MAX_PAGES) for one staff ID and flattens into the
// role shape the browser expects. Mirrors loadStaffRoles() in app.js exactly.
// Also returns a manifest row populated from the first-page staff block so a
// single fetchVa call can populate BOTH data/va/<id>.json and the manifest.
async function fetchVa(id) {
    let staff = null;
    let manifestRow = null;
    const roles = [];
    let page = 1;
    let hasNext = true;

    while (hasNext && page <= MAX_PAGES) {
        const data = await gql(STAFF_QUERY, { id, page, perPage: MEDIA_PER_PAGE });
        const s = data.Staff;
        if (!s) throw new Error(`Staff ${id} not found`);
        if (!staff) {
            staff = {
                id: s.id,
                name: s.name,
                image: s.image,
                language: s.languageV2,
                favourites: s.favourites,
                siteUrl: s.siteUrl,
            };
            manifestRow = {
                id: s.id,
                full: s.name?.full || "",
                native: s.name?.native || "",
                language: s.languageV2 || "",
                image: s.image?.medium || "",
                favourites: s.favourites || 0,
            };
        }

        const edges = s.characterMedia?.edges || [];
        for (const edge of edges) {
            const media = edge.node;
            if (!media || media.type !== "ANIME") continue;
            if (!media.startDate?.year) continue;
            const characters = edge.characters || [];
            if (!characters.length) continue;
            for (const character of characters) {
                roles.push({
                    year: media.startDate.year,
                    animeId: media.id,
                    animeTitle: media.title.english || media.title.romaji,
                    animeCover: media.coverImage?.medium || null,
                    animeUrl: media.siteUrl,
                    animeFormat: media.format,
                    characterName: character.name.full,
                    characterImage: character.image?.medium || null,
                    role: edge.characterRole,
                });
            }
        }

        // Rely solely on AniList's canonical hasNextPage. The browser's
        // loadStaffRoles uses an extra "edges.length >= PER_PAGE" guard to
        // economize rate-limit budget, but the prebake runs offline and has
        // no user waiting, so it walks the full career.
        const pageInfo = s.characterMedia?.pageInfo || {};
        hasNext = !!pageInfo.hasNextPage;
        page += 1;
        if (hasNext) await sleep(THROTTLE_MS);
    }
    if (hasNext) {
        console.warn(`  hit MAX_PAGES=${MAX_PAGES} cap for staff ${id}; older roles may be truncated`);
    }

    // Dedupe (matches loadStaffRoles)
    const seen = new Set();
    const unique = roles.filter(r => {
        const k = `${r.animeId}::${r.characterName}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    return { staff, roles: unique, manifestRow };
}

// Reads the optional pinned-extras list. Lets curators keep a handful of
// always-on VAs even if they fall out of the top-N favourites cutoff.
async function readPinnedIds() {
    try {
        const raw = await readFile(PINNED_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return (parsed.staff || []).map(s => s.id).filter(id => Number.isInteger(id));
    } catch (err) {
        if (err.code !== "ENOENT") console.warn(`Could not read ${PINNED_FILE}: ${err.message}`);
        return [];
    }
}

async function main() {
    console.log(`Enumerating top ${TOP_N} voice actors by favourites...`);
    const topRows = await enumeratePopularVoiceActors(TOP_N);
    console.log(`Got ${topRows.length} voice actors from enumeration.`);

    const pinned = await readPinnedIds();
    const topIds = new Set(topRows.map(r => r.id));
    const extraIds = pinned.filter(id => !topIds.has(id));
    if (extraIds.length) {
        console.log(`Pinned extras (not in top-${TOP_N}): ${extraIds.length}`);
    }

    // Full target list. Enumeration rows seed the manifest; pinned extras get
    // their manifest rows populated by fetchVa itself.
    const targets = [
        ...topRows.map(r => ({ id: r.id, label: r.full })),
        ...extraIds.map(id => ({ id, label: `pinned ${id}` })),
    ];

    await mkdir(OUT_DIR, { recursive: true });

    const manifestRowsById = new Map();
    for (const r of topRows) manifestRowsById.set(r.id, r);

    let ok = 0, failed = 0;
    for (const { id, label } of targets) {
        process.stdout.write(`→ ${id} (${label}) ... `);
        try {
            const { staff, roles, manifestRow } = await fetchVa(id);
            const payload = {
                staff,
                roles,
                generatedAt: new Date().toISOString(),
            };
            const outFile = resolve(OUT_DIR, `${id}.json`);
            await writeFile(outFile, JSON.stringify(payload) + "\n");
            // fetchVa's manifestRow includes up-to-date favourites/image even
            // when the source came from the pinned list rather than enumeration.
            if (manifestRow) manifestRowsById.set(id, manifestRow);
            console.log(`${roles.length} roles`);
            ok += 1;
        } catch (err) {
            console.log(`FAILED: ${err.message}`);
            failed += 1;
        }
        await sleep(THROTTLE_MS);
    }

    // Emit the manifest, sorted by favourites DESC so the client's default
    // ranking (for single-character queries and ties) already leans popular.
    const manifest = Array.from(manifestRowsById.values())
        .sort((a, b) => (b.favourites || 0) - (a.favourites || 0));
    await writeFile(MANIFEST_FILE, JSON.stringify(manifest) + "\n");
    console.log(`\nWrote ${manifest.length} rows to ${MANIFEST_FILE}`);
    console.log(`Done. ${ok} succeeded, ${failed} failed.`);
    if (failed > 0 && ok === 0) process.exit(1);
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
