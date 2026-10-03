/** Static contract for the page-world player-colour diagnostic. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const diagnostic = readFileSync(join(root, "src", "player-colours.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const gameScripts = manifest.content_scripts
  .filter((entry) => entry.matches?.includes("https://game.chronodivide.com/*"))
  .flatMap((entry) => entry.js || []);

const required = [
  "function inspect()",
  "const inspectRenderPath = inspect",
  "function show(id, exportName, method)",
  "window.__cdcPlayerColours = {",
  "setEnemyColor",
  "const TARGETS = [",
  "engine/renderable/entity/map/MinimapModel",
  "engine/renderable/entity/map/MinimapRenderer",
  "engine/renderable/builder/ShpBuilder",
  "Object.getOwnPropertyDescriptors(value.prototype)",
  "function setEnemyColor(name)",
  "game.rules.colors",
];

const missing = required.filter((needle) => !diagnostic.includes(needle));
if (missing.length || !gameScripts.includes("src/player-colours.js")) {
  console.error("FAIL player-colours diagnostic contract", {
    missing,
    manifestLoadsDiagnostic: gameScripts.includes("src/player-colours.js"),
  });
  process.exit(1);
}

class Palette {
  get size() {
    return this.colors.length;
  }

  remap() {}
}

class CombatantUi {
  init() {}
  dispose() {}
}

const consoleCalls = [];
const listeners = new Map();
const context = {
  console: {
    group: () => {},
    groupEnd: () => {},
    log: () => {},
    info: () => {},
    warn: () => {},
    table: (rows) => consoleCalls.push(rows),
  },
  window: {
    addEventListener: (type, listener) => listeners.set(type, listener),
    System: {
      _loader: {
        modules: {
          "https://game.chronodivide.com/data/Palette": { module: { Palette } },
          "https://game.chronodivide.com/gui/screen/game/CombatantUi": { module: { CombatantUi } },
        },
      },
    },
  },
  setTimeout: () => 0,
};
vm.runInNewContext(diagnostic, context);
const rows = context.window.__cdcPlayerColours.inspect();
if (!rows.some((row) => row.class === "Palette" && row.method === "remap") ||
    rows.some((row) => row.method === "size") || !consoleCalls.length) {
  console.error("FAIL player-colours accessor safety", rows);
  process.exit(1);
}

const local = { color: { name: "Gold" } };
const ally = { color: { name: "Orange" } };
const originalEnemy = { name: "Purple" };
const originalSecondEnemy = { name: "Magenta" };
const enemy = { color: originalEnemy };
const secondEnemy = { color: originalSecondEnemy };
const darkRed = { name: "DarkRed" };
const darkBlue = { name: "DarkBlue" };
const ui = new CombatantUi();
ui.player = local;
ui.game = {
  rules: { colors: new Map([["DarkRed", darkRed], ["DarkBlue", darkBlue]]) },
  getCombatants: () => [local, ally, enemy, secondEnemy],
  alliances: { areAllied: (a, b) => a === local && b === ally },
};
ui.init();
listeners.get("message")({ data: {
  source: "cdc-bridge",
  type: "config",
  prefs: {
    playerColoursEnabled: true,
    playerColoursMatchMode: "2v2",
    playerColoursEnemyMode: "different",
    playerColoursOrder: ["DarkRed", "DarkBlue"],
  },
} });
const api = context.window.__cdcPlayerColours;
if (enemy.color !== darkRed || secondEnemy.color !== darkBlue || ally.color.name !== "Orange") {
  console.error("FAIL player-colours enemy override", { local, ally, enemy, secondEnemy });
  process.exit(1);
}
const capturedUnit = { owner: enemy };
const alliedUnit = { owner: local };
if (capturedUnit.owner.color !== darkRed || alliedUnit.owner.color.name !== "Gold") {
  console.error("FAIL player-colours owner colour inheritance", { capturedUnit, alliedUnit });
  process.exit(1);
}
api.setEnabled(false);
if (enemy.color !== originalEnemy || secondEnemy.color !== originalSecondEnemy) {
  console.error("FAIL player-colours restore", { enemy, secondEnemy });
  process.exit(1);
}

console.log("PASS player-colours diagnostic contract — inspection skips accessors; overrides and owner colours restore safely");
