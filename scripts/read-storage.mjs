/**
 * Read the extension's own `chrome.storage.local` off disk, from a shell.
 *
 *   node scripts/read-storage.mjs                 # every key and its size
 *   node scripts/read-storage.mjs log             # the log, one line per entry
 *   node scripts/read-storage.mjs pools bulk      # those keys, as JSON
 *   node scripts/read-storage.mjs --where         # just say where the store is
 *
 * The other half of the logger: `src/bridge.js` writes what the extension did
 * into storage, and this reads it without a browser, a console or a click. It
 * answers questions about the machine the extension actually runs on — which
 * `scripts/check-*.mjs` cannot, being tests of shipped files against fakes.
 *
 * **Read-only, and safe while the browser is running** — this file is only the
 * command line; the LevelDB and snappy parsing it drives lives in
 * `scripts/storage-lib.mjs`, which explains why that holds.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findStore, readStore, loadedFrom, summarise } from "./storage-lib.mjs";

const stamp = (ms) => new Date(ms).toISOString().slice(11, 23);

function printLog(value) {
  let entries;
  try {
    entries = JSON.parse(value.toString("utf8"));
  } catch (e) {
    console.log(`log is not JSON: ${e.message}`);
    return;
  }
  if (!Array.isArray(entries)) {
    console.log(JSON.stringify(entries, null, 1));
    return;
  }
  for (const e of entries) {
    const level = e.level && e.level !== "info" ? ` ${e.level.toUpperCase()}` : "";
    console.log(`${stamp(e.at)} ${(e.src || "?").padEnd(9)}${level} ${e.msg}`);
  }
  console.log(`-- ${entries.length} entries`);
}

// Nothing in this store should reach it with the pictures gone; it is here so a
// key that grows one day says so instead of filling the terminal.
const PRINT_LIMIT = 400_000;

function print(value) {
  const text = JSON.stringify(summarise(value), null, 1);
  if (text.length <= PRINT_LIMIT) {
    console.log(text);
    return;
  }
  console.log(text.slice(0, PRINT_LIMIT));
  console.log(`-- cut: ${text.length} characters with the pictures already summarised`);
}

function main() {
  const args = process.argv.slice(2);
  const repo = loadedFrom(dirname(fileURLToPath(import.meta.url)));
  const stores = findStore(repo);
  if (!stores.length) {
    console.error(`No browser profile has an unpacked extension loaded from ${repo}.`);
    console.error("Load it (edge://extensions -> Load unpacked) and try again.");
    process.exitCode = 1;
    return;
  }
  if (stores.length > 1) {
    console.log(`${stores.length} profiles hold this extension; reading the first:`);
    for (const s of stores) console.log(`  ${s.profile} (${s.id})`);
  }
  const store = stores[0];
  console.log(`${store.profile} · ${store.id}`);
  if (args[0] === "--where") {
    console.log(store.dir);
    return;
  }

  const data = readStore(store.dir, { big: args.length ? 40_000_000 : 200_000 });
  if (!args.length) {
    for (const key of [...data.keys()].sort()) {
      const v = data.get(key);
      console.log(`  ${key}: ${typeof v === "number" ? v : v.length} B`);
    }
    console.log(`-- ${data.size} keys`);
    return;
  }
  for (const key of args) {
    const value = data.get(key);
    console.log(`\n=== ${key} ===`);
    if (value === undefined) {
      console.log("not in the store");
    } else if (typeof value === "number") {
      console.log(`${value} B, too large to print`);
    } else if (key === "log") {
      printLog(value);
    } else {
      print(JSON.parse(value.toString("utf8")));
    }
  }
}

main();
