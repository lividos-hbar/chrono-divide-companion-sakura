/**
 * Run `__cdcHq.survey()` — src/hq-preview.js as shipped — over a map built by
 * hand, with the client's modules faked.
 *
 *   node scripts/check-survey.mjs
 *
 * The survey is the extension's only durable answer to "what is on this map":
 * it is walked once, in a game tab, and read back for ever from storage without
 * one. A miscount is therefore not a wrong pixel that the next render corrects —
 * it is a wrong fact that outlives the client that produced it, and nothing
 * downstream can tell.
 *
 * What is actually checked is the *classification*, because that is where the
 * survey can be wrong while looking right: an ore drill is a terrain object
 * that counts as ore, a bridge is an overlay that is not one, four overlay ids
 * draw nothing at all, and a pre-captured building belongs to a player named
 * nowhere in [Structures]. Each of those is a rule the render pass already
 * follows, and the survey has to follow the same one or the tally describes a
 * different map from the picture.
 *
 * Not checked here: that the client's own data means what these fakes say it
 * means. `ORE_CLASSES`, `SKIP_OVERLAY_IDS` and the trigger constants are read
 * out of the client and live in src/hq-preview.js; this file exercises the code
 * that uses them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

// --- the client, as much of it as a survey touches --------------------------

const ObjectType = { Building: 1, Terrain: 2, Overlay: 3, Smudge: 4, Vehicle: 5 };

/** Names the ruleset knows, and the one property the survey asks each about. */
const OBJECTS = {
  CAAIRP: { capturable: true },
  CAOILD: { capturable: true },
  CABHUT: { capturable: false },
  TREE01: {},
  // The one terrain object that is not scenery: it grows ore, so it is counted
  // with the ore and corrected with it.
  CAMISC01: { spawnsTiberium: true },
};

const COUNTRIES = {
  Americans: { multiplay: true },
  Neutral: { multiplay: false },
  Special: { multiplay: false },
};

const OVERLAY_NAMES = { 1: "SANDBAG", 24: "BRIDGE1", 25: "BRIDGE2", 104: "GOLD01", 130: "GOLD03", 30: "GEM01" };

const modules = {
  "engine/Engine": { Engine: { getRules: () => ({}), getArt: () => ({}), getImages: () => ({}) } },
  "game/rules/Rules": {
    Rules: class {
      getObject(name) {
        const found = OBJECTS[name];
        if (!found) throw new Error(`no such object: ${name}`);
        return found;
      }
      getCountry(name) {
        return COUNTRIES[name];
      }
      getOverlayName(id) {
        const found = OVERLAY_NAMES[id];
        if (!found) throw new Error(`no overlay ${id}`);
        return found;
      }
    },
  },
  "game/art/Art": { Art: class {} },
  "game/art/ObjectArt": { ObjectArt: {} },
  "engine/type/ObjectType": { ObjectType },
  "engine/type/PaletteType": { PaletteType: {} },
  "engine/ImageFinder": { ImageFinder: class {} },
  "game/GameMap": { GameMap: class {} },
  "engine/gfx/drawable/TmpDrawable": { TmpDrawable: class {} },
  // 24 and 25 are the bridges here; the ore ids are decided by ORE_CLASSES in
  // the file under test, not by this.
  "game/map/BridgeOverlayTypes": {
    BridgeOverlayTypes: {
      isBridge: (id) => id === 24 || id === 25,
      isHighBridge: (id) => id === 25,
      bridgePlaceholderIds: [100, 101, 231, 232],
    },
  },
  "util/Color": { Color: {} },
};

// --- the map ----------------------------------------------------------------

/**
 * A pre-captured map, in miniature.
 *
 * The airport carries a tag; the tag names a trigger; the trigger's ChangeHouse
 * action names start position 1 (4475 is `locationHouseIdBegin`). That is how
 * every "(PreCaptured)" map in the ladder pool hands a building over, and it is
 * why reading [Structures] alone says every one of them is Neutral.
 */
const SECTIONS = {
  Houses: new Map([
    ["0", "MyHouse"],
    ["1", "Neutral"],
  ]),
  MyHouse: { Country: "Americans" },
  Neutral: { Country: "Neutral" },
  Tags: new Map([["01000001", '0,"tech p1 1",01000000']]),
  Triggers: new Map([["01000000", "Americans,<none>,tech p1,0,1,1,1,0"]]),
  Actions: new Map([["01000000", "1,14,0,4475,0,0,0,0,A"]]),
  Events: new Map([["01000000", "1,13,0,10"]]),
};

const section = (name) => {
  const raw = SECTIONS[name];
  if (!raw) return null;
  if (raw instanceof Map) return { entries: raw };
  return { getString: (key) => raw[key] };
};

const mapFile = {
  fullSize: { width: 80, height: 80 },
  theaterType: "temperate",
  startingLocations: [
    { x: 10, y: 10 },
    { x: 70, y: 70 },
  ],
  smudges: [{ name: "CRATER01", rx: 5, ry: 5 }],
  overlays: [
    { id: 1, rx: 1, ry: 1 }, // a sandbag wall: plain overlay
    { id: 24, rx: 2, ry: 2 }, // bridge
    { id: 25, rx: 3, ry: 3 }, // high bridge, still a bridge
    { id: 104, rx: 4, ry: 4 }, // ore
    { id: 130, rx: 5, ry: 4 }, // ore, the range that overlaps at 127
    { id: 30, rx: 6, ry: 4 }, // gems, which are ore to a sprite offset
    { id: 100, rx: 7, ry: 7 }, // bridge placeholder: draws nothing, counts as nothing
    { id: 231, rx: 8, ry: 8 }, // the same
    { id: 999, rx: 9, ry: 9 }, // an id this ruleset cannot name
  ],
  terrains: [
    { name: "TREE01", rx: 20, ry: 20 },
    { name: "TREE01", rx: 21, ry: 20 },
    { name: "CAMISC01", rx: 22, ry: 20 }, // an ore drill
  ],
  structures: [
    { name: "CAAIRP", owner: "Neutral", rx: 52, ry: 92, tag: "01000001" }, // handed to start 1
    { name: "CAAIRP", owner: "Neutral", rx: 135, ry: 92 }, // and one that is not
    { name: "CABHUT", owner: "Neutral", rx: 30, ry: 30 },
    { name: "CABHUT", owner: "Neutral", rx: 31, ry: 30 },
    { name: "CAOILD", owner: "MyHouse", rx: 12, ry: 12 }, // owned outright by a playable country
  ],
  getSection: section,
};

// --- run it -----------------------------------------------------------------

const context = vm.createContext({ console, setTimeout, clearTimeout, performance });
context.window = context;
context.System = { import: (id) => Promise.resolve(modules[id] || {}) };
vm.runInContext(readFileSync(join(src, "glyphs.js"), "utf8"), context);
vm.runInContext(readFileSync(join(src, "hq-preview.js"), "utf8"), context);

const survey = await context.__cdcHq.survey(mapFile);

const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : " — " + detail}`);

const kind = (name, owner, player) =>
  survey.structures.find((s) => s.name === name && s.owner === owner && (player === undefined || s.player === player));

check("the survey is stamped with how it was counted", survey.v === context.__cdcHq.SURVEY_VERSION, `v${survey.v}`);

check("walls and fences are overlays", survey.types.overlay === 1, JSON.stringify(survey.types));
check("bridges are not, high or low", survey.types.bridge === 2);
check("ore and gems are ore", survey.types.ore === 4, `3 overlays + 1 drill = ${survey.types.ore}`);
check("bridge placeholders draw nothing and count as nothing", survey.types.overlay + survey.types.bridge === 3);
check(
  "an overlay the ruleset cannot name is dropped, as the render drops it",
  survey.types.overlay === 1 && !Object.keys(survey.byName).some((n) => !n || n === "undefined"),
  JSON.stringify(Object.keys(survey.byName))
);
check("an ore drill is ore, not a tree", survey.types.terrain === 2, `${survey.types.terrain} terrain objects`);
check("smudges are counted", survey.types.smudge === 1);
check("structures are counted", survey.types.building === 5);

check("names are tallied", survey.byName.CAAIRP === 2 && survey.byName.TREE01 === 2, JSON.stringify(survey.byName));
check("including the ore the tally rolls up", survey.byName.GOLD01 === 1 && survey.byName.GEM01 === 1);

// The question that started this: how many airports, and does the panel's
// by-name dial have anything to move.
check(
  "two airports, on a map whose [Structures] call them all Neutral",
  survey.structures.filter((s) => s.name === "CAAIRP").reduce((n, s) => n + s.count, 0) === 2,
  JSON.stringify(survey.structures.filter((s) => s.name === "CAAIRP"))
);
check("and they carry the glyph the render marks them with", kind("CAAIRP", "Neutral", 1).icon === "parachute");

check(
  "a tagged building is handed to the start its trigger names",
  !!kind("CAAIRP", "Neutral", 1) && /trigger "tech p1"/.test(kind("CAAIRP", "Neutral", 1).via),
  kind("CAAIRP", "Neutral", 1) && kind("CAAIRP", "Neutral", 1).via
);
check(
  "the untagged one of the same kind stays nobody's, and is a row of its own",
  !!kind("CAAIRP", "Neutral", 0) && kind("CAAIRP", "Neutral", 0).count === 1
);
check("a playable owner needs no trigger", !!kind("CAOILD", "MyHouse") && kind("CAOILD", "MyHouse").player === 1);
check("scenery is not capturable", kind("CABHUT", "Neutral").capturable === false);
check("and identical scenery is one row", kind("CABHUT", "Neutral").count === 2);
check("start positions travel with it", survey.starts === 2);

// The whole point is that this fits beside a thumbnail rather than beside a
// render: a few kilobytes, whatever the map's ore field costs to draw.
const bytes = JSON.stringify(survey).length;
check("it is kilobytes, not megabytes", bytes < 8000, `${bytes} B for this map`);

for (const line of results) console.log(line);
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
