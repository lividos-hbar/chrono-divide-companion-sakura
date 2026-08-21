/**
 * Run src/replay.js — the file as shipped — against a real ladder replay.
 *
 *   node scripts/check-replay.mjs [replay file or URL]
 *
 * With no argument it reads `scripts/fixtures/ladder-1v1.rpl`, a 4-minute 1v1
 * off the EU ladder (`5a41749b-…`, Tour of Egypt, Libya vs Iraq), and asserts
 * the build order it decodes — not "a build order came out", but *that* one,
 * down to the tile a Tesla Reactor stands on. A shape test would pass while every
 * id was off by one, which is the failure this parser is actually exposed to:
 * the id -> name table is an ordinal into rules lists, and an insertion anywhere
 * in a list shifts everything below it.
 *
 * Pass a URL to run the same assertions' machinery over a different match — the
 * per-match expectations are skipped and it prints the report instead, which is
 * how a new replay gets eyeballed before becoming a fixture.
 *
 * src/replay.js needs `window`, `fetch` and `atob` and none of them for parsing,
 * so it runs unmodified under node — the same trick as scripts/check-ladder.mjs,
 * and for the same reason: a copy of the logic here would pass while the shipped
 * file was broken.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

globalThis.window = globalThis;
new Function(readFileSync(join(here, "fixtures", "replay-types.js"), "utf8"))();
new Function(readFileSync(join(src, "replay.js"), "utf8"))();

const target = process.argv[2] || join(here, "fixtures", "ladder-1v1.rpl");
const isUrl = /^https?:/i.test(target);
const text = isUrl ? await (await fetch(globalThis.__cdcReplay.locate(target).url)).text() : readFileSync(target, "utf8");

const replay = globalThis.__cdcReplay.parse(text);
const report = globalThis.__cdcReplay.analyze(replay);

const time = (at) => `${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")}`;
for (const player of report.players) {
  console.log(`\n${player.name} — ${player.country}, ${player.apm} APM, ${player.real} actions`);
  for (const row of player.order.slice(0, 12)) {
    const what = row.object.label + (row.quantity > 1 ? ` x${row.quantity}` : "");
    console.log(`  ${time(row.at).padStart(5)}  ${row.kind.padEnd(9)} ${what}${row.tile ? ` at (${row.tile.x},${row.tile.y})` : ""}`);
  }
}

let failed = 0;
const is = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`FAIL ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
  return ok;
};

if (isUrl) {
  console.log(`\n${target} decoded — ${report.players.length} players, ${replay.events.length} events, no assertions run`);
  process.exit(0);
}

// --- the fixture, stated ----------------------------------------------------

is("replay version", replay.version, 6);
is("engine", replay.engine, { version: "0.83", modHash: 211050247 });
is("game id", replay.gameId, "5a41749b-26f9-4303-a69c-5938bb8b219c");
is("map file", report.mapFile, "tourofegypt.map");
is("map title", report.map, "Tour of Egypt (2-6)");
// The ladder's own settings, as ladder-rules.html states them: speed 6, 10000
// credits, short game on, superweapons on, crates off. A replay that disagreed
// would not be a ranked match.
is("game speed", replay.opts.gameSpeed, 6);
is("ticks per second", replay.ticksPerSecond, 60);
is("credits", replay.opts.credits, 10000);
is("short game", replay.opts.shortGame, true);
is("crates", replay.opts.cratesAppear, false);
// 14592 ticks at 60/s is 4:03, and the ladder API reports this match as 4 minutes.
is("duration in whole minutes", Math.floor(report.duration / 60), 4);
is(
  "players",
  report.players.map((p) => `${p.name}/${p.country}/${p.side}`),
  ["Player_A/Libya/Soviet", "P_B/Iraq/Soviet"]
);

// The build order itself. Structures are placements — the moment the building
// exists — and the tiles are what makes this a decode rather than a plausible
// story.
const built = (player) => report.players[player].structures.map((r) => `${time(r.at)} ${r.object.name} (${r.tile.x},${r.tile.y})`);
is("P0 structures", built(0), [
  "0:07 NAPOWR (86,46)",
  "0:14 NAHAND (93,46)",
  "0:27 NALASR (81,44)",
  "0:37 NAREFN (93,37)",
  "0:54 NALASR (85,35)",
  "1:02 NAWEAP (92,50)",
  "1:08 NALASR (94,57)",
  "1:50 NAREFN (95,55)",
  "3:25 NALASR (91,45)",
]);
is("P1 structures", built(1), [
  "0:09 NAPOWR (64,107)",
  "0:16 NAHAND (64,103)",
  "0:40 NAREFN (63,98)",
  "1:04 NAWEAP (54,106)",
  "1:36 NAREFN (55,102)",
  "1:57 NAPOWR (53,98)",
  "2:40 NAREFN (41,71)",
  "3:54 NALASR (34,72)",
  "3:58 NAWEAP (47,96)",
]);

// **The base standing up, out of the file.** An order names no unit — only the
// player's last selection does, and a selection is runtime object ids nothing in
// the file maps to a type — so a deploy order mid-match could be an MCV moving
// or a GI dropping sandbags. Before a player's first placement it can only be
// the MCV: nothing can be placed until the Construction Yard it becomes exists.
is(
  "the file says when each base stood up, and what stood up",
  report.players.map((p) => `${p.name} ${time(p.deployedAt)} ${p.deployed && p.deployed.name}`),
  ["Player_A 0:00 NACNST", "P_B 0:01 NACNST"]
);
is(
  "and it is before that player's first placement, which is what makes it the MCV",
  report.players.every((p) => p.deployedAt > 0 && p.deployedAt < p.structures[0].at),
  true
);
// P_B presses the key twice, at ticks 104 and 120. One base arrives.
is(
  "a second press is not a second base",
  replay.events.filter((e) => e.order === "DeploySelected" && e.playerId === 1 && e.tick < 600).length,
  2
);
// The two payloads a deploy comes in, both decoded now. `DeploySelected` is the
// hotkey over whatever is selected and carries nothing else; `Deploy` is the
// cursor clicked somewhere and carries the tile and the object under it.
is(
  "an order says what it was an order to do, and to where",
  replay.events
    .filter((e) => e.order && e.order.startsWith("Deploy"))
    .map((e) => `${e.order} ${e.target ? `(${e.target.x},${e.target.y})` : "no target"}`),
  ["DeploySelected no target", "DeploySelected no target", "DeploySelected no target", "DeploySelected no target", "DeploySelected no target", "Deploy (61,32)"]
);
is(
  "and a selection says which objects the order below it is about",
  // `?? "not decoded"` rather than reaching straight into it: an assertion that
  // throws when the decode goes away takes the whole file down with it, and a
  // check that cannot report its own failure is not a check.
  replay.events.filter((e) => e.type === 8 && e.tick < 200).map((e) => `${e.tick}:${e.selected?.join(",") ?? "not decoded"}`),
  ["40:2121", "104:2122"]
);

// Units are orders, not deliveries. The x-counts are the grouping doing its job:
// eight conscripts inside two seconds is one line, five Rhinos queued three
// times over as many seconds is one order of fifteen.
const queued = (player) =>
  report.players[player].order
    .filter((r) => r.kind === "queued" && r.object.kind !== "building")
    .map((r) => `${time(r.at)} ${r.object.name} x${r.quantity}`);
is("P0 units ordered", queued(0), [
  "0:18 DOG x2",
  "0:18 E2 x8",
  "1:04 HARV x3",
  "1:16 DOG x3",
  "1:52 HTNK x5",
]);
is("P1 units ordered", queued(1), [
  "0:18 DOG x4",
  "0:19 E2 x4",
  "1:06 HARV x1",
  "1:07 HTNK x15",
  "1:38 HTNK x10",
  "2:17 HTNK x6",
  "2:46 HTNK x10",
]);

// Sentry Guns are the Armory queue, and they are placements like any structure —
// the row above proves the queue and the tile agree.
is("P0 Sentry Guns", report.players[0].tally["Sentry Gun"], 4);

// --- what the game could accept ---------------------------------------------

// This match is the one that settles the queue model, because the queue it
// settles it on holds exactly one item: P_B ordered a Tesla Reactor twice 0.2 s
// apart and a Barracks twice 0.3 s apart, and placed one of each. Two orders the
// engine dropped on the floor, and the model finds both and no others.
is("orders were run through the queue model", report.capped, true);
is("overclicks", report.players.map((p) => p.overclicks), [0, 2]);
is(
  "P1 overclicked orders",
  report.players[1].production
    .filter((r) => r.overclick)
    .map((r) => `${time(r.at)} ${r.object.name} ordered ${r.ordered} took ${r.quantity}`),
  ["0:03 NAPOWR ordered 1 took 0", "0:10 NAHAND ordered 1 took 0"]
);

// A structure is one decision with two times, and the pairing is the model's:
// the building queue holds one item, so the placement completes the order that
// is in it. P_B's second Tesla Reactor is the case that proves it pairs with the
// *accepted* order rather than the last one — the 0:03 duplicate took nothing.
is(
  "P1 structures carry the order they completed",
  report.players[1].structures.slice(0, 2).map((r) => `${r.object.name} ${time(r.orderedAt)} -> ${time(r.at)}`),
  ["NAPOWR 0:03 -> 0:09", "NAHAND 0:10 -> 0:16"]
);

// A building ordered and never placed is the one case where the order is the
// only evidence there is. This one is the Sentry Gun P_B was still building when
// the match ended at 4:03.
is(
  "P1 unplaced building orders",
  report.players[1].order.filter((r) => r.unplaced && r.quantity).map((r) => `${time(r.at)} ${r.object.name}`),
  ["3:56 NALASR"]
);

// The two clicks the queue refused fall inside the grouping window of the ones
// it took, so they are not rows of their own: the row says two were ordered, one
// was taken, and the building stands at 0:09.
is(
  "a refused click stays with the order it was a second copy of",
  report.players[1].order
    .filter((r) => r.kind === "queued" && r.object.kind === "building" && r.overclick)
    .map((r) => `${time(r.at)} ${r.object.name} ordered ${r.ordered} took ${r.quantity} placed ${time(r.placedAt)}`),
  ["0:03 NAPOWR ordered 2 took 1 placed 0:09", "0:10 NAHAND ordered 2 took 1 placed 0:16"]
);

// No row may state more than a queue can hold — 30 (`MaximumQueuedObjects` 29,
// plus one), and 1 for the two building queues. The regression this guards is a
// fold that counted 45 IFVs into a row inside ten seconds.
const cap = 30;
is(
  "no order exceeds what its queue holds",
  report.players.flatMap((p) => p.order.filter((r) => r.kind === "queued" && r.quantity > cap).map((r) => r.object.name)),
  []
);

// `production` is the events and `order` is how they read. They must not be the
// same objects: folding adds a run into its first row, and while the two lists
// shared rows that addition rewrote the events it was folding — summing
// `production` then gave the fold's totals back on top of the events, 115
// Rocketeers coming out as 220 in the match this was measured on.
is(
  "folding leaves the events it folded alone",
  report.players.map((p) => p.order.filter((row) => p.production.includes(row)).length),
  [0, 0]
);

// APM has to be counted on real actions: every player is padded with a NoAction
// every turn, so the raw counts are identical and mean nothing.
is(
  "raw action counts are equal (the padding)",
  report.players.map((p) => Object.values(p.actions).reduce((a, b) => a + b, 0)),
  [331, 331]
);
is("real actions", report.players.map((p) => p.real), [155, 195]);
is("APM", report.players.map((p) => p.apm), [38, 48]);
is("P0 action mix", report.players[0].actions.SelectUnits, 54);
// The loser is dropped rather than resigning — this match ended with a base
// dying, and DropPlayer is how the file says so.
is("P0 dropped, P1 not", [report.players[0].dropped > 0, report.players[1].dropped > 0], [true, false]);

// --- the simulated half ------------------------------------------------------
//
// `scripts/fixtures/sim-5a41749b.json` is a real harvest of the same match,
// produced by driving src/replay-sim.js through the client (the harness is a
// session scratchpad thing — it needs Playwright, the network and 400 MB of game
// assets, which a node-only check has none of). What is checked here is the
// merge: that a harvest lands on the right players, on the report's own clock,
// and that the two kinds of claim stay apart.

const sim = JSON.parse(readFileSync(join(here, "fixtures", "sim-5a41749b.json"), "utf8"));
const merged = globalThis.__cdcReplay.mergeSim(report, sim);

is("the run finished the match", [sim.complete, sim.error], [true, ""]);
is("and it was faster than watching it", sim.ticksPerSecond > 600, true);
is("the report says where its numbers come from", merged.derivedFrom, "actions + simulation");
// Player_A lost the match: that base is in this list, which is why a loss count
// is worth having at all.
is(
  "losses land on the player who lost them",
  [merged.players[0].sim.lost, merged.players[1].sim.lost],
  [40, 4]
);
is("and so do kills", [merged.players[0].sim.killed, merged.players[1].sim.killed], [4, 29]);
is("the loser is marked as defeated", [merged.players[0].sim.defeated, merged.players[1].sim.defeated], [true, false]);
// The economy the file cannot state: one side earned six times the other.
is("credits gained", [merged.players[0].sim.gained, merged.players[1].sim.gained], [4000, 26350]);
// By category off the counters (they are keyed by ObjectType), and by name off
// the destroy events — the two must agree on the total.
is("losses by category", merged.players[0].sim.byKind, { buildings: 10, infantry: 26, vehicles: 4 });
is(
  "the per-name breakdown sums to the same number",
  Object.values(merged.players[0].sim.byName).reduce((a, b) => a + b, 0),
  40
);
is("and it names what was lost", merged.players[0].sim.byName.E2, 20);
// In the words the game uses, biggest first — an internal id is not a report.
is(
  "the loss list is in display names, biggest first",
  merged.players[0].sim.lostList.slice(0, 3).map((row) => `${row.label} x${row.count}`),
  ["Conscript x20", "Attack Dog x5", "Sentry Gun x4"]
);
// Every loss is on the report's clock, in seconds, inside the match.
is(
  "every loss is inside the match",
  merged.sim.losses.every((loss) => loss.at >= 0 && loss.at <= report.duration + 1),
  true
);
is("a loss says who killed it", merged.sim.losses[0].by, "P_B");

// The other half of a harvest: what came out of the queues, which is the one
// number the file cannot state at all. The committed harvest predates the spawn
// events, so this is asserted on a hand-written one — four deliveries at 60
// ticks to the second: a pair in the same second, one nine seconds after them,
// and one for the other side.
//
// The nine-second gap is the case the ten-second loss window got wrong. A
// factory turning out a tank every nine seconds chained its whole run into one
// row printed at the moment the first one appeared, so a delivery track whose
// entire worth is *when* stated a moment the tanks did not share.
const withProduced = globalThis.__cdcReplay.mergeSim(globalThis.__cdcReplay.analyze(globalThis.__cdcReplay.parse(text)), {
  ...sim,
  produced: [
    { tick: 3000, name: "HTNK", kind: 7, owner: "P_B" },
    { tick: 3060, name: "HTNK", kind: 7, owner: "P_B" },
    { tick: 3600, name: "HTNK", kind: 7, owner: "P_B" },
    { tick: 9000, name: "E2", kind: 3, owner: "Player_A" },
    // A building spawns when it is placed, which the file already states — the
    // file puts this War Factory down at 62.13s, so the spawn is the same moment
    // read off the other clock and draws nothing of its own.
    { tick: 3730, name: "NAWEAP", kind: 2, owner: "Player_A" },
    // And the one building nobody placed: an MCV deploying. No `PlaceBuilding`
    // action stands anywhere behind it, which is the whole test.
    { tick: 180, name: "NACNST", kind: 2, owner: "Player_A" },
  ],
  ready: [{ tick: 8900, name: "NAWEAP", owner: "Player_A" }],
});
is("a harvest says what came out", withProduced.players[1].sim.madeByName, { HTNK: 3 });
is(
  "and in display names, biggest first",
  withProduced.players[1].sim.madeList.map((row) => `${row.label} x${row.count}`),
  ["Rhino Heavy Tank x3"]
);
is(
  "deliveries in the same second are one row",
  withProduced.sim.madeRows.map((row) => `${row.owner} ${row.name} x${row.count} ${Math.round(row.at)}s`),
  ["P_B HTNK x2 50s", "P_B HTNK x1 60s", "Player_A E2 x1 150s"]
);
is(
  "and no delivery row claims a span it did not happen in",
  withProduced.sim.madeRows.every((row) => row.until - row.at <= 1),
  true
);
is("and they are on the report's clock", Math.round(withProduced.players[0].sim.made[0].at), 150);

// A building is not on the delivery track: it appears by being placed, and the
// placement is already a row. What it gets instead is the moment it was ready,
// which is what says whether the player put it down at once or sat on it.
is(
  "a building is not counted as a delivery on the timeline",
  withProduced.sim.madeRows.some((row) => row.type === 2),
  false
);
is(
  "it is ready, and that is a row",
  withProduced.sim.readyRows.map((row) => `${row.owner} ${row.name} ${Math.round(row.at)}s`),
  ["Player_A NAWEAP 148s"]
);

// The exception the delivery filter above used to swallow. A Construction Yard
// from a deploying MCV is created by `DeployOrder`, so no placement stands
// behind it — and a base standing up, first or relocated, is one of the few
// moves that changes everything about a match's geography.
is(
  "a building no placement accounts for is a deploy, and its own row",
  withProduced.sim.deployRows.map((row) => `${row.owner} ${row.name} x${row.count} ${Math.round(row.at)}s`),
  ["Player_A NACNST x1 3s"]
);
is(
  "and a building whose placement is in the file is not",
  withProduced.sim.deployRows.some((row) => row.name === "NAWEAP"),
  false
);
// And the case that made all of the above wrong on a profile with no harvested
// table. The pairing key is the object's internal name; the simulation always
// has the client's, but the file only has an ordinal, so a reader with no table
// reads `building #12` and matches nothing. Every building anyone put down then
// reads as a base standing up — eight false rows in the fixture, one per
// placement, which is worse than the missing names that caused it.
//
// Parsed with the table nulled, because a name is fixed by the frame decoder
// during parse, not during analyze: re-analysing the report above would not
// reproduce it.
const withoutTable = (() => {
  const types = globalThis.__cdcReplayTypes;
  const rules = globalThis.__cdcReplayRules;
  globalThis.__cdcReplayTypes = undefined;
  globalThis.__cdcReplayRules = undefined;
  try {
    return globalThis.__cdcReplay.mergeSim(
      globalThis.__cdcReplay.analyze(globalThis.__cdcReplay.parse(text)),
      { ...sim, produced: [{ tick: 3730, name: "NAWEAP", kind: 2, owner: "Player_A" }] }
    );
  } finally {
    globalThis.__cdcReplayTypes = types;
    globalThis.__cdcReplayRules = rules;
  }
})();
// A placement the client sent twice. Seen in a real ladder match — one player's
// side of it and not the other's — as the same building on the same tile 0.1 to
// 0.2 seconds apart, behind a single queue order. The game creates the first and
// refuses the second (the tile is taken, the queue is no longer Ready), so a
// reader that draws both credits a player with a building that never existed,
// and with a run merged in one of the pair absorbs the readiness while the other
// is left standing with nothing behind it.
const resent = (gap, tile) => {
  const replay = globalThis.__cdcReplay.parse(text);
  const at = replay.events.findIndex((e) => e.type === 5 && e.tile);
  const first = replay.events[at];
  replay.events.splice(at + 1, 0, {
    ...first,
    tick: first.tick + gap,
    tile: tile || first.tile,
  });
  const player = globalThis.__cdcReplay.analyze(replay).players[first.playerId];
  const built = player.order.filter((row) => row.kind === "built" && row.object.name === first.object.name);
  return built.map((row) => `${Math.round(row.at)}s ${row.object.name} +${row.overclick}`);
};
// Six ticks is a tenth of a second, which is the gap the match showed.
is("a placement sent twice on the same tile is one building", resent(6)[0], "8s NAPOWR +1");
is(
  "and the repeat is not a row of its own",
  resent(6).length,
  globalThis.__cdcReplay
    .analyze(globalThis.__cdcReplay.parse(text))
    .players[0].order.filter((row) => row.kind === "built" && row.object.name === "NAPOWR").length
);
// The tile is what says it is the same building rather than a second one, and
// the window is what keeps a rebuild on a cleared tile from being swallowed.
is(
  "the same building on a different tile is a second building",
  resent(6, { x: 90, y: 50 }).length,
  2
);
is("and the same tile a minute later is a rebuild, not a resend", resent(3600).length, 2);

is(
  "a reader with no object table invents no deploys out of placements it cannot name",
  withoutTable.sim.deployRows.length,
  0
);
is(
  "and it reads the placement as unnamed rather than as an object called that",
  withoutTable.players[0].structures[0].object.unnamed === true,
  true
);
// The pairing is one placement to one spawn, so a player who put down one War
// Factory cannot have it account for two of them appearing.
const deploysFrom = (produced) =>
  globalThis.__cdcReplay
    .mergeSim(globalThis.__cdcReplay.analyze(globalThis.__cdcReplay.parse(text)), { ...sim, produced })
    .sim.deployRows.map((row) => `${row.owner} ${row.name} ${Math.round(row.at)}s`);
is(
  "one placement absorbs one spawn, and a second of the same building is a deploy",
  deploysFrom([
    { tick: 3730, name: "NAWEAP", kind: 2, owner: "Player_A" },
    { tick: 3735, name: "NAWEAP", kind: 2, owner: "Player_A" },
  ]),
  ["Player_A NAWEAP 62s"]
);
// And the placement has to be the spawning player's own. Player_A places a War
// Factory at 62.13s and P_B one at 64.4s: an P_B spawn in Player_A's second is a
// deploy, and the same spawn in P_B's own second is not — which is the owner in
// the key doing its job rather than the clock.
is(
  "a spawn is paired against its own owner's placements, not anybody's",
  deploysFrom([{ tick: 3730, name: "NAWEAP", kind: 2, owner: "P_B" }]),
  ["P_B NAWEAP 62s"]
);
is("and against them it pairs", deploysFrom([{ tick: 3864, name: "NAWEAP", kind: 2, owner: "P_B" }]), []);
is("samples are on the same clock", Math.round(merged.sim.samples[merged.sim.samples.length - 1].at), 243);

// The object walk sends internal names, because that is what it read off the
// objects; the name table lives here, so the translation is done once and handed
// to whatever draws the chart. A harvest taken before the walk existed leaves it
// empty, which is how the report knows not to draw an economy it never counted.
is("a harvest with no object walk names no miner types", merged.sim.harvesterLabels, {});
const withWalk = globalThis.__cdcReplay.mergeSim(globalThis.__cdcReplay.analyze(globalThis.__cdcReplay.parse(text)), {
  ...sim,
  samples: sim.samples.map((row) => ({
    ...row,
    players: row.players.map((player) => ({ ...player, harvesters: { HARV: 2, CMIN: 1 }, derricks: 1 })),
  })),
});
is("and one that has it says them in words", withWalk.sim.harvesterLabels, { HARV: "War Miner", CMIN: "Chrono Miner" });

// --- a building changing hands -----------------------------------------------
//
// The client says a capture in two events: `ObjectOwnerChange`, which fires for
// everything that changes hands and names both sides, and `BuildingCapture`,
// which fires only for a capture and names only the building. The rule that
// pairs them is the whole feature, and it lives in src/replay-sim.js — which
// needs a game tab. The pairing does not: it takes ids and names, so the file is
// evaluated here as shipped and the ledger is asked directly. `addEventListener`
// is the one thing it touches at load, listening for the bridge's job, and node's
// global object has none.
globalThis.addEventListener = () => {};
new Function(readFileSync(join(src, "replay-sim.js"), "utf8"))();
const ledger = globalThis.__cdcSim.captureLedger();
// One tick of a match in which a lot changes hands and one thing is captured: a
// mind-controlled tank, a docked unit following the shipyard it sits in, and the
// refinery an engineer has just walked into.
ledger.changed(11, 900, "Player_A");
ledger.changed(12, 900, "Player_A");
ledger.changed(13, 900, "Player_A");
is(
  "a capture is paired with the owner change of its own object, in its own tick",
  ledger.captured(13, { tick: 900, name: "NAREFN", kind: 2, owner: "P_B" }),
  { tick: 900, name: "NAREFN", kind: 2, owner: "P_B", from: "Player_A" }
);
// The flood a defeat sets off is the case this exists for: a player leaving hands
// their whole base to the civilians or to an ally, one `changeObjectOwner` at a
// time, and a capture landing in the middle of it must not take its losing side
// from whichever object the flood had just moved.
is(
  "an owner change from another tick is not this capture's losing side",
  ledger.captured(11, { tick: 901, name: "NAREFN", kind: 2, owner: "P_B" }).from,
  ""
);
is(
  "and neither is another object's",
  ledger.captured(99, { tick: 900, name: "CAOILD", kind: 2, owner: "P_B" }).from,
  ""
);

// The merge, on a hand-written harvest for the same reason the deliveries above
// are: the committed one predates the events. A refinery taken off Player_A, and
// an oil derrick that belonged to the map's civilians, who are not a side.
const withCaptures = globalThis.__cdcReplay.mergeSim(globalThis.__cdcReplay.analyze(globalThis.__cdcReplay.parse(text)), {
  ...sim,
  captures: [
    { tick: 6000, name: "NAREFN", kind: 2, owner: "P_B", from: "Player_A" },
    { tick: 7200, name: "CAOILD", kind: 2, owner: "Player_A", from: "Civilians" },
  ],
});
is(
  "a capture names the building, who took it and who lost it",
  withCaptures.sim.captureRows.map((row) => `${Math.round(row.at)}s ${row.owner} took ${row.label} from ${row.from}`),
  ["100s P_B took Soviet Ore Refinery from Player_A", "120s Player_A took Tech Oil Derrick from Civilians"]
);
// Two captures are two rows even when they are the same building type close
// together — a loss row stands for a squad dying at once, a capture stands for
// one building and nothing else.
is("and one capture is one row", withCaptures.sim.captureRows.length, 2);
// The constraint the whole feature is under: a captured building was not
// destroyed, so nothing about the losses may move.
is(
  "nothing about the losses moves",
  [withCaptures.players[0].sim.lost, withCaptures.players[0].sim.byName.E2, withCaptures.sim.lossRows.length],
  [merged.players[0].sim.lost, merged.players[0].sim.byName.E2, merged.sim.lossRows.length]
);
// A harvest taken before the client was asked about captures says nothing about
// them, which is not the same as saying there were none — but an absent key must
// read as an empty track rather than throwing on the way to the timeline.
is("a harvest with no captures in it is an empty track", merged.sim.captureRows, []);
// A harvest of a different match is refused rather than merged.
const other = globalThis.__cdcReplay.analyze(globalThis.__cdcReplay.parse(text));
globalThis.__cdcReplay.mergeSim(other, { ...sim, gameId: "not-this-match" });
is("a harvest of another game is refused", [other.sim, other.players[0].sim], [undefined, undefined]);

// --- a report as a file ------------------------------------------------------
//
// The site can parse a replay and can never re-run one, so an exported report is
// the only way losses and credits reach a reader without the extension. What is
// asserted is that the trip is lossless and that a wrong file is turned away
// with a sentence rather than half-read: a report read back short of its harvest
// would draw a match that looks like nobody died in it.

const { exportReport, importReport } = globalThis.__cdcReplay;
const wire = JSON.stringify(exportReport(merged, { extension: "0.40.0", source: "https://replays-eu.chronodivide.com/x.rpl" }));
const back = importReport(wire);
is("an exported report survives the trip whole", JSON.stringify(back.report), JSON.stringify(merged));
is("and it carries what wrote it", [back.extension, back.source.endsWith("x.rpl")], ["0.40.0", true]);
is("the harvest travels with it", [back.report.players[0].sim.lost, back.report.sim.lossRows.length], [40, 16]);

const refuses = (what, input) => {
  let message = "";
  try {
    importReport(input);
  } catch (e) {
    message = e.message;
  }
  is(what, message.length > 0, true);
  return message;
};
refuses("a replay file is refused", text.slice(0, 400));
refuses("so is JSON that is not a report", '{"players":[]}');
refuses("so is a report from a newer version", JSON.stringify({ kind: "cd-companion-report", version: 99, report: merged }));
refuses(
  "and so is one whose report did not survive",
  JSON.stringify({ kind: "cd-companion-report", version: 1, report: { players: [] } })
);

// --- what locate() has to accept --------------------------------------------

const { locate } = globalThis.__cdcReplay;
const id = "5a41749b-26f9-4303-a69c-5938bb8b219c";
const url = `https://replays-eu.chronodivide.com/${id}.rpl`;
is("a game page", locate(`https://ladder.chronodivide.com/am-eu/1v1/game/${id}`).url, url);
is("the client's replay route", locate(`https://game.chronodivide.com/#/replay/${encodeURIComponent(url)}`).url, url);
is("a replay url", locate(url).url, url);
is("a bare game id", locate(id).url, url);
is("a bare id in the SEA realm", locate(id, "sea").url, `https://replays-sea.chronodivide.com/${id}.rpl`);
is("nonsense", locate("what"), null);

console.log(
  failed
    ? `\n${failed} assertion(s) failed`
    : `\nthe fixture decodes as expected — ${replay.events.length} events, ${report.players[0].structures.length + report.players[1].structures.length} structures placed`
);
process.exit(failed ? 1 : 0);
