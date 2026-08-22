/**
 * The public build's configuration, which nothing else exercises.
 *
 *   node scripts/check-debug-hud.mjs
 *
 * `src/debug-hud.js` is dropped from the manifest in the public build, so
 * `window.__cdcHud` is undefined there and
 * `src/companion.js` has to survive it. That is not a hypothetical: `renderHud`
 * is called from seven places, one of them inside `note()`, so a shim that
 * handed back only a toggle would take the diagnostics log down with the panel
 * — on every log line, in the build with the fewest people able to report it.
 *
 * This check therefore reads **only** `src/companion.js`, because it has to run
 * inside the exported tree, where the panel does not exist. The panel's own
 * behaviour is `scripts/check-debug-panel.mjs`, which is withheld for the same
 * reason.
 *
 * The section is sliced out and evaluated against a stub `window`, the trick
 * `check-net.mjs` and `check-chords.mjs` both use.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const companion = readFileSync(join(here, "..", "src", "companion.js"), "utf8");

const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

// --- the section, verbatim ----------------------------------------------------

const START = "  // --- Debug HUD ---";
const END = "  // --- Keyboard ---";
const from = companion.indexOf(START);
const to = companion.indexOf(END);
if (from < 0 || to < 0 || to < from) {
  console.error("could not find the Debug HUD section in companion.js — this check is out of date");
  process.exit(1);
}
const section = companion.slice(from, to);

/**
 * Evaluate the section with the `window` it is given and hand back the three
 * names the rest of the file uses. A `new Function` body rather than an import:
 * the section is a fragment of an IIFE and has no module boundary of its own.
 */
function evaluate(win) {
  const build = new Function(
    "window",
    `${section}\nreturn { toggleHud, renderHud, escapeHtml, hud };`
  );
  return build(win);
}

// --- the public build: no panel behind the names ------------------------------

{
  // Deliberately empty. If the shim reached for any of the ten dependencies
  // outside the `window.__cdcHud ?` branch, this would throw rather than fail.
  const api = evaluate({});

  check(
    "the section evaluates with __cdcHud absent",
    typeof api.toggleHud === "function" && typeof api.renderHud === "function",
    `toggleHud is ${typeof api.toggleHud}, renderHud is ${typeof api.renderHud}`
  );
  check("toggleHud() answers false rather than throwing", api.toggleHud() === false);
  check("toggleHud(true) answers false too", api.toggleHud(true) === false);
  check("toggleHud(false) answers false", api.toggleHud(false) === false);

  let threw = null;
  try {
    api.renderHud();
    api.renderHud();
  } catch (e) {
    threw = e;
  }
  check(
    "renderHud() is inert rather than fatal — this is note()'s call site",
    threw === null,
    threw ? String(threw) : ""
  );

  check(
    "escapeHtml stayed behind, because the hints box and the player list need it",
    api.escapeHtml('<a href="x">&</a>') === "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
    api.escapeHtml('<a href="x">&</a>')
  );
}

// --- the dev build: the names delegate, they are not inert everywhere ---------

{
  const calls = [];
  const panel = {
    create(deps) {
      calls.push(["create", deps]);
      return {
        toggle: (force) => {
          calls.push(["toggle", force]);
          return "toggled";
        },
        render: () => calls.push(["render"]),
      };
    },
  };
  // The ten dependencies exist in companion.js's scope; here they are whatever
  // `new Function` finds, so the section is evaluated with them stubbed out.
  const build = new Function(
    "window",
    "state",
    "VERSION",
    "hotkeyConflicts",
    "buildConflicts",
    "chordSummary",
    "chordReport",
    "minimapRect",
    "savedRect",
    "hqShown",
    `${section}\nreturn { toggleHud, renderHud };`
  );
  const api = build({ __cdcHud: panel }, {}, "0.0.0", 0, 0, 0, 0, 0, 0, 0);

  check("create() is called once when the panel is present", calls.filter((c) => c[0] === "create").length === 1);
  check("toggleHud delegates and returns what the panel returns", api.toggleHud(true) === "toggled");
  api.renderHud();
  check("renderHud delegates", calls.filter((c) => c[0] === "render").length === 1);

  const deps = calls.find((c) => c[0] === "create")[1];
  const handed = Object.keys(deps).sort();
  const expected = [
    "VERSION",
    "buildConflicts",
    "chordReport",
    "chordSummary",
    "escapeHtml",
    "hotkeyConflicts",
    "hqShown",
    "minimapRect",
    "savedRect",
    "state",
  ];
  check(
    "all ten dependencies are handed over",
    handed.join(" ") === expected.join(" "),
    handed.join(" ")
  );
  check(
    "and none of them is undefined — a name that moved would arrive as a hole",
    expected.every((k) => deps[k] !== undefined),
    expected.filter((k) => deps[k] === undefined).join(" ") || "none"
  );
}

// --- what the rest of the file must keep --------------------------------------

check(
  "the panel itself is gone from companion.js",
  !companion.includes("cdc-hud") && !companion.includes("hudVisible") && !companion.includes("statusRows"),
  "a HUD class name or the panel's own state is still here"
);
check(
  "__cdc.debug points at the shim, so the public build answers false rather than throwing",
  companion.includes("debug: toggleHud,")
);
check(
  "note()'s renderHud() call sites are all still there",
  (companion.match(/renderHud\(\);/g) || []).length === 7,
  `${(companion.match(/renderHud\(\);/g) || []).length} call site(s)`
);
check(
  "the load line names the debug key only when there is a panel behind it",
  /window\.__cdcHud \? `, \$\{state\.keys\.debug\.label\} debug panel`/.test(companion)
);
// scripts/check-net.mjs slices the net readout between its own header and this
// one. Asserted here so removing it fails with a reason rather than as
// "check-net is out of date".
check(
  "the Debug HUD header is still where check-net.mjs's END marker expects it",
  companion.includes(START)
);

// --- and what the options page must not offer ---------------------------------
//
// The options page runs in its own context and cannot see `window.__cdcHud`, so
// it reads the manifest — the one thing the export's transform edits. A build
// with no panel must not draw a hotkey row for it: a control that opens nothing
// reads as broken rather than as absent.

const options = readFileSync(join(here, "..", "src", "options.js"), "utf8");
const guard = /function hasDebugPanel\(\)[\s\S]*?\n  \}/.exec(options);

check("the options page decides from the manifest, not from a guess", !!guard);
if (guard) {
  const decide = new Function("chrome", `${guard[0]}\nreturn hasDebugPanel;`);
  const withPanel = {
    runtime: { getManifest: () => ({ content_scripts: [{ js: ["src/debug-hud.js", "src/companion.js"] }] }) },
  };
  const without = {
    runtime: { getManifest: () => ({ content_scripts: [{ js: ["src/companion.js"] }] }) },
  };
  const none = { runtime: { getManifest: () => ({}) } };
  check("it finds the panel when the manifest names it", decide(withPanel)() === true);
  check("and does not when it does not", decide(without)() === false);
  check("a manifest with no content_scripts at all is not a crash", decide(none)() === false);
}
check(
  "and the debug row is skipped on that answer",
  /if \(name === "debug" && !hasDebugPanel\(\)\) return;/.test(options)
);
check(
  "no page copy still tells the reader to press the debug hotkey",
  !options.includes("press the debug hotkey")
);

// --- and what the keyboard must not keep --------------------------------------
//
// The row the options page skips has to leave the *table* as well. It did not,
// and the cost was the whole point of hiding it: `debug` is tested first in the
// keydown chain, so in the public build a `6` the user had rebound to the
// preview swap was swallowed by a binding they could neither see nor change,
// and handed to the inert toggle above it. A hidden control that still wins the
// press is worse than a visible one.

const own = /  function ownKeys\(table\) \{[\s\S]*?\n  \}/.exec(companion);
check("the key table is filtered by what this build ships", !!own);
if (own) {
  const make = new Function("window", `${own[0]}\nreturn ownKeys;`);
  const table = { overlay: { code: "Digit1" }, hqSwap: { code: "Digit6" }, debug: { code: "Digit6" } };
  const withPanel = make({ __cdcHud: {} })(table);
  const without = make({})(table);
  check(
    "with the panel, every key stays",
    Object.keys(withPanel).sort().join(" ") === "debug hqSwap overlay",
    Object.keys(withPanel).sort().join(" ")
  );
  check("without it, the debug binding is gone", without.debug === undefined && !!without.hqSwap);
  check(
    "and the table handed in is not mutated — the options write filters a spread of it, not a copy",
    table.debug !== undefined
  );
}
check(
  "the initial table goes through the filter",
  /keys: ownKeys\(JSON\.parse\(JSON\.stringify\(DEFAULT_KEYS\)\)\)/.test(companion)
);
check(
  "and so does the options page's write, which would otherwise put it straight back",
  /state\.keys = ownKeys\(\{ \.\.\.state\.keys, \.\.\.data\.keys \}\);/.test(companion)
);
check(
  "a descriptor that is not there answers false rather than throwing on `.code`",
  /function matchesHotkey\(e, key\) \{[\s\S]*?if \(!key\) return false;/.test(companion)
);

// ------------------------------------------------------------------------------

for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL"));
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`\n${results.length} checks, all passing`);
