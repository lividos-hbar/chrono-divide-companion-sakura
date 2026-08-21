/**
 * Which maps the ranked queue actually uses.
 *
 * Nothing publishes the pool — it is decided server-side, and the client only
 * knows the queue types (`Solo1v1`, `Random2v2` in `network/ladder/wladderConfig`).
 * But every ranked match names its map in the player's history, so the pool in
 * play is derivable by sampling: take a slice of the ladder, pull each player's
 * recent matches, and count the map titles that come back.
 *
 * Measured that way 2026-08-07: 36 players over three rungs, ~4300 matches, 21
 * distinct maps, every one of them with a match on the sampling day.
 *
 * Two ladders answer, and they are separate pools rather than one — see LADDERS
 * below for the slug the team ladder is keyed by, which is not the one the
 * queue is called.
 *
 * The endpoints come from the leaderboard app's own bundle
 * (ladder.chronodivide.com/_next/static/chunks/), with the realm base out of
 * gateway.chronodivide.com/legacy/realms/servers.ini:
 *
 *   POST <base>/ladder/<sku>/<type>/<season>/rungsearch  {ladderId, start, count}
 *        -> { totalCount, records: [{ name, rank, points, wins, losses, mmr }] }
 *   POST <base>/ladder/<sku>/<type>/match-history/v2      {player}
 *        -> [{ gameId, timestamp, duration, map, result, opponents, replayUrl }]
 *
 * The service sends `Access-Control-Allow-Origin: *`, so the calls above run
 * from the options page freely. The replay host does not — it answers only
 * `https://game.chronodivide.com` and an extension holding the host permission,
 * which is why `manifest.json` asks for `replays-eu` and `replays-sea`.
 *
 * `map` comes back as the UI title with its slot suffix — "Stormy Weather LE (2)"
 * — which is exactly what MapManifest#getFullMapTitle builds.
 *
 * **A title does not identify a map**, though — corrected 2026-08-08, against
 * the claim that used to stand here. A client holds `tn04mw.map` and
 * `tn04t2.map`, both keyed `NAME:TOURNEY5`, so both are "Official Tournament
 * Map B (2)"; the ladder plays the second. So the sample resolves each title to
 * a file name out of a replay header, and the run matches on that.
 */
(() => {
  "use strict";

  const TAG = "[cd-companion/ladder]";

  // The realms the client offers. Both answer the same API; a player's history
  // lives in the realm they play, so the pool is read per realm rather than
  // merged — a map in the SEA rotation is not evidence about EU.
  const REALMS = {
    "am-eu": { label: "Americas & Europe", base: "https://wol-eu.chronodivide.com" },
    sea: { label: "South-East Asia", base: "https://wol-sea.chronodivide.com" },
  };

  /**
   * The ranked ladders, by the slug the API keys them under.
   *
   * **The slug is not the queue name.** The client keeps two enums side by side
   * in `network/ladder/wladderConfig` — `LadderQueueType` (`Solo1v1` = "1v1",
   * `Team2v2` = "2v2") and `LadderType` (`Solo1v1` = "1v1", `Random2v2` =
   * "2v2-random") — and `getLadderTypeForQueueType` maps one to the other. It is
   * the *ladder* type that goes in the URL, so the team ladder is `2v2-random`;
   * a plain `2v2` answers 404 on every path. Probed live 2026-08-09 against
   * wol-eu: `/ladder/16640/2v2-random` returns its season list, and rungsearch
   * and match-history come back in exactly the shape the 1v1 ladder uses.
   *
   * Same rungs, same history shape, same `map` titles — so one sampler serves
   * both, and the only thing that differs is which pool it is a claim about.
   */
  const LADDERS = {
    "1v1": { label: "Ladder 1x1", queue: "Solo1v1" },
    "2v2-random": { label: "Ladder 2x2", queue: "Team2v2" },
  };

  // The client SKU the ladder is keyed by, as the leaderboard app hardcodes it.
  const SKU = 16640;

  // Rung 0 is the unranked pool and 2 upwards are the ranked tiers. Sampling
  // three of them rather than one guards against a tier whose players happen to
  // share a habit. Rung 1 is empty on the 1v1 ladder and thinly populated on the
  // 2v2 one (17 players, 2026-08-09), which is why the sample starts at 2 for
  // both rather than taking the top three that answer.
  const RUNGS = [2, 3, 4];

  // Per rung. Twelve players over three rungs was enough for the tally to
  // separate cleanly into "in the pool" and "not present at all" — every map
  // that appeared at all appeared dozens of times.
  const PER_RUNG = 12;

  // A map is only counted as in the pool if it was played this recently. The
  // history window is about a month wide anyway, so this mostly matters when a
  // map is rotated out mid-window.
  const FRESH_DAYS = 30;

  // How much of a replay to decode before giving up on finding its header line.
  // Three lines of text; the limit is only there so a file that is not a replay
  // cannot pull the whole download in.
  const HEADER_LIMIT = 8192;

  const post = (base, path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => {
      if (!response.ok) throw new Error(`${path} answered ${response.status}`);
      return response.json();
    });

  /**
   * One page of a ladder rung.
   *
   * `start` is **1-based**. Passing 0 returns a correct `totalCount` with an
   * empty `records` array rather than an error — a silent empty page, and the
   * first thing to suspect when a sample comes back with nothing in it.
   */
  const rung = (base, type, season, ladderId, count) =>
    post(base, `/ladder/${SKU}/${type}/${season}/rungsearch`, { ladderId, start: 1, count });

  const history = (base, type, player) =>
    post(base, `/ladder/${SKU}/${type}/match-history/v2`, { player });

  /**
   * One player's recent ranked matches, by realm and ladder rather than by base.
   *
   * The sampler above calls `history` with a base it already resolved; the
   * replays tab has a realm key and a name typed into a box, and nothing else.
   * Exported so that tab does not carry a second copy of the SKU, the path and
   * the realm table — a private endpoint duplicated is a second thing to fix
   * when it moves.
   *
   * @returns {Promise<Array<{gameId, timestamp, duration, map, result, countryId,
   *                          opponents: Array<{name, countryId}>, replayUrl}>>}
   */
  const matchHistory = (player, opts = {}) => {
    const realm = REALMS[opts.realm] ? opts.realm : "am-eu";
    const type = LADDERS[opts.type] ? opts.type : "1v1";
    return history(REALMS[realm].base, type, player);
  };

  /**
   * What counts as a map file name.
   *
   * **Not `.map` alone** — corrected 2026-08-09, against the regex that used to
   * stand below. The ladder plays YR ports that keep the Yuri's Revenge
   * extension: `dorado_descent_yr_port.mpr`, `4_tutankhamun_yrport.mpr`, both
   * measured in live replay headers. A `.map`-only test walked straight past
   * them and reported "no map file name in the replay header", which is how two
   * maps out of the 2v2 pool's eighteen ended up with no file at all — and a
   * pool entry with no file is matched by title, which is the one thing the file
   * is here to avoid.
   *
   * Exported because `src/options.js` asks the same question of a catalogue key
   * and must not answer it differently.
   */
  const MAP_FILE = /\.(map|mpr|yrm)$/i;

  /**
   * What the resolver above is, as a number, stamped on every pool it samples.
   *
   * Because a stored pool outlives the code that made it, and there is no way
   * to tell by looking: after the `.mpr` correction the two YR ports still read
   * `file unresolved` on screen — correctly, since that is what the *sample*
   * said, taken seventeen minutes before the fix. The row's advice to re-sample
   * was already there and reads as boilerplate; a pool that can say it predates
   * the resolver turns it into a fact.
   *
   * Raised whenever a change here would give a different answer for the same
   * ladder. 1 is the `.mpr`-aware resolver; a pool with no stamp is older than
   * that and is exactly the case this exists for.
   */
  const RESOLVER_VERSION = 1;

  /**
   * The map file behind a title, read out of a replay's own header.
   *
   * Line 3 of a replay is one comma-separated record; the field that names a
   * map file is the one the game was played on, and the one after it is that
   * file's CRC. It is the only place the ladder states a file name — the match
   * history says "Official Tournament Map B (2)", which is two different maps.
   *
   * Only the head is read. The rest of a replay is 50–150 KB of game commands
   * and none of it is the answer, so the stream is cancelled as soon as the
   * line is in hand. A `Range` request would be cheaper still, but it is not a
   * CORS-safelisted header and the host answers the preflight it triggers with
   * 403 — measured 2026-08-08.
   */
  async function mapFileFromReplay(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`replay answered ${response.status}`);
    if (!response.body) throw new Error("replay came back without a body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let head = "";
    try {
      while (head.split("\n").length < 4 && head.length < HEADER_LIMIT) {
        const chunk = await reader.read();
        if (chunk.done) break;
        head += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.cancel().catch((e) => console.warn(TAG, "could not drop the replay stream", e));
    }
    const file = (head.split("\n")[2] || "").split(",").find((f) => MAP_FILE.test(f));
    if (!file) throw new Error("no map file name in the replay header");
    return file;
  }

  /**
   * Sample the ladder and return the maps it is played on.
   *
   * Players are queried one at a time on purpose. This is somebody else's
   * service being asked a question it was not built to answer, and a burst of
   * three dozen parallel requests is the difference between reading a public
   * API and hammering it. The whole sample is a few dozen requests once.
   *
   * @param {object}   [opts]
   * @param {string}   [opts.realm]     key of REALMS, default "am-eu"
   * @param {string}   [opts.type]      key of LADDERS, default "1v1". An
   *                                    unknown one falls back rather than
   *                                    throwing, the way an unknown realm does —
   *                                    a stored pool naming a ladder that has
   *                                    since been retired should re-sample as
   *                                    something, not fail.
   * @param {function} [opts.onProgress] (done, total, what) while it runs
   * @returns {Promise<{realm, type, at, from, to, players, matches, maps: Array}>}
   *          `from`/`to` are the first and last match the tally actually counted
   *          — the period the pool is a claim about, which is not FRESH_DAYS
   *          (nobody played on the oldest day of the window) and not `at` (the
   *          day it was measured). `maps` is sorted by how often it came up:
   *          { title, matches, last, replay, file }
   */
  async function samplePool(opts = {}) {
    const realm = REALMS[opts.realm] ? opts.realm : "am-eu";
    const base = REALMS[realm].base;
    const type = LADDERS[opts.type] ? opts.type : "1v1";
    const progress = opts.onProgress || (() => {});

    const names = new Set();
    for (const ladderId of RUNGS) {
      progress(0, 0, `reading rung ${ladderId}`);
      try {
        const page = await rung(base, type, "current", ladderId, PER_RUNG);
        for (const record of page.records || []) if (record.name) names.add(record.name);
      } catch (e) {
        // One unreachable rung is a thinner sample, not a failed one — the
        // other rungs still answer the question.
        console.warn(TAG, `rung ${ladderId} failed`, e);
      }
    }
    if (!names.size) throw new Error("the ladder returned no players — nothing to sample");

    const players = [...names];
    const seen = new Map(); // title -> { matches, last }
    const cutoff = Date.now() - FRESH_DAYS * 86400000;
    let matches = 0;
    let failed = 0;
    let from = 0;
    let to = 0;

    for (let i = 0; i < players.length; i++) {
      progress(i, players.length, players[i]);
      let games;
      try {
        games = await history(base, type, players[i]);
      } catch (e) {
        // A player whose history will not load costs us their sample and
        // nothing else; a run that gave up here would be defeated by one
        // renamed account.
        console.warn(TAG, `history for ${players[i]} failed`, e);
        failed++;
        continue;
      }
      for (const game of games || []) {
        if (!game || !game.map || !(game.timestamp >= cutoff)) continue;
        matches++;
        // The period the tally covers, measured rather than assumed: a history
        // that only goes back a fortnight makes a fortnight's claim, whatever
        // FRESH_DAYS allows.
        if (!from || game.timestamp < from) from = game.timestamp;
        if (game.timestamp > to) to = game.timestamp;
        const entry = seen.get(game.map) || { matches: 0, last: 0, replay: "" };
        entry.matches++;
        // The newest match's replay, because that is the one whose map file is
        // the one in the rotation now — an old replay can name a map the pool
        // has since replaced.
        if (game.timestamp >= entry.last) {
          entry.last = game.timestamp;
          if (game.replayUrl) entry.replay = game.replayUrl;
        }
        seen.set(game.map, entry);
      }
    }
    progress(players.length, players.length, "");

    if (failed === players.length) throw new Error("no match history could be read");

    const maps = [...seen]
      .map(([title, entry]) => ({
        title,
        matches: entry.matches,
        last: entry.last,
        replay: entry.replay,
        file: "",
      }))
      .sort((a, b) => b.matches - a.matches || a.title.localeCompare(b.title));

    // The file each title actually means. One replay head per map — a map whose
    // replay will not answer keeps an empty `file` and is matched by title
    // instead, which is right until two maps share the title.
    for (let i = 0; i < maps.length; i++) {
      if (!maps[i].replay) continue;
      progress(i, maps.length, `resolving ${maps[i].title}`);
      try {
        maps[i].file = await mapFileFromReplay(maps[i].replay);
      } catch (e) {
        console.warn(TAG, `could not resolve a file for "${maps[i].title}"`, e);
      }
    }
    progress(maps.length, maps.length, "");

    return {
      realm,
      type,
      at: Date.now(),
      rv: RESOLVER_VERSION,
      from,
      to,
      players: players.length - failed,
      matches,
      maps,
    };
  }

  window.__cdcLadder = { samplePool, matchHistory, REALMS, LADDERS, MAP_FILE, RESOLVER_VERSION };
})();
