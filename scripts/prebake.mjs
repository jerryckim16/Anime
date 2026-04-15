#!/usr/bin/env node
// Pre-bake the top-N most popular voice actors into static JSON files under
// data/va/<id>.json. GitHub Pages serves these globally at edge speed, so
// common sessions (people always looking up Kana Hanazawa / Mamoru Miyano)
// hit zero live infrastructure: no Worker, no AniList call, no IndexedDB miss.
//
// Run manually:
//   node scripts/prebake.mjs
//
// Or let the weekly GitHub Action (.github/workflows/prebake.yml) handle it.
//
// Output shape matches what the browser produces in loadStaffRoles():
//   { staff: {...}, roles: [...], generatedAt: <ISO8601> }
//
// `generatedAt` lets the client display "updated X days ago" for prebaked
// payloads and distinguishes them from live fetches.
//
// Tuning knobs (via env):
//   ANILIST_APP_TOKEN — optional bearer token for higher rate limits
//   PER_PAGE           — page size (default 50, AniList max)
//   MAX_PAGES          — cap per VA (default 6 → up to 300 roles)
//   THROTTLE_MS        — inter-request delay (default 1500 to stay well below the 30 req/min degraded limit)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const POPULAR_FILE = resolve(REPO_ROOT, "data/popular-vas.json");
const OUT_DIR = resolve(REPO_ROOT, "data/va");

const ANILIST_URL = "https://graphql.anilist.co";
const PER_PAGE = parseInt(process.env.PER_PAGE || "50", 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "6", 10);
const THROTTLE_MS = parseInt(process.env.THROTTLE_MS || "1500", 10);

const STAFF_QUERY = `
query ($id: Int, $page: Int, $perPage: Int) {
  Staff(id: $id) {
    id
    name { full native }
    image { large }
    languageV2
    favourites
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

// Fetches all pages (up to MAX_PAGES) for one staff ID and flattens into the
// role shape the browser expects. Mirrors loadStaffRoles() in app.js exactly.
async function fetchVa(id) {
    let staff = null;
    const roles = [];
    let page = 1;
    let hasNext = true;

    while (hasNext && page <= MAX_PAGES) {
        const data = await gql(STAFF_QUERY, { id, page, perPage: PER_PAGE });
        const s = data.Staff;
        if (!s) throw new Error(`Staff ${id} not found`);
        if (!staff) staff = {
            id: s.id,
            name: s.name,
            image: s.image,
            language: s.languageV2,
            favourites: s.favourites,
            siteUrl: s.siteUrl,
        };

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

        const pageInfo = s.characterMedia?.pageInfo || {};
        hasNext = !!pageInfo.hasNextPage && edges.length >= PER_PAGE;
        page += 1;
        if (hasNext) await sleep(THROTTLE_MS);
    }

    // Dedupe (matches loadStaffRoles)
    const seen = new Set();
    const unique = roles.filter(r => {
        const k = `${r.animeId}::${r.characterName}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    return { staff, roles: unique };
}

async function main() {
    const raw = await readFile(POPULAR_FILE, "utf8");
    const { staff: list } = JSON.parse(raw);
    await mkdir(OUT_DIR, { recursive: true });

    let ok = 0, failed = 0;
    for (const { id, name } of list) {
        const label = `${id} (${name})`;
        process.stdout.write(`→ ${label} ... `);
        try {
            const payload = await fetchVa(id);
            payload.generatedAt = new Date().toISOString();
            const outFile = resolve(OUT_DIR, `${id}.json`);
            await writeFile(outFile, JSON.stringify(payload) + "\n");
            console.log(`${payload.roles.length} roles`);
            ok += 1;
        } catch (err) {
            console.log(`FAILED: ${err.message}`);
            failed += 1;
        }
        // Inter-VA throttle keeps the job well under AniList's per-IP budget.
        await sleep(THROTTLE_MS);
    }
    console.log(`\nDone. ${ok} succeeded, ${failed} failed.`);
    if (failed > 0 && ok === 0) process.exit(1);
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
