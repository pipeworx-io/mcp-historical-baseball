interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * historical-baseball -- MLB history from Retrosheet game logs and the SABR
 * Lahman Baseball Database (fleet #2976).
 *
 * Two local-copy sources in one D1 database (gateway hands it to this pack
 * as `_d1`, "d1Binding": "HISTORICAL_BASEBALL_DB"):
 *   - Retrosheet game logs (retrosheet.org/gamelogs): one row per game,
 *     team-level totals, 1871-2025. Free with a required attribution notice.
 *   - The SABR Lahman Baseball Database (sabr.org/lahman-database): season
 *     batting/pitching/team tables and player bios, 1871-2025, CC BY-SA 3.0.
 *
 * Both sources only publish BULK FILES (no live query API), so this pack
 * builds a copy rather than proxying (CLAUDE.md "BUILD THE COPY"). SCOPE:
 * season and game AGGREGATES only -- Retrosheet's play-by-play event files
 * are never loaded. Loader: scripts/historical-baseball/load-data.mjs.
 *
 * Licensing: every response carries `source`, `source_url`, `license` and
 * `data_as_of`. See README.md "Licensing and ShareAlike compliance" for how
 * this pack complies with the Lahman database's CC BY-SA 3.0 ShareAlike term,
 * which applies because these tables are built from SABR's bulk files rather
 * than answered by calling SABR live.
 */
import {
  battingLeaders,
  battingSeasonsFor,
  BATTING_STAT_KEYS,
  clampLimit,
  findPeopleByName,
  findPersonById,
  gamesByDateAndTeam,
  getMeta,
  isBattingStat,
  isPitchingStat,
  normDate,
  pitchingLeaders,
  pitchingSeasonsFor,
  PITCHING_STAT_KEYS,
  requireDb,
  resolveTeamCode,
  SOURCES,
  teamSeasonByNameRows,
  teamSeasonRows,
  validTeamInGames,
  type D1Like,
} from './store.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'baseball_player_history',
    description:
      'Year-by-year MLB batting and/or pitching statistics for one player\'s whole career, from the SABR Lahman Baseball Database (1871-2025). Pass a player NAME ("Babe Ruth", "Walter Johnson") or an exact Lahman player_id (e.g. "ruthba01") -- a name is resolved by exact then fuzzy match; if more than one player matches, a list of candidates (with player_id, birth year, debut) is returned instead of a guess, so the caller can re-ask with the exact player_id. Returns every season the player appears in Batting.csv and/or Pitching.csv (most players have only one; a few, like Babe Ruth, have both). Each season row has team, league, games and the standard counting stats. Unknown or ambiguous names are refused with a clear error/candidate-list, never an empty success.',
    summary: 'Career year-by-year batting/pitching lines for one MLB player.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        player: { type: 'string', description: 'Player name ("Hank Aaron") or exact Lahman player_id ("aaronha01").' },
      },
      required: ['player'],
    },
  },
  {
    name: 'baseball_team_season',
    description:
      'One MLB team\'s full-season record and stats for one year, from the SABR Lahman Baseball Database (1871-2025): wins/losses, division/league/World Series result, runs scored and allowed, team batting and pitching totals, home park and attendance. Pass team as a 3-letter-ish code ("NYA", "BOS") or a common name ("Yankees", "Red Sox", "Dodgers") -- codes changed for some relocated/renamed franchises over the years (e.g. the Athletics\' code changed for 2025), so an unrecognized code for that year is refused with a clear error rather than an empty success; try the franchise\'s name instead, or call with a nearby year to see what code that franchise used.',
    summary: 'One team\'s season record, standings result and team stats for one year.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        team: { type: 'string', description: 'Team code ("LAN") or common name ("Dodgers").' },
        year: { type: 'number', description: 'Season year, e.g. 1927.' },
      },
      required: ['team', 'year'],
    },
  },
  {
    name: 'baseball_game_log',
    description:
      'Box-score-level summary of MLB game(s) played by one team on one date, from Retrosheet game logs (1871-2025): final score, game length, day/night, park, attendance, winning/losing/saving pitcher, managers, and each side\'s at-bats/hits/doubles/triples/homers/RBI/walks/strikeouts/errors. Covers regular season plus All-Star, Division Series, League Championship Series, Wild Card and World Series games (see game_type in the response: R/A/D/L/C/W). Pass date as "YYYY-MM-DD" or "YYYYMMDD" and team as a code ("NYA") or common name ("Yankees"). Returns an array because doubleheaders are two games on one date. This is a per-game SUMMARY, not a play-by-play log -- no pitch or at-bat level detail is stored. No games found for a valid date/team combination is reported as found:false with the reason, never an empty array treated as success.',
    summary: 'Per-game box-score summary for one team on one date (handles doubleheaders).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Game date, "YYYY-MM-DD" or "YYYYMMDD".' },
        team: { type: 'string', description: 'Team code ("BOS") or common name ("Red Sox").' },
      },
      required: ['date', 'team'],
    },
  },
  {
    name: 'baseball_season_leaders',
    description:
      `Top players in one MLB season for one statistic, from the SABR Lahman Baseball Database. Batting stats: ${BATTING_STAT_KEYS.join(', ')} (AVG = hits/at-bats, qualified at a simple AB>=100 floor -- NOT MLB's official plate-appearance qualifying rule, so this can include players who would not qualify for an official batting title). Pitching stats: ${PITCHING_STAT_KEYS.join(', ')} (SO_P = pitcher strikeouts, to avoid colliding with batting SO; ERA and WHIP are qualified at a simple IPouts>=100 i.e. ~33 innings floor, also not the official rule). Pass stat exactly as listed (case-sensitive). Optionally scope to one league ("AL" or "NL"; pre-1901 leagues like "NA", "AA", "UA", "PL" also appear in the data). limit caps how many rows come back (default 10, max 50). An unrecognized stat name is refused with the list of valid ones, never an empty success.`,
    summary: 'Top-N leaderboard for one batting or pitching stat in one MLB season.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        year: { type: 'number', description: 'Season year, e.g. 1998.' },
        stat: { type: 'string', description: `One of: ${[...BATTING_STAT_KEYS, ...PITCHING_STAT_KEYS].join(', ')}.` },
        league: { type: 'string', description: 'Optional: scope to one league code ("AL", "NL", or an historical league code).' },
        limit: { type: 'number', description: 'Max rows to return, 1-50. Default 10.' },
      },
      required: ['year', 'stat'],
    },
  },
  {
    name: 'baseball_coverage',
    description:
      'What this pack actually has loaded right now: the Retrosheet game-log date range, how many games, the latest Lahman season year, and when it was last loaded. Call this if a query for a date or year you expect to exist comes back not-found, to rule out a coverage gap before assuming a typo.',
    summary: 'Loaded date/year ranges and when they were last refreshed.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

function notFoundTeam(input: unknown, year?: number) {
  return {
    found: false,
    reason: 'unknown_team',
    message:
      `${JSON.stringify(input)} did not resolve to a known team code${year ? ` for ${year}` : ''}. Try a common franchise name ("Yankees") or the exact code used in that era -- team codes changed for several relocated/renamed franchises. Call baseball_coverage or try a nearby year.`,
  };
}

async function playerHistoryTool(db: D1Like, args: Record<string, unknown>) {
  const input = typeof args.player === 'string' ? args.player.trim() : '';
  if (!input) return { found: false, reason: 'missing_player', message: 'player is required.' };

  let person = await findPersonById(db, input);
  let candidates: Awaited<ReturnType<typeof findPeopleByName>> = [];
  if (!person) {
    candidates = await findPeopleByName(db, input);
    if (candidates.length === 1) person = candidates[0];
  }
  if (!person) {
    if (candidates.length > 1) {
      return {
        found: false,
        reason: 'ambiguous_player',
        message: `${candidates.length} players match ${JSON.stringify(input)}. Re-ask with the exact player_id.`,
        candidates: candidates.slice(0, 20).map((c) => ({
          player_id: c.player_id,
          name: c.full_name,
          birth_year: c.birth_year,
          debut: c.debut,
          final_game: c.final_game,
        })),
        ...SOURCES.lahman,
      };
    }
    return {
      found: false,
      reason: 'unknown_player',
      message: `No player matching ${JSON.stringify(input)} in the loaded Lahman People table. Check spelling, or try a less-specific name.`,
      ...SOURCES.lahman,
    };
  }

  const [batting, pitching] = await Promise.all([battingSeasonsFor(db, person.player_id), pitchingSeasonsFor(db, person.player_id)]);
  if (!batting.length && !pitching.length) {
    return {
      found: false,
      reason: 'no_seasons',
      player: person,
      message: `${person.full_name} (${person.player_id}) is in the Lahman People table but has no Batting or Pitching rows loaded.`,
      ...SOURCES.lahman,
    };
  }

  const battingWithAvg = batting.map((b) => ({
    ...b,
    avg: typeof b.ab === 'number' && b.ab > 0 && typeof b.h === 'number' ? round3(b.h / b.ab) : null,
  }));

  return {
    found: true,
    player: {
      player_id: person.player_id,
      name: person.full_name,
      birth_year: person.birth_year,
      bats: person.bats,
      throws: person.throws,
      debut: person.debut,
      final_game: person.final_game,
    },
    batting_seasons: battingWithAvg.length ? battingWithAvg : undefined,
    pitching_seasons: pitching.length ? pitching : undefined,
    ...SOURCES.lahman,
    data_as_of: person.final_game || undefined,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function teamSeasonTool(db: D1Like, args: Record<string, unknown>) {
  const year = Math.floor(Number(args.year));
  if (!Number.isFinite(year)) return { found: false, reason: 'invalid_year', message: 'year must be a valid number.' };

  const code = resolveTeamCode(args.team);
  let rows: Awaited<ReturnType<typeof teamSeasonRows>> = [];
  if (code) rows = await teamSeasonRows(db, code, year);
  if (!rows.length && typeof args.team === 'string' && args.team.trim()) {
    rows = await teamSeasonByNameRows(db, args.team.trim(), year);
  }
  if (!rows.length) return { ...notFoundTeam(args.team, year), year };

  return {
    found: true,
    year,
    teams: rows,
    ...SOURCES.lahman,
    data_as_of: String(year),
  };
}

async function gameLogTool(db: D1Like, args: Record<string, unknown>) {
  const date = normDate(args.date);
  if (!date) {
    return {
      found: false,
      reason: 'invalid_date',
      message: `${JSON.stringify(args.date)} is not a valid date -- use "YYYY-MM-DD" or "YYYYMMDD".`,
    };
  }
  const code = resolveTeamCode(args.team);
  if (!code) return notFoundTeam(args.team);
  if (!(await validTeamInGames(db, code))) return notFoundTeam(args.team);

  const games = await gamesByDateAndTeam(db, date, code);
  if (!games.length) {
    return {
      found: false,
      reason: 'no_games',
      date,
      team: code,
      message: `No games found for ${code} on ${date} in the loaded Retrosheet game logs. Call baseball_coverage to check the loaded date range, or confirm the team played that day (off days, rainouts and franchise code changes are common causes).`,
      ...SOURCES.retrosheet,
    };
  }
  return {
    found: true,
    date,
    team: code,
    games_returned: games.length,
    games,
    ...SOURCES.retrosheet,
    data_as_of: date,
  };
}

async function seasonLeadersTool(db: D1Like, args: Record<string, unknown>) {
  const year = Math.floor(Number(args.year));
  if (!Number.isFinite(year)) return { found: false, reason: 'invalid_year', message: 'year must be a valid number.' };
  const stat = typeof args.stat === 'string' ? args.stat : '';
  const league = typeof args.league === 'string' && args.league.trim() ? args.league.trim().toUpperCase() : null;
  const limit = clampLimit(args.limit, 10, 50);

  if (isBattingStat(stat)) {
    const rows = await battingLeaders(db, year, stat, league, limit);
    if (!rows.length) {
      return {
        found: false,
        reason: 'no_data',
        year,
        stat,
        league,
        message: `No qualifying batting rows for ${stat} in ${year}${league ? ` (league ${league})` : ''}.`,
        ...SOURCES.lahman,
      };
    }
    return { found: true, year, stat, league, kind: 'batting', returned: rows.length, leaders: rows, ...SOURCES.lahman, data_as_of: String(year) };
  }
  if (isPitchingStat(stat)) {
    const rows = await pitchingLeaders(db, year, stat, league, limit);
    if (!rows.length) {
      return {
        found: false,
        reason: 'no_data',
        year,
        stat,
        league,
        message: `No qualifying pitching rows for ${stat} in ${year}${league ? ` (league ${league})` : ''}.`,
        ...SOURCES.lahman,
      };
    }
    return { found: true, year, stat, league, kind: 'pitching', returned: rows.length, leaders: rows, ...SOURCES.lahman, data_as_of: String(year) };
  }
  return {
    found: false,
    reason: 'unknown_stat',
    message: `${JSON.stringify(args.stat)} is not a recognized stat. Batting: ${BATTING_STAT_KEYS.join(', ')}. Pitching: ${PITCHING_STAT_KEYS.join(', ')}.`,
  };
}

async function coverageTool(db: D1Like) {
  const meta = await getMeta(db);
  return {
    retrosheet: {
      earliest_date: meta.retro_earliest_date,
      latest_date: meta.retro_latest_date,
      games_loaded: meta.retro_games_loaded,
      loaded_at: meta.retro_loaded_at,
      ...SOURCES.retrosheet,
    },
    lahman: {
      latest_season_year: meta.lahman_latest_year,
      loaded_at: meta.lahman_loaded_at,
      ...SOURCES.lahman,
    },
    note: 'Season and game AGGREGATES only -- Retrosheet play-by-play event files are not loaded. Re-run the loader to refresh (see README.md "Refresh").',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const bound = requireDb(args._d1);
  switch (name) {
    case 'baseball_player_history':
      return playerHistoryTool(bound, args);
    case 'baseball_team_season':
      return teamSeasonTool(bound, args);
    case 'baseball_game_log':
      return gameLogTool(bound, args);
    case 'baseball_season_leaders':
      return seasonLeadersTool(bound, args);
    case 'baseball_coverage':
      return coverageTool(bound);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
