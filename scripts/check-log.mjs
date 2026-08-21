/**
 * Run src/background.js and src/bridge.js — the files as shipped — against a
 * fake `chrome`, and check the log they keep between them.
 *
 *   node scripts/check-log.mjs
 *
 * The log exists because of one failure and is checked against it: a map was
 * rendered, the render reached storage, the **card did not**, and the run
 * reported a clean success. Afterwards there was nothing to distinguish a write
 * that failed from a write that was never started.
 *
 * So the two rules worth a test are:
 *
 * 1. **A write is written down before it is attempted**, not only after. An
 *    entry added on the acknowledgement cannot describe a write whose
 *    acknowledgement never comes.
 * 2. **The log lands before the tab is asked to close.** The whole point is to
 *    be readable after the tab is gone, and the last batch is the one that
 *    explains the run — losing exactly that batch to the tab closing would be
 *    the original bug wearing a new hat.
 *
 * As in check-bridge.mjs the writes never complete on their own; the test
 * releases them, which is the only way to tell waiting from a race won slowly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

// --- the worker, which owns the log -----------------------------------------
//
// Driven through its own onMessage listener rather than by calling appendLog:
// the wire is part of what is being checked.

function loadWorker() {
  let stored = {};
  let session = {};
  let listener = null;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: {
      openOptionsPage() {},
      onMessage: { addListener: (fn) => (listener = fn) },
    },
    tabs: { create: async () => ({ id: 1 }), remove: async () => {}, update: async () => ({ id: 1 }), onRemoved: { addListener() {} } },
    windows: { update: async () => {} },
    storage: {
      local: {
        get: async (query) => {
          const out = {};
          Object.keys(query).forEach((k) => (out[k] = stored[k] === undefined ? query[k] : stored[k]));
          return out;
        },
        set: async (items) => void Object.assign(stored, items),
      },
      session: {
        get: async (query) => ({ ...query, ...session }),
        set: async (items) => void Object.assign(session, items),
      },
    },
  };
  vm.runInContext(
    readFileSync(join(src, "background.js"), "utf8"),
    vm.createContext({ chrome, console, setTimeout, clearTimeout })
  );
  const send = (message) =>
    new Promise((resolve) => {
      const kept = listener(message, {}, resolve);
      if (!kept) resolve(undefined);
    });
  return { send, log: () => stored.log || [] };
}

const worker = loadWorker();

await worker.send({ type: "log", lines: [{ at: 1, src: "page", msg: "first", level: "info" }] });
await worker.send({ type: "log", lines: [{ at: 2, src: "bridge", msg: "second", level: "warn" }] });
check(
  "batches are appended in order",
  worker.log().map((e) => e.msg).join(",") === "first,second",
  JSON.stringify(worker.log())
);

await worker.send({ type: "log", lines: [{ at: 3, src: "page", msg: "" }, null, { src: "page", msg: "kept" }] });
const last = worker.log()[worker.log().length - 1];
check("an entry with no message is dropped", worker.log().length === 3, `${worker.log().length} entries`);
check("and one with no timestamp is stamped on arrival", typeof last.at === "number" && last.at > 1e12, String(last.at));

await worker.send({ type: "log", lines: [{ src: "page", msg: "x".repeat(5000) }] });
const long = worker.log()[worker.log().length - 1];
check("a very long line is cut rather than stored whole", long.msg.length < 1000, `${long.msg.length} chars`);

await worker.send({ type: "log", lines: [{ src: "page", msg: "made up", level: "shout" }] });
check(
  "an unknown level is not taken at its word",
  worker.log()[worker.log().length - 1].level === "info",
  worker.log()[worker.log().length - 1].level
);

// The cap is the worker's own number, so it is measured rather than restated.
const before = worker.log().length;
await worker.send({
  type: "log",
  lines: Array.from({ length: 2000 }, (_, i) => ({ src: "page", msg: "n" + i })),
});
const capped = worker.log().length;
check("the log is capped", capped < before + 2000 && capped > 0, `${capped} entries`);
check(
  "and it is the newest that are kept",
  worker.log()[capped - 1].msg === "n1999",
  worker.log()[capped - 1].msg
);

// --- the bridge, which narrates ---------------------------------------------

function loadBridge() {
  const sent = [];
  const pending = [];
  let stored = { maps: {}, renders: {}, guides: {}, keys: {}, prefs: {}, bulk: null };
  let onMessage = null;
  let onPageHide = null;
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "0.0.0-test" }),
      sendMessage: (message, cb) => {
        sent.push(message);
        if (cb) cb();
      },
    },
    storage: {
      local: {
        get: (query, cb) => {
          const out = {};
          if (typeof query === "string") out[query] = stored[query];
          else if (Array.isArray(query)) query.forEach((k) => (out[k] = stored[k]));
          else Object.keys(query).forEach((k) => (out[k] = stored[k] === undefined ? query[k] : stored[k]));
          setTimeout(() => cb(out), 0);
        },
        set: (items, cb) => {
          Object.assign(stored, items);
          pending.push(() => cb && cb());
        },
        remove: (keys, cb) => {
          [].concat(keys).forEach((k) => delete stored[k]);
          if (cb) cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };
  const window = {
    addEventListener: (type, fn) => {
      if (type === "message") onMessage = fn;
      if (type === "pagehide") onPageHide = fn;
    },
    postMessage() {},
  };
  window.window = window;
  vm.runInContext(
    readFileSync(join(src, "bridge.js"), "utf8"),
    vm.createContext({ ...window, window, chrome, console, setTimeout, clearTimeout })
  );
  return {
    sent,
    pending,
    stored: () => stored,
    say: (data) => onMessage({ source: window, data: { source: "cdc-page", ...data } }),
    pagehide: () => onPageHide && onPageHide(),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
/**
 * Long enough for the bridge's batch timer to fire.
 *
 * Read off the file rather than written down twice: a test that hardcodes the
 * interval passes for the wrong reason the day the interval changes.
 */
const FLUSH_MS = Number(
  /LOG_FLUSH_MS\s*=\s*(\d+)/.exec(readFileSync(join(src, "bridge.js"), "utf8"))[1]
);
const flushed = () => new Promise((r) => setTimeout(r, FLUSH_MS + 60));
/** Every log line the bridge has handed over, flattened. */
const linesOf = (b) => b.sent.filter((m) => m.type === "log").flatMap((m) => m.lines);

let b = loadBridge();

// A card write: the entry that matters is the one before the write, because a
// write that never lands leaves nothing else behind.
b.say({ type: "map-seen", map: { key: "mp01.map", name: "One", thumb: "t", facts: {} } });
await flushed();
const beforeAck = linesOf(b).map((e) => e.msg);
check(
  "a card write is written down before it is attempted",
  beforeAck.some((m) => m === "card mp01.map: writing"),
  JSON.stringify(beforeAck)
);
check(
  "and its outcome is not claimed yet",
  !beforeAck.some((m) => m.startsWith("card mp01.map: stored")),
  JSON.stringify(beforeAck)
);

b.pending.shift()();
await flushed();
check(
  "the outcome follows once the write lands",
  linesOf(b).some((e) => e.msg === "card mp01.map: stored"),
  JSON.stringify(linesOf(b).map((e) => e.msg))
);

// The harvested cameo sheet, on the same terms as a card. It is the largest
// single write the extension makes and the one whose loss is least visible: a
// sheet that never landed leaves a timeline drawn in words, which reads as a
// setting rather than as a failure. The log is the only place that can tell
// those apart.
b = loadBridge();
const harvested = {
  version: "0.83.3/1",
  at: 1,
  cols: 16,
  cell: { width: 60, height: 36 },
  size: { width: 960, height: 216 },
  sheet: "data:image/png;base64,AAAA",
  index: { GAPOWR: 0 },
  pictures: 1,
  ids: 1,
  objects: 1,
  missing: [],
};
b.say({ type: "cameo-sheet", cameos: harvested });
await flushed();
const beforeSheet = linesOf(b).map((e) => e.msg);
check(
  "a cameo harvest is written down before it is attempted",
  beforeSheet.some((m) => m.startsWith("cameos: writing")),
  JSON.stringify(beforeSheet)
);
check(
  "and its outcome is not claimed yet",
  !beforeSheet.some((m) => m === "cameos: stored"),
  JSON.stringify(beforeSheet)
);

b.pending.shift()();
await flushed();
check(
  "the outcome follows once the sheet lands",
  linesOf(b).some((e) => e.msg === "cameos: stored"),
  JSON.stringify(linesOf(b).map((e) => e.msg))
);

// A harvest that drew nothing must not be written over a good sheet, and must
// not say it was: silence here would be a stored sheet nobody can account for.
b = loadBridge();
b.say({ type: "cameo-sheet", cameos: { ...harvested, index: {}, sheet: "" } });
await flushed();
check(
  "an empty harvest is neither written nor claimed",
  !linesOf(b).some((e) => e.msg.startsWith("cameos:")) && !b.pending.length,
  JSON.stringify(linesOf(b).map((e) => e.msg))
);

// The harvested object table, on the same terms. It is not the largest write
// the extension makes, but it is the one whose loss is hardest to see from the
// outside: a replay decoded without it names every object as a number, which
// reads as a client that never had the rules rather than as a write that never
// landed. The log is the only place those are told apart.
b = loadBridge();
const harvestedTypes = {
  version: "0.83.3/1",
  at: 1,
  types: {
    building: [["GAPOWR", "Power Plant", 800, { tech: 1, side: "Allied" }]],
    infantry: [["E1", "GI", 200]],
    vehicle: [["HARV", "War Miner", 1400]],
    aircraft: [["ORCA", "Intruder", 1200]],
  },
  general: { maximumQueuedObjects: 29, buildSpeed: 0.7, multipleFactory: 0.8, padAircraft: ["ORCA"] },
  objects: 4,
  named: 4,
};
b.say({ type: "replay-types", replayTypes: harvestedTypes });
await flushed();
const beforeTypes = linesOf(b).map((e) => e.msg);
check(
  "a replay-types harvest is written down before it is attempted",
  beforeTypes.some((m) => m.startsWith("replay types: writing")),
  JSON.stringify(beforeTypes)
);
check(
  "and its outcome is not claimed yet",
  !beforeTypes.some((m) => m === "replay types: stored"),
  JSON.stringify(beforeTypes)
);

b.pending.shift()();
await flushed();
check(
  "the outcome follows once the table lands",
  linesOf(b).some((e) => e.msg === "replay types: stored"),
  JSON.stringify(linesOf(b).map((e) => e.msg))
);

// An empty table must not be written over a good one, and must not say it was.
b = loadBridge();
b.say({ type: "replay-types", replayTypes: { ...harvestedTypes, types: {} } });
await flushed();
check(
  "an empty object table is neither written nor claimed",
  !linesOf(b).some((e) => e.msg.startsWith("replay types:")) && !b.pending.length,
  JSON.stringify(linesOf(b).map((e) => e.msg))
);

// The page's own narration reaches the same log rather than a second one.
b.say({ type: "log", msg: "bulk: One — 3000x1595", level: "info" });
await flushed();
const fromPage = linesOf(b).filter((e) => e.src === "page");
check("the page's narration is carried too", fromPage.length === 1, JSON.stringify(fromPage));

// A warning does not wait for the batch timer.
b = loadBridge();
b.say({ type: "log", msg: "something is wrong", level: "warn" });
check(
  "a warning is handed over at once, not on the timer",
  linesOf(b).some((e) => e.msg === "something is wrong"),
  JSON.stringify(b.sent)
);

// The rule the original bug turns on.
b = loadBridge();
b.say({ type: "map-render", key: "mp01.map", render: { thumb: "t", full: "F", v: 3 } });
await settle();
b.say({ type: "bulk-progress", done: 1, total: 1, rendered: 1, active: "", failed: [], finished: true });
await settle();
check(
  "nothing asks to close the tab while a write is in flight",
  !b.sent.some((m) => m.type === "run-finished"),
  JSON.stringify(b.sent.map((m) => m.type))
);
while (b.pending.length) {
  b.pending.shift()();
  await settle();
}
const order = b.sent.map((m) => m.type);
const closedAt = order.indexOf("run-finished");
check("the tab is asked to close in the end", closedAt >= 0, JSON.stringify(order));
check(
  "and every log line was handed over before that",
  closedAt >= 0 && !order.slice(closedAt).includes("log"),
  JSON.stringify(order)
);
check(
  "including the one that says the run finished",
  linesOf(b).some((e) => /^run finished/.test(e.msg)),
  JSON.stringify(linesOf(b).map((e) => e.msg))
);

// A tab going away with lines still buffered hands them over on the way out.
b = loadBridge();
b.say({ type: "log", msg: "still in the buffer", level: "info" });
check("a line waiting on the timer has not been sent yet", linesOf(b).length === 0, JSON.stringify(b.sent));
b.pagehide();
check(
  "and pagehide hands it over",
  linesOf(b).some((e) => e.msg === "still in the buffer"),
  JSON.stringify(linesOf(b))
);

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
