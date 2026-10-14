/**
 * Reads for historical-baseball (fleet #2976).
 *
 * Two sources, loaded into the SAME D1 database the gateway hands this pack
 * as `_d1` (pack-manifest "d1Binding": "HISTORICAL_BASEBALL_DB") by
 * scripts/historical-baseball/load-data.mjs -- never by a deploy:
 *
 *   - `games`: Retrosheet game logs (retrosheet.org/gamelogs) -- one row per
 *     game, team-level totals, 1871-2025. Free with a required attribution
 *     notice (SOURCES.retrosheet.license, reproduced verbatim).
 *   - `people` / `batting_season` / `pitching_season` / `teams_season`: the
 *     SABR Lahman Baseball Database, CC BY-SA 3.0. See README.md "Licensing
 *     and ShareAlike compliance" -- because these four tables are built from
 *     SABR's bulk files rather than answered by calling SABR live per
 *     request, ShareAlike applies: they are themselves served under
 *     CC BY-SA 3.0, same as the source.
 *
 * SCOPE: season and game AGGREGATES only -- Retrosheet's play-by-play event
 * files are never loaded (CLAUDE.md "prefer the smallest store that answers
 * the tool questions").
 */

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'historical-baseball: the store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export const SOURCES = {
  retrosheet: {
    source: 'Retrosheet, game logs (retrosheet.org/gamelogs)',
    source_url: 'https://www.retrosheet.org/gamelogs/',
    license:
      'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".',
  },
  lahman: {
    source: 'SABR Lahman Baseball Database (sabr.org/lahman-database), via Sean Lahman',
    source_url: 'https://sabr.org/lahman-database/',
    license:
      'Copyright 1996-2025 SABR, via generous donation from Sean Lahman. Licensed Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0, https://creativecommons.org/licenses/by-sa/3.0/). These tables are built from SABR\'s bulk files rather than a live call, so ShareAlike applies: the people/batting_season/pitching_season/teams_season data served here is itself CC BY-SA 3.0 -- see this pack\'s README "Licensing and ShareAlike compliance".',
  },
} as const;

export interface Meta {
  retro_loaded_at: string;
  retro_earliest_date: string;
  retro_latest_date: string;
  retro_games_loaded: number;
  lahman_loaded_at: string;
  lahman_latest_year: number;
}
let cachedMeta: Meta | null = null;
export async function getMeta(db: D1Like): Promise<Meta> {
  if (cachedMeta) return cachedMeta;
  const r = await db.prepare('SELECT key, value FROM historical_baseball_meta').all<{ key: string; value: string }>();
  const m = Object.fromEntries(r.results.map((row) => [row.key, row.value]));
  cachedMeta = {
    retro_loaded_at: m.retro_loaded_at ?? '',
    retro_earliest_date: m.retro_earliest_date ?? '',
    retro_latest_date: m.retro_latest_date ?? '',
    retro_games_loaded: Number(m.retro_games_loaded ?? 0),
    lahman_loaded_at: m.lahman_loaded_at ?? '',
    lahman_latest_year: Number(m.lahman_latest_year ?? 0),
  };
  return cachedMeta;
}

export function clampLimit(requested: unknown, dflt = 50, max = 200): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(n, max);
}

// ── team code resolution ────────────────────────────────────────────────
// Retrosheet/Lahman team codes are mostly 2-3 letters and stable for the
// current 30 franchises; this maps common names to the code CURRENTLY in use
// (e.g. the Athletics' Retrosheet code changed OAK -> ATH for the 2025
// relocation to Sacramento -- both codes exist in the loaded data, this
// alias just picks the modern one). A handful of well-known defunct
// franchises are included too. A code NOT in this table still works fine
// typed directly (e.g. "BRO", "SLA", "WS1") -- validity is checked against
// what the DB actually holds, not against this list.
const TEAM_ALIASES: Record<string, string> = {
  ANGELS: 'ANA', 'LOS ANGELES ANGELS': 'ANA',
  DIAMONDBACKS: 'ARI', DBACKS: 'ARI', ARIZONA: 'ARI',
  ATHLETICS: 'ATH', "A'S": 'ATH', OAKLAND: 'ATH',
  BRAVES: 'ATL', ATLANTA: 'ATL',
  ORIOLES: 'BAL', BALTIMORE: 'BAL',
  'RED SOX': 'BOS', BOSTON: 'BOS',
  'WHITE SOX': 'CHA',
  CUBS: 'CHN',
  REDS: 'CIN', CINCINNATI: 'CIN',
  GUARDIANS: 'CLE', INDIANS: 'CLE', CLEVELAND: 'CLE',
  ROCKIES: 'COL', COLORADO: 'COL',
  TIGERS: 'DET', DETROIT: 'DET',
  ASTROS: 'HOU', HOUSTON: 'HOU',
  ROYALS: 'KCA', 'KANSAS CITY': 'KCA',
  DODGERS: 'LAN',
  MARLINS: 'MIA', MIAMI: 'MIA', FLORIDA: 'MIA',
  BREWERS: 'MIL', MILWAUKEE: 'MIL',
  TWINS: 'MIN', MINNESOTA: 'MIN',
  YANKEES: 'NYA',
  METS: 'NYN',
  PHILLIES: 'PHI', PHILADELPHIA: 'PHI',
  PIRATES: 'PIT', PITTSBURGH: 'PIT',
  PADRES: 'SDN', 'SAN DIEGO': 'SDN',
  MARINERS: 'SEA', SEATTLE: 'SEA',
  GIANTS: 'SFN', 'SAN FRANCISCO': 'SFN',
  CARDINALS: 'SLN', 'ST. LOUIS': 'SLN', 'ST LOUIS': 'SLN',
  RAYS: 'TBA', 'DEVIL RAYS': 'TBA', 'TAMPA BAY': 'TBA',
  RANGERS: 'TEX', TEXAS: 'TEX',
  'BLUE JAYS': 'TOR', TORONTO: 'TOR',
  NATIONALS: 'WAS', WASHINGTON: 'WAS',
  // defunct/relocated franchises with well-known names
  EXPOS: 'MON', MONTREAL: 'MON',
  'BROOKLYN DODGERS': 'BRO',
  'ST. LOUIS BROWNS': 'SLA', 'ST LOUIS BROWNS': 'SLA',
  'BOSTON BRAVES': 'BSN',
  'MILWAUKEE BRAVES': 'MLN',
  'PHILADELPHIA ATHLETICS': 'PHA',
  'NEW YORK GIANTS': 'NY1',
  'WASHINGTON SENATORS': 'WS1',
};

/** Normalize caller input to a candidate team code -- does NOT guarantee the
 *  code exists in this pack's data; callers check existence themselves. */
export function resolveTeamCode(input: unknown): string | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (TEAM_ALIASES[upper]) return TEAM_ALIASES[upper];
  if (/^[A-Z0-9]{2,3}$/.test(upper)) return upper;
  return null;
}

export async function validTeamInGames(db: D1Like, code: string): Promise<boolean> {
  const r = await db.prepare('SELECT 1 AS x FROM games WHERE v_team = ? OR h_team = ? LIMIT 1').bind(code, code).first<{ x: number }>();
  return r != null;
}

export async function teamSeasonRows(db: D1Like, teamId: string, year: number) {
  const r = await db
    .prepare(
      `SELECT year, lg_id, team_id, franch_id, div_id, rank, g, w, l, div_win, wc_win, lg_win, ws_win,
        r AS runs, ab, h, b2b, b3b, hr, bb, so, sb, cs, ra, er, era, name, park, attendance
       FROM teams_season WHERE year = ? AND team_id = ?`,
    )
    .bind(year, teamId)
    .all();
  return r.results;
}

export async function teamSeasonByNameRows(db: D1Like, nameSubstr: string, year: number) {
  const r = await db
    .prepare(
      `SELECT year, lg_id, team_id, franch_id, div_id, rank, g, w, l, div_win, wc_win, lg_win, ws_win,
        r AS runs, ab, h, b2b, b3b, hr, bb, so, sb, cs, ra, er, era, name, park, attendance
       FROM teams_season WHERE year = ? AND lower(name) LIKE ?`,
    )
    .bind(year, `%${nameSubstr.toLowerCase()}%`)
    .all();
  return r.results;
}

export interface PersonRow {
  player_id: string;
  name_first: string | null;
  name_last: string | null;
  full_name: string | null;
  birth_year: number | null;
  bats: string | null;
  throws: string | null;
  debut: string | null;
  final_game: string | null;
}

export async function findPersonById(db: D1Like, playerId: string): Promise<PersonRow | null> {
  const r = await db
    .prepare('SELECT player_id, name_first, name_last, full_name, birth_year, bats, throws, debut, final_game FROM people WHERE player_id = ?')
    .bind(playerId)
    .first<PersonRow>();
  return r ?? null;
}

export async function findPeopleByName(db: D1Like, name: string): Promise<PersonRow[]> {
  const lower = name.trim().toLowerCase();
  const exact = await db
    .prepare('SELECT player_id, name_first, name_last, full_name, birth_year, bats, throws, debut, final_game FROM people WHERE full_name_lower = ?')
    .bind(lower)
    .all<PersonRow>();
  if (exact.results.length) return exact.results;
  const fuzzy = await db
    .prepare(
      'SELECT player_id, name_first, name_last, full_name, birth_year, bats, throws, debut, final_game FROM people WHERE full_name_lower LIKE ? ORDER BY full_name_lower LIMIT 20',
    )
    .bind(`%${lower}%`)
    .all<PersonRow>();
  return fuzzy.results;
}

export async function battingSeasonsFor(db: D1Like, playerId: string) {
  const r = await db
    .prepare(
      `SELECT year, stint, team_id, lg_id, g, ab, r, h, b2b, b3b, hr, rbi, sb, cs, bb, so, ibb, hbp, sh, sf, gidp
       FROM batting_season WHERE player_id = ? ORDER BY year, stint`,
    )
    .bind(playerId)
    .all();
  return r.results as Array<Record<string, number | string | null>>;
}

export async function pitchingSeasonsFor(db: D1Like, playerId: string) {
  const r = await db
    .prepare(
      `SELECT year, stint, team_id, lg_id, w, l, g, gs, cg, sho, sv, ipouts, h, er, hr, bb, so, era, ibb, wp, hbp, bk, bfp, gf, r, sh, sf, gidp
       FROM pitching_season WHERE player_id = ? ORDER BY year, stint`,
    )
    .bind(playerId)
    .all();
  return r.results as Array<Record<string, number | string | null>>;
}

export interface GameRow {
  date: string;
  game_num: string;
  game_type: string;
  v_team: string;
  h_team: string;
  v_score: number | null;
  h_score: number | null;
  [k: string]: unknown;
}

export async function gamesByDateAndTeam(db: D1Like, date: string, teamCode: string): Promise<GameRow[]> {
  const r = await db
    .prepare(
      `SELECT date, game_num, game_type, day_of_week, v_team, v_league, h_team, h_league, v_score, h_score, outs,
        day_night, park_id, attendance, time_minutes,
        v_ab, v_h, v_2b, v_3b, v_hr, v_rbi, v_bb, v_so, v_e,
        h_ab, h_h, h_2b, h_3b, h_hr, h_rbi, h_bb, h_so, h_e,
        wp_id, wp_name, lp_id, lp_name, sv_id, sv_name, v_manager, h_manager
       FROM games WHERE date = ? AND (v_team = ? OR h_team = ?) ORDER BY game_num`,
    )
    .bind(date, teamCode, teamCode)
    .all<GameRow>();
  return r.results;
}

/** Parse a caller-supplied date into "YYYY-MM-DD". Accepts "YYYY-MM-DD" or
 *  "YYYYMMDD". Returns null if it cannot be parsed as a plausible date. */
export function normDate(input: unknown): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    const m2 = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m2) m = m2;
  }
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 1871 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

// ── season leaders ───────────────────────────────────────────────────────
export type BattingStat = 'HR' | 'AVG' | 'RBI' | 'R' | 'H' | 'SB' | 'BB' | 'SO' | '2B' | '3B';
export type PitchingStat = 'W' | 'ERA' | 'SO_P' | 'SV' | 'L' | 'WHIP';
const BATTING_STATS: Record<BattingStat, { col: string; asc: boolean; minAb?: boolean }> = {
  HR: { col: 'hr', asc: false },
  AVG: { col: 'CAST(h AS REAL) / NULLIF(ab, 0)', asc: false, minAb: true },
  RBI: { col: 'rbi', asc: false },
  R: { col: 'r', asc: false },
  H: { col: 'h', asc: false },
  SB: { col: 'sb', asc: false },
  BB: { col: 'bb', asc: false },
  SO: { col: 'so', asc: false },
  '2B': { col: 'b2b', asc: false },
  '3B': { col: 'b3b', asc: false },
};
const PITCHING_STATS: Record<PitchingStat, { col: string; asc: boolean; minIp?: boolean }> = {
  W: { col: 'w', asc: false },
  ERA: { col: 'era', asc: true, minIp: true },
  SO_P: { col: 'so', asc: false },
  SV: { col: 'sv', asc: false },
  L: { col: 'l', asc: false },
  WHIP: { col: 'CAST(bb + h AS REAL) / NULLIF(ipouts / 3.0, 0)', asc: true, minIp: true },
};

export function isBattingStat(s: string): s is BattingStat {
  return Object.prototype.hasOwnProperty.call(BATTING_STATS, s);
}
export function isPitchingStat(s: string): s is PitchingStat {
  return Object.prototype.hasOwnProperty.call(PITCHING_STATS, s);
}
export const BATTING_STAT_KEYS = Object.keys(BATTING_STATS);
export const PITCHING_STAT_KEYS = Object.keys(PITCHING_STATS);

export async function battingLeaders(db: D1Like, year: number, stat: BattingStat, league: string | null, limit: number) {
  const def = BATTING_STATS[stat];
  const where = ['bs.year = ?'];
  const params: unknown[] = [year];
  if (league) { where.push('bs.lg_id = ?'); params.push(league); }
  if (def.minAb) where.push('bs.ab >= 100'); // simple qualifying floor, not MLB's official rule -- see tool description
  const sql = `SELECT bs.player_id, p.full_name, bs.team_id, bs.lg_id, bs.g, bs.ab, bs.h, bs.hr, bs.rbi, bs.r, bs.sb, bs.bb, bs.so, bs.b2b, bs.b3b,
      (${def.col}) AS stat_value
    FROM batting_season bs JOIN people p ON p.player_id = bs.player_id
    WHERE ${where.join(' AND ')} AND (${def.col}) IS NOT NULL
    ORDER BY stat_value ${def.asc ? 'ASC' : 'DESC'}
    LIMIT ?`;
  params.push(limit);
  const r = await db.prepare(sql).bind(...params).all();
  return r.results;
}

export async function pitchingLeaders(db: D1Like, year: number, stat: PitchingStat, league: string | null, limit: number) {
  const def = PITCHING_STATS[stat];
  const where = ['ps.year = ?'];
  const params: unknown[] = [year];
  if (league) { where.push('ps.lg_id = ?'); params.push(league); }
  if (def.minIp) where.push('ps.ipouts >= 100'); // ~33.1 IP floor, not MLB's official qualifying rule
  const sql = `SELECT ps.player_id, p.full_name, ps.team_id, ps.lg_id, ps.g, ps.w, ps.l, ps.sv, ps.so, ps.era, ps.ipouts, ps.bb, ps.h,
      (${def.col}) AS stat_value
    FROM pitching_season ps JOIN people p ON p.player_id = ps.player_id
    WHERE ${where.join(' AND ')} AND (${def.col}) IS NOT NULL
    ORDER BY stat_value ${def.asc ? 'ASC' : 'DESC'}
    LIMIT ?`;
  params.push(limit);
  const r = await db.prepare(sql).bind(...params).all();
  return r.results;
}
