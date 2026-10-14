# @pipeworx/historical-baseball

Historical MLB statistics: career batting/pitching lines, team-season
records, per-game box-score summaries, and season leaderboards, back to
1871. Fleet #2976 — the live `mlb-stats` pack only covers the current MLB
Stats API; this pack is the historical record underneath it.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1786+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `baseball_player_history(player)` — year-by-year batting and/or pitching
  stats for one player's whole career. Pass a name ("Babe Ruth") or an exact
  Lahman `player_id` ("ruthba01"). An ambiguous name returns a candidate list
  (with `player_id`) instead of guessing.
- `baseball_team_season(team, year)` — one team's full-season record for one
  year: wins/losses, division/league/World Series result, team batting and
  pitching totals, park and attendance. Pass a code ("NYA") or common name
  ("Yankees").
- `baseball_game_log(date, team)` — box-score-level summary of the game(s)
  one team played on one date (an array, so doubleheaders return two games):
  final score, winning/losing/save pitcher, managers, and each side's
  AB/H/2B/3B/HR/RBI/BB/SO/errors. Covers regular season plus All-Star,
  Division Series, League Championship Series, Wild Card and World Series
  games (`game_type`: R/A/D/L/C/W).
- `baseball_season_leaders(year, stat, league?, limit?)` — top-N leaderboard
  for one batting or pitching stat in one season. Batting: `HR, AVG, RBI, R,
  H, SB, BB, SO, 2B, 3B`. Pitching: `W, ERA, SO_P, SV, L, WHIP`. `AVG`/`ERA`/
  `WHIP` apply a simple qualifying floor (AB>=100 / IPouts>=100), **not**
  MLB's official plate-appearance/innings qualifying rule.
- `baseball_coverage()` — the loaded Retrosheet date range, latest Lahman
  season year, and when it was last refreshed. Call this if a date/year you
  expect to exist comes back not-found.

Team codes changed for several relocated/renamed franchises (e.g. the
Athletics' Retrosheet code changed for the 2025 move to Sacramento); both the
old and new codes exist in the data where applicable, and a handful of common
names and well-known defunct franchises resolve automatically (see
`TEAM_ALIASES` in `src/store.ts`). An unrecognized team/year/date/stat is
refused with a clear error, never an empty success.

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds the
data; a standalone `npm install` has no data to read, and every tool throws a
clear "not bound in this runtime" error there instead of returning an empty
list.

## Data sources

- **Retrosheet** (retrosheet.org/gamelogs) — one row per game, 1871-2025.
  Free with a required attribution notice, reproduced verbatim in every
  `baseball_game_log` response:

  > The information used here was obtained free of charge from and is
  > copyrighted by Retrosheet. Interested parties may contact Retrosheet at
  > "www.retrosheet.org".

- **SABR Lahman Baseball Database** (sabr.org/lahman-database) — season
  batting/pitching/team tables and player bios, 1871-2025 (now including
  Negro Leagues statistics licensed from Seamheads.com), maintained by SABR
  from Sean Lahman's original donation. Licensed **CC BY-SA 3.0 Unported**
  (Creative Commons Attribution-ShareAlike):

  > This database is copyright 1996-2025 by SABR, via generous donation from
  > Sean Lahman. This work is licensed under a Creative Commons
  > Attribution-ShareAlike 3.0 Unported License. For details see:
  > http://creativecommons.org/licenses/by-sa/3.0/

Neither source publishes a live query API — both ship bulk files only — so
this pack builds a copy rather than proxying (CLAUDE.md "BUILD THE COPY").
**Scope: season and game AGGREGATES only.** Retrosheet's play-by-play EVENT
files are never loaded; game logs are already one row per game and Lahman's
tables are already one row per player-team-season, so unlike a raw-flight or
raw-delivery source, neither needed an aggregation step here.

### Licensing and ShareAlike compliance

The Lahman tables (`people`, `batting_season`, `pitching_season`,
`teams_season`) are built from SABR's bulk files rather than answered by
calling SABR live per request — and CC BY-SA 3.0's ShareAlike term applies to
that kind of build, not to calling an upstream live. Concretely, that means:

- **Attribution (BY)**: every response from a Lahman-backed tool carries
  `source` (SABR/Sean Lahman), `source_url` (sabr.org/lahman-database) and
  the full license text in `license`, and this README states it again.
- **ShareAlike**: because we hold and redistribute a derivative of these
  specific four tables (via the tool responses above), that derivative is
  itself licensed CC BY-SA 3.0 — same as the source, not more restrictively.
  If you build a product on data returned by `baseball_player_history`,
  `baseball_team_season` or the batting/pitching side of
  `baseball_season_leaders`, your own adaptation of *that data* carries the
  same CC BY-SA 3.0 obligation: credit SABR/Sean Lahman, and license your own
  redistribution of it under CC BY-SA 3.0 or a compatible license.
- This does **not** extend to the Retrosheet-backed `baseball_game_log` data,
  which carries only Retrosheet's own attribution requirement (quoted
  above), no ShareAlike term.
- It does not restrict anything else in the Pipeworx catalog — ShareAlike
  "infects" only the specific copied/adapted work, not an unrelated codebase
  that happens to also call this gateway (the same reasoning as the
  `symmap` precedent in CLAUDE.md, applied to a license that actually
  requires it rather than one that was waived).

### Refreshing or extending the data

```bash
node scripts/historical-baseball/load-data.mjs
# Retrosheet only (skip re-downloading/parsing Lahman's local CSVs):
node scripts/historical-baseball/load-data.mjs --skip-lahman
# Lahman only, once new CSVs are in place:
node scripts/historical-baseball/load-data.mjs --skip-retrosheet
```

**Retrosheet is fully automated.** The loader downloads
`https://www.retrosheet.org/gamelogs/gl1871_2025.zip` (a stable combined bulk
file covering 1871-2025 plus All-Star/postseason game logs) directly — no
manual step. Re-run once Retrosheet publishes the following season's combined
zip (check `https://www.retrosheet.org/gamelogs/` for a newer
`gl1871_20XX.zip`, or a standalone `gl20XX.zip` before the combined file is
updated).

**Lahman is NOT automated and needs a one-time manual download.** SABR
distributes the comma-delimited release through **signed per-file Box.com
links** (`sabr.box.com/s/<share-id>/file/<id>`) minted by Box's web app —
there is no stable, curlable URL for the CSVs themselves (unlike Retrosheet's
zip). To refresh:

1. Open <https://sabr.org/lahman-database/> and follow the "Comma-delimited
   version" link (currently `sabr.box.com/s/...`) under "Download latest
   version".
2. Download `Teams.csv`, `People.csv`, `Batting.csv` and `Pitching.csv` from
   that Box folder into a local directory.
3. Run the loader with `--lahman-dir <that directory>` (defaults to
   `../lahman-csv` relative to this repo's root, i.e. a sibling of the
   `pipeworx` checkout).

Each run **replaces** every table (DROP + reload), because SABR republishes
corrected editions of the whole file rather than publishing incremental
diffs, so a clean reload is the only way to avoid stale rows from a
previously-corrected season lingering alongside the new data.

Needs `wrangler` logged in to the Pipeworx Cloudflare account for either
source.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "historical-baseball": {
      "url": "https://gateway.pipeworx.io/historical-baseball/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/historical-baseball/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1786+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/baseball_player_history \
  -H 'Content-Type: application/json' \
  -d '{"player":"Babe Ruth"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/baseball_player_history`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "historical-baseball": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-historical-baseball"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-historical-baseball
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Historical Baseball data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
