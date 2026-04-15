"""Prototype: fetch and print info for "Frieren" Season 1 from the MAL API.

Public anime lookups only need the Client ID passed via the
X-MAL-CLIENT-ID header — no OAuth/user token required.

Usage:
    export MAL_CLIENT_ID="..."
    export MAL_CLIENT_SECRET="..."   # required by secret_script on import
    python3 frieren_info.py
"""

import textwrap

import requests

from secret_script import MAL_CLIENT_ID

BASE_URL = "https://api.myanimelist.net/v2"
HEADERS = {"X-MAL-CLIENT-ID": MAL_CLIENT_ID}

DETAIL_FIELDS = ",".join(
    [
        "id",
        "title",
        "alternative_titles",
        "start_date",
        "end_date",
        "synopsis",
        "mean",
        "rank",
        "popularity",
        "num_episodes",
        "status",
        "genres",
        "studios",
        "source",
        "rating",
        "media_type",
        "average_episode_duration",
        "start_season",
    ]
)


def search_anime(query: str, limit: int = 10) -> list[dict]:
    """Search MAL for anime matching `query`."""
    response = requests.get(
        f"{BASE_URL}/anime",
        headers=HEADERS,
        params={
            "q": query,
            "limit": limit,
            "fields": "media_type,start_season",
        },
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["data"]


def get_anime_details(anime_id: int) -> dict:
    """Fetch the full detail payload for a given MAL anime id."""
    response = requests.get(
        f"{BASE_URL}/anime/{anime_id}",
        headers=HEADERS,
        params={"fields": DETAIL_FIELDS},
        timeout=10,
    )
    response.raise_for_status()
    return response.json()


def find_frieren_season_1(results: list[dict]) -> dict | None:
    """Pick the main TV series from a list of search hits."""
    for entry in results:
        node = entry["node"]
        title = node.get("title", "").lower()
        if node.get("media_type") == "tv" and "frieren" in title:
            return node
    return results[0]["node"] if results else None


def format_duration(seconds: int | None) -> str:
    if not seconds:
        return "unknown"
    minutes = seconds // 60
    return f"{minutes} min per episode"


def print_anime(anime: dict) -> None:
    title = anime.get("title", "Unknown")
    english = anime.get("alternative_titles", {}).get("en") or "—"
    japanese = anime.get("alternative_titles", {}).get("ja") or "—"
    season = anime.get("start_season", {})
    season_str = (
        f"{season.get('season', '?').title()} {season.get('year', '?')}"
        if season
        else "—"
    )
    genres = ", ".join(g["name"] for g in anime.get("genres", [])) or "—"
    studios = ", ".join(s["name"] for s in anime.get("studios", [])) or "—"
    synopsis = anime.get("synopsis", "").strip() or "—"

    print("=" * 72)
    print(f"  {title}")
    print("=" * 72)
    print(f"  English title : {english}")
    print(f"  Japanese title: {japanese}")
    print(f"  MAL ID        : {anime.get('id')}")
    print(f"  Type          : {anime.get('media_type', '—').upper()}")
    print(f"  Status        : {anime.get('status', '—')}")
    print(f"  Aired         : {anime.get('start_date', '?')} -> {anime.get('end_date', '?')}")
    print(f"  Season        : {season_str}")
    print(f"  Episodes      : {anime.get('num_episodes', '—')}")
    print(f"  Duration      : {format_duration(anime.get('average_episode_duration'))}")
    print(f"  Source        : {anime.get('source', '—')}")
    print(f"  Rating        : {anime.get('rating', '—')}")
    print(f"  Score         : {anime.get('mean', '—')}")
    print(f"  Rank          : #{anime.get('rank', '—')}")
    print(f"  Popularity    : #{anime.get('popularity', '—')}")
    print(f"  Studios       : {studios}")
    print(f"  Genres        : {genres}")
    print()
    print("  Synopsis:")
    for paragraph in synopsis.split("\n"):
        for line in textwrap.wrap(paragraph, width=68) or [""]:
            print(f"    {line}")
    print("=" * 72)


def main() -> None:
    results = search_anime("Frieren")
    target = find_frieren_season_1(results)
    if target is None:
        raise SystemExit("No results returned from MAL for 'Frieren'.")
    anime = get_anime_details(target["id"])
    print_anime(anime)


if __name__ == "__main__":
    main()
