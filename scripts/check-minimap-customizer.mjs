/** Persistent radar-customizer contract, checked without a running client. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const radar = readFileSync(join(root, "src", "minimap-qol.js"), "utf8");
const settings = readFileSync(join(root, "src", "minimap-settings.js"), "utf8");
const page = readFileSync(join(root, "src", "minimap-settings.html"), "utf8");
const checks = [
  ["ships the requested dimming defaults", /litLo: 0\.10, litHi: 0\.34, shLo: 0\.03, shHi: 0\.09/.test(radar)],
  ["reads the saved radar preference from bridge config", /const saved = prefs && prefs\.minimapRadar;/.test(radar)],
  ["writes every panel adjustment back through the bridge", /type: "prefs-set", prefs: \{ minimapRadar: snapshot\(\) \}/.test(radar)],
  ["keeps unexplored tiles black", /ShroudType\.Unexplored.*return "#000000"/.test(radar)],
  ["forces one full redraw after a changed setting", /if \(state\.repaint\) \{[\s\S]*?this\.renderFull\(\);/.test(radar)],
  ["offers persistent controls in the display settings page", /id="radarLitLo"/.test(page) && /id="radarHalo"/.test(page)],
  ["stores values as numbers rather than slider strings", /litLo: Number\(controls\.radarLitLo\.value\)/.test(settings)],
];

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0);
