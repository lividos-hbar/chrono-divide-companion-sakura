/**
 * Read a browser's `chrome.storage.local` off disk, without a browser.
 *
 * The parser half of `scripts/read-storage.mjs`, lifted out so more than one
 * consumer can drive it: the CLI prints keys for a human, the site build
 * streams the render blobs into files. Nothing here writes to the store or
 * knows about either caller.
 *
 * **Read-only, and safe while the browser is running.** The `.ldb` tables are
 * immutable once written and are read in place; the write-ahead `.log` is being
 * appended to, so it is copied to a temporary file and the copy is parsed.
 * Nothing here opens the database as a database, so the browser's lock is never
 * contested.
 *
 * Not a LevelDB client: the manifest and the level structure are ignored, every
 * table and the log are scanned, and the highest sequence number wins per key.
 * Slower than a real client, and immune to a stale manifest — which matters
 * when reading a database whose owner still has it open.
 *
 * No dependencies, deliberately: this repo has no `package.json`, and neither
 * snappy nor LevelDB is available to it, so both formats are implemented below.
 * That is ~200 lines that cannot be uninstalled, against a global install that
 * can.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// --- snappy -----------------------------------------------------------------

/** Raw snappy block -> Buffer. Four tag types, per google/snappy. */
function snappyDecompress(data) {
  let [length, i] = uvarint(data, 0);
  const out = Buffer.allocUnsafe(length);
  let w = 0;
  while (i < data.length) {
    const tag = data[i];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      i += 1;
      if (n >= 60) {
        const extra = n - 59;
        n = data.readUIntLE(i, extra);
        i += extra;
      }
      n += 1;
      data.copy(out, w, i, i + n);
      w += n;
      i += n;
      continue;
    }
    let n;
    let offset;
    if (kind === 1) {
      n = 4 + ((tag >> 2) & 7);
      offset = ((tag >> 5) << 8) | data[i + 1];
      i += 2;
    } else if (kind === 2) {
      n = (tag >> 2) + 1;
      offset = data.readUInt16LE(i + 1);
      i += 3;
    } else {
      n = (tag >> 2) + 1;
      offset = data.readUInt32LE(i + 1);
      i += 5;
    }
    if (offset === 0 || offset > w) throw new Error(`copy offset ${offset} past ${w} bytes`);
    // Overlapping copies are how snappy encodes a run, so this cannot be a
    // single copy() — each byte may be one just written.
    for (let j = 0, from = w - offset; j < n; j++) out[w++] = out[from + j];
  }
  if (w !== length) throw new Error(`snappy said ${length} bytes, produced ${w}`);
  return out;
}

function uvarint(data, i) {
  let out = 0;
  let shift = 0;
  for (;;) {
    const b = data[i++];
    out += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) return [out, i];
    shift += 7;
  }
}

// --- the write-ahead log ----------------------------------------------------

const BLOCK = 32768;

/** Yield reassembled WriteBatch payloads out of a `.log`. */
function* logRecords(data) {
  let buf = Buffer.alloc(0);
  let pos = 0;
  while (pos + 7 <= data.length) {
    const off = pos % BLOCK;
    if (BLOCK - off < 7) {
      pos += BLOCK - off;
      continue;
    }
    const length = data.readUInt16LE(pos + 4);
    const type = data[pos + 6];
    const payload = data.subarray(pos + 7, pos + 7 + length);
    pos += 7 + length;
    if (type === 1) yield payload;
    else if (type === 2) buf = payload;
    else if (type === 3) buf = Buffer.concat([buf, payload]);
    else if (type === 4) {
      yield Buffer.concat([buf, payload]);
      buf = Buffer.alloc(0);
    } else {
      // Zero is padding at a block tail; anything else is a torn record, and
      // guessing past one is how a parser invents data. Skip to the next block.
      pos = (Math.floor(pos / BLOCK) + 1) * BLOCK;
      buf = Buffer.alloc(0);
    }
  }
}

/** Yield [key, value|null] from one WriteBatch; null is a delete. */
function* batchEntries(batch) {
  if (batch.length < 12) return;
  const count = batch.readUInt32LE(8);
  let i = 12;
  for (let n = 0; n < count && i < batch.length; n++) {
    const kind = batch[i++];
    let klen;
    [klen, i] = uvarint(batch, i);
    const key = batch.subarray(i, i + klen);
    i += klen;
    if (kind === 1) {
      let vlen;
      [vlen, i] = uvarint(batch, i);
      yield [key, batch.subarray(i, i + vlen)];
      i += vlen;
    } else {
      yield [key, null];
    }
  }
}

// --- sstables ---------------------------------------------------------------

const MAGIC_LO = 0x8b80fb57;
const MAGIC_HI = 0xdb477524;
const FOOTER = 48;

function blockAt(data, offset, size) {
  const raw = data.subarray(offset, offset + size);
  const kind = data[offset + size];
  if (kind === 0) return raw;
  if (kind === 1) return snappyDecompress(raw);
  throw new Error(`unknown block compression ${kind}`);
}

/** Yield [key, value] from a block, undoing the shared-prefix encoding. */
function* blockEntries(block) {
  if (block.length < 4) return;
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - restarts * 4;
  let i = 0;
  let key = Buffer.alloc(0);
  while (i < end) {
    let shared;
    let nonShared;
    let vlen;
    [shared, i] = uvarint(block, i);
    [nonShared, i] = uvarint(block, i);
    [vlen, i] = uvarint(block, i);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(i, i + nonShared)]);
    i += nonShared;
    yield [key, block.subarray(i, i + vlen)];
    i += vlen;
  }
}

/**
 * Yield [userKey, seq, kind, value] from one `.ldb`.
 *
 * `skipPrefix` drops whole data blocks that lie inside one key prefix, decided
 * from the index block's separators without decompressing the block. The store
 * is ~99% `full:<map>` render blobs; skipping them is the difference between
 * under a second and several minutes.
 */
function* tableEntries(path, skipPrefix) {
  const data = readFileSync(path);
  if (data.length < FOOTER) return;
  const footer = data.subarray(data.length - FOOTER);
  if (
    footer.readUInt32LE(FOOTER - 8) !== MAGIC_LO ||
    footer.readUInt32LE(FOOTER - 4) !== MAGIC_HI
  ) {
    throw new Error(`${path}: not an sstable`);
  }
  let i = 0;
  [, i] = uvarint(footer, i); // metaindex offset
  [, i] = uvarint(footer, i); // metaindex size
  let indexOff;
  let indexSize;
  [indexOff, i] = uvarint(footer, i);
  [indexSize, i] = uvarint(footer, i);
  let prev = null;
  for (const [sep, value] of blockEntries(blockAt(data, indexOff, indexSize))) {
    // A separator is >= every key in its block, so the block is wholly inside
    // the prefix only when the separator before it is too.
    const inside =
      skipPrefix && startsWith(sep, skipPrefix) && prev && startsWith(prev, skipPrefix);
    prev = sep;
    if (inside) continue;
    let off;
    let size;
    let j = 0;
    [off, j] = uvarint(value, 0);
    [size, j] = uvarint(value, j);
    for (const [key, val] of blockEntries(blockAt(data, off, size))) {
      if (key.length < 8) continue;
      const lo = key.readUInt32LE(key.length - 8);
      const hi = key.readUInt32LE(key.length - 4);
      // seq is the top 56 bits of the 64-bit trailer, kind the bottom 8.
      yield [key.subarray(0, key.length - 8), hi * 0x1000000 + (lo >>> 8), lo & 0xff, val];
    }
  }
}

const startsWith = (buf, prefix) => buf.subarray(0, prefix.length).equals(prefix);

// --- finding the store ------------------------------------------------------

/**
 * Where this extension's storage is, found rather than hardcoded: the browser
 * profiles' `Secure Preferences` name every unpacked extension and the path it
 * was loaded from, so the repo's own path identifies it.
 *
 * Checked for Edge and Chrome, every profile of each. The companion is loaded
 * in Edge here, and the id is derived from the load path — which makes it
 * stable while the repo stays put and wrong the moment it moves, so it is never
 * written down.
 */
export function findStore(repoPath) {
  // The worktree redirect below yields forward slashes and the browser records
  // backslashes; neither is more correct, so compare with both flattened.
  const same = (p) => String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const want = same(repoPath);
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const bases = [
    join(local, "Microsoft", "Edge", "User Data"),
    join(local, "Google", "Chrome", "User Data"),
  ];
  const found = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const profile of readdirSync(base)) {
      const prefs = join(base, profile, "Secure Preferences");
      if (!existsSync(prefs)) continue;
      let settings;
      try {
        settings = JSON.parse(readFileSync(prefs, "utf8")).extensions?.settings || {};
      } catch (e) {
        console.warn(`  ! ${profile}: ${e.message}`);
        continue;
      }
      for (const [id, entry] of Object.entries(settings)) {
        if (same(entry.path) !== want) continue;
        const dir = join(base, profile, "Local Extension Settings", id);
        if (existsSync(dir)) found.push({ id, profile, base, dir });
      }
    }
  }
  return found;
}

/**
 * The directory the browser loaded the extension from — always the **main**
 * working tree, never the worktree this script may be running in. A worktree's
 * `.git` is a file pointing at `<main>/.git/worktrees/<name>`, which is the
 * whole of the redirection; no subprocess needed.
 */
export function loadedFrom(here) {
  const repo = join(here, "..");
  const dotgit = join(repo, ".git");
  if (existsSync(dotgit) && statSync(dotgit).isFile()) {
    const gitdir = readFileSync(dotgit, "utf8").replace(/^gitdir:\s*/, "").trim();
    const cut = gitdir.replace(/\\/g, "/").indexOf("/.git/worktrees/");
    if (cut > 0) return gitdir.slice(0, cut);
  }
  return repo;
}

// --- reading the store ------------------------------------------------------

/**
 * Every live key. Values longer than `big` come back as their length instead —
 * a single render is megabytes of data URL and is never worth holding.
 *
 * `sink` is the escape hatch for the keys that cannot be held at all: give it
 * `{ prefix, onValue(key, value, seq) }` and every entry whose key starts with
 * `prefix` is handed to `onValue` — key as a string, value as a Buffer, `null`
 * for a delete — and then dropped, never entering the returned Map and never
 * retained here. That is what keeps the `full:` blobs (~450 MB across the
 * store) off the heap: one value is live at a time, and only for as long as
 * `onValue` keeps it.
 *
 * The sink reports **every occurrence**, not the winner: a key lives in as many
 * tables as it has been rewritten in, and `readStore` yields them in whatever
 * order it happens to scan. `seq` is there so the caller can decide — highest
 * wins, exactly as the Map path does internally. A caller that writes each
 * value straight out will overwrite an older version with a newer one or the
 * reverse, depending on scan order, unless it compares `seq` first.
 *
 * `sink` and `skipPrefix` are independent, and usually opposed: `skipPrefix`
 * exists to avoid decompressing the render blocks, so a sink aimed at `full:`
 * wants `skipPrefix: null` or the blocks it wants are never opened.
 *
 * The Buffer handed to `onValue` is a view into the table it came from, not a
 * copy — keeping one keeps the whole ~20 MB block alive. Write it out or copy
 * what you need inside the callback; a caller that collects the views has
 * rebuilt the very heap the sink exists to avoid.
 */
export function readStore(dir, { big = 200_000, skipPrefix = Buffer.from("full:"), sink = null } = {}) {
  const sinkPrefix = sink ? Buffer.from(sink.prefix) : null;
  const best = new Map(); // key -> [seq, value|length|null]
  const keep = (key, seq, val) => {
    // Before the Map, and before the `big` truncation: a sunk value is passed
    // on and forgotten, so nothing sized by the store's contents accumulates.
    if (sinkPrefix && startsWith(key, sinkPrefix)) {
      sink.onValue(key.toString("utf8"), val, seq);
      return;
    }
    const k = key.toString("utf8");
    const prev = best.get(k);
    if (prev && prev[0] > seq) return;
    best.set(k, [seq, val === null ? null : val.length > big ? val.length : val]);
  };

  let scratch = null;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    try {
      if (name.endsWith(".ldb")) {
        for (const [key, seq, kind, val] of tableEntries(path, skipPrefix)) {
          keep(key, seq, kind === 1 ? val : null);
        }
      } else if (name.endsWith(".log")) {
        // The only file the browser is still writing to. Copy, then parse the
        // copy — a half-written record at the tail is skipped by the parser
        // either way, but a file that grows under `readFileSync` is not worth
        // reasoning about.
        scratch = join(tmpdir(), `cdc-wal-${process.pid}-${name}`);
        writeFileSync(scratch, readFileSync(path));
        // A log record carries a sequence per batch, not per entry, and the log
        // is newer than every table; counting up from a number no table can
        // reach keeps the order without inventing exact sequences.
        let seq = Number.MAX_SAFE_INTEGER - 1e6;
        for (const batch of logRecords(readFileSync(scratch))) {
          seq++;
          for (const [key, val] of batchEntries(batch)) keep(key, seq, val);
        }
        rmSync(scratch, { force: true });
        scratch = null;
      }
    } catch (e) {
      console.warn(`  ! ${name}: ${e.message}`);
      if (scratch) rmSync(scratch, { force: true });
      scratch = null;
    }
  }

  const out = new Map();
  for (const [k, [, v]] of best) if (v !== null) out.set(k, v);
  return out;
}

// --- presenting a value -----------------------------------------------------

/**
 * A picture, as what it is and how big — anything else unchanged.
 *
 * Every interesting key in this store holds its facts wrapped in images:
 * `maps` is 3 MB of base64 thumbnails around a few kilobytes of names and, now,
 * of what is on each map. Printing the value meant printing the pictures, and
 * the guard against that was a 20 000-character slice — which cut the JSON
 * mid-base64, so the one key worth reading end to end could not be read at all,
 * and could not be piped into anything either.
 *
 * Only data URLs are summarised, by their own prefix rather than by length: a
 * guide is a long string a person wrote and must print in full.
 */
export function summarise(value) {
  if (typeof value === "string") {
    const kind = /^data:([^;,]+)[;,]/.exec(value);
    return kind ? `<${kind[1]}, ${(value.length / 1024).toFixed(1)} KB>` : value;
  }
  if (Array.isArray(value)) return value.map(summarise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarise(v)]));
  }
  return value;
}
