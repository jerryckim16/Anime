// Seiyuu Compare — anime voice actor comparison
// Data source: AniList GraphQL API (https://docs.anilist.co/)

const ANILIST_URL = "https://graphql.anilist.co";

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
    characters(perPage: 25, page: $page, sort: [START_DATE_DESC]) {
      pageInfo { hasNextPage currentPage }
      edges {
        role
        node { id name { full } image { medium } }
        media(sort: [START_DATE_DESC], type: ANIME) {
          id
          title { romaji english }
          startDate { year }
          coverImage { medium }
          siteUrl
          format
        }
      }
    }
  }
}`;

const MAX_PAGES = 12; // hard cap: ~300 character roles per VA

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

// ---------- AniList ----------

async function gql(query, variables) {
    const res = await fetch(ANILIST_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
        throw new Error(`Rate limited by AniList. Try again in ${retryAfter}s.`);
    }
    if (!res.ok) {
        throw new Error(`AniList HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json.errors && json.errors.length) {
        throw new Error(json.errors[0].message || "AniList GraphQL error");
    }
    return json.data;
}

async function searchStaff(query) {
    const data = await gql(SEARCH_QUERY, { search: query });
    return data.Page.staff.filter(s =>
        (s.primaryOccupations || []).some(o => o.toLowerCase().includes("voice"))
    );
}

async function loadStaffRoles(id) {
    let staff = null;
    const roles = [];
    let page = 1;
    let hasNext = true;

    while (hasNext && page <= MAX_PAGES) {
        const data = await gql(STAFF_QUERY, { id, page });
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

        for (const edge of s.characters.edges) {
            const character = edge.node;
            for (const media of edge.media || []) {
                if (!media || !media.startDate || !media.startDate.year) continue;
                roles.push({
                    year: media.startDate.year,
                    animeId: media.id,
                    animeTitle: media.title.english || media.title.romaji,
                    animeCover: media.coverImage && media.coverImage.medium,
                    animeUrl: media.siteUrl,
                    animeFormat: media.format,
                    characterName: character.name.full,
                    characterImage: character.image && character.image.medium,
                    role: edge.role, // MAIN | SUPPORTING | BACKGROUND
                });
            }
        }
        hasNext = s.characters.pageInfo.hasNextPage;
        page += 1;
    }

    // Deduplicate (same character + anime can repeat across pages occasionally)
    const seen = new Set();
    const unique = roles.filter(r => {
        const key = `${r.animeId}::${r.characterName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return { staff, roles: unique };
}

// ---------- Search UI ----------

function setupSearchPanel(side) {
    const panel = $(`.va-panel[data-side="${side}"]`);
    const input = $(".search-input", panel);
    const list = $(".search-results", panel);

    const runSearch = debounce(async (query) => {
        if (!query.trim()) {
            list.hidden = true;
            list.innerHTML = "";
            return;
        }
        try {
            const results = await searchStaff(query.trim());
            renderSearchResults(list, results, side);
        } catch (err) {
            console.error(err);
            showError(err.message);
        }
    }, 300);

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

function renderVaCard(panel, { staff, roles }) {
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
        el("div", { class: "va-name" }, staff.name.full),
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

// ---------- Timeline ----------

function renderTimeline() {
    if (!state.left || !state.right) return;

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
                el("div", { class: "role-character" }, `as ${r.characterName}`),
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
