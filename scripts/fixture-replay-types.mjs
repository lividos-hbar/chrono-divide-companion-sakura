/**
 * Rebuild the two test fixtures the checks decode a real replay with, from the
 * extension's own harvested `chrome.storage.local`.
 *
 *   node scripts/fixture-replay-types.mjs
 *
 * Writes `scripts/fixtures/replay-types.js` (the object table a replay's
 * ordinals index into) and `scripts/fixtures/cameo-ids.js` (which object the
 * game has a picture for — the index alone, never the pixels). Nothing else is
 * touched, and neither file ships: they exist so scripts/check-replay.mjs can
 * decode scripts/fixtures/ladder-1v1.rpl down to "Tesla Reactor at a tile"
 * rather than "building #9", which is the only kind of table those assertions
 * are worth anything against.
 *
 * It also answers a question the wiki left open. The committed fixtures came
 * out of a retail Red Alert 2 install; what a player's browser runs is Chrono
 * Divide's own rules, and whether the two agree on the ordinals had never been
 * checked. Run this and read `git diff scripts/fixtures/` — that diff *is* the
 * comparison, id by id. The file framing is written by this script in both
 * directions, so what shows up in the diff is the provenance line and the rows
 * that genuinely moved.
 *
 * The store is found by scripts/storage-lib.mjs, which locates the browser
 * profile that has this repo loaded as an unpacked extension; see
 * scripts/read-storage.mjs for the same machinery driven as a CLI. Read-only
 * against the browser, and safe while it is running.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { findStore, readStore, loadedFrom } from "./storage-lib.mjs";

const KINDS = ["building", "infantry", "vehicle", "aircraft"];

/** Local date, in the repo's timezone. */
const day = (ms) => new Date(ms).toLocaleDateString("sv");

/**
 * `window.__cdcReplayTypes` + `window.__cdcReplayRules`, as a file.
 *
 * `provenance` is one sentence saying where the rows came from, and it is the
 * point of the header rather than decoration: this table is facts out of
 * somebody's game install, and a fixture that does not say whose is the same
 * defect the MIT LICENSE had while src/cameos.js sat next to it.
 */
export function renderTypes(types, rules, provenance) {
  const body = KINDS.map(
    (kind) =>
      `    ${kind}: [\n${types[kind].map((row) => `      ${JSON.stringify(row)},`).join("\n")}\n    ],`
  ).join("\n");
  return `/**
 * TEST FIXTURE — object id -> [internal name, display name, cost, extra], per
 * rules type list. Same shape and same globals as the file it came from:
 * \`window.__cdcReplayTypes\` and \`window.__cdcReplayRules\`.
 *
 * Source: ${provenance}
 *
 * Not shipped, and read only by scripts/check-*.mjs. They need a REAL table
 * because a replay names what was built as an ordinal into these lists and
 * nothing else: against a synthetic table scripts/fixtures/ladder-1v1.rpl
 * decodes to "building #9" instead of "Tesla Reactor", and every assertion
 * about the decode — the one that caught defences counted twice, the one that
 * caught NALASR sold out of the Armory queue — passes on a table it agrees with
 * by construction.
 *
 * What this holds is facts about the game: internal names, display names, costs,
 * tech levels, and the order the lists put them in. Not artwork and not code,
 * which is why it can stay in this repository where the cameo sheet could not.
 *
 * Rebuilt by scripts/fixture-replay-types.mjs from harvested storage. Do not
 * edit by hand.
 *
 * \`extra\` is present only where there is something to say: \`factory\` (which
 * queue's production speed this building counts towards), \`docks\` (helipad
 * capacity, which is the whole of the aircraft queue's size), \`limit\`
 * (\`BuildLimit\`) and \`cat\` (\`"combat"\` for a building the game puts on the
 * Defence tab rather than Structures), \`tech\` (\`TechLevel\`), \`only\` (the
 * \`RequiredHouses\` list, which is what makes something a country unit) and
 * \`side\` — which side can build it at all, resolved through the prerequisite
 * chain to one of the two construction yards, because \`Owner=\` says both for
 * almost everything. \`__cdcReplayRules\` carries the \`[General]\` settings every
 * queue's capacity is derived from.
 */
(() => {
  "use strict";
  window.__cdcReplayTypes = {
${body}
  };
  window.__cdcReplayRules = ${JSON.stringify(rules)};
})();
`;
}

/**
 * A stand-in for the sheet a real harvest carries. The fixture needs the key
 * because src/replay-view.js reads it, and it must never carry the real one:
 * the pixels are Red Alert 2's sidebar art whichever client they came out of,
 * and this file is committed. A 1x1 transparent PNG, and no check decodes it.
 */
const PLACEHOLDER_SHEET =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

/** `window.__cdcCameos` with the geometry and a stand-in sheet, as a file. */
export function renderCameoIndex(cameos, provenance) {
  const { index, cols, cell, size } = cameos;
  // Geometry travels with the index, or the cell arithmetic in check-options has
  // nothing to check against. A harvest always writes all four; a store missing
  // one is broken rather than old, so it fails here by name.
  if (!index || !cols || !cell || !size) {
    throw new Error(
      "the harvested cameos hold no cols/cell/size — the fixture cannot carry geometry it was not given"
    );
  }
  const sorted = {};
  for (const key of Object.keys(index).sort((a, b) => (a < b ? -1 : 1))) sorted[key] = index[key];
  const ids = Object.keys(sorted).length;
  const cells = new Set(Object.values(sorted)).size;
  const supers = Object.keys(sorted).filter((key) => key.startsWith("sw:")).length;
  return `/**
 * TEST FIXTURE — object id -> its cell in the cameo sheet, plus the geometry
 * a cell number means nothing without. No artwork: the sheet below is a stand-in.
 *
 * Source: ${provenance}
 *
 * Not shipped. Read by scripts/check-chords.mjs, which asks only whether a chord
 * slot names an object the game has a picture for — \`cameos.index[name] === undefined\`. No assertion there touches a pixel,
 * so no pixel is here: what this holds is ${ids} object ids and the cell numbers
 * they were assigned across ${cells} distinct pictures, which is bookkeeping
 * about artwork rather than artwork. That is why the index could be kept when
 * the sheet it indexes — 190 KB of Red Alert 2 sidebar art — could not.
 *
 * ${supers} of the keys are \`sw:<rules section>\` superweapons, which are not objects
 * but are named the same way in a build-grid layout. An id that is absent has no
 * cameo in the game's own art — mostly civilian scenery and cut content.
 *
 * It publishes \`window.__cdcCameos\` so a check loads it exactly as it loaded the
 * shipped file; scripts/check-options.mjs asserts cell arithmetic over \`cols\` and
 * \`cell\`, which is the only guard against an off-by-one that would otherwise be
 * invisible — every row would still draw *a* picture. Nothing decodes \`sheet\`:
 * src/replay-view.js interpolates it into a CSS \`url()\` and stops there, which is
 * why a stand-in serves. A running extension gets the same four keys, with real
 * pixels, from the harvested \`cameos\` storage key.
 *
 * Rebuilt by scripts/fixture-replay-types.mjs from that harvest. Do not edit by
 * hand.
 */
(() => {
  "use strict";
  window.__cdcCameos = {
    // The drawing contract: the four keys every reader of __cdcCameos expects.
    cols: ${cols},
    cell: { width: ${cell.width}, height: ${cell.height} },
    size: { width: ${size.width}, height: ${size.height} },
    sheet:
      "${PLACEHOLDER_SHEET}",
    index: ${JSON.stringify(sorted, null, 6).replace(/\n/g, "\n    ")},
  };
})();
`;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = loadedFrom(here);
  const stores = findStore(repo);
  if (!stores.length) {
    console.error(`No browser profile has an unpacked extension loaded from ${repo}.`);
    console.error("Load it (edge://extensions -> Load unpacked) and try again.");
    process.exit(1);
  }
  const store = stores[0];
  console.log(`${store.profile} · ${store.id}`);
  // 40 MB, not the library's 200 KB default: the `cameos` value carries the
  // sheet, and a value over the limit comes back as its own length instead.
  const data = readStore(store.dir, { big: 40_000_000 });

  // The two fixtures come from two independent storage keys, harvested by two
  // independent passes in the game tab, so each is rebuilt or refused on its
  // own: a store holding one of them rebuilds that one. A refusal names the key
  // and leaves the committed fixture exactly as it was — the check that reads it
  // keeps passing against the old table rather than against an invented one,
  // and the non-zero exit is what says the rebuild did not happen.
  let refused = 0;
  const value = (key) => {
    const raw = data.get(key);
    if (raw === undefined) {
      console.error(
        `\`${key}\` is not in this store — nothing rebuilt from it.\n` +
          "  It is written by the game tab, not the options page: open Chrono Divide once\n" +
          "  with the extension loaded and let it reach the main menu, then run this again.\n" +
          "  `node scripts/read-storage.mjs` lists what the store does hold."
      );
      refused++;
      return null;
    }
    return JSON.parse(raw.toString("utf8"));
  };

  const types = value("replayTypes");
  if (types) {
    const absent = KINDS.filter((kind) => !Array.isArray(types.types?.[kind]));
    if (absent.length) {
      console.error(`\`replayTypes\` holds no rows for: ${absent.join(", ")} — the harvest is incomplete.`);
      refused++;
    } else {
      const counted = KINDS.reduce((n, kind) => n + types.types[kind].length, 0);
      const file = join(here, "fixtures", "replay-types.js");
      writeFileSync(
        file,
        renderTypes(
          types.types,
          types.general,
          `a harvest of a running Chrono Divide client (${types.version}), taken ${day(types.at)} — ${counted} ids.`
        )
      );
      console.log(`wrote ${file} — ${counted} ids`);
    }
  }

  const cameos = value("cameos");
  if (cameos) {
    if (!cameos.index || typeof cameos.index !== "object") {
      console.error("`cameos` holds no `index` — the harvest is incomplete.");
      refused++;
    } else {
      const ids = Object.keys(cameos.index).length;
      const file = join(here, "fixtures", "cameo-ids.js");
      writeFileSync(
        file,
        renderCameoIndex(
          cameos,
          `a harvest of a running Chrono Divide client (${cameos.version}), taken ${day(cameos.at)} — ${ids} ids.`
        )
      );
      console.log(`wrote ${file} — ${ids} ids`);
    }
  }

  console.log("`git diff scripts/fixtures/` is the comparison against what was committed.");
  if (refused) process.exit(1);
}

// Importable for its two renderers — the seed of a fixture is written through
// the same template as a rebuild, or the diff between them is whitespace.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
