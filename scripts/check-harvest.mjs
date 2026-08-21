/**
 * Run `__cdcHq.cameos()` and `__cdcHq.objectTypes()` — src/hq-preview.js as
 * shipped — against a faked client, and check the rules they follow rather than
 * the pixels and rows they make.
 *
 *   node scripts/check-harvest.mjs
 *
 * The harvest existed to get Red Alert 2's artwork out of this repo, and it
 * has: the committed src/cameos.js was 190 KB of sidebar pictures from a retail
 * install that no licence this project can adopt covers, and it is deleted.
 * What replaced it is only as good as its coverage, and coverage is exactly the
 * thing that fails quietly — an id that silently loses its picture draws a row
 * in words, which looks like a design choice rather than a defect. There is no
 * committed sheet left to fall back to, which is what makes this file the guard
 * rather than a second opinion.
 *
 * So what is checked here is the *mapping*: which id ends up pointing at which
 * cell, and which ids survive at all. Four rules decide that, and each of them
 * was a decision that could have gone the other way:
 *
 *   - a picture comes from the **art** (`Cameo=`), never from the rules'
 *     `SidebarImage=`, which belongs to superweapons alone;
 *   - the walk is **unfiltered**, unlike `roster()` in the same file — a replay
 *     names objects nobody can build, and filtering them out would drop rows
 *     from a timeline;
 *   - ids that share a picture **share a cell**, because RA2 reuses art freely
 *     and a sheet with a copy per id would be several times the size;
 *   - two construction yards **borrow** their MCV's cell when they end the
 *     harvest without one — which is a question about the *built index*, not
 *     about what their art nominated. Both are exercised below, because the
 *     live defect lived in the gap between them.
 *
 * The object table below is the other half, and the decision it turns on is
 * narrower still: **a replay names an object by its ordinal**, so the index of
 * a row is the id, and reading the four type lists in any other order silently
 * renames everything. `allObjectRules` is right there, keyed by name, holding
 * more objects than the type lists do and in an order nothing promises — which
 * is why "by ordinal, not by that" is asserted rather than left to a comment.
 *
 * Not checked here: that a real client's data means what these fakes say it
 * means. That was measured live instead — scripts/probe-cameo-harvest.js, whose
 * answers are recorded in the task doc.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

const ObjectType = { Building: 1, Infantry: 2, Vehicle: 3, Aircraft: 4 };

/**
 * A TypeScript numeric enum, reverse mapping and all — `e[e.Combat = 0] =
 * "Combat"`, which is what the client's bundle actually contains.
 *
 * The shape is the point rather than a detail: **`BuildCat.Combat` is 0**, so a
 * truthiness or a string test on `buildCat` reads as correct and silently files
 * every defence under Structures. Both enums are exported by
 * `game/rules/TechnoRules`; read out of the shipped bundle 2026-08-21.
 */
const enumOf = (...names) => {
  const out = {};
  names.forEach((name, value) => {
    out[name] = value;
    out[value] = name;
  });
  return out;
};
const BuildCat = enumOf("Combat", "Tech", "Resource", "Power");
const FactoryType = enumOf("None", "BuildingType", "InfantryType", "UnitType", "NavalUnitType");

/**
 * One harvest against a client made of these parts.
 *
 * A fresh context per scenario on purpose: hq-preview caches its modules and
 * its parsed rules on a module-level `state`, so a second harvest in the same
 * context would answer from the first one's client.
 *
 * @param {object} spec
 * @param {object} spec.objects  type label -> { id: { cameo, ...rules } }
 * @param {object} [spec.weapons] superweapon name -> SidebarImage
 * @param {Set<string>} [spec.absent] picture names the VFS does not have
 * @param {object} [spec.ordinals] type label -> the names in ordinal order, or
 *   a Map of ordinal -> name where the point is that it has a hole in it.
 *   Left out, the objects' own declaration order is used — which is what a
 *   client whose rules text listed them in that order would hand out.
 * @param {object} [spec.general] the `[General]` block, or null for none
 * @param {object} [spec.enums] what `game/rules/TechnoRules` exports, or null
 *   for a client that exports nothing
 * @param {object} [spec.strings] the string table `objectTypes` resolves
 *   `uiName` through
 */
async function client(spec) {
  const drawn = [];
  const canvases = [];

  // Enough of a canvas to be drawn on and read back. `drawImage` is recorded
  // rather than performed: where each cell lands is arithmetic, and arithmetic
  // is what this file is checking.
  const makeCanvas = () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (source, ...args) => drawn.push({ canvas, source, args }),
      }),
      toDataURL: () => "data:image/png;base64,SHEET",
    };
    canvases.push(canvas);
    return canvas;
  };

  const byType = new Map();
  for (const [label, ids] of Object.entries(spec.objects)) {
    byType.set(ObjectType[label], new Map(Object.entries(ids)));
  }

  const cameoOf = new Map(); // "id/type" -> picture name
  for (const [label, ids] of Object.entries(spec.objects)) {
    for (const [id, object] of Object.entries(ids)) {
      cameoOf.set(`${id}/${ObjectType[label]}`, object.cameo || "");
    }
  }

  const weapons = new Map(
    Object.entries(spec.weapons || {}).map(([name, sidebarImage]) => [
      name,
      { name, sidebarImage },
    ])
  );

  const absent = spec.absent || new Set();

  // The four ordinal maps the client keeps beside its rules: `readObjectTypes`
  // hands out 0, 1, 2… as it accepts entries, so they are dense by
  // construction, and a scenario that hands over a Map is saying "this one is
  // not, and the harvest had better notice".
  const ordinalsFor = (label) => {
    const given = (spec.ordinals || {})[label];
    if (given instanceof Map) return given;
    const names = given || Object.keys(spec.objects[label] || {});
    return new Map(names.map((name, ordinal) => [ordinal, name]));
  };

  // Enough of a `[General]` to pass the harvest's own check on it; a scenario
  // that wants to watch that check fire passes its own.
  const general =
    spec.general === undefined
      ? { maximumQueuedObjects: 29, buildSpeed: 0.7, multipleFactory: 0.8, padAircraft: ["ORCA"] }
      : spec.general;

  // A visible marker rather than the key itself: an id whose display name comes
  // back as its CSF key is one nothing resolved, which is the mistake this
  // stands in the way of.
  const strings = spec.strings || { get: (key) => `csf(${key})` };

  const modules = {
    "engine/Engine": {
      Engine: {
        getRules: () => ({}),
        getArt: () => ({}),
        getImages: () => ({
          // The client's collection throws on a name it cannot resolve as
          // readily as it returns undefined; the harvester has to survive both,
          // so this does both.
          get: (file) => {
            const name = file.replace(/\.shp$/i, "");
            if (absent.has(name)) throw new Error(`no such file: ${file}`);
            return { name };
          },
        }),
        getPalettes: () => ({ get: (name) => (name === "cameo.pal" ? { cameo: true } : null) }),
      },
    },
    "game/rules/Rules": {
      Rules: class {
        constructor() {
          this.allObjectRules = byType;
          this.superWeaponRules = weapons;
          this.buildingTypes = ordinalsFor("Building");
          this.infantryTypes = ordinalsFor("Infantry");
          this.vehicleTypes = ordinalsFor("Vehicle");
          this.aircraftTypes = ordinalsFor("Aircraft");
          this.general = general;
        }
      },
    },
    "game/art/Art": {
      // Named rather than anonymous: the constructor records onto the class
      // itself, and a `class {}` expression gives it no binding to record on.
      Art: class Art {
        constructor(rules, art, mapFile) {
          // The live client accepts two arguments; a harvester that started
          // needing a map would be a different design, so record the arity the
          // call actually used.
          Art.lastArgCount = mapFile === undefined ? 2 : 3;
        }
        getObject(name, type) {
          const found = cameoOf.get(`${name}/${type}`);
          if (found === undefined) throw new Error(`no art for ${name}`);
          return { cameo: found };
        }
      },
    },
    "game/art/ObjectArt": { ObjectArt: {} },
    "engine/type/ObjectType": { ObjectType },
    "engine/type/PaletteType": { PaletteType: {} },
    "engine/ImageFinder": { ImageFinder: class {} },
    "game/GameMap": { GameMap: class {} },
    "engine/gfx/drawable/TmpDrawable": { TmpDrawable: class {} },
    "engine/gfx/ImageUtils": {
      ImageUtils: {
        convertShpToCanvas: (shp) => ({ shp, width: 60, height: 48 }),
      },
    },
    "game/map/BridgeOverlayTypes": { BridgeOverlayTypes: {} },
    "util/Color": { Color: {} },
    "game/rules/TechnoRules": spec.enums === undefined ? { BuildCat, FactoryType } : spec.enums || {},
  };

  const context = vm.createContext({ console, setTimeout, clearTimeout, performance });
  context.window = context;
  context.document = { createElement: (tag) => (tag === "canvas" ? makeCanvas() : {}) };
  context.System = { import: (id) => Promise.resolve(modules[id] || {}) };
  vm.runInContext(readFileSync(join(src, "glyphs.js"), "utf8"), context);
  vm.runInContext(readFileSync(join(src, "hq-preview.js"), "utf8"), context);

  return {
    hq: context.__cdcHq,
    drawn,
    strings,
    // A getter: the constructor records onto the class when the harvest runs,
    // which is after this returns.
    artArgs: () => modules["game/art/Art"].Art.lastArgCount,
  };
}

/** One cameo harvest against such a client. */
async function harvest(spec) {
  const made = await client(spec);
  const sheet = await made.hq.cameos();
  return { sheet, drawn: made.drawn, hq: made.hq, artArgs: made.artArgs() };
}

/** One object-table harvest against the same. */
async function types(spec) {
  const made = await client(spec);
  return { table: await made.hq.objectTypes(made.strings), hq: made.hq };
}

const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : " — " + detail}`);

// --- the ordinary case ------------------------------------------------------

const { sheet, drawn, hq, artArgs } = await harvest({
  objects: {
    Building: {
      GAPOWR: { cameo: "napowricon", techLevel: 1, buildLimit: -1, owner: ["Americans"] },
      GAREFN: { cameo: "refnicon", techLevel: 1, buildLimit: -1, owner: ["Americans"] },
      // No cameo of its own; borrows AMCV's, which is a *vehicle* — the borrow
      // therefore cannot be resolved inside the pass that walks buildings.
      GACNST: { cameo: "", techLevel: 1, buildLimit: -1, owner: ["Americans"] },
      // Every reason roster() would reject an object, on something a replay can
      // still name. If any of these three drop out, a timeline loses a row.
      NOBUILD: { cameo: "nobuildicon", techLevel: -1, buildLimit: -1, owner: ["Americans"] },
      AIONLY: { cameo: "aionlyicon", techLevel: 1, buildLimit: 0, owner: ["Americans"] },
      NOOWNER: { cameo: "noownericon", techLevel: 1, buildLimit: -1, owner: [] },
      // The art names a picture the VFS does not hold: this id and no other
      // must be the one that goes missing.
      GONE: { cameo: "goneicon", techLevel: 1, buildLimit: -1, owner: ["Americans"] },
    },
    Vehicle: {
      AMCV: { cameo: "amcvicon", techLevel: 1, buildLimit: -1, owner: ["Americans"] },
      // Two ids, one picture — the alias case, which is the common one.
      HARV: { cameo: "harvicon", techLevel: 1, buildLimit: -1, owner: ["Americans"] },
      HORV: { cameo: "harvicon", techLevel: 1, buildLimit: -1, owner: ["Americans"] },
    },
  },
  weapons: { ParaDropSpecial: "paraicon", ChronoSphereSpecial: "chroicon" },
  absent: new Set(["goneicon"]),
});

check("the sheet says how it was built", sheet.version === undefined && hq.CAMEO_VERSION === 2, `CAMEO_VERSION ${hq.CAMEO_VERSION}`);
check("Art is built without a map file", artArgs === 2, `${artArgs} arguments`);

check(
  "a picture comes from the art, and every id with one is in the index",
  sheet.index.GAPOWR !== undefined && sheet.index.GAREFN !== undefined,
  JSON.stringify(Object.keys(sheet.index))
);

// The decision this file exists to hold still. roster() rejects all three.
check(
  "an object nobody can build still gets a picture",
  sheet.index.NOBUILD !== undefined &&
    sheet.index.AIONLY !== undefined &&
    sheet.index.NOOWNER !== undefined,
  JSON.stringify(Object.keys(sheet.index))
);

check(
  "two ids sharing a picture share one cell",
  sheet.index.HARV === sheet.index.HORV && sheet.index.HARV !== undefined,
  `HARV ${sheet.index.HARV}, HORV ${sheet.index.HORV}`
);

check(
  "a construction yard borrows its MCV's cell rather than going without",
  sheet.index.GACNST !== undefined && sheet.index.GACNST === sheet.index.AMCV,
  `GACNST ${sheet.index.GACNST}, AMCV ${sheet.index.AMCV}`
);

check(
  "a superweapon is keyed apart from the objects, off SidebarImage",
  sheet.index["sw:ParaDropSpecial"] !== undefined &&
    sheet.index["sw:ChronoSphereSpecial"] !== undefined,
  JSON.stringify(Object.keys(sheet.index).filter((k) => k.startsWith("sw:")))
);

check(
  "a missing SHP costs that id and no other",
  sheet.index.GONE === undefined &&
    sheet.missing.length === 1 &&
    sheet.missing[0].startsWith("GONE ->") &&
    sheet.index.GAPOWR !== undefined,
  JSON.stringify(sheet.missing)
);

// Geometry. The cells the consumers read are computed from these three, so a
// sheet whose size disagrees with its cell count draws blanks off the bottom.
const pictures = sheet.pictures;
check("the cell is the crop that drops the localised name band", sheet.cell.height === 36 && sheet.cell.width === 60, JSON.stringify(sheet.cell));
check("the sheet is as wide as its column count", sheet.size.width === sheet.cols * sheet.cell.width, JSON.stringify(sheet.size));
check(
  "and as tall as the cells it holds, rounded up to a row",
  sheet.size.height === Math.ceil(pictures / sheet.cols) * sheet.cell.height,
  `${pictures} pictures -> ${sheet.size.height}px`
);
check(
  "every cell in the index exists in the sheet",
  Object.values(sheet.index).every((cell) => cell >= 0 && cell < pictures),
  `${pictures} pictures, cells ${JSON.stringify([...new Set(Object.values(sheet.index))].sort((a, b) => a - b))}`
);
check(
  "one picture is drawn once, however many ids point at it",
  pictures === new Set(Object.values(sheet.index)).size,
  `${pictures} pictures for ${Object.keys(sheet.index).length} ids`
);

// Each cameo is drawn twice: once cropped into its own cell, once onto the
// sheet. The second of each pair is what places it, and is the arithmetic a
// consumer's `cell % cols` has to agree with.
// The crop call carries the eight numbers of a source-and-destination rect; the
// placement carries two. Counting them apart is how "drawn" is told from "put
// somewhere", and an empty list must not read as agreement.
const placements = drawn.filter((d) => d.args.length === 2);
check(
  "each picture is placed on the sheet exactly once",
  placements.length === pictures && pictures > 0,
  `${placements.length} placements for ${pictures} pictures`
);
check(
  "and placed where cell % cols says it is",
  placements.length > 0 &&
    placements.every(
      (d, i) => d.args[0] === (i % sheet.cols) * 60 && d.args[1] === Math.floor(i / sheet.cols) * 36
    ),
  JSON.stringify(placements.map((d) => d.args))
);

// --- the borrower whose own art names a picture the client does not ship ----
//
// The path the client above cannot reach, and the one the live harvest took.
// There GACNST gives `cameo` an empty string, so `wanted` never held it and a
// borrow keyed on `wanted` fired. A real client is the other way round: the
// construction yard's art *does* name a cameo SHP, the shipped client does not
// hold that file, and a borrow asking "was a picture nominated" therefore stood
// down — after which the conversion dropped the id for a missing file. Measured
// against the author's own store, 2026-08-21: 405 ids harvested, and GACNST and
// NACNST — which src/replay.js draws for a player's deployed base, the most
// visible row a report has — in none of them.
//
// So the two questions are asked in one sheet: nominated (NACNST, empty cameo)
// and survived (GACNST, a named picture the VFS lost). The borrow has to answer
// the second.
const rescued = await harvest({
  objects: {
    Building: {
      GAPOWR: { cameo: "napowricon" },
      // Names a picture, and the VFS does not have it. This is the live case.
      GACNST: { cameo: "gacnsticon" },
      // Names none at all. The case the fixture above already held.
      NACNST: { cameo: "" },
      // Neither a borrower nor a lender: what "lost for good" looks like, so
      // the rescue is told apart from it rather than from an empty list.
      GONE: { cameo: "goneicon" },
    },
    Vehicle: {
      AMCV: { cameo: "amcvicon" },
      SMCV: { cameo: "smcvicon" },
    },
  },
  absent: new Set(["gacnsticon", "goneicon"]),
}).then((r) => r.sheet);

check(
  "a construction yard whose own cameo the client does not ship still borrows its MCV's cell",
  rescued.index.GACNST !== undefined && rescued.index.GACNST === rescued.index.AMCV,
  `GACNST ${rescued.index.GACNST}, AMCV ${rescued.index.AMCV}`
);
check(
  "and one whose art names no cameo at all borrows in the same sheet",
  rescued.index.NACNST !== undefined && rescued.index.NACNST === rescued.index.SMCV,
  `NACNST ${rescued.index.NACNST}, SMCV ${rescued.index.SMCV}`
);
check(
  "an id the borrow rescued is not also reported as art the harvest lost",
  rescued.missing.length === 1 && rescued.missing[0].startsWith("GONE ->"),
  JSON.stringify(rescued.missing)
);

// And the branch with nothing to lend: no cell either side, so there is no
// answer to invent. The id stays out of the index and stays in `missing`, which
// is the one report that is true.
const unlendable = await harvest({
  objects: {
    Building: { GAPOWR: { cameo: "napowricon" }, GACNST: { cameo: "gacnsticon" } },
    Vehicle: { AMCV: { cameo: "amcvicon" } },
  },
  absent: new Set(["gacnsticon", "amcvicon"]),
}).then((r) => r.sheet);
check(
  "a borrower whose lender has no cell either goes without, rather than being given one",
  unlendable.index.GACNST === undefined &&
    unlendable.index.AMCV === undefined &&
    unlendable.missing.length === 2,
  JSON.stringify(unlendable.missing)
);

// --- the empty case ---------------------------------------------------------

// A harvest that drew nothing must say so. Returning an empty sheet would be
// stored, would satisfy every reader, and would draw a timeline with no
// pictures at all — indistinguishable from a client with no art.
let threw = "";
try {
  await harvest({
    objects: { Building: { GAPOWR: { cameo: "napowricon" } } },
    absent: new Set(["napowricon"]),
  });
} catch (e) {
  threw = (e && e.message) || String(e);
}
check("a harvest that draws nothing fails rather than storing a blank sheet", /no cameo drew/.test(threw), threw || "it returned normally");

// --- the automatic run ------------------------------------------------------

// Text, not a parse, for the reason scripts/check-modules.mjs gives: a checker
// that needed a real client to run would never be run. What is held here are the
// three gates on the unasked harvest, each of which fails silently if it goes —
// a dropped frame in a match, a harvest that never notices new art, or one that
// gives up for good the first time it runs before the game files are imported.
const companion = readFileSync(join(src, "companion.js"), "utf8");

check(
  "the harvest runs on the way into the game, not only on the button",
  /const harvest = \(\) => \{[\s\S]{0,80}autoHarvest\(\);/.test(companion),
  "autoHarvest is reached from the config push's idle callback"
);
check(
  "and never while a match is running",
  // Matched on the one term that carries the meaning, not on the whole
  // condition: this assertion broke once already, on a guard gaining a flag
  // beside the gate it was watching. A check that fails when the code was right
  // teaches people to edit the check.
  /async function autoHarvest\(\) \{\s*if \([^)]*state\.combatant[^)]*\) return;/.test(companion),
  "a config push arrives whenever settings change, so it can land mid-match"
);
check(
  "it compares stamps rather than remembering it once ran",
  /HARVESTERS\.filter\(\(job\) => job\.stamp\(\) !== job\.stored\(\)\)/.test(companion),
  "new client art has to be picked up without anyone asking for it"
);
check(
  "a harvest that failed is not recorded as done",
  /if \(failed\) retryHarvest\(\);\s*else harvested = true;/.test(companion),
  "failing before the game files are imported is expected, and must not be final"
);
check(
  "a client that is not ready yet is retried rather than counted as a failure",
  /if \(!due\.every\(\(job\) => job\.ready\(\)\)\) \{\s*retryHarvest\(\);/.test(companion),
  "the first idle callback of a cold page is usually earlier than the client"
);

// --- the asked-for run ------------------------------------------------------

// The automatic run above answers "the client is not up yet" with retryHarvest.
// The button does not go through it and had no answer of its own: bulkRender
// asked ready() the moment it was entered, which in a tab the run had just
// opened is always no, so a harvest-only run returned "nothing to do" before
// reaching the one call that waits. Position, not presence — both statements
// were there all along and the defect was their order.
const bulkRender = /async function bulkRender\([\s\S]*?\r?\n {2}\}\r?\n/.exec(companion);
check(
  "the asked-for harvest waits for the client before deciding who can run",
  !!bulkRender &&
    bulkRender[0].indexOf("await waitForClient(") > 0 &&
    bulkRender[0].indexOf(".filter((h) => h.ready())") >
      bulkRender[0].indexOf("await waitForClient("),
  "ready() answers Engine.getRules(), which throws until the archives are parsed"
);

// The four defects the first live run turned up, 2026-08-20. Each of them
// worked — the sheet was harvested and stored — while being wrong in a way only
// the log showed, which is why they are held here rather than trusted to
// memory.

check(
  "readiness is asked of the client, not discovered by failing",
  /Engine\.getRules\(\) && !!Engine\.getArt\(\)/.test(companion),
  "a cold page filed fourteen warnings about rules that were merely not loaded yet"
);
check(
  "two config pushes cannot harvest at once",
  /if \(harvested \|\| harvestBusy \|\| state\.combatant\) return;/.test(companion) &&
    /harvestBusy = true;/.test(companion),
  "run() is awaited, so the guard above it does not hold across the await"
);
check(
  "and cannot start two retry chains against one budget",
  /if \(harvested \|\| harvestTimer \|\| harvestRetries >= HARVEST_RETRIES\) return;/.test(companion),
  "the log carried every retry twice, and the budget went in half the time"
);
check(
  "the retry budget outlasts a cold client",
  /const HARVEST_RETRIES = (\d+);/.test(companion) &&
    Number(/const HARVEST_RETRIES = (\d+);/.exec(companion)[1]) *
      Number(/const HARVEST_RETRY_MS = (\d+);/.exec(companion)[1]) >
      180000,
  "a cold browser took just over two minutes to have rules; CLIENT_WAIT_MS is 180000"
);
check(
  "a stored cameo sheet is not counted as a map",
  /if \(data\.what === "cameos"\) \{/.test(companion) &&
    companion.indexOf('data.what === "cameos"') <
      companion.indexOf('const what = data.what === "render" ? "render" : "map";'),
  "falling through put the cameo id count into state.catalogue, which the debug panel draws as maps"
);

// --- the object table -------------------------------------------------------

// The whole of the ordinal question in one client: the type lists say
// GAPOWR, GAREFN, GACNST, and the rules were parsed in another order entirely —
// with an object in them that no type list names. A replay written against this
// client says "building 0" and means GAPOWR.
const ORDINAL_CLIENT = {
  objects: {
    Building: {
      // Declared first and named by no type list at all. It exists to be left
      // out: `allObjectRules` holds terrain and scenery a replay can never name.
      GAEXTRA: { uiName: "Name:GAEXTRA", cost: 1, techLevel: 1, buildLimit: -1 },
      GACNST: {
        uiName: "Name:GACNST",
        name: "RULES NAME",
        cost: 3000,
        factory: FactoryType.BuildingType,
        techLevel: 1,
        buildLimit: -1,
        prerequisite: [],
      },
      GAREFN: {
        uiName: "Name:GAREFN",
        cost: 2000,
        // Every techno carries a FactoryType; most carry this one, and it is
        // not a factory. The committed table gives it no `factory` field at all.
        factory: FactoryType.None,
        techLevel: 1,
        buildLimit: 0, // only the AI may have it: not a build limit
        prerequisite: ["GACNST"],
      },
      GAPOWR: {
        uiName: "Name:GAPOWR",
        name: "RAW POWER",
        cost: 800,
        techLevel: -1,
        buildLimit: 2,
        buildCat: BuildCat.Combat,
        requiredHouses: ["Germans"],
        prerequisite: ["POWER", "GACNST"],
      },
    },
    Infantry: {
      E1: { uiName: "Name:E1", cost: 200, techLevel: 2, buildLimit: -1, prerequisite: ["NACNST"] },
      // NOTHING is in the type list below and deliberately not here: an id the
      // rules never described still has to sit at its own ordinal, or every id
      // under it shifts.
    },
    Vehicle: {
      HARV: { uiName: "Name:HARV", cost: 1400, numberOfDocks: 4, prerequisite: ["GAREFN"] },
      GAYARD: { uiName: "Name:GAYARD", cost: 1000, numberOfDocks: 4, helipad: false, prerequisite: ["GACNST"] },
      GAAIRC: { uiName: "Name:GAAIRC", cost: 1000, numberOfDocks: 4, helipad: true, prerequisite: ["GACNST"] },
      NACNST: { uiName: "Name:NACNST", cost: 3000, prerequisite: [] },
      // A prerequisite loop, which rules text is free to contain and a walk of
      // it is not free to hang on.
      LOOPA: { uiName: "Name:LOOPA", cost: 1, prerequisite: ["LOOPB"] },
      LOOPB: { uiName: "Name:LOOPB", cost: 1, prerequisite: ["LOOPA"] },
    },
    Aircraft: {
      ORCA: { uiName: "Name:ORCA", cost: 1200, techLevel: 3 },
    },
  },
  ordinals: {
    Building: ["GAPOWR", "GAREFN", "GACNST"],
    Infantry: ["E1", "NOTHING"],
    Vehicle: ["HARV", "GAYARD", "GAAIRC", "NACNST", "LOOPA", "LOOPB"],
    Aircraft: ["ORCA"],
  },
};

const { table, hq: typesHq } = await types(ORDINAL_CLIENT);
const nameAt = (list, ordinal) => (table.types[list][ordinal] || [])[0];

check("the table says how it was read", typesHq.TYPES_VERSION === 1, `TYPES_VERSION ${typesHq.TYPES_VERSION}`);

// The assertion this file exists for. Swap the walk to `allObjectRules` and
// building 0 becomes GAEXTRA, which is an object a replay cannot even name.
check(
  "a row sits at the ordinal the client would decode it by, not where the rules were parsed",
  nameAt("building", 0) === "GAPOWR" &&
    nameAt("building", 1) === "GAREFN" &&
    nameAt("building", 2) === "GACNST",
  JSON.stringify(table.types.building.map((row) => row[0]))
);
check(
  "an object no type list names is not in the table at all",
  table.types.building.length === 3 && !table.types.building.some((row) => row[0] === "GAEXTRA"),
  JSON.stringify(table.types.building.map((row) => row[0]))
);
check(
  "and an ordinal whose object has no rules keeps its place rather than shifting the rest",
  nameAt("infantry", 1) === "NOTHING" &&
    table.types.infantry[1][1] === "" &&
    table.unknown.join(",") === "NOTHING",
  JSON.stringify(table.types.infantry)
);

// A display name is a CSF key until the string table resolves it. Reading
// `name` — the raw ini key, which is right there on the same object — is what
// ships an English table to a Russian player, or a Russian one to everybody.
check(
  "a display name comes from the string table, not from the rules' own key",
  table.types.building[0][1] === "csf(Name:GAPOWR)" &&
    !table.types.building.some((row) => row[1] === "RAW POWER" || row[1] === "GAPOWR"),
  JSON.stringify(table.types.building.map((row) => row[1]))
);

check("a cost comes back with it", table.types.building[0][2] === 800, JSON.stringify(table.types.building[0]));

// `extra` is what the queue model reads, and each field is present only where
// there is something to say — the shape src/replay-types.js used to publish.
const extraOf = (list, ordinal) => table.types[list][ordinal][3] || {};
// The two numeric enums, and the two ways of reading one that look right.
// `buildCat` was compared as a lower-cased string until the client's bundle was
// read (2026-08-21): `String(0).toLowerCase() === "combat"` is false, so every
// defence would have lost its tab — and with it the Armory queue it is routed
// to — while the table still looked like a table.
check(
  "a defence is told by the enum member, not by the look of it — and Combat is 0",
  extraOf("building", 0).cat === "combat" && extraOf("building", 2).cat === undefined,
  JSON.stringify([extraOf("building", 0), extraOf("building", 2)])
);
// The same read the other way round: `factory` is a number on the rules object
// and a string in the table, because src/replay.js counts factories by the ini
// spelling. Emitting the number would be a queue model built on 1, 2, 3.
check(
  "a factory comes back as the name its enum gives it, not as its number",
  extraOf("building", 2).factory === "BuildingType",
  JSON.stringify(extraOf("building", 2))
);
check(
  "and FactoryType.None is no factory at all, not a factory called None",
  !("factory" in extraOf("building", 1)),
  JSON.stringify(extraOf("building", 1))
);

check(
  "a factory, a build limit, a defence tab and a country are carried",
  extraOf("building", 0).factory === undefined &&
    extraOf("building", 0).limit === 2 &&
    extraOf("building", 0).cat === "combat" &&
    JSON.stringify(extraOf("building", 0).only) === '["Germans"]' &&
    extraOf("building", 2).factory === "BuildingType",
  JSON.stringify([extraOf("building", 0), extraOf("building", 2)])
);
check(
  "a tech level of -1 is not a tech level, and a build limit of 0 is not a limit",
  extraOf("building", 0).tech === undefined && extraOf("building", 1).limit === undefined,
  JSON.stringify([extraOf("building", 0), extraOf("building", 1)])
);
check(
  "docks count only where they are helipads",
  extraOf("vehicle", 2).docks === 4 &&
    extraOf("vehicle", 0).docks === undefined &&
    extraOf("vehicle", 1).docks === undefined,
  JSON.stringify([extraOf("vehicle", 0), extraOf("vehicle", 1), extraOf("vehicle", 2)])
);

// The side is resolved through the prerequisite chain to one of the two
// construction yards, because every other signal in the rules says both sides
// own almost everything. Ported from the deleted scripts/gen-replay-types.mjs.
check(
  "a side is inherited through the prerequisite chain from a construction yard",
  extraOf("building", 0).side === "Allied" && // GAPOWR -> POWER (nothing), GACNST
    extraOf("building", 2).side === "Allied" && // the yard itself
    extraOf("infantry", 0).side === "Soviet", // E1 -> NACNST
  JSON.stringify([extraOf("building", 0), extraOf("building", 2), extraOf("infantry", 0)])
);
check(
  "a chain that reaches no yard leaves the side unsaid rather than guessing one",
  extraOf("vehicle", 4).side === undefined && extraOf("vehicle", 5).side === undefined,
  JSON.stringify([extraOf("vehicle", 4), extraOf("vehicle", 5)])
);

check(
  "the [General] block the queue model is built from comes with the table",
  table.general.maximumQueuedObjects === 29 &&
    table.general.buildSpeed === 0.7 &&
    table.general.multipleFactory === 0.8 &&
    JSON.stringify(table.general.padAircraft) === '["ORCA"]',
  JSON.stringify(table.general)
);

// --- the ordinals that are not dense ----------------------------------------
//
// `readObjectTypes` increments only on an accepted entry, so its keys are
// exactly 0..size-1 and each list can be an array whose index is the id. If
// that ever stops being true, every id below the hole means a different object
// — a whole timeline mislabelled, silently, in a way no reader could notice.
// There is nothing to fall back to, so the harvest fails and says which list.
let sparseThrew = "";
try {
  await types({
    ...ORDINAL_CLIENT,
    ordinals: {
      ...ORDINAL_CLIENT.ordinals,
      Building: new Map([
        [0, "GAPOWR"],
        [2, "GACNST"],
      ]),
    },
  });
} catch (e) {
  sparseThrew = (e && e.message) || String(e);
}
check(
  "a type list with a hole in it fails the harvest, by name",
  /building/.test(sparseThrew) && /not dense/.test(sparseThrew),
  sparseThrew || "it returned a table"
);

// The same for the settings: a zero read out of a renamed field would be stored
// and drawn as a queue that can hold nothing.
let generalThrew = "";
try {
  await types({ ...ORDINAL_CLIENT, general: { maximumQueuedObjects: 29, buildSpeed: 0.7 } });
} catch (e) {
  generalThrew = (e && e.message) || String(e);
}
check(
  "and so does a [General] block missing what the queue model reads",
  /General/.test(generalThrew) && /multipleFactory/.test(generalThrew),
  generalThrew || "it returned a table"
);

// Neither enum can be written down here instead: a number copied out of the
// client is the drift this harvest exists to remove, and it would be wrong
// silently. A client that does not export them fails, by name.
let enumThrew = "";
try {
  await types({ ...ORDINAL_CLIENT, enums: null });
} catch (e) {
  enumThrew = (e && e.message) || String(e);
}
check(
  "a client whose TechnoRules names no BuildCat fails the harvest rather than guessing 0",
  /BuildCat/.test(enumThrew) && /TechnoRules/.test(enumThrew),
  enumThrew || "it returned a table"
);
let factoryEnumThrew = "";
try {
  await types({ ...ORDINAL_CLIENT, enums: { BuildCat } });
} catch (e) {
  factoryEnumThrew = (e && e.message) || String(e);
}
check(
  "and the same when it names no FactoryType",
  /FactoryType/.test(factoryEnumThrew) && /TechnoRules/.test(factoryEnumThrew),
  factoryEnumThrew || "it returned a table"
);

// The string table is a parameter rather than something built here, so it can
// be left out — and a table of CSF keys would look like data.
let stringsThrew = "";
try {
  await (await client(ORDINAL_CLIENT)).hq.objectTypes();
} catch (e) {
  stringsThrew = (e && e.message) || String(e);
}
check(
  "a harvest with no string table fails rather than storing the keys",
  /string table/.test(stringsThrew),
  stringsThrew || "it returned a table"
);

// --- the registry entry -----------------------------------------------------
//
// Text, for the reason given above: the run itself needs a client. What is held
// here is that the second harvester declares the same four things the first
// one does — a key it writes, a stamp of both halves, the stored stamp it
// compares against, and the message that carries the table to the bridge.

const registry = /const HARVESTERS = \[[\s\S]*?\r?\n {2}\];/.exec(companion);
const typesEntry = registry && /key: "replayTypes",[\s\S]*/.exec(registry[0]);
check(
  "the object table is a harvester in the registry, not a path of its own",
  !!typesEntry,
  "a harvest is an item of the run the way a map is, and the run is one button"
);
check(
  "it declares the storage key it writes",
  !!typesEntry && /keys: \["replayTypes"\]/.test(typesEntry[0]),
  "the run reports what it wrote, and the log names it"
);
check(
  "it stamps the client's version and the harvester's own",
  !!typesEntry && /TYPES_VERSION/.test(typesEntry[0]) && /clientVersion\(\)/.test(typesEntry[0]),
  "either half alone leaves a stored table wrong with nothing to say so"
);
check(
  "and compares that against the stamp storage sent back",
  !!typesEntry && /stored: \(\) => state\.replayTypesVersion/.test(typesEntry[0]),
  "a config push carries the stamp so a current table costs nothing to skip"
);
check(
  "the harvested table reaches the bridge over its own message",
  !!typesEntry && /type: "replay-types"/.test(typesEntry[0]),
  "the page world has no chrome.*; the bridge is the only way to storage"
);
check(
  "the display names are resolved with the string table the map run already builds",
  !!typesEntry && /stringTable\(mods\)/.test(typesEntry[0]),
  "there is one CSF in this extension and one thing that opens it"
);

// --- report -----------------------------------------------------------------

const failed = results.filter((r) => r.startsWith("FAIL")).length;
for (const line of results) console.log(line);
console.log(
  failed
    ? `\n${failed} assertion(s) failed`
    : "\nthe cameo harvest maps ids to cells, and the object table sits on its ordinals"
);
process.exit(failed ? 1 : 0);
