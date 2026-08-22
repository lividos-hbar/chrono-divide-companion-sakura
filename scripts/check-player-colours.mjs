/** Static contract for the page-world player-colour diagnostic. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const diagnostic = readFileSync(join(root, "src", "player-colours.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const gameScripts = manifest.content_scripts
  .filter((entry) => entry.matches?.includes("https://game.chronodivide.com/*"))
  .flatMap((entry) => entry.js || []);

const required = [
  "function inspect()",
  "function inspectRenderPath()",
  "function show(id, exportName, method)",
  "window.__cdcPlayerColours = { inspect, inspectRenderPath, moduleTable, show }",
  "if (id.includes(\"/three\")) continue",
];

const missing = required.filter((needle) => !diagnostic.includes(needle));
if (missing.length || !gameScripts.includes("src/player-colours.js")) {
  console.error("FAIL player-colours diagnostic contract", {
    missing,
    manifestLoadsDiagnostic: gameScripts.includes("src/player-colours.js"),
  });
  process.exit(1);
}

console.log("PASS player-colours diagnostic contract — ranked inspection and source display available");
