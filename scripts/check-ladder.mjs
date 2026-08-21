/**
 * Run src/ladder.js — the file as shipped — against the live ladder API.
 *
 *   node scripts/check-ladder.mjs [source] [realm] [ladder]
 *
 * `realm` is a key of REALMS (`am-eu`, `sea`) and `ladder` one of LADDERS
 * (`1v1`, `2v2-random`); both fall back to their default when left out or
 * unknown, and the line the run prints names the pair it actually sampled.
 *
 * The only executable check in this repo, and it exists because `src/ladder.js`
 * is the only part of the extension that depends on somebody else's service.
 * Everything else needs a running game client; this needs a network. When the
 * ladder pool comes back empty or wrong, run this first: it separates "our code
 * broke" from "their API changed", which is the one question the browser
 * console cannot answer on its own.
 *
 * The file only needs `window` and `fetch`, so it runs unmodified under node.
 * That is the point — a copy of the logic here would pass while the shipped
 * file was broken.
 *
 * Expected shape as of 2026-08-07: ~36 players, ~1800 matches, 21 maps, the top
 * of the list an order of magnitude above nothing. A sample with zero players
 * usually means `rungsearch` changed its paging — `start` is 1-based, and 0
 * answers an empty page rather than an error.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] || join(here, "..", "src", "ladder.js");

globalThis.window = globalThis;
new Function(readFileSync(source, "utf8"))();

const result = await globalThis.__cdcLadder.samplePool({
  realm: process.argv[3],
  type: process.argv[4],
  onProgress: (done, total, what) =>
    process.stderr.write(`\r${total ? `${done}/${total}` : ""} ${what}`.padEnd(60)),
});
process.stderr.write("\r".padEnd(62) + "\r");

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

console.log(
  `${result.realm} · ${result.type} · ${result.players} players · ${result.matches} matches · ` +
    `${result.maps.length} maps · played ${day(result.from)} – ${day(result.to)}`
);
for (const map of result.maps) {
  console.log(
    `  ${String(map.matches).padStart(4)}  last ${day(map.last)}  ` +
      `${(map.file || "— no file —").padEnd(32)}${map.title}`
  );
}

// The file is what the run matches on, because a title can name two maps. A
// sample that resolved none of them still works — the run falls back to the
// title — but it means the replay host stopped answering, and the fallback is
// exactly what put the wrong "Official Tournament Map B" in the catalogue.
const unresolved = result.maps.filter((m) => !m.file);
if (unresolved.length) {
  console.error(
    `${unresolved.length} of ${result.maps.length} maps have no file name: ` +
      unresolved.map((m) => m.title).join(", ")
  );
}

// A sample with no maps in it is a failure, not a result: it means the pool
// could not be read, and a caller that treated it as "the pool is empty" would
// untick every map in the options page.
if (!result.maps.length) {
  console.error("no maps in the sample — the API shape probably changed");
  process.exit(1);
}
