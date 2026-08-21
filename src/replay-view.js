/**
 * A replay report, drawn.
 *
 * The reader is src/replay.js — this is the half that turns its output into a
 * page: the shared-clock timeline, the per-side header, and the charts. It was
 * written inside the options page and lifted out on 2026-08-16, unchanged, when
 * the published site grew a Replays page: the site can parse a `.rpl` a visitor
 * hands it (`parse`/`analyze` need no host permission, and the replay hosts
 * grant none — no `Access-Control-Allow-Origin`, and a 403 to the preflight),
 * so the only thing standing between it and the same report was this renderer.
 *
 * Two copies of six hundred lines would have diverged on the first fix, so
 * there is one, and `site/build.mjs` vendors it the way it already vendors
 * `src/glyphs.js`.
 *
 * **Write-only, and that is what makes it portable.** Nothing here reads the
 * document, the storage or a chrome API; it is handed a report and returns a
 * fragment. The caller owns the panel, the preferences and where the report
 * came from — the options page has a re-run button and a history list, the site
 * has a file drop, and neither difference reaches this file.
 *
 * `scripts/check-options.mjs` evaluates this very file against the real parser's
 * output and asserts the layout: one clock down the middle, each side reading
 * outwards, a placement distinguishable from an intent.
 */
(() => {
  "use strict";

  /**
   * The two formats a report states time in: a date for when the match was
   * played, a clock for a moment inside it.
   *
   * Exported, because a caller listing matches beside the report must not print
   * dates in a second shape.
   */
  const REPLAY_DATE = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const mmss = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

  /**
   * Which clock a moment is printed on.
   *
   * A match has two, and they are not the same number. Every time in a report is
   * a tick divided by the rate the match was **played** at
   * (`report.ticksPerSecond`, 60 on the ladder) — the wall clock, and the one
   * the ladder's own `duration` agrees with: 32 130 ticks of a ranked match are
   * 8:55, and the API says 8 minutes.
   *
   * The clock the *client* draws while you watch is a different one. It counts
   * ticks at `GameSpeed.BASE_TICKS_PER_SECOND`, 15 a second, whatever speed the
   * game is set to — so the same match reads **35:42** on screen. That is the
   * number a player remembers a moment by, and until now no report could be
   * searched for it (measured 2026-08-17: a replay whose tab died at 31 892
   * ticks showed 35:30 on the client's clock, and the report called it 8:51).
   *
   * So: `real` is the wall clock the report has always printed, `game` is the
   * client's own clock, and `both` prints the pair, `8:55 / 35:42`. A slash and
   * not a parenthesis: the two are one moment read off two clocks, neither of
   * them an aside to the other, and a bracketed half reads as the lesser one. `clockRate` is the match's
   * played rate, set for the report being drawn.
   */
  const GAME_TICKS_PER_SECOND = 15;
  let clockMode = "real";
  let clockRate = 60;
  const CLOCKS = { real: "real time", game: "game clock", both: "both" };

  /**
   * The readings a moment has, one per clock the reader asked for.
   *
   * **Parts, not a string**, because the thing between two of them is a column
   * rule and not a character. It was ` (…)`, then ` / `, and both were the same
   * mistake in different punctuation: air measured in glyphs, untunable, copied
   * out with the line and wrapped as if it were a word. `clock()` still joins
   * them for the places that can only take text — a `title`, the fallback's
   * plain rows — and everything drawn writes them with `writeClock`.
   */
  function clockParts(seconds) {
    // seconds are ticks/clockRate; the client's clock is the same ticks over 15.
    const game = (seconds * clockRate) / GAME_TICKS_PER_SECOND;
    // A match played at 15 ticks a second has one clock, not two.
    if (clockRate === GAME_TICKS_PER_SECOND) return [mmss(seconds)];
    if (clockMode === "game") return [mmss(game)];
    if (clockMode === "both") return [mmss(seconds), mmss(game)];
    return [mmss(seconds)];
  }

  const clock = (seconds) => clockParts(seconds).join(" / ");

  /** The same readings written into a cell, one element each — see `clockParts`. */
  function writeClock(el, seconds) {
    for (const part of clockParts(seconds)) {
      const said = document.createElement("span");
      said.className = "replaytime";
      said.textContent = part;
      el.append(said);
    }
    return el;
  }

  /**
   * How wide a cell of clock has to be, in characters and in pixels.
   *
   * The characters are the readings themselves, with **nothing counted for what
   * sits between them** — that is a rule and its air, which is a measurement and
   * belongs in the pixels. `CLOCK_RULE` is the two 6px margins and the hairline
   * of `.replaytime + .replaytime` in replay-view.css and has to match it.
   */
  const CLOCK_RULE = 13;
  const clockChars = (seconds) => clockParts(seconds).join("").length;

  /**
   * The two sides of a match, or nothing if it does not have two.
   *
   * A build order is read by comparison, and a comparison needs two sides — so
   * the timeline below is built around them rather than around players. A 1v1
   * is a player each way; a team game is a team each way, when the file states
   * teams. When neither holds (three free-for-all players, or a 2v2 whose slots
   * carry no team id) there is no centre to put a clock on, and the report falls
   * back to a column per player rather than inventing a pairing.
   */
  function replaySides(report) {
    if (report.players.length === 2) return report.players.map((player) => [player]);
    const teams = new Map();
    for (const player of report.players) {
      if (!teams.has(player.teamId)) teams.set(player.teamId, []);
      teams.get(player.teamId).push(player);
    }
    return teams.size === 2 ? [...teams.values()] : null;
  }

  const sideName = (side) => side.map((player) => player.name).join(" + ");

  /**
   * Who won, said out loud.
   *
   * The file knows this without any help: the losing side is the one that
   * **resigns or is dropped**, and `DropPlayer` is what the client writes when a
   * base dies. A harvest adds `defeated` as a second witness, but is not needed
   * for the answer — which matters, because the outcome should not be something
   * only a re-run can tell you.
   *
   * Said only when exactly one side is out. Both out, or neither, is a match
   * that ended some other way — a recording that stops early, a draw — and a
   * guess there would be worse than the silence this used to keep.
   */
  function sideVerdicts(sides) {
    const out = sides.map((side) =>
      side.every((player) => player.dropped || player.resigned || (player.sim && player.sim.defeated))
    );
    if (out.filter(Boolean).length !== 1) return sides.map(() => "");
    return out.map((isOut) => (isOut ? "lost" : "won"));
  }

  /**
   * When a player left the match, and how — nothing at all for one who stayed.
   *
   * **The resignation when there is one, else the drop.** A player can carry
   * both: they resign, everything they own comes apart, and the client then
   * records the drop it always records for a dead base. That drop is the
   * consequence being noticed, not a second defeat — so the resignation is the
   * moment, and everything asking when this player left has to ask it here
   * rather than pick its own rule. Two rules for one question read as two
   * different facts a line apart: a verdict naming one second and the losses
   * splitting at another.
   */
  function playerDefeat(player) {
    if (player.resigned) return { kind: "resigned", at: player.resigned };
    if (player.dropped) return { kind: "dropped", at: player.dropped };
    // Neither, and still out: a match won by capturing the last building ends
    // with no resignation and no drop, so the file holds nothing about it and
    // the report said `lost` beside the name with an empty clock column down the
    // middle of the header. The re-run saw it — this is the moment it did.
    return player.sim && player.sim.defeatedAt ? { kind: "defeated", at: player.sim.defeatedAt } : null;
  }

  /**
   * When a side left the match, and how — nothing at all for a side that stayed.
   *
   * The latest of its players' moments, because a side is out when the last of
   * it is; the word is that player's, since a team can hold one resignation and
   * one dead base and only the second of them ends the side.
   */
  function sideDefeat(side) {
    let out = null;
    for (const player of side) {
      const defeat = playerDefeat(player);
      if (defeat && (!out || defeat.at > out.at)) out = defeat;
    }
    return out;
  }

  /**
   * A loss total split the way the question is actually asked: how much of that
   * was the base.
   *
   * One rule for every total in the header, because both sources name a loss
   * with the same four words — the game's own `byKind` counter and the destroy
   * events' own `kind`. Each total is therefore split out of the rows it was
   * counted from, and a number and its parts cannot come apart.
   *
   * Anything that is not a building is a unit, including a word this file has
   * never been taught: a kind it cannot name is still something that died, and
   * dropping it would be the one way the parts stop summing to the total.
   */
  function lossSplit(counts) {
    const rows = Object.entries(counts).filter(([, count]) => count > 0);
    return {
      buildings: counts.buildings || 0,
      units: rows.reduce((n, [kind, count]) => (kind === "buildings" ? n : n + count), 0),
      // Infantry from vehicles from aircraft, where the source knows the
      // difference — kept as the units figure's title rather than as a third
      // number, since what was asked for is two.
      detail: rows
        .filter(([kind]) => kind && kind !== "buildings")
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([kind, count]) => `${count} ${kind}`)
        .join(" · "),
    };
  }

  /**
   * How many of a set of rows were buildings, and how many were not — the only
   * split the header knows, counted off rows that each carry the client's own
   * ObjectType.
   */
  function kindSplit(rows) {
    const buildings = rows.filter((row) => row.type === 2).length;
    return { buildings, units: rows.length - buildings };
  }

  /**
   * A total and its parts, in the three words every row of the header uses:
   * **how many, how many of those were buildings, how many were not.**
   *
   * `split` is counted off the same rows the total was, or there is no split at
   * all — never a second source. Two sources for one number was the first
   * attempt and it withheld the parts on every real report: `produced` took its
   * total from the game's `unitsBuiltByType` counter and its parts from the
   * spawn events, and those are not the same quantity. Measured across the eight
   * stored harvests, the counter runs from 33 *below* the unit spawns to 20
   * above them, with no arithmetic between them — so a rule that drew the parts
   * only when they summed to the counter drew them never, and the row read `68
   * total` and nothing else.
   *
   * The units figure is an element: it carries the finer breakdown its source
   * knows — infantry from vehicles from aircraft — as its title, and a title
   * belongs to an element.
   */
  function saidTotal(total, split, detail) {
    const said = [`${total} total`];
    if (!split || split.buildings + split.units !== total) return said;
    said.push(`${split.buildings} buildings`);
    const units = document.createElement("span");
    units.textContent = `${split.units} units`;
    if (detail) units.title = detail;
    said.push(units);
    return said;
  }

  /**
   * How hard a side was playing, out of the file alone.
   *
   * The one pair of numbers in the header that needs no re-run, which is why it
   * rides on the name line rather than in the ledger under it: a report the site
   * draws from a file nobody has re-run still has this much to say about the two
   * players, and it says it beside their names.
   */
  function sideRate(side, report) {
    const real = side.reduce((n, player) => n + player.real, 0);
    // A rate over a handful of seconds is not a rate; the report says so rather
    // than printing a number it would have to be told to distrust.
    const apm = report.duration >= 30 ? `${Math.round(real / (report.duration / 60))} APM` : "APM —";
    return [apm, `${real} actions`];
  }

  /** The ledger's rows, in the order they are read. */
  const LEDGER_ROWS = ["produced", "placed", "destroyed", "lost"];

  /**
   * The counters as rows of a ledger: one claim per row, and **the word for it
   * said once, in the middle, for both sides**.
   *
   * The header used to write all of them as one sentence per side — `24 built ·
   * 9 buildings · 40 lost · 4 killed` facing `34 built · …` — so every word was
   * printed twice and the two numbers a reader actually wants to compare sat at
   * two different distances from the clock with three other numbers between
   * them. A row is one word and the two numbers it names, either side of the
   * column that names it; nothing has to be aligned by counting.
   *
   * The three words are `produced`, `destroyed`, `lost`, and each of them holds
   * for a building as much as for a tank — which is the whole reason for the
   * names. `built` came from `unitsBuiltByType`, whose own name says units and
   * which this repo cannot prove either way about buildings, so the row is split
   * by the spawn events rather than by subtracting the file's placements from
   * it; `killed` is a word for a conscript and not for a War Factory.
   *
   * Keyed by that word rather than listed, because a row is drawn when *either*
   * side has it and the pair has to be the same claim — a side with no re-run
   * behind it and a side with one must not silently face each other's different
   * fourth row.
   */
  function sideLedger(side, report) {
    // The file's own: a structure this side put on the map. It is the whole of
    // the ledger when nobody has re-run the match.
    const placed = side.reduce((n, player) => n + player.structures.length, 0);
    // Only when the match has been re-run: everything on the name line came out
    // of the file, and none of these can.
    const sim = side.filter((player) => player.sim);
    if (!sim.length) return { placed: { n: placed, parts: [`${placed} buildings`] } };
    const total = (what) => sim.reduce((n, player) => n + (player.sim[what] || 0), 0);
    // The counter's own breakdown, which is what makes this total's split its
    // own: `lost` and `byKind` are two readings of one row, taken by the game in
    // one sample. Measured across the eight stored harvests, that counter and
    // the destroy events agree object for object, every match, both sides.
    const kinds = {};
    for (const player of sim) {
      for (const [kind, count] of Object.entries(player.sim.byKind || {})) kinds[kind] = (kinds[kind] || 0) + count;
    }
    const lost = lossSplit(kinds);
    // What came out of the queues, with a kind on each — buildings are in here
    // too, since a placement is a spawn. **The whole of the produced row**, total
    // and parts, rather than `unitsBuiltByType` with these for parts: the counter
    // is not the same quantity (see `saidTotal`) and a row assembled out of the
    // two could not add up. What it costs is the first seconds of the match,
    // which the harvest does not watch — kflow ACTIVE
    // `resim-early-ticks-unwatched`.
    const made = sim.flatMap((player) => player.sim.made || []);
    // What this side destroyed, off the same events the other side's losses are
    // counted from, credited by attacker. A loss with no attacker is nobody's
    // kill — a base coming apart at a resignation — which is why this is a
    // second reading of one list and not the same number twice. Measured, it
    // agrees with the `killed` counter on all eight harvests bar one kill.
    const names = new Set(side.map((player) => player.name));
    const struck = ((report.sim && report.sim.losses) || []).filter((loss) => loss.by && names.has(loss.by));
    return {
      // A harvest taken before the client was asked what came out of the queues,
      // or before it was asked who struck what, keeps the counter and says only
      // the total: parts that cannot be counted are not guessed at.
      produced: made.length
        ? { n: made.length, parts: saidTotal(made.length, kindSplit(made)) }
        : { n: total("built"), parts: [`${total("built")} total`] },
      destroyed: struck.length
        ? { n: struck.length, parts: saidTotal(struck.length, kindSplit(struck)) }
        : { n: total("killed"), parts: [`${total("killed")} total`] },
      lost: { n: total("lost"), parts: saidTotal(total("lost"), lost, lost.detail) },
    };
  }

  /**
   * The same facts as one sentence, for the fallback that has no middle column
   * to hang a word on: each ledger row's word goes back onto the number it
   * names, in place of the `total` the column would have said.
   */
  function sideStats(side, report) {
    const ledger = sideLedger(side, report);
    return [
      ...sideRate(side, report),
      ...LEDGER_ROWS.filter((label) => ledger[label]).flatMap((label) => [
        `${ledger[label].n} ${label}`,
        ...ledger[label].parts.slice(1),
      ]),
    ];
  }

  /**
   * The parts written into their cell, one element each and **nothing between
   * them**.
   *
   * The ` · ` is gone. It was carrying two jobs: telling the parts apart, and
   * holding them off each other — and it did the second with non-breaking
   * spaces, because a flex item's own leading and trailing white space is
   * stripped (`GAP`, below, is the same finding), so the air was a character and
   * not a measurement. Now that every part of a total says what it is — `40
   * total`, `10 buildings`, `30 units` — there is nothing left for a dot to
   * separate, and the space between them is the cell's `gap`: one number in the
   * stylesheet, changed in one place, and the same on a mirrored row.
   */
  function writeSentence(el, parts) {
    for (const part of parts) {
      if (typeof part !== "string") {
        el.append(part);
        continue;
      }
      const span = document.createElement("span");
      span.className = "replaypart";
      span.textContent = part;
      el.append(span);
    }
    return el;
  }

  /**
   * What a side lost, by type, biggest first — the answer the counters cannot
   * give, since they are keyed by ObjectType and not by what the thing was —
   * split at the moment the side left the match.
   *
   * Everything a resigning player owns dies in the same instant, so one list
   * misreads the whole match: `74 lost` is a base evaporating at 5:12 with a
   * dozen fighting losses buried in it. Two blocks separate the two claims.
   *
   * **The boundary is the player's own moment, inclusive** — `playerDefeat`'s,
   * so the block splits at the second the verdict beside the name states. A
   * resignation destroys the base in the tick it is recorded in, so that second
   * is part of the defeat rather than the last second of play; and it is per
   * player, because on a team side each leaves at its own moment.
   *
   * A dropped player's at-defeat block is normally empty, and that is the
   * finding rather than a gap: `DropPlayer` is what the client writes once a
   * base is already gone, so everything it explains happened before the moment
   * it names. A resignation is the other way round, which is exactly why the
   * two are still told apart everywhere else in this file.
   *
   * The exact moments are `report.sim.losses` — `lossRows` is grouped, and a
   * group can straddle the second the side leaves.
   *
   * Each stretch is counted twice over the same events: once by type, which is
   * what the chips are, and once by kind, which is what the caption opens into.
   * Two readings of one list, so the caption cannot disagree with what is under
   * it.
   */
  function sideLosses(side, report) {
    const leftAt = new Map(side.map((player) => [player.name, (playerDefeat(player) || {}).at || 0]));
    const before = { types: new Map(), kinds: {} };
    const atDefeat = { types: new Map(), kinds: {} };
    for (const loss of (report.sim && report.sim.losses) || []) {
      if (!leftAt.has(loss.owner)) continue;
      const moment = leftAt.get(loss.owner);
      const into = moment && loss.at >= moment ? atDefeat : before;
      // A report exported before the losses carried a word for themselves still
      // has the name, and a raw name reads better than a blank chip.
      const label = loss.label || loss.name;
      into.types.set(label, (into.types.get(label) || 0) + 1);
      // The number the client keeps, not the word derived from it: an event of a
      // kind this repo has no name for still knows whether it was a building.
      const kind = loss.type === 2 ? "buildings" : loss.kind || "";
      into.kinds[kind] = (into.kinds[kind] || 0) + 1;
    }
    const block = ({ types, kinds }) => ({
      entries: [...types]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([label, count]) => ({ label, count })),
      kinds,
    });
    return { before: block(before), atDefeat: block(atDefeat) };
  }

  /**
   * A row's marks, in two kinds, and the difference between them is the whole
   * grammar of the axis.
   *
   * **A sign sits against the name, like arithmetic: `+` got it, `−` lost it.**
   * A placement, a delivery and the taking half of a capture are all `+` — a
   * building standing on the map, a tank driving out of a war factory and a
   * refinery walking over to your side are the same claim about how the world
   * changed. `−` is a loss and the other half of a capture.
   *
   * **A glyph a space away from the name is an action or a state, not a
   * quantity**: `$` ordered, `✓` finished and waiting, `<>` deployed, `⇄` changed
   * hands, `⚑` left the match. It never says whether anything was gained, which
   * is why it can sit beside a sign and add to it rather than compete with it —
   * `✓ +War Factory` is *finished, and standing*, two facts about one row.
   *
   * The two used to be one list, and the space was whatever each glyph happened
   * to carry. Which meant `+Rhino` and `✓ War Factory` looked like the same kind
   * of statement while `⇄` sat at the far end of its row saying a third thing in
   * a fourth position. One rule for where a mark goes is worth more than any of
   * the individual placements it overrides.
   *
   * `<>` is the game's own deploy cursor said in two characters: the thing
   * unfolding. It carries no sign, unlike every other arrival on the axis,
   * because nothing was gained — a vehicle became a building, and the row
   * opposite it that a capture would have does not exist.
   */
  const ROW_SIGN = { built: "+", made: "+", taken: "+", lost: "−", ceded: "−" };

  /**
   * The space in every one of these is a **non-breaking** space, and it has to
   * be. `.replaycell` is a flex row (so the leader in it can take whatever the
   * words leave over), a mark drawn as its own element is therefore a flex item,
   * and **a flex item's leading and trailing whitespace is stripped** — an
   * ordinary space at the end of one is not narrow, it is gone. `✓ +Allied
   * Barracks` came out as `✓+Allied Barracks` for exactly that reason.
   *
   * Uniform rather than only on the mark that is an element today, because the
   * failure is silent and arrives whenever a mark *becomes* one: the readiness
   * had to, to be painted dim, and the next one will have its own reason. A
   * non-breaking space is also one character wide in the axis's monospace face,
   * so the column arithmetic — counted, never measured — is unaffected.
   */
  const GAP = "\u00a0";
  const ROW_STATUS = {
    queued: "$" + GAP,
    cancelled: "$" + GAP,
    ready: "✓" + GAP,
    deployed: "<>" + GAP,
    taken: "⇄" + GAP,
    ceded: "⇄" + GAP,
    resigned: "⚑" + GAP,
    // Three ways out, three marks, and they are three different claims. A flag
    // is a decision. The zigzag is the client losing the player, which is what a
    // drop is — an observation, and the row stays as quiet as it was. The skull
    // is the match being over for them, which is the only one of the three that
    // is the defeat itself rather than a record of one.
    //
    // U+FE0E after the skull: it has an emoji presentation by default and came
    // out as a colour glyph beside marks drawn in the row's own ink. The
    // variation selector asks for the text one, which every other mark here is.
    dropped: "↯" + GAP,
    defeated: "☠︎" + GAP,
  };

  /**
   * The sidebar cameo for an object, as an element ready to sit in a row — or
   * `null` when there is no picture for it.
   *
   * The sheet is optional on purpose, and its absence is now the ordinary state
   * rather than an edge: nothing ships one. It is harvested from the player's
   * own running client, so a host that has none — a profile that has not
   * harvested yet, a site build, a test harness — must draw the same report in
   * words rather than throw. A row whose object has no cameo in the game's own
   * art (civilian scenery, cut content) gets nothing for the same reason: an
   * invented placeholder would be a claim.
   *
   * The sheet is a data URL a couple of hundred kilobytes long, so it is written
   * into a custom property on the document once and every icon then refers to it
   * by name. Setting it as an inline `background-image` would put a copy of the
   * whole PNG in the DOM per row.
   */
  // Which sheet the custom property holds, not merely that it holds one. A
  // harvest finishing in the game tab replaces the global while this page is
  // open, and a second harvest — a different client, numbered its own way —
  // replaces it again. A boolean latch here would leave the property pointing at
  // the old pixels while the cells came from the new index, which does not fail:
  // it draws a confidently wrong picture for every row.
  let cameoSheetInstalled = null;
  function cameoFor(object, scale) {
    const sheet = window.__cdcCameos;
    if (!sheet || !object || !object.name) return null;
    const cell = sheet.index[object.name];
    if (cell === undefined) return null;
    if (cameoSheetInstalled !== sheet) {
      const root = document.documentElement.style;
      root.setProperty("--cdc-cameo-sheet", `url("${sheet.sheet}")`);
      root.setProperty("--cdc-cameo-w", `${sheet.size.width}px`);
      root.setProperty("--cdc-cameo-h", `${sheet.size.height}px`);
      cameoSheetInstalled = sheet;
    }
    const icon = document.createElement("span");
    icon.className = "replaycameo";
    // Where the picture is in the sheet, and how big to draw it. The stylesheet
    // does the arithmetic from these three — the geometry is easier to check
    // written out in CSS than assembled into strings here.
    icon.style.setProperty("--cx", `${(cell % sheet.cols) * sheet.cell.width}px`);
    icon.style.setProperty("--cy", `${Math.floor(cell / sheet.cols) * sheet.cell.height}px`);
    icon.style.setProperty("--k", String(scale));
    icon.setAttribute("aria-hidden", "true"); // the label beside it already says what it is
    return icon;
  }

  /**
   * How big a picture gets, by how many lines the run under it holds.
   *
   * Only halves and doubles of the source's own 60×36, so the pixel art is never
   * resampled: 0.5× is one device pixel per source pixel on the 2× displays these
   * pages are read on, and 2× is four. A run's picture also has to *fit* the
   * lines it spans — at 12px/1.7 a line is 20.4px, so 36px needs two lines and
   * 72px needs four. The ladder is those two constraints agreeing.
   */
  const CAMEO_SCALES = [
    { lines: 4, k: 2 },
    { lines: 2, k: 1 },
    { lines: 1, k: 0.5 },
  ];
  /**
   * What the gutter holds beside the picture: the bracket, the arm that leads
   * out of it towards the words, and the air between the two and the picture.
   * The pieces are in `.replaycameorun` in replay-view.css and add up to this.
   */
  const BRACE_ROOM = 14;

  /**
   * How far a deploy *order* in the file may sit from the deploy the re-run saw
   * and still be the same base standing up.
   *
   * The order is the click and the spawn is the Construction Yard existing, and
   * between them is however long the engine took to accept it — a second or two.
   * Generous rather than tight, because the cost of the two being read as
   * separate events is two rows claiming one base arrived twice, while the cost
   * of merging two that really were separate is nothing a reader would notice:
   * both are the same player's base standing up within five seconds.
   */
  const DEPLOY_SECONDS = 5;

  /**
   * Where a row sits in one object's passage from intent to existence: ordered,
   * then finished and waiting, then standing on the map. A delivery is a unit's
   * own last step — the moment it exists — so it shares the placement's rung
   * rather than taking one of its own.
   *
   * Everything else a row can be — a loss, a capture, a side leaving the match —
   * is not a stage of anything and has no rank. Those rows are not ordered
   * against each other and must not be read as a progression.
   */
  const CHAIN_RANK = { queued: 1, ready: 2, built: 3, made: 3 };

  /**
   * Whether a row continues the one before it, given the two are about the same
   * object. Naming the same thing is necessary and not sufficient: an object can
   * be built and later die, and one picture over both would claim those two rows
   * are one event.
   *
   * Two ranked rows continue when the rank does not go backwards, so
   * order → ready → placed is one chain, two deliveries in a row are one batch,
   * and a **new order after a placement starts a new one** — that is a second
   * copy of the building, not more news about the first. Two unranked rows
   * continue only when they are the same kind of claim, so two deaths are one
   * loss. A ranked row against an unranked one never continues: a placement and
   * a death are two things that happened to one object, not one event.
   */
  function chains(previous, row) {
    const before = CHAIN_RANK[previous.kind];
    const after = CHAIN_RANK[row.kind];
    if (before && after) return after >= before;
    if (!before && !after) return previous.kind === row.kind;
    return false;
  }

  /**
   * The runs down one side of the axis: stretches of consecutive rows that are
   * one object's one chain (see `chains`).
   *
   * A run is the report's own claim that a stretch is about one thing —
   * `Power Plant` ordered, finished, placed, or four Rhinos coming out one after
   * another — and it is what earns a bigger picture and a brace.
   *
   * **A line where only the other side acted does not break a run.** The two
   * columns share one clock, so the opponent's activity pushes this side's rows
   * apart on the page without putting anything between them; treating that as an
   * interruption would break almost every run in a real match, since an order
   * and its placement are seconds apart and the opponent fills the gap. What
   * breaks a run is *this* side naming something else, or naming the same thing
   * about something that is no longer the same event.
   */
  function runsIn(lines, side) {
    const runs = [];
    let open = null;
    lines.forEach((line, index) => {
      const row = line.rows[side];
      if (!row) return;
      if (open && open.name === row.object.name && chains(open.row, row)) {
        open.end = index;
        open.rows++;
        open.row = row; // the chain is judged against the row before it, not the run's first
        return;
      }
      if (open) runs.push(open);
      open = { name: row.object.name, object: row.object, row, start: index, end: index, rows: 1 };
    });
    if (open) runs.push(open);

    for (const run of runs) {
      const span = run.end - run.start + 1;
      // Sized by the lines it *spans*, not by the rows it holds: a picture wider
      // than its own brace is what would push the rows around.
      const step = CAMEO_SCALES.find((s) => span >= s.lines) || CAMEO_SCALES[CAMEO_SCALES.length - 1];
      run.icon = cameoFor(run.object, step.k);
      run.width = run.icon ? 60 * step.k : 0;
    }
    return runs;
  }

  /**
   * The timeline: one clock down the middle, each side reading outwards from it.
   *
   * Two build orders in two columns can only be compared by reading a time off
   * one and hunting for it in the other. With a single shared axis the eye does
   * the comparison instead — who reached a refinery first is a glance at which
   * side of the same row is filled, and a run of rows filled on one side only is
   * a lead, visible without reading a word of it.
   *
   * Rows are grouped by the second, so two things that happened at the same
   * moment share one clock reading rather than making two rows that look
   * sequential. Inside a group the clock is printed once, on the first row.
   */
  function renderTimeline(report, sides, opts = {}) {
    const axis = document.createElement("div");
    axis.className = "replayaxis";

    // The header: one row per kind of line, rather than one column per side.
    //
    // Two stacked columns were bottom-aligned, so the shorter side opened with a
    // blank line and the same kind of fact sat at a different height on either
    // side of the clock. A row per kind cannot drift — both sides are cells of
    // the same three-column grid the axis below uses, so the name faces the name
    // and the losses face the losses whatever either side has to say.
    const head = document.createElement("div");
    head.className = "replayheads";
    /**
     * A header row: two cells and, between them, the one thing they are both
     * about — a clock reading on the first row, the row's own name on every
     * other.
     *
     * **A label is not a clock and is never counted as one.** The middle column
     * is measured in characters, off the readings it has to print
     * (`widestClock` below), and the axis under the header is the same grid — so
     * a word counted into that column pushes the two build orders apart down the
     * whole report. `time` was such a word: four characters of caption over a
     * column whose longest reading is `8:54`. A label is drawn at its own size,
     * centred on the column and sized by its own content, and overhangs the
     * column rather than widening it (`.replaylabel` in replay-view.css).
     */
    const headRow = (mid, cells) => {
      const row = document.createElement("div");
      // A row whose middle is a word keeps more air off the column than one
      // whose middle is a reading: a label overhangs the column it is centred on
      // and a reading does not, so only the labelled rows pay for it. The name
      // row was paying too, which is the gap between the clock and the two dots.
      row.className = "replayrow head" + (mid.className === "replayat" ? "" : " labelled");
      row.append(cells[0], mid, cells[1]);
      head.append(row);
    };
    /**
     * How wide a label is, in pixels, without a layout to ask.
     *
     * The header's middle column has to be as wide as the widest word in it
     * before any of it is drawn, and the renderer hands back a fragment nobody
     * has inserted yet — there is nothing to measure. So it is counted, the way
     * every other width on this page is counted: `.replaylabel` is 10px in the
     * axis's own monospace face with `0.04em` of letter-spacing, and one
     * character of that measured 6.26px in a browser at dpr 2 (`at defeat`, nine
     * characters, 56.3px). 6.3 rounds it up, which is the safe direction — a
     * column a pixel wide of its word, never a word wide of its column.
     */
    const LABEL_CH = 6.3;
    const LABEL_AIR = 12;
    let widestLabel = 0;
    const headLabel = (said, className) => {
      const label = document.createElement("div");
      label.className = "replaylabel" + (className ? " " + className : "");
      label.textContent = said;
      widestLabel = Math.max(widestLabel, said.length);
      return label;
    };
    const headCell = (className) => {
      const cell = document.createElement("div");
      cell.className = className;
      return cell;
    };

    const verdicts = sideVerdicts(sides);
    // When the match ended, in the column that already holds every other moment
    // on the page. It used to ride in the verdict's parentheses — a time inside
    // a badge painted the colour of a defeat, stated as a fact about the side
    // that lost. One side leaves and the other stays, so the moment belongs to
    // neither of them: it is the clock's, and the clock has a column.
    const ended = sides.map((side, index) => (verdicts[index] === "lost" ? sideDefeat(side) : null)).find(Boolean);
    const headAt = headCell("replayat");
    if (ended) writeClock(headAt, ended.at);
    const headStamp = ended ? clockChars(ended.at) : 0;
    headRow(
      headAt,
      sides.map((side, index) => {
        const name = document.createElement("div");
        name.className = "replayname";
        // The dot is the identity, not the text — the same colour this side is
        // drawn in on the charts below, so the two panels name the same player
        // the same way. It sits against the clock on both sides, where the pair
        // of them reads as the axis's own legend.
        const dot = document.createElement("span");
        dot.className = "replaydot s" + (index + 1);
        // How hard they were playing, beside the dot: the one pair of numbers
        // every report has, re-run or not (`sideRate`).
        const rate = headCell("replaystats");
        writeSentence(rate, sideRate(side, report));
        // Nickname then faction, and the stylesheet mirrors the pair on the left
        // so the **nickname is the inner word on both sides** — the two of them
        // face each other across the middle of the header instead of sitting at
        // its two outer edges with a faction between each and the clock.
        const who = document.createElement("span");
        who.className = "replaywho";
        const nick = document.createElement("span");
        nick.className = "replaynick";
        nick.textContent = sideName(side);
        who.append(nick);
        // On the nickname's line, not under it: a faction is one word and a
        // whole row of the header was being spent on it.
        const faction = document.createElement("span");
        faction.className = "replayside";
        faction.textContent = side.map((player) => player.country).join(" + ");
        who.append(faction);
        // Its own block, between the rate and the name, so it lands **against
        // the clock on both sides** rather than at the outer edge of one of them.
        // Inside the phrase it was mirrored with the phrase: `Player_A Libya
        // RESIGNED` facing `P_B Iraq WON`, which put the two verdicts a whole
        // header's width apart — and the verdict is the first thing anyone opens
        // a match for.
        //
        // **One word**, and `resigned` or `lost`: a drop is how the client
        // records a base dying and losing is what happened, so the word for the
        // reader is the second. The moment that used to follow it in a
        // parenthesis is the clock column's now.
        const verdict = document.createElement("span");
        if (verdicts[index]) {
          const defeat = sideDefeat(side);
          verdict.className = "replayverdict " + verdicts[index];
          verdict.textContent = defeat && defeat.kind === "resigned" ? "resigned" : verdicts[index];
          verdict.title =
            verdicts[index] === "won"
              ? "the other side resigned or was defeated"
              : !defeat
              ? "the match records this side as defeated"
              : defeat.kind === "resigned"
              ? "a decision to end the match, not the client noticing a dead base"
              : "dropped out of the match — which is what the client records when a base dies, not a decision";
        }
        name.append(dot, rate, verdict, who);
        return name;
      })
    );

    // The counters, a row each. Drawn when either side has the row, so the two
    // cells of it are always the same claim — which is the invariant the whole
    // header is built on.
    const ledgers = sides.map((side) => sideLedger(side, report));
    for (const label of LEDGER_ROWS) {
      if (!ledgers.some((ledger) => ledger[label])) continue;
      headRow(
        headLabel(label),
        ledgers.map((ledger) => writeSentence(headCell("replaystats"), (ledger[label] || { parts: [] }).parts))
      );
    }

    /**
     * One block of losses: every type that went, and — when the block is one of
     * two — how many that was. Which stretch of the match it is, is the middle
     * column's to say; it used to be a word inside both cells, printed twice on
     * every row.
     *
     * `counted` is off for losses that were never split, because there the
     * block's own total is the `lost` row directly above it read a second way,
     * off the events rather than off the counter. Two numbers that agree, said a
     * line apart, are a reader working out which of them to believe.
     *
     * No tail count. "+5 more" withheld exactly the half a re-run was run for —
     * and a base is a dozen kinds of object, so the whole list read as prose
     * came out as a paragraph. Each type is its own chip instead, and the block
     * wraps rather than running on.
     */
    const lossBlock = (lost, counted, atDefeat, title) => {
      const block = document.createElement("div");
      block.className = "replaylost" + (atDefeat ? " atdefeat" : "");
      // An empty block rather than no cell: it is the twin of the other side's,
      // and the pair is what holds the two of them on one row.
      if (!lost.entries.length) return block;
      if (counted) {
        // Its own element, and a line of its own (`.replaycount` takes the whole
        // row): loose in the block, the numbers were flex items among the chips
        // and a chip wrapped up onto the label's line — `Chrono Miner ×4  0
        // buildings · 5 units · 5` beside `AT DEFEAT`, with the name of a unit
        // reading as part of the count.
        const count = document.createElement("span");
        count.className = "replaycount";
        const split = lossSplit(lost.kinds);
        writeSentence(
          count,
          saidTotal(
            lost.entries.reduce((n, entry) => n + entry.count, 0),
            split,
            split.detail
          )
        );
        block.append(count);
      }
      for (const entry of lost.entries) {
        const chip = document.createElement("span");
        chip.className = "replaychip";
        chip.textContent = entry.count > 1 ? `${entry.label} ×${entry.count}` : entry.label;
        block.append(chip);
      }
      if (title) block.title = title;
      return block;
    };

    // What each side lost while it was playing, and what went the moment it
    // left — two rows, and the second only when there is something in it, which
    // for a dropped side there usually is not (see `sideLosses`).
    const losses = sides.map((side) => sideLosses(side, report));
    const split = losses.some((side) => side.atDefeat.entries.length);
    if (losses.some((side) => side.before.entries.length)) {
      headRow(
        // Named against the block under it only when there is one. With nothing
        // to tell it apart from, this is not a stretch of the match — it is the
        // `lost` row above it, said by type.
        headLabel(split ? "in play" : "by type"),
        losses.map((side) =>
          lossBlock(
            side.before,
            split,
            false,
            "destroyed while this side was still in the match — read off a re-run, not the file"
          )
        )
      );
    }
    if (split) {
      headRow(
        headLabel("at defeat", "atdefeat"),
        sides.map((side, index) => {
          const defeat = sideDefeat(side);
          return lossBlock(
            losses[index].atDefeat,
            true,
            true,
            defeat ? `everything this side still had when it left at ${clock(defeat.at)}` : ""
          );
        })
      );
    }
    axis.append(head);

    /**
     * Everything one side has on the timeline.
     *
     * Two sources again: what they did, out of the file, and what they lost, out
     * of a re-run of the match — and a loss belongs on this axis for the same
     * reason a placement does. Reading "Sentry Gun ×4 lost" against the other
     * side's tank orders two rows above is the whole point of having one clock.
     */
    const rowsFor = (side, index) => {
      const rows = [];
      // Everything harvested is keyed by player name, and every track below asks
      // the same question of it: is this side's.
      const names = new Set(side.map((player) => player.name));
      for (const player of side) {
        // An order the game took nothing from is not a thing that happened, so
        // it is not a row — until the reader asks to see the clicking itself.
        for (const row of player.order) {
          if (!row.quantity && !opts.overclicks) continue;
          rows.push({ ...row, player });
        }
      }
      // What actually came out of the queues, when the match has been re-run.
      // The file's rows above it are orders; this is the delivery, and reading
      // one against the other is what says whether an order ever became a unit.
      //
      // Buildings are not in here — their delivery is the placement the file
      // already records. What they get is the row before it: the moment the
      // queue finished and the building stood waiting to be put down, so a
      // placement that followed immediately reads differently from one the
      // player sat on.
      //
      // A building that stood in the second it finished is the one case where
      // those two rows are one fact printed twice: there is no wait to show, and
      // the pair reads as two events. The placement keeps it — it is the
      // brighter of the two and the one that says the building exists — and
      // takes the `✓` off the readiness row, which is the same claim either way:
      // this is the moment the queue finished with it.
      if (opts.made !== false && report.sim) {
        const placements = new Map();
        for (const row of rows) {
          if (row.kind !== "built" || !row.object) continue;
          const key = row.player.name + "|" + row.object.name + "|" + Math.floor(row.at);
          if (!placements.has(key)) placements.set(key, []);
          placements.get(key).push(row);
        }
        for (const [kind, list] of [
          ["made", report.sim.madeRows],
          ["ready", report.sim.readyRows],
        ]) {
          for (const made of list || []) {
            if (!names.has(made.owner)) continue;
            let quantity = made.count;
            if (kind === "ready") {
              // One placement absorbs one readiness. A count above one is two
              // of the same building finishing in one second, which needs two
              // placements to disappear entirely — anything left over is still
              // waiting and still has a row.
              const waiting = placements.get(made.owner + "|" + made.name + "|" + Math.floor(made.at)) || [];
              for (const row of waiting) {
                if (row.ready || quantity < 1) continue;
                row.ready = true;
                quantity--;
              }
              if (quantity < 1) continue;
            }
            rows.push({
              at: made.at,
              kind,
              structure: made.type === 2,
              object: { label: made.label, name: made.name },
              quantity,
              player: { name: made.owner },
            });
          }
        }
      }
      // A building changing hands: one event with two sides to it, so two rows
      // at the same second — the side that took it and the side it came off. A
      // capture with no losing side in the match, a neutral oil derrick, draws
      // the first of them and nothing opposite.
      //
      // Not gated with the losses: a captured building was not destroyed, and a
      // reader who turned the casualties off has not asked to stop being told
      // that their refinery is now the other side's.
      // A base standing up, from two sources that cover different halves of the
      // match and are drawn as one kind of row.
      //
      // **The file** knows the first one exactly: a deploy order issued before
      // that player placed anything can only be their MCV, because nothing can
      // be placed until the Construction Yard it becomes exists. It is there
      // with no re-run at all, which the site's Replays page needs and which is
      // also the only thing that can rescue a match whose harvest missed the
      // opening (see `report.sim` — a re-run subscribes to spawns after the
      // match has already started ticking).
      //
      // **The re-run** knows the rest: a building spawn no placement accounts
      // for is a deploy whenever it happens, which is the only way to see a
      // relocation or a second MCV — the file's later deploy orders name no unit
      // and cannot be told from a GI dropping sandbags.
      //
      // Where both saw the same event they are one row, and the re-run wins it:
      // an order is an intent and a spawn is the outcome, so the second is the
      // moment the base actually stood.
      const deployed = [];
      if (report.sim) {
        for (const row of report.sim.deployRows || []) {
          if (!names.has(row.owner)) continue;
          deployed.push({
            at: row.at,
            kind: "deployed",
            structure: true,
            object: { label: row.label, name: row.name },
            quantity: row.count,
            player: { name: row.owner },
          });
        }
      }
      for (const player of side) {
        if (!player.deployedAt || !player.deployed) continue;
        if (deployed.some((row) => row.player.name === player.name && Math.abs(row.at - player.deployedAt) <= DEPLOY_SECONDS)) continue;
        deployed.push({
          at: player.deployedAt,
          kind: "deployed",
          structure: true,
          object: { label: player.deployed.label, name: player.deployed.name },
          quantity: 1,
          ordered: true,
          player,
        });
      }
      // Not gated with the deliveries, and for the capture's reason: this is not
      // a queue's output, it is the geography of the match changing. A reader
      // who turned the delivery track off asked to stop being told which tanks
      // came out, not to stop being told the base moved.
      rows.push(...deployed);
      if (report.sim) {
        for (const capture of report.sim.captureRows || []) {
          const taken = names.has(capture.owner);
          if (!taken && !names.has(capture.from)) continue;
          rows.push({
            at: capture.at,
            kind: taken ? "taken" : "ceded",
            object: { label: capture.label, name: capture.name },
            from: capture.from,
            to: capture.owner,
            player: { name: taken ? capture.owner : capture.from },
          });
        }
      }
      // The moment a side left the match. It comes out of the file, not a
      // re-run, so unlike the two blocks around it this row is on the axis with
      // nothing harvested — and it is pushed before the losses because
      // everything that side owned dies around it, and a wall of `−` rows reads
      // as a consequence only when the reason sits above it.
      //
      // A drop is here for the same reason a resignation is — it is the other
      // way a side leaves — but it stays its own claim rather than being folded
      // into one "gave up" row: the client writes it when a base dies, so it is
      // an observation, not a decision, and the Construction Yard coming apart a
      // second above it is exactly what it should be read against.
      for (const player of side) {
        for (const [kind, label] of [
          ["resigned", "resigned"],
          ["dropped", "dropped out"],
        ]) {
          if (player[kind]) rows.push({ at: player[kind], kind, object: { label }, player });
        }
        // The loss itself, and **only when nothing in the file already says this
        // player left**: every defeated player is defeated in the harvest too, so
        // drawn unconditionally this would be a second row a second under every
        // drop, saying the same thing in another word.
        const out = playerDefeat(player);
        if (out && out.kind === "defeated") {
          rows.push({ at: out.at, kind: "defeated", object: { label: "lost" }, player });
        }
      }
      if (opts.losses !== false && report.sim) {
        for (const loss of report.sim.lossRows) {
          if (!names.has(loss.owner)) continue;
          rows.push({
            at: loss.at,
            kind: "lost",
            // A building coming apart is not the same event as a conscript
            // dying, and a base being dismantled should read as one.
            structure: loss.type === 2,
            object: { label: loss.label, name: loss.name },
            quantity: loss.count,
            by: loss.by,
            player: { name: loss.owner },
          });
        }
      }
      return rows;
    };

    // second -> the rows each side had in it, in the order they happened.
    const seconds = new Map();
    sides.forEach((side, index) => {
      for (const row of rowsFor(side, index)) {
        const key = Math.floor(row.at);
        if (!seconds.has(key)) seconds.set(key, [[], []]);
        seconds.get(key)[index].push(row);
      }
    });

    /**
     * The axis flattened to lines, before anything is drawn.
     *
     * It has to exist first because of the pictures: one that spans four lines
     * has to know it does before the first of those lines is placed, and a run
     * is only visible from above.
     */
    const lines = [];
    for (const key of [...seconds.keys()].sort((a, b) => a - b)) {
      const [left, right] = seconds.get(key);
      const count = Math.max(left.length, right.length);
      for (let i = 0; i < count; i++) {
        lines.push({ at: key, opens: i === 0, rows: [left[i] || null, right[i] || null] });
      }
    }

    const runs = opts.cameos === false ? [[], []] : [0, 1].map((side) => runsIn(lines, side));
    // The gutter is as wide as the largest picture this report actually uses,
    // plus room for the brace — so the two strips have a fixed edge and the
    // clock stays under the header's, rather than each row's icon sitting
    // wherever its text ran out.
    const widest = Math.max(0, ...runs.flat().map((run) => run.width));
    const gutter = widest ? widest + BRACE_ROOM : 0;
    // The header block sits inside the axis, so it inherits this and the two
    // grids cannot drift apart about where the clock column is.
    axis.style.setProperty("--cdc-cameo-gutter", `${gutter}px`);

    // The lines a picture points at: the first and last of every run, which is
    // the same row on a run of one. Each gets a leader — a rule running from
    // beside the picture up to that row's own words.
    //
    // It has to be an element inside the cell, not more of the holder's bracket
    // in the gutter: a row's words end wherever they end, and only something
    // living in the cell can grow to reach them. It carries no text, so the
    // cell's words are still exactly its `textContent`.
    const leadingLines = [new Set(), new Set()];
    for (const side of [0, 1]) {
      for (const run of runs[side]) {
        if (!run.width) continue;
        leadingLines[side].add(run.start).add(run.end);
      }
    }

    // The longest line in each column, in characters — one number per side, not
    // one for both. Shared, the quieter side was padded out to the busier one's
    // longest line and its pictures sat a centimetre off its own text.
    const widestLine = [0, 0];
    // And the longest reading of the clock, counted the same way — **readings
    // only**. The header's own stamp is one of them; the labels down the middle
    // of the header are not, and are exactly what would otherwise widen this
    // column, and the gap between the two build orders under it, for a word that
    // is not a time (see `headRow`).
    let widestClock = headStamp;
    lines.forEach((line, index) => {
      // Grid row 1 is the header block that sits inside the axis, so the lines
      // start at 2. Explicit placement rather than auto-flow, because a run’s
      // picture is placed by row and span and the two must agree.
      const at = index + 2;
      const cells = line.rows.map((row, index) => {
        const cell = document.createElement("div");
        cell.className =
          "replaycell" +
          (row
            ? ` ${row.kind} s${index + 1}${row.structure ? " structure" : ""}${row.unplaced ? " unplaced" : ""}` +
              (row.ready ? " wasready" : "")
            : ` empty s${index + 1}`);
        cell.style.gridArea = `${at} / ${index === 0 ? 2 : 4}`;
        if (row) {
            // Who did it, when a side is more than one player. Its own element
            // rather than the head of the words, because the readiness mark
            // below has to be able to sit *between* the name and the row, and a
            // text node cannot be entered halfway.
            // Non-breaking at the end, for `ROW_STATUS`'s reason: this is an
            // element too, so an ordinary space there is stripped and the name
            // runs into the mark after it.
            const who = sides[index].length > 1 ? `${row.player.name} ·${GAP}` : "";
            // A placement that absorbed its own readiness carries the readiness
            // mark as well as its own sign — `✓ +War Factory`, finished and
            // standing, which is two facts about one row and not one said twice.
            // It is drawn **dim**, like the readiness row it stands in for: the
            // bright claim here is that the building exists, and the `✓` is the
            // quieter one about how it got there. Its own element for that
            // reason — part of a text node cannot be painted.
            const tick = row.ready ? ROW_STATUS.ready : "";
            const words =
              (ROW_STATUS[row.kind] || "") +
              (ROW_SIGN[row.kind] || "") +
              row.object.label +
              (row.quantity > 1 ? ` ×${row.quantity}` : "");
            cell.textContent = words;
            let length = who.length + tick.length + words.length;
            // Prepended in this order so they come out in the other: the name
            // first, then the readiness, then the words already in the cell.
            if (tick) {
              const ready = document.createElement("span");
              ready.className = "replayready";
              ready.textContent = tick;
              cell.prepend(ready);
            }
            if (who) {
              const player = document.createElement("span");
              player.className = "replaywho";
              player.textContent = who;
              cell.prepend(player);
            }
            // The clicks the queue could not take, when the reader has asked for
            // them: a separate span, because they are a different claim from the
            // count beside them and must not read as part of it.
            if (opts.overclicks && row.overclick) {
              const over = document.createElement("span");
              over.className = "replayover";
              over.textContent = ` +${row.overclick}`;
              over.title = `${row.ordered} ordered, ${row.quantity} accepted — the queue was full`;
              cell.append(over);
              length += over.textContent.length;
            }
            // The leader goes on the *outward* side of everything the row says —
            // first child on the left of the clock, last on the right — so it is
            // always the piece of the cell nearest the gutter, and never comes
            // between the count and the clicks the queue turned away.
            if (leadingLines[index].has(at - 2)) {
              const lead = document.createElement("span");
              lead.className = "replaylead";
              lead.setAttribute("aria-hidden", "true"); // a rule, not a word
              if (index === 0) cell.prepend(lead);
              else cell.append(lead);
            }
            // How wide a side's column has to be, counted rather than measured:
            // the axis is set in a monospace face, so the longest line is the
            // widest one. That is what lets the pictures be placed against the
            // widest line with no layout pass and no second render.
            widestLine[index] = Math.max(widestLine[index], length);
            cell.title =
              row.kind === "lost"
                ? `${row.object.name} lost at ${clock(row.at)}` +
                  (row.by && row.by.length ? ` — to ${row.by.join(", ")}` : " — no attacker recorded")
                : row.kind === "made"
                ? `${row.object.name} came out at ${clock(row.at)} — read off the re-run, not the file`
                : row.kind === "ready"
                ? `${row.object.name} finished at ${clock(row.at)} and waited to be placed — read off the re-run`
                : row.kind === "deployed"
                ? // Which of the two sources says so, because they are different
                  // claims: the file has the order and the re-run has the
                  // building. A reader who wants to know whether a row needed a
                  // re-run should be able to find out from the row.
                  row.ordered
                  ? `${row.object.name} stood up at ${clock(row.at)} — ${row.player.name} deployed before placing anything, which only the MCV can do`
                  : `${row.object.name} stood up at ${clock(row.at)} — a deploy: it appeared with no placement behind it, read off the re-run`
                : row.kind === "taken" || row.kind === "ceded"
                ? // Both sides of it, on both rows: which side is which is the
                  // one thing a cell in a column cannot say by itself.
                  `${row.object.name} — ${row.to} captured it at ${clock(row.at)}` +
                  (row.from ? ` from ${row.from}` : ", from an owner the re-run could not name")
                : row.kind === "defeated"
                ? `${row.player.name} was out at ${clock(row.at)} — off the re-run's own sampling, since a match won by capture leaves nothing in the file`
                : row.kind === "resigned"
                ? `${row.player.name} resigned at ${clock(row.at)} — a decision to end the match, not the client noticing a dead base`
                : row.kind === "dropped"
                ? `${row.player.name} dropped out at ${clock(row.at)} — what the client records when a base dies, not a decision`
                : row.object.name +
                  (row.queue ? ` · ${row.queue} queue` : "") +
                  // A structure is one decision with two times: the click and the
                  // building standing on the map.
                  (row.orderedAt !== undefined
                    ? ` · ordered ${clock(row.orderedAt)}, placed ${clock(row.at)}`
                    : row.unplaced
                    ? ` · ordered ${clock(row.at)} — never placed`
                    : ` · ${clock(row.at)}`) +
                  // Why this one row carries a ✓ and the placement above it does
                  // not: there was no wait to draw, so the readiness is here.
                  (row.ready ? " · finished and placed in the same second — read off the re-run" : "");
          }
        return cell;
      });
      const stamp = document.createElement("div");
      stamp.className = "replayat";
      if (line.opens) {
        writeClock(stamp, line.at);
        widestClock = Math.max(widestClock, clockChars(line.at));
      }
      stamp.style.gridArea = `${at} / 3`;
      axis.append(cells[0], stamp, cells[1]);
    });

    // No slack. It was a character wide, for the marks a row can carry — `×`,
    // `✓`, `−`, `⚑`, `⇄` — which come from a fallback face and need not be
    // exactly one cell wide; what it bought was an empty character between every
    // line and its picture. The stylesheet lets those marks overhang into the
    // gutter's padding instead (`white-space: nowrap` on a cell), which is a
    // fraction of a character on the few rows that carry one.
    //
    // The gap a cell keeps between its words and the clock is part of the
    // column, not something the column overflows by: without it counted here the
    // longest line of each side pokes ten pixels out into its own gutter, and the
    // leader drawn there is then struck through that one row's text. The number
    // is the `padding` on `.replaycell` in replay-view.css and has to match it.
    const CLOCK_GAP = 10;
    // A column with nothing in it still has to hold that side's header, so it
    // keeps the fraction it had before these widths were counted.
    const columnWidth = (n) => (n ? `calc(${n}ch + ${CLOCK_GAP}px)` : "1fr");
    axis.style.setProperty("--cdc-line-ch-s1", columnWidth(widestLine[0]));
    axis.style.setProperty("--cdc-line-ch-s2", columnWidth(widestLine[1]));
    /**
     * The header's middle column, which is **not** the axis's.
     *
     * The two are drawn as one table down the middle of the report — a rule
     * either side, running from the first header row to the last — and a table's
     * column has one width. Which width is whichever of the two things in it is
     * wider: on the `both` clock the reading is `7:48 / 31:12` and the rules land
     * either side of it, in the space between it and the two dots; on a single
     * clock no reading comes near the longest word, so the widest label is what
     * sets it.
     *
     * `max()` in the stylesheet rather than the arithmetic here, because one
     * half of it is in `ch` of a font this file cannot measure and the other is
     * in pixels of one it can only count (see `LABEL_CH`).
     *
     * The axis below keeps its own column, counted off clock readings alone. A
     * label that widened *that* would push the two build orders apart down the
     * whole report, which is the one thing the middle of this page may not do.
     */
    axis.style.setProperty(
      "--cdc-head-mid",
      `max(var(--cdc-clock-ch), ${Math.ceil(widestLabel * LABEL_CH) + 2 * LABEL_AIR}px)`
    );

    // The clock column, counted rather than fixed. 56px was a guess that fitted
    // `12:34` with twenty pixels to spare — a strip of nothing down the middle of
    // the report, twice, since each side already keeps its own ten pixels off the
    // rules. It is also the wrong guess in the other direction: on the `both`
    // clock a reading is `8:55 (35:42)`, which at 56px wrapped onto two lines and
    // made every row of the axis taller. Counted, the column is exactly as wide
    // as the widest reading it has to print, whichever clock the reader chose.
    const CLOCK_AIR = 10;
    // Plus the rule between a pair of readings, which is measured and not
    // counted: the characters above are the readings and nothing else.
    const rules = (clockParts(0).length - 1) * CLOCK_RULE;
    axis.style.setProperty("--cdc-clock-ch", `calc(${widestClock}ch + ${CLOCK_AIR + rules}px)`);

    // The pictures last, so they sit over the rows they brace rather than under
    // them, and one per run rather than one per line.
    for (const side of [0, 1]) {
      for (const run of runs[side]) {
        if (!run.width) continue;
        const holder = document.createElement("div");
        // A run of losses is the one kind whose picture is about something that
        // no longer exists, and the sheet has one cameo per object however it
        // ends. The rule that builds a run only ever chains a loss to a loss
        // (`chains`), so the run's own kind is the whole run's.
        holder.className =
          `replaycameorun s${side + 1}${run.rows > 1 ? " braced" : ""}` + (run.row.kind === "lost" ? " lost" : "");
        holder.style.gridArea = `${run.start + 2} / ${side === 0 ? 1 : 5} / span ${run.end - run.start + 1}`;
        holder.append(run.icon);
        holder.title =
          run.rows > 1
            ? `${run.rows} lines, all ${run.object.label} — ${clock(lines[run.start].at)} to ${clock(lines[run.end].at)}`
            : "";
        axis.append(holder);
      }
    }
    return axis;
  }

  /** The fallback for a match with no two sides: a column per player. */
  function renderColumns(report, opts = {}) {
    const columns = document.createElement("div");
    columns.className = "replaycols";
    for (const player of report.players) {
      const column = document.createElement("section");
      column.className = "replaycol";
      const who = document.createElement("h4");
      // With no two sides there is no verdict to hang the defeat off, and the
      // statistics sentence stopped carrying it — so the moment a player left
      // goes on their own name line, which is this fallback's version of the
      // same idea.
      const defeat = playerDefeat(player);
      who.textContent = `${player.name} — ${player.country}` + (defeat ? ` — ${defeat.kind} ${clock(defeat.at)}` : "");
      const stats = document.createElement("p");
      stats.className = "replaystats";
      writeSentence(stats, sideStats([player], report));
      const list = document.createElement("div");
      list.className = "replayorder";
      for (const row of player.order) {
        if (!row.quantity && !opts.overclicks) continue;
        const line = document.createElement("div");
        line.className = "replaycell " + row.kind + (row.unplaced ? " unplaced" : "");
        line.textContent =
          `${clock(row.at)}  ${row.object.label}${row.quantity > 1 ? ` ×${row.quantity}` : ""}` +
          (opts.overclicks && row.overclick ? ` +${row.overclick}` : "");
        list.append(line);
      }
      column.append(who, stats, list);
      columns.append(column);
    }
    return columns;
  }

  // How wide a window an APM figure is taken over. A minute is what the number
  // is named after, and short enough that a push shows up as a hump rather than
  // being averaged into the match.
  const APM_WINDOW = 60;

  /**
   * How wide a window the income rate is averaged over, in seconds.
   *
   * Thirty rather than the five-second sample interval, because ore lands in
   * lumps: a miner unloading a thousand credits at once made the raw delta a
   * comb of 12 000/min teeth separated by flat zero, which reads as a sampling
   * artefact rather than as an economy. Thirty is six samples — smooth enough to
   * read as a curve, short enough that a refinery going down shows up while it
   * still matters.
   */
  const INCOME_WINDOW = 30;

  /**
   * The two curves the action stream can honestly draw.
   *
   * Neither is an economy: a replay states orders, not deliveries, and holds no
   * credits at all. *Ordered* value is what a side committed to buying — units
   * as they were queued, buildings as they were placed — and it reads as an
   * economy curve only in the sense that a player who cannot pay stops ordering.
   * The captions say so; a chart that let itself be read as income would be the
   * report's one dishonest pixel.
   */
  function replayCurves(report, sides) {
    const end = Math.max(report.duration, 1);
    const step = Math.max(1, end / 160);
    const value = [];
    const rate = [];

    sides.forEach((side, index) => {
      const orders = [];
      let actions = [];
      for (const player of side) {
        for (const row of player.order) {
          if (row.kind === "cancelled") continue;
          // A structure is two rows now — ordered, then placed — and it is paid
          // for once. The placement is the row that carries it, because that is
          // the moment the building is a fact rather than an intent.
          if (row.kind === "queued" && row.object.kind === "building") continue;
          const cost = row.object.cost * (row.kind === "built" ? 1 : row.quantity);
          if (cost) orders.push({ at: row.at, cost });
        }
        actions = actions.concat(player.actionTimes);
      }
      orders.sort((a, b) => a.at - b.at);
      actions.sort((a, b) => a - b);

      const spent = [];
      const acted = [];
      let total = 0;
      let next = 0;
      for (let t = 0; t <= end; t += step) {
        while (next < orders.length && orders[next].at <= t) total += orders[next++].cost;
        spent.push([t, total]);
        // The window is short at the start of a match, so the divisor is the
        // window that actually exists — otherwise the first minute of every
        // game reads as half the pace it was played at. It stops shrinking at a
        // quarter of the window, though: one action two seconds in is not "30
        // APM", it is one action, and dividing by two seconds drew an opening
        // spike taller than anything either player did for the rest of the match.
        const from = t - APM_WINDOW;
        const window = Math.min(APM_WINDOW, Math.max(t, APM_WINDOW / 4));
        let n = 0;
        for (const at of actions) if (at > from && at <= t) n++;
        acted.push([t, (n * 60) / window]);
      }
      const label = sideName(side);
      value.push({ label, index, points: spent });
      rate.push({ label, index, points: acted });
    });

    return { value, rate, end };
  }

  /**
   * The curves only a re-run of the match can draw.
   *
   * Credits are read off the players every five seconds of match time, and a
   * loss is one destroy event with an owner — so unlike `replayCurves` above,
   * neither of these is a proxy for anything. They replace the ordered-value
   * chart when they exist, because that one was standing in for exactly this.
   */
  function simCurves(report, sides) {
    const end = Math.max(report.duration, 1);
    const credits = [];
    const losses = [];
    const income = [];
    const harvesters = [];
    const derricks = [];
    const labels = report.sim.harvesterLabels || {};
    /** What a whole side had of something at one reading — a team is one line. */
    const across = (side, row, read) => side.reduce((total, player) => total + read(row.players[player.name] || {}), 0);
    sides.forEach((side, index) => {
      const label = sideName(side);
      const names = new Set(side.map((player) => player.name));
      credits.push({
        label,
        index,
        points: report.sim.samples.map((row) => [Math.min(row.at, end), across(side, row, (p) => p.credits || 0)]),
      });
      /**
       * Income as it arrived, not the bank.
       *
       * `gained` is a lifetime counter, so the rate is its slope: the credits
       * that appeared between two readings, scaled to the minute. The bank
       * chart above cannot answer this — a balance falls when a player spends,
       * so a side out-mining the other two to one can hold less money all
       * match.
       *
       * Read over `INCOME_WINDOW`, not between neighbouring samples. Ore does
       * not arrive continuously — a miner docks and a thousand credits land at
       * once — so a five-second delta drew a comb: on the fixture, four teeth
       * of 12 000/min and flat zero everywhere between them, which is a picture
       * of the sampling rather than of an economy. The window is trailing, so a
       * refinery going down still shows inside half a minute.
       *
       * Every point is a real average over a stated span, so nothing here is
       * invented: what changes is which span the reader is being told about.
       */
      const rate = [];
      report.sim.samples.forEach((row, n) => {
        if (!n) return;
        // The oldest sample still inside the window — and before a window has
        // elapsed, the widest reading there is rather than no reading at all.
        let first = n - 1;
        while (first > 0 && report.sim.samples[first - 1].at >= row.at - INCOME_WINDOW) first--;
        const previous = report.sim.samples[first];
        const seconds = row.at - previous.at;
        if (seconds <= 0) return;
        const arrived = across(side, row, (p) => p.gained || 0) - across(side, previous, (p) => p.gained || 0);
        // A defeated side's counters stop moving; a negative here would be the
        // client having reset one, which nothing should draw as income.
        rate.push([Math.min(row.at, end), Math.max(0, arrived) * (60 / seconds)]);
      });
      income.push({ label, index, points: rate });
      /**
       * What was earning it. One line per side *and* miner type: a side fields
       * one type in every ordinary match, so the normal chart is a line each,
       * and a second line means a side captured something that builds the other
       * one. The type is named on the line only when there is a choice to make
       * — two Soviet players would otherwise both read "War Miner" and neither
       * would say who.
       */
      const kinds = new Set();
      for (const row of report.sim.samples) {
        for (const player of side) for (const name of Object.keys((row.players[player.name] || {}).harvesters || {})) kinds.add(name);
      }
      for (const name of [...kinds].sort()) {
        harvesters.push({
          label: kinds.size > 1 ? `${label} · ${labels[name] || name}` : label,
          index,
          points: report.sim.samples.map((row) => [
            Math.min(row.at, end),
            across(side, row, (p) => (p.harvesters || {})[name] || 0),
          ]),
        });
      }
      derricks.push({
        label,
        index,
        points: report.sim.samples.map((row) => [Math.min(row.at, end), across(side, row, (p) => p.derricks || 0)]),
      });
      const mine = report.sim.losses.filter((loss) => names.has(loss.owner)).sort((a, b) => a.at - b.at);
      // A step per loss, plus the two ends, so a flat stretch reads as one and
      // the line does not stop short of the match it belongs to.
      const points = [[0, 0]];
      mine.forEach((loss, n) => {
        points.push([Math.min(loss.at, end), n], [Math.min(loss.at, end), n + 1]);
      });
      points.push([end, mine.length]);
      losses.push({ label, index, points });
    });
    // The two counts come off a walk of the players' objects, which harvests
    // taken before that walk existed do not carry. Absent rather than zero: a
    // flat line at nought is a claim that a side had no miners, and drawing one
    // for a match nobody counted would be the report inventing an economy.
    const counted = report.sim.samples.some((row) =>
      Object.values(row.players).some((player) => player.derricks !== undefined || player.harvesters)
    );
    return { credits, losses, income, harvesters: counted ? harvesters : [], derricks: counted ? derricks : [], end };
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  /**
   * The plot, in its own coordinates; the SVG scales to whatever width the panel
   * gives it. Right padding is where the lines' own labels go.
   *
   * The box is kept close to the width a chart actually gets on screen, because
   * everything inside an SVG scales together — at 640 units in a 370px panel the
   * tick labels came out at six pixels. Near 1:1, 10-unit text is 10-pixel text.
   */
  const CHART = { w: 520, h: 150, left: 40, right: 78, top: 12, bottom: 20 };

  const svgEl = (name, attrs) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };

  /**
   * A round number at or above the top of the data, so the axis reads cleanly.
   *
   * The steps are close together on purpose: a coarse ladder (1, 2, 5, 10) sent
   * 51 700 credits to a 100 000 axis and drew the whole match in the bottom half
   * of the box. Every step here is still a number a reader can halve in their
   * head, which is what the mid gridline needs.
   */
  function niceMax(value) {
    if (!(value > 0)) return 1;
    const power = Math.pow(10, Math.floor(Math.log10(value)));
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
      if (value <= step * power) return step * power;
    }
    return 10 * power;
  }

  /**
   * One line chart: time across, one line per side, a crosshair on hover.
   *
   * Written out as SVG rather than drawn on a canvas because the reading of it
   * is text — the crosshair has to name a number at a time, and a canvas would
   * have to redraw itself to say so.
   */
  function replayChart(title, note, series, end, format) {
    const figure = document.createElement("figure");
    figure.className = "replaychart";

    const caption = document.createElement("figcaption");
    const name = document.createElement("strong");
    name.textContent = title;
    const why = document.createElement("span");
    why.textContent = note;
    caption.append(name, why);

    // A legend for two series, always — identity is never colour alone, and the
    // crosshair readout below names the same two.
    const legend = document.createElement("div");
    legend.className = "replaylegend";
    for (const line of series) {
      const item = document.createElement("span");
      const dot = document.createElement("span");
      dot.className = "replaydot s" + (line.index + 1);
      item.append(dot, document.createTextNode(line.label));
      legend.append(item);
    }

    const top = niceMax(Math.max(...series.flatMap((line) => line.points.map((p) => p[1])), 0));
    const x = (t) => CHART.left + (t / end) * (CHART.w - CHART.left - CHART.right);
    const y = (v) => CHART.h - CHART.bottom - (v / top) * (CHART.h - CHART.top - CHART.bottom);

    const svg = svgEl("svg", { viewBox: `0 0 ${CHART.w} ${CHART.h}`, class: "replayplot", role: "img" });
    const described = svgEl("title", {});
    described.textContent = `${title} — ${note}`;
    svg.append(described);

    // Grid: recessive, three horizontals and a vertical each minute.
    for (const value of [0, top / 2, top]) {
      svg.append(svgEl("line", { x1: CHART.left, x2: CHART.w - CHART.right, y1: y(value), y2: y(value), class: "replaygrid" }));
      const label = svgEl("text", { x: CHART.left - 8, y: y(value) + 4, class: "replaytick end" });
      label.textContent = format(value);
      svg.append(label);
    }
    for (let minute = 0; minute * 60 <= end; minute++) {
      const at = x(minute * 60);
      svg.append(svgEl("line", { x1: at, x2: at, y1: CHART.top, y2: CHART.h - CHART.bottom, class: "replaygrid" }));
      const label = svgEl("text", { x: at, y: CHART.h - 6, class: "replaytick mid" });
      label.textContent = `${minute}:00`;
      svg.append(label);
    }

    for (const line of series) {
      svg.append(
        svgEl("polyline", {
          points: line.points.map(([t, v]) => `${x(t)},${y(v)}`).join(" "),
          class: "replayline s" + (line.index + 1),
        })
      );
      const last = line.points[line.points.length - 1];
      const label = svgEl("text", { x: x(last[0]) + 8, y: y(last[1]) + 4, class: "replaytick" });
      label.textContent = line.label;
      svg.append(label);
    }

    const crosshair = svgEl("line", {
      x1: 0,
      x2: 0,
      y1: CHART.top,
      y2: CHART.h - CHART.bottom,
      class: "replaycross",
      visibility: "hidden",
    });
    svg.append(crosshair);

    const readout = document.createElement("div");
    readout.className = "replayreadout";
    readout.hidden = true;

    const surface = svgEl("rect", {
      x: CHART.left,
      y: CHART.top,
      width: CHART.w - CHART.left - CHART.right,
      height: CHART.h - CHART.top - CHART.bottom,
      class: "replayhit",
    });
    surface.addEventListener("mousemove", (event) => {
      const box = svg.getBoundingClientRect();
      const scale = CHART.w / box.width;
      const at = ((event.clientX - box.left) * scale - CHART.left) / (CHART.w - CHART.left - CHART.right);
      const t = Math.max(0, Math.min(end, at * end));
      crosshair.setAttribute("x1", x(t));
      crosshair.setAttribute("x2", x(t));
      crosshair.setAttribute("visibility", "visible");
      readout.hidden = false;
      readout.style.left = `${((x(t) - CHART.left) / (CHART.w - CHART.left - CHART.right)) * 100}%`;
      readout.textContent = "";
      const when = document.createElement("strong");
      when.textContent = clock(t);
      readout.append(when);
      for (const line of series) {
        const point = line.points[Math.min(line.points.length - 1, Math.round((t / end) * (line.points.length - 1)))];
        const row = document.createElement("span");
        const dot = document.createElement("span");
        dot.className = "replaydot s" + (line.index + 1);
        row.append(dot, document.createTextNode(`${line.label} ${format(point[1])}`));
        readout.append(row);
      }
    });
    surface.addEventListener("mouseleave", () => {
      crosshair.setAttribute("visibility", "hidden");
      readout.hidden = true;
    });
    svg.append(surface);

    const plot = document.createElement("div");
    plot.className = "replayplotwrap";
    plot.append(svg, readout);
    figure.append(caption, legend, plot);
    return figure;
  }
  /**
   * The report: a header line, the shared timeline, then the charts.
   *
   * Returns a fragment rather than writing into a panel it was handed, because
   * the two callers own different pages — one has a re-run button under it, the
   * other a file drop — and a renderer that clears somebody's container is a
   * renderer that has to be told about it.
   *
   * `opts.note` is one more fact for the header line, when the caller knows
   * something the file does not: the options page has the ladder's own row for
   * the match and can say `loss for Player_A`. `opts.losses` is where the
   * timeline's own losses switch starts — they are on whenever a harvest is
   * present — and `opts.onLosses` is told each time a reader moves it, for a
   * host that keeps the answer.
   */
  /**
   * How much of the match a harvest covers, as a share rather than a tick — a
   * reader knows what 97% means and does not know what tick 31 377 means. It is
   * what a run saved mid-match reports, and a run that stopped early with it.
   */
  function simShare(sim) {
    if (!sim.endTick || !sim.tick) return "part";
    return Math.min(99, Math.floor((sim.tick / sim.endTick) * 100)) + "%";
  }

  function render(report, opts = {}) {
    const out = document.createDocumentFragment();
    // Set for this report before anything is drawn: every `clock()` below reads
    // them, and a report drawn from another match must not inherit them.
    clockRate = report.ticksPerSecond || 60;
    clockMode = CLOCKS[opts.clock] ? opts.clock : "real";

    const head = document.createElement("div");
    head.className = "replayhead";
    const title = document.createElement("h3");
    title.textContent = report.map;
    const facts = document.createElement("span");
    facts.className = "replayfacts";
    // One element per fact, held apart by the stylesheet — the last of the ` · `
    // separators this report drew as text. A separator that is a character is
    // air measured in glyphs: it cannot be tuned, it is copied out with the
    // line, and it wraps as if it were a word. The rule between two of these is
    // the same hairline the header's own column is drawn with.
    // The duration is the one fact that can be two readings, and they are two
    // elements for the same reason every other separator on this page is a rule
    // — held closer together than the facts are, so the pair still reads as one
    // fact rather than as two.
    const duration = writeClock(document.createElement("span"), report.duration);
    for (const fact of [
      report.mapFile,
      duration,
      report.startedAt ? REPLAY_DATE.format(report.startedAt) : "",
      opts.note || "",
      // What the numbers below rest on, and whether the run that produced them
      // got to the end — a partial harvest must not read as a whole one.
      report.sim
        ? report.sim.complete
          ? `re-run in ${report.sim.seconds}s`
          : `re-run covers ${simShare(report.sim)} of the match${report.sim.error ? ` — ${report.sim.error}` : ""}`
        : "",
    ].filter(Boolean)) {
      const said = typeof fact === "string" ? document.createElement("span") : fact;
      said.className = "replayfact";
      if (typeof fact === "string") said.textContent = fact;
      facts.append(said);
    }
    head.append(title, facts);

    const sides = replaySides(report);
    const timeline = document.createElement("div");
    let showCameos = opts.cameos !== false;
    let showOverclicks = !!opts.overclicks;
    let showLosses = opts.losses !== false;
    const draw = () => {
      timeline.textContent = "";
      const axis = sides
        ? renderTimeline(report, sides, { ...opts, losses: showLosses, overclicks: showOverclicks, cameos: showCameos })
        : renderColumns(report, { overclicks: showOverclicks });
      timeline.append(axis);
    };

    /**
     * One switch, wired to redraw. The three above the timeline are the same
     * object — a box, a word, a reason — and were three copies of it.
     */
    const toggle = (on, label, why, set) => {
      const control = document.createElement("label");
      control.className = "replaytoggle";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = on;
      box.addEventListener("change", () => {
        set(box.checked);
        draw();
      });
      control.append(box, document.createTextNode(` ${label}`));
      control.title = why;
      head.append(control);
    };

    /**
     * The clicking, kept out of the report unless it is asked for.
     *
     * An overclick is a click the engine dropped because the queue was already
     * full — of no interest to someone reading a build order, and of a lot of
     * interest to someone reading how a player plays. Off by default, and the
     * count sits on the label so the control is worth noticing when there is
     * something behind it.
     */
    const overclicks = report.players.reduce((total, player) => total + (player.overclicks || 0), 0);
    if (report.capped && overclicks) {
      toggle(
        showOverclicks,
        `overclicks (${overclicks})`,
        "Clicks the game threw away because the queue was full — a queue holds 30 of a type, " +
          "and one building at a time. They are not units and are not counted as any.",
        (on) => {
          showOverclicks = on;
        }
      );
    }

    /**
     * The pictures, and the switch that takes them away.
     *
     * On by default: the icons are the point of the row, and a build order read
     * in sidebar cameos is the thing this report was always describing in words.
     * The switch exists because they are also the densest thing on the page, and
     * a reader comparing two long build orders line by line may want the words
     * alone. Only offered when there is a sheet to draw from — a profile that
     * has not harvested one yet gets no control rather than a dead one.
     */
    if (window.__cdcCameos) {
      toggle(
        showCameos,
        "icons",
        "The unit's own sidebar cameo beside each row, from the game's art. " +
          "An object the game gives no cameo — civilian scenery, mostly — shows none.",
        (on) => {
          showCameos = on;
        }
      );
    }

    /**
     * The losses, and the switch that takes them off the timeline.
     *
     * Only on a report that has been re-run, because only a harvest holds any:
     * a replay file records what each side *did*, and what happened to them is
     * the half a run is run for. Here rather than on the host's own bar — where
     * the extension used to draw it — because it decides what these rows say
     * and belongs where the reader is looking when the question comes up.
     * `opts.onLosses` is only how the answer outlives this report; the redraw
     * is this file's, so a host that keeps no preference still gets a working
     * switch.
     */
    if (report.sim) {
      toggle(
        showLosses,
        "losses",
        "Put what each side lost on the same timeline as what they built — units and buildings, " +
          "at the second they died, marked with a minus. The totals in the header stay either way.",
        (on) => {
          showLosses = on;
          if (opts.onLosses) opts.onLosses(on);
        }
      );
    }

    /**
     * The clock picker — only on a match whose two clocks differ, because on a
     * ladder match they are the same number and a control that changes nothing
     * is worse than no control. Changing it hands the choice back to whoever is
     * showing the report: this file draws a report, it does not own the page it
     * is drawn into, and both hosts (the options page and the site) already
     * re-render one when something about it changes.
     */
    if (clockRate !== GAME_TICKS_PER_SECOND && opts.onClock) {
      const pick = document.createElement("label");
      pick.className = "replaytoggle";
      const select = document.createElement("select");
      for (const [value, label] of Object.entries(CLOCKS)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        if (value === clockMode) option.selected = true;
        select.append(option);
      }
      select.addEventListener("change", () => opts.onClock(select.value));
      pick.append(document.createTextNode("clock "), select);
      pick.title =
        `This match ran at ${clockRate} ticks a second, and the client's own clock counts ` +
        `${GAME_TICKS_PER_SECOND} a second whatever the speed — so a moment 8:55 into the match reads ` +
        "35:42 on screen while you watch it. Real time is the wall clock, and what the ladder's own " +
        "record of the match agrees with; the game clock is the number you saw in the corner.";
      head.append(pick);
    }
    out.append(head);

    draw();
    out.append(timeline);

    if (sides) {
      const curves = replayCurves(report, sides);
      const money = (value) => (value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value)));
      const charts = document.createElement("div");
      charts.className = "replaycharts";
      if (report.sim && report.sim.samples.length) {
        // The match has been played through, so the proxy comes down: these are
        // the real numbers it was standing in for.
        const real = simCurves(report, sides);
        const whole = (value) => String(Math.round(value));
        charts.append(
          replayChart("Credits", "what each side actually had, read off the match every five seconds", real.credits, real.end, money),
          // Beside the bank on purpose: the two answer different questions and
          // are read against each other. A side can be out-earning the other
          // and holding less, which is a build order spending well.
          replayChart(
            "Gold per minute",
            `income as it arrived, averaged over a ${INCOME_WINDOW}-second window — ore lands in lumps, so a reading per sample was a comb`,
            real.income,
            real.end,
            money
          )
        );
        // Only for a match re-run since the object walk existed. An older
        // harvest counted nobody's miners, and a chart of that would be a chart
        // of nothing.
        //
        // Gated on the derricks, which get a line per side whenever the walk
        // ran: a match where a side genuinely never had a miner should draw an
        // empty Harvesters chart, which is a fact about the match, rather than
        // take the derrick count down with it.
        if (real.derricks.length) {
          charts.append(
            replayChart(
              "Harvesters",
              "miners on the map — inside a factory does not count, and the type is the economy",
              real.harvesters,
              real.end,
              whole
            ),
            replayChart(
              "Oil derricks",
              "held, not captured: a derrick taken back is off this line the moment it changes hands",
              real.derricks,
              real.end,
              whole
            )
          );
        }
        charts.append(
          replayChart(
            "Units and buildings lost",
            "cumulative, one step per loss — read off the destroy events, not the file",
            real.losses,
            real.end,
            whole
          )
        );
      } else {
        charts.append(
          replayChart(
            "Ordered value",
            "credits committed — units as the queue took them, buildings as placed. Not income: a replay holds no credits.",
            curves.value,
            curves.end,
            money
          )
        );
      }
      charts.append(
        replayChart(
          "Actions per minute",
          `over a ${APM_WINDOW}-second window — where each side was pushing, not how well`,
          curves.rate,
          curves.end,
          (value) => String(Math.round(value))
        )
      );
      out.append(charts);
    }

    if (report.chat.length) {
      const chat = document.createElement("div");
      chat.className = "replaychat";
      for (const line of report.chat) {
        const row = document.createElement("div");
        const name = (report.players[line.playerId] && report.players[line.playerId].name) || `player ${line.playerId}`;
        row.textContent = `${clock(line.at)}  ${name}: ${line.text}`;
        chat.append(row);
      }
      out.append(chat);
    }

    return out;
  }

  const api = {
    render,
    clock,
    // Exported for the options page's build-hotkey rows, which want the same
    // picture beside the same object's name. The sheet is installed on the
    // document by the first call wherever it comes from, so the two callers
    // share one copy of it rather than each carrying their own.
    cameoFor,
    REPLAY_DATE,
    replaySides,
    sideVerdicts,
    sideDefeat,
    sideRate,
    sideLedger,
    sideStats,
    sideLosses,
    lossSplit,
    renderTimeline,
    renderColumns,
    replayCurves,
    simCurves,
    replayChart,
    niceMax,
    APM_WINDOW,
  };
  if (typeof window !== "undefined") window.__cdcReplayView = api;
})();
