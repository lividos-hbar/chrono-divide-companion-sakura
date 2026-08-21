/**
 * A settings backup reads what is there and writes back exactly that.
 *
 *   node scripts/check-settings.mjs
 *
 * The two halves of a backup live in two worlds that cannot see each other, and
 * neither has a test a browser is not required for — so both are sliced out of
 * their files and driven against stubs, the same trick check-chords.mjs uses for
 * the keyboard lock.
 *
 * What is checked is what has a right answer rather than a look:
 *
 *   - the client's `[Hotkey]` INI survives a round trip, comments and all;
 *   - the live table beats the saved file, and a client with neither says so
 *     instead of writing an empty backup;
 *   - the whitelists hold — a file name the client does not keep and a
 *     localStorage key that is identity or session state are both refused, in
 *     both directions;
 *   - a command this client has no name for is REPORTED, not dropped in
 *     silence, which is the one failure a newer client will actually cause;
 *   - a client whose own writer writes nothing still ends up with a file;
 *   - and a loaded file is checked before anything of the game's is touched.
 *
 * What it cannot check: that the client reads the file back the way it wrote it.
 * That is one reload in a real browser, and it is in the task's review block.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
const companion = readFileSync(join(src, "companion.js"), "utf8");
const options = readFileSync(join(src, "options.js"), "utf8");
const bridge = readFileSync(join(src, "bridge.js"), "utf8");

const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

/** One function, whole, out of a file that exports nothing. */
function sliceFn(source, where, name) {
  let at = source.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`check-settings is out of date: no function ${name} in ${where}`);
  // With its `async`, when it has one: half of this feature is asynchronous, and
  // a slice that dropped the keyword would not parse.
  if (source.slice(at - 6, at) === "async ") at -= 6;
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name} in ${where}`);
}

/**
 * One `const NAME = …;`.
 *
 * To the first semicolon **outside** any bracket or string, not the first
 * semicolon: one of the tables being sliced binds a key called ";" and stopping
 * at that one produced a fragment that did not parse.
 */
function sliceConst(source, where, name) {
  const at = source.indexOf(`const ${name} = `);
  if (at < 0) throw new Error(`check-settings is out of date: no const ${name} in ${where}`);
  let depth = 0;
  let quote = "";
  for (let i = at; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`unterminated ${name} in ${where}`);
}

// --- the game tab's half -----------------------------------------------------

/** A directory that behaves like the client's, and remembers what was written. */
function stubDir(files = {}) {
  const written = [];
  return {
    files,
    written,
    async containsEntry(name) {
      return Object.prototype.hasOwnProperty.call(this.files, name);
    },
    async getRawFile(name) {
      const text = this.files[name];
      if (text === undefined) throw new Error(`no ${name}`);
      return { text: async () => text };
    },
    async writeFile(file) {
      written.push({ name: file.name, text: file.parts.join("") });
      this.files[file.name] = file.parts.join("");
    },
  };
}

/** The client's KeyBinds, as far as a backup ever touches it. */
function stubBinds(table, { persistFileName = "keyboard.ini", saves = true, dir = null } = {}) {
  return {
    persistFileName,
    saved: 0,
    hotKeys: new Map(Object.entries(table).map(([command, code]) => [code, command])),
    addHotKey(command, code) {
      this.hotKeys.set(code, command);
    },
    async save() {
      this.saved++;
      if (!saves || !dir) return; // an instance built before the file system existed
      const lines = ["[Hotkey]"];
      for (const [code, command] of this.hotKeys) lines.push(`${command}=${code}`);
      dir.files[persistFileName] = lines.join("\r\n") + "\r\n";
    },
  };
}

const COMMANDS = ["Options", "ToggleRepair", "SelectGroup1", "CenterBase", "Scoreboard"];

function pageHarness({ dir, binds, prefs = {}, commands = COMMANDS }) {
  const notes = [];
  const localStorage = {
    store: { ...prefs },
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
    },
    setItem(key, value) {
      this.store[key] = value;
    },
  };
  class FileStub {
    constructor(parts, name) {
      this.parts = parts;
      this.name = name;
    }
  }
  const window = {
    System: {
      import: async (id) => {
        if (id === "gui/screen/game/worldInteraction/keyboard/KeyCommandType") {
          if (!commands) throw new Error("no such module");
          return { KeyCommandType: Object.fromEntries(commands.map((c) => [c, c])) };
        }
        throw new Error("unexpected import " + id);
      },
    },
  };
  const state = { keyBinds: binds, clientHotkeys: new Map() };
  const api = new Function(
    "state",
    "localStorage",
    "window",
    "File",
    "note",
    "clientRootDir",
    `${sliceConst(companion, "companion.js", "HOTKEY_FILES")}
     ${sliceConst(companion, "companion.js", "CLIENT_PREF_KEYS")}
     ${sliceFn(companion, "companion.js", "liveHotkeys")}
     ${sliceFn(companion, "companion.js", "parseHotkeyIni")}
     ${sliceFn(companion, "companion.js", "hotkeyIniText")}
     ${sliceFn(companion, "companion.js", "readClientSettings")}
     ${sliceFn(companion, "companion.js", "writeClientSettings")}
     return { readClientSettings, writeClientSettings, parseHotkeyIni, hotkeyIniText, HOTKEY_FILES, CLIENT_PREF_KEYS };`
  )(state, localStorage, window, FileStub, (m, level) => notes.push(`${level || "info"}: ${m}`), async () => dir);
  return { api, notes, localStorage, state };
}

// --- the INI round trip ------------------------------------------------------

{
  const { api } = pageHarness({ dir: stubDir(), binds: null });
  const text =
    "; written by the client\r\n[Hotkey]\r\nOptions=27\r\nToggleRepair=1094\r\n\r\n[Other]\r\nOptions=1\r\n";
  const table = api.parseHotkeyIni(text);
  check(
    "the [Hotkey] section is read, and only it",
    JSON.stringify(table) === JSON.stringify({ Options: 27, ToggleRepair: 1094 }),
    JSON.stringify(table)
  );
  const round = api.parseHotkeyIni(api.hotkeyIniText(table));
  check("and survives being written back out", JSON.stringify(round) === JSON.stringify(table));
  check(
    "the file the client will read is CRLF, as its own writer makes it",
    api.hotkeyIniText({ Options: 27 }) === "[Hotkey]\r\nOptions=27\r\n"
  );
}

// --- reading -----------------------------------------------------------------

{
  const dir = stubDir({ "keyboard.ini": "[Hotkey]\r\nOptions=27\r\n" });
  const { api } = pageHarness({ dir, binds: null });
  const out = await api.readClientSettings({ hotkeys: true, prefs: false });
  check(
    "a saved file is read when no client has built a table",
    JSON.stringify(out.hotkeys) === JSON.stringify({ "keyboard.ini": { Options: 27 } }),
    JSON.stringify(out.hotkeys)
  );
}

{
  // The live table is never staler than the file — the file is written from it —
  // and it exists when the file does not, which is a client on its defaults.
  const dir = stubDir({ "keyboard.ini": "[Hotkey]\r\nOptions=27\r\n" });
  const binds = stubBinds({ Options: 999, CenterBase: 66 }, { dir });
  const { api } = pageHarness({ dir, binds });
  const out = await api.readClientSettings({ hotkeys: true, prefs: false });
  check(
    "the live table beats the file it was loaded from",
    JSON.stringify(out.hotkeys["keyboard.ini"]) === JSON.stringify({ Options: 999, CenterBase: 66 }),
    JSON.stringify(out.hotkeys["keyboard.ini"])
  );
}

{
  const dir = stubDir({ "keyboardmd.ini": "[Hotkey]\r\nCenterBase=66\r\n" });
  const binds = stubBinds({ Options: 27 }, { dir });
  const { api } = pageHarness({ dir, binds });
  const out = await api.readClientSettings({ hotkeys: true, prefs: false });
  check(
    "both engines' tables travel, not just the one in play",
    Object.keys(out.hotkeys).sort().join(",") === "keyboard.ini,keyboardmd.ini",
    Object.keys(out.hotkeys).join(",")
  );
}

{
  const { api } = pageHarness({ dir: stubDir(), binds: null });
  let threw = "";
  await api.readClientSettings({ hotkeys: true, prefs: false }).catch((e) => (threw = e.message));
  check(
    "nothing to read is said out loud rather than saved as an empty backup",
    /no hotkey table/.test(threw),
    threw || "it returned normally"
  );
}

{
  // The exclusions are the security-shaped half of this feature: a reconnect
  // payload imported elsewhere makes that browser offer to rejoin a match.
  const { api } = pageHarness({
    dir: stubDir(),
    binds: null,
    prefs: {
      _r_opts_v3: "12,1,x,1,0,1,1,1",
      _r_mixer_v3: "5,5",
      _r_lastCon: '{"gameId":"live"}',
      _r_nickname: "somebody",
      _r_gameRes: "1",
      _r_last_gpu: "3",
    },
  });
  const out = await api.readClientSettings({ hotkeys: false, prefs: true });
  const carried = Object.keys(out.prefs).sort();
  check(
    "the carried preferences are the whitelist and nothing else",
    carried.join(",") === "_r_mixer_v3,_r_opts_v3",
    carried.join(",")
  );
  check(
    "so a live reconnect, an identity and a per-machine measurement stay behind",
    !carried.includes("_r_lastCon") && !carried.includes("_r_nickname") && !carried.includes("_r_gameRes")
  );
}

// --- writing -----------------------------------------------------------------

{
  const dir = stubDir();
  const binds = stubBinds({ Options: 27, SelectGroup1: 49 }, { dir });
  const { api, state } = pageHarness({ dir, binds });
  const report = await api.writeClientSettings({
    hotkeys: { "keyboard.ini": { Options: 1094, CenterBase: 66 } },
    prefs: {},
  });
  const landed = Object.fromEntries([...binds.hotKeys.entries()].map(([code, cmd]) => [cmd, code]));
  check(
    "an import replaces the live table rather than merging into it",
    JSON.stringify(landed) === JSON.stringify({ Options: 1094, CenterBase: 66 }),
    JSON.stringify(landed)
  );
  check("and goes out through the client's own writer", binds.saved === 1);
  check(
    "the copy the conflict warnings read is put back in step with it",
    state.clientHotkeys.size === 2,
    "size " + state.clientHotkeys.size
  );
  check(
    "a live client needs no reload for its hotkeys",
    report.reload === false && report.files[0].live === true,
    JSON.stringify(report.files)
  );
}

{
  // A client whose KeyBinds was built before the file system existed saves
  // nothing, successfully — `saveIni` writes through an optional chain.
  const dir = stubDir();
  const binds = stubBinds({ Options: 27 }, { saves: false });
  const { api } = pageHarness({ dir, binds });
  const report = await api.writeClientSettings({ hotkeys: { "keyboard.ini": { Options: 1094 } }, prefs: {} });
  check(
    "a save that wrote nothing is caught, and the file is written anyway",
    dir.written.length === 1 && dir.files["keyboard.ini"].includes("Options=1094"),
    JSON.stringify(dir.written)
  );
  check(
    "and it says so rather than reporting a clean import",
    report.notes.some((n) => /wrote nothing/.test(n)),
    JSON.stringify(report.notes)
  );
}

{
  // The fresh-browser case the whole feature exists for: no client has built a
  // table yet, so there is nothing to write through.
  const dir = stubDir();
  const { api } = pageHarness({ dir, binds: null });
  const report = await api.writeClientSettings({ hotkeys: { "keyboard.ini": { Options: 27 } }, prefs: {} });
  check(
    "with no client table the file is written directly",
    dir.files["keyboard.ini"] === "[Hotkey]\r\nOptions=27\r\n",
    JSON.stringify(dir.files)
  );
  check("and the tab is told it has to reload", report.reload === true);
}

{
  const dir = stubDir();
  const binds = stubBinds({}, { dir });
  const { api } = pageHarness({ dir, binds });
  const report = await api.writeClientSettings({
    hotkeys: { "keyboard.ini": { Options: 27, RenamedInANewerClient: 55 } },
    prefs: {},
  });
  check(
    "a command this client has no name for is reported, not written",
    report.unknown.join(",") === "RenamedInANewerClient" && !binds.hotKeys.has(55),
    JSON.stringify(report.unknown)
  );
  check("and the rest of the table still lands", binds.hotKeys.get(27) === "Options");
}

{
  const dir = stubDir();
  const { api } = pageHarness({ dir, binds: null });
  const report = await api.writeClientSettings({
    hotkeys: { "../rules.ini": { Options: 27 }, "keyboard.ini": { Options: 27 } },
    prefs: { _r_opts_v3: "12", _r_lastCon: '{"gameId":"live"}' },
  });
  check(
    "a file name the client does not keep is refused",
    dir.written.length === 1 && dir.written[0].name === "keyboard.ini",
    JSON.stringify(dir.written.map((w) => w.name))
  );
  check(
    "a preference outside the whitelist is refused on the way in as well",
    report.prefs === 1 && report.notes.some((n) => /_r_lastCon/.test(n)),
    JSON.stringify(report.notes)
  );
}

{
  // Without the client's command list nothing can be checked against it — and
  // that has to be said, not assumed either way.
  const dir = stubDir();
  const { api } = pageHarness({ dir, binds: null, commands: null });
  const report = await api.writeClientSettings({ hotkeys: { "keyboard.ini": { Whatever: 27 } }, prefs: {} });
  check(
    "an unreadable command list is reported rather than silently trusted",
    report.notes.some((n) => /could not be read/.test(n)) && report.unknown.length === 0,
    JSON.stringify(report.notes)
  );
}

// --- the options page's half -------------------------------------------------

const pageApi = new Function(
  "chrome",
  `${sliceConst(options, "options.js", "BACKUP_KIND")}
   ${sliceConst(options, "options.js", "BACKUP_VERSION")}
   ${sliceConst(options, "options.js", "CLIENT_KEY_NAMES")}
   for (let i = 0; i < 10; i++) CLIENT_KEY_NAMES.set(96 + i, "Num" + i);
   for (let i = 1; i <= 32; i++) CLIENT_KEY_NAMES.set(111 + i, "F" + i);
   ${sliceConst(options, "options.js", "CLIENT_NUMPAD_ARROWS")}
   ${sliceFn(options, "options.js", "clientKeyLabel")}
   ${sliceFn(options, "options.js", "countOf")}
   ${sliceFn(options, "options.js", "buildBackup")}
   ${sliceFn(options, "options.js", "parseBackup")}
   ${sliceFn(options, "options.js", "backupLines")}
   return { clientKeyLabel, buildBackup, parseBackup, backupLines, BACKUP_KIND, BACKUP_VERSION };`
)({ runtime: { getManifest: () => ({ version: "0.0.0" }) } });

{
  // The same hash the client's own getHotKeyCode builds: meta<<12, alt<<10,
  // ctrl<<9, shift<<8, keyCode — and bit 2048 for a numpad key stored as an
  // arrow. Wrong here and the backup describes a key nobody pressed.
  const cases = [
    [27, "Esc"],
    [70, "F"],
    [1024 + 70, "Alt+F"],
    [512 + 256 + 65, "Ctrl+Shift+A"],
    [2048 + 38, "Num8"],
    [1024 + 2048 + 40, "Alt+Num2"],
    [123, "F12"],
    [4096 + 27, "Win+Esc"],
  ];
  const wrong = cases.filter(([code, want]) => pageApi.clientKeyLabel(code) !== want);
  check(
    "every hotkey code is named the way the game names it",
    wrong.length === 0,
    wrong.map(([code, want]) => `${code}: ${pageApi.clientKeyLabel(code)} != ${want}`).join("; ")
  );
}

{
  const file = pageApi.buildBackup(
    { hotkeys: { "keyboard.ini": { Options: 1024 + 70 } }, prefs: { _r_opts_v3: "12" } },
    { keys: { overlay: {} }, guides: {}, chords: { Allied: {} } },
    { hotkeys: true, gameOpts: true, bindings: true, notes: true }
  );
  check(
    "the readable block is built from the codes in the file, not from a second read",
    file.readable["keyboard.ini"].Options === "Alt+F",
    JSON.stringify(file.readable)
  );
  check(
    "an empty storage item is left out rather than written as {}",
    !("guides" in file.extension) && "chords" in file.extension,
    JSON.stringify(Object.keys(file.extension))
  );
  const only = pageApi.buildBackup({ hotkeys: { "keyboard.ini": { Options: 27 } }, prefs: { _r_opts_v3: "12" } }, {}, {
    hotkeys: true,
    gameOpts: false,
    bindings: false,
    notes: false,
  });
  check(
    "a section that was not ticked is absent, not empty",
    only.game.hotkeys && !("prefs" in only.game) && !("extension" in only),
    JSON.stringify(only)
  );
}

{
  const bad = [
    ["not JSON at all", "hello", /not JSON/],
    ["JSON that is not a backup", '{"maps":{}}', /not a settings backup/],
    ["an array", "[1,2]", /not a backup/],
    [
      "a backup from a newer format",
      JSON.stringify({ kind: pageApi.BACKUP_KIND, version: pageApi.BACKUP_VERSION + 1 }),
      /newer version/,
    ],
  ];
  const wrong = bad.filter(([, text, want]) => {
    try {
      pageApi.parseBackup(text);
      return true;
    } catch (e) {
      return !want.test(e.message);
    }
  });
  check(
    "nothing is written from a file that is not a backup of this format",
    wrong.length === 0,
    wrong.map(([name]) => name).join(", ")
  );
  const good = pageApi.parseBackup(
    JSON.stringify({ kind: pageApi.BACKUP_KIND, version: pageApi.BACKUP_VERSION, game: {} })
  );
  check("and a well-formed one is taken", good.kind === pageApi.BACKUP_KIND);
}

{
  const lines = pageApi.backupLines({
    game: { hotkeys: { "keyboard.ini": { Options: 27, CenterBase: 66 } }, prefs: { _r_opts_v3: "12" } },
    extension: { builds: { Allied: [{}, {}], Soviet: [{}] }, guides: { a: "x" } },
  });
  const joined = lines.join(" | ");
  check(
    "the summary counts what is actually in the file",
    /keyboard\.ini — 2 binding/.test(joined) &&
      /game options — 1/.test(joined) &&
      /build hotkeys — 3 across 2/.test(joined) &&
      /map guides — 1/.test(joined),
    joined
  );
}

// --- the wire between them ---------------------------------------------------

{
  // Three source rules, because the job only works if all three hold and none of
  // them is exercised without a browser: the bridge forwards a request, answers
  // on the same item, and picks up one written before the tab existed.
  const rules = [
    ["the bridge forwards a requested job", /settings && settings\.requested\) startSettings/],
    ["the page's answer lands on the same item", /data\.type === "settings-result"[\s\S]{0,200}settingsPatch\(/],
    ["a job written before the tab existed is taken", /data\.settings && data\.settings\.requested\) startSettings/],
    ["and the flag is cleared as it is forwarded", /requested: false, patchedAt: Date\.now\(\)/],
  ];
  const missing = rules.filter(([, re]) => !re.test(bridge));
  check("the bridge carries the job both ways", missing.length === 0, missing.map(([n]) => n).join(", "));

  const pageRules = [
    ["the page world answers a settings job", /data\.type === "settings-job"[\s\S]{0,120}runSettingsJob\(/],
    ["a write snapshots before it overwrites", /previous = await readClientSettings\(/],
  ];
  const missingPage = pageRules.filter(([, re]) => !re.test(companion));
  check("and the game tab answers it", missingPage.length === 0, missingPage.map(([n]) => n).join(", "));
}

// --- report ------------------------------------------------------------------

for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
