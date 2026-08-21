/**
 * Run src/background.js — the file as shipped — against a fake `chrome`.
 *
 *   node scripts/check-background.mjs
 *
 * One rule is worth a test of its own: **a tab the extension did not open is
 * never closed.** The worker opens a game tab when a render run has nobody to
 * do it, and the tab tells the worker when the run is over — but the same
 * message arrives from a tab the user opened and is playing in, and closing
 * that would be destroying somebody's game to tidy up after ourselves.
 *
 * The ownership list lives in `chrome.storage.session` because an MV3 worker is
 * torn down whenever it is idle and a run takes minutes. That is exactly the
 * kind of thing that looks right and is not, so the checks below drive the real
 * file rather than a copy of its logic.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "background.js"), "utf8");

const created = [];
const removed = [];
const updated = [];
const focused = [];
let session = {};
let nextId = 100;
const handlers = { message: [], removed: [] };

const chrome = {
  action: { onClicked: { addListener() {} } },
  runtime: {
    openOptionsPage() {},
    onMessage: { addListener: (fn) => handlers.message.push(fn) },
  },
  tabs: {
    create: async (opts) => {
      const tab = { id: nextId++, ...opts };
      created.push(tab);
      return tab;
    },
    remove: async (id) => void removed.push(id),
    update: async (id, opts) => {
      updated.push({ id, ...opts });
      return { id, windowId: 7 };
    },
    onRemoved: { addListener: (fn) => handlers.removed.push(fn) },
  },
  windows: {
    update: async (id, opts) => void focused.push({ id, ...opts }),
  },
  storage: {
    session: {
      get: async (defaults) => ({ ...defaults, ...session }),
      set: async (patch) => void (session = { ...session, ...patch }),
    },
  },
};

vm.runInNewContext(source, { chrome, console });

/** One message to the worker, resolving with its answer if it sends one. */
const send = (message, sender) =>
  new Promise((resolve) => {
    let answered = false;
    for (const fn of handlers.message) fn(message, sender, (answer) => ((answered = true), resolve(answer)));
    setTimeout(() => !answered && resolve(undefined), 50);
  });

const settle = () => new Promise((r) => setTimeout(r, 30));
const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

const first = await send({ type: "open-game-tab" }, {});
check("opens a tab and reports its id", !!(first && first.ok && typeof first.tabId === "number"), JSON.stringify(first));
check("opens it in the background", created.length === 1 && created[0].active === false, JSON.stringify(created));
check("points it at the client", /game\.chronodivide\.com/.test(created[0]?.url || ""), created[0]?.url);

const ourId = created[0].id;

check(
  "and mutes it",
  updated.some((u) => u.id === ourId && u.muted === true),
  JSON.stringify(updated)
);

// Activations, not every `update`: muting the tab goes through the same call.
const activations = () => updated.filter((u) => u.active);

const shown = await send({ type: "show-game-tab", tabId: ourId }, {});
check("a tab we opened can be brought to the front", !!(shown && shown.ok), JSON.stringify(shown));
check("and its window with it", activations().length === 1 && focused.length === 1, JSON.stringify({ updated, focused }));

const notOurs = await send({ type: "show-game-tab", tabId: 4242 }, {});
check("somebody else's tab is not", !!(notOurs && notOurs.ok === false), JSON.stringify(notOurs));
check("and nothing was activated", activations().length === 1, JSON.stringify(updated));


await send({ type: "run-finished" }, { tab: { id: 4242 } });
await settle();
check("a run in the user's own tab closes nothing", removed.length === 0, JSON.stringify(removed));

await send({ type: "run-finished" }, { tab: { id: ourId } });
await settle();
check("a run in the tab we opened closes it", removed.length === 1 && removed[0] === ourId, JSON.stringify(removed));

await send({ type: "run-finished" }, { tab: { id: ourId } });
await settle();
check("a second finish does not close it twice", removed.length === 1, JSON.stringify(removed));

const second = await send({ type: "open-game-tab" }, {});
await settle();
handlers.removed.forEach((fn) => fn(second.tabId)); // the user closes it by hand
await settle();
await send({ type: "run-finished" }, { tab: { id: second.tabId } });
await settle();
check("a tab the user closed is not closed again", removed.length === 1, JSON.stringify(removed));

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
