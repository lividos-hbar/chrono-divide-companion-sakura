/**
 * Every client module companion.js reads is one it actually keeps.
 *
 *   node scripts/check-modules.mjs
 *
 * `src/companion.js` reaches the client's own classes through SystemJS, and that
 * used to be three hand-maintained lists that had to agree: the ids to import,
 * the destructured results, and the object literal that stored them. In 0.53.0
 * three modules were added to the first two and left out of the third. Nothing
 * failed — the imports succeeded, `import failed` was never logged, and the
 * `modules:` narration listed only the seven names the literal knew about — but
 * `state.modules.CombatantUi` was `undefined`, so the hook that captures a match
 * never installed and every build hotkey was silently dead.
 *
 * 0.53.3 replaced the three lists with one table (`MODULE_EXPORTS`). This checks
 * the two things that table cannot enforce by itself:
 *
 *   1. every id in MODULE_IDS has an entry in MODULE_EXPORTS, and vice versa —
 *      an id with no entry is imported and thrown away, an entry with no id is
 *      a name nothing ever fills;
 *   2. every `state.modules.X` the file reads is a name the table produces —
 *      which is the exact shape of the 0.53.0 defect, read rather than reasoned
 *      about.
 *
 * Text, not a parse: both tables are object literals of string keys, and a
 * checker needing a real client to run would never be run.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(join(here, "..", "src", "companion.js"), "utf8");

/** The keys of one `const NAME = { … };` object literal. */
function literal(name) {
  const at = js.indexOf(`const ${name} = {`);
  if (at < 0) throw new Error(`${name} is not in companion.js — this checker is out of date`);
  const body = js.slice(at, js.indexOf("\n  };", at));
  return [...body.matchAll(/^\s{4}(\w+):\s*"([^"]+)"/gm)].map((m) => ({ key: m[1], value: m[2] }));
}

const ids = literal("MODULE_IDS");
const exports_ = literal("MODULE_EXPORTS");

const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

if (!ids.length || !exports_.length) {
  console.error("read no entries out of one of the tables — the checker's pattern has stopped matching");
  process.exit(1);
}

const idKeys = new Set(ids.map((e) => e.key));
const exportKeys = new Set(exports_.map((e) => e.key));

const imported = [...idKeys].filter((k) => !exportKeys.has(k));
const stored = [...exportKeys].filter((k) => !idKeys.has(k));

check(
  "every imported module is kept",
  imported.length === 0,
  imported.length ? `imported and thrown away: ${imported.join(", ")}` : `${idKeys.size} modules`
);
check(
  "and nothing is kept that is never imported",
  stored.length === 0,
  stored.length ? `no id for: ${stored.join(", ")}` : ""
);

// What the rest of the file expects to find on state.modules. Both the dotted
// read and the destructured one, since the build hotkeys use the latter.
const names = new Set(exports_.map((e) => e.value));
const read = new Set([
  ...[...js.matchAll(/state\.modules\.(\w+)/g)].map((m) => m[1]),
  ...[...js.matchAll(/const \{ ([^}]+) \} = state\.modules;/g)].flatMap((m) =>
    m[1].split(",").map((part) => part.trim())
  ),
]);

const unfilled = [...read].filter((name) => !names.has(name));
check(
  "every module the file reads is one the table fills",
  unfilled.length === 0,
  unfilled.length
    ? `read off state.modules but never stored: ${unfilled.join(", ")}`
    : `${read.size} names read, all filled`
);

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
