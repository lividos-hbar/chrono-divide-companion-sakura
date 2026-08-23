(() => {
  "use strict";

  const TAG = "[cd-companion/player-colours]";
  const WORDS = ["color", "colour", "palette", "player", "owner", "team", "render", "sprite", "material", "remap"];
  const DEFAULTS = {
    enabled: false,
    matchMode: "1v1",
    enemyMode: "same",
    colorOrder: ["DarkRed", "DarkBlue"],
  };
  const state = { ...DEFAULTS, installed: false, combatant: null, originals: new Map() };

  // These are the short paths observed in the loaded client module table. They
  // deliberately cover the minimap plus the SHP/palette route that paints a
  // unit, instead of dumping every unrelated renderer in the client.
  const TARGETS = [
    ["data/Palette", "Palette"],
    ["engine/renderable/entity/map/MinimapModel", "MinimapModel"],
    ["engine/renderable/entity/map/MinimapRenderer", "MinimapRenderer"],
    ["engine/gfx/material/PaletteBasicMaterial", "PaletteBasicMaterial"],
    ["engine/gfx/material/PalettePhongMaterial", "PalettePhongMaterial"],
    ["engine/renderable/builder/CanvasSpriteBuilder", "CanvasSpriteBuilder"],
    ["engine/renderable/builder/ShpBuilder", "ShpBuilder"],
    ["engine/renderable/builder/BatchShpBuilder", "BatchShpBuilder"],
    ["engine/renderable/ShpRenderable", "ShpRenderable"],
    ["gui/ShpSpriteBatch", "ShpSpriteBatch"],
    ["engine/renderable/entity/Building", "Building"],
    ["engine/renderable/entity/Vehicle", "Vehicle"],
    ["engine/renderable/entity/Infantry", "Infantry"],
    ["engine/renderable/entity/Aircraft", "Aircraft"],
  ];

  function moduleTable() {
    const modules = window.System?._loader?.modules;
    return modules ? Object.entries(modules) : [];
  }

  function moduleFor(id) {
    for (const [moduleId, record] of moduleTable()) {
      if (moduleId === id || moduleId.endsWith(`/${id}`)) return { id: moduleId, mod: record?.module || record };
    }
    return undefined;
  }

  function prototypeMethods(value) {
    if (!value?.prototype) return [];
    // Do not read `value.prototype[name]`: classes in the client have accessor
    // properties such as `size`, and reading one with the prototype as `this`
    // invokes the getter before the report can be made.
    return Object.entries(Object.getOwnPropertyDescriptors(value.prototype))
      .filter(([name, descriptor]) => name !== "constructor" && typeof descriptor.value === "function")
      .map(([name, descriptor]) => ({ name, fn: descriptor.value }));
  }

  function wordsIn(text) {
    const lower = text.toLowerCase();
    return WORDS.filter((word) => lower.includes(word));
  }

  function preview(fn) {
    return Function.prototype.toString.call(fn).replace(/\s+/g, " ").slice(0, 280);
  }

  function colorFor(game, name) {
    const color = game?.rules?.colors?.get?.(name);
    if (!color) console.warn(TAG, `"${name}" is not one of this game's rule colours`);
    return color;
  }

  function restore() {
    for (const [player, color] of state.originals) player.color = color;
    state.originals.clear();
  }

  function applyPrefs(prefs = {}) {
    restore();
    if (typeof prefs.playerColoursEnabled === "boolean") state.enabled = prefs.playerColoursEnabled;
    if (prefs.playerColoursMatchMode === "1v1" || prefs.playerColoursMatchMode === "2v2") {
      state.matchMode = prefs.playerColoursMatchMode;
    }
    if (prefs.playerColoursEnemyMode === "same" || prefs.playerColoursEnemyMode === "different") {
      state.enemyMode = prefs.playerColoursEnemyMode;
    }
    if (Array.isArray(prefs.playerColoursOrder)) {
      const order = prefs.playerColoursOrder.filter((name) => typeof name === "string" && name);
      if (order.length) state.colorOrder = order;
    }
    apply();
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "cdc-bridge" || data.type !== "config") return;
    applyPrefs(data.prefs);
  });

  /** Apply a known rule-palette colour to enemies of the local combatant only. */
  function apply(combatant = state.combatant) {
    const game = combatant?.game;
    const localPlayer = combatant?.player;
    if (!state.enabled || !game || !localPlayer) return false;

    const players = [...(game.getCombatants?.() || [])];
    const areAllied = game.alliances?.areAllied;
    if (!players.length || typeof areAllied !== "function") {
      console.warn(TAG, "combatants, alliances, or rule colours are unavailable; nothing changed");
      return false;
    }

    const enemies = players.filter((player) =>
      player !== localPlayer && !areAllied.call(game.alliances, localPlayer, player)
    );
    const allies = players.filter((player) =>
      player === localPlayer || areAllied.call(game.alliances, localPlayer, player)
    );
    const eligible = state.matchMode === "1v1"
      ? players.length === 2 && enemies.length === 1
      : players.length === 4 && allies.length === 2 && enemies.length === 2;
    if (!eligible) return false;

    const colorNames = enemies.map((_, index) =>
      state.enemyMode === "same" ? state.colorOrder[0] : state.colorOrder[index % state.colorOrder.length]
    );
    const colors = colorNames.map((name) => colorFor(game, name));
    if (colors.some((color) => !color)) return false;

    for (const [index, player] of enemies.entries()) {
      if (!state.originals.has(player)) state.originals.set(player, player.color);
      // This must be a value from game.rules.colors: batched VXL palettes only
      // accept the client's precomputed colour list, not a new Color instance.
      player.color = colors[index];
    }
    console.info(TAG, `enemy display colours set to ${colorNames.join(", ")}`);
    return true;
  }

  function setEnemyColor(name) {
    if (typeof name !== "string" || !name) return false;
    state.colorOrder[0] = name;
    restore();
    state.enabled = true;
    return apply();
  }

  function setEnabled(enabled) {
    state.enabled = !!enabled;
    if (!state.enabled) {
      restore();
      return true;
    }
    return apply();
  }

  /** Hook after CombatantUi initialises game and local-player references. */
  function install() {
    if (state.installed) return true;
    const entry = moduleFor("gui/screen/game/CombatantUi");
    const CombatantUi = entry?.mod?.CombatantUi;
    if (typeof CombatantUi?.prototype?.init !== "function") return false;

    const originalInit = CombatantUi.prototype.init;
    CombatantUi.prototype.init = function (...args) {
      const result = originalInit.apply(this, args);
      state.combatant = this;
      apply(this);
      return result;
    };
    if (typeof CombatantUi.prototype.dispose === "function") {
      const originalDispose = CombatantUi.prototype.dispose;
      CombatantUi.prototype.dispose = function (...args) {
        if (state.combatant === this) {
          restore();
          state.combatant = null;
        }
        return originalDispose.apply(this, args);
      };
    }
    state.installed = true;
    console.info(TAG, "installed — configure player colours from the extension popup");
    return true;
  }

  /**
   * One copy-and-paste command for the live-game investigation. Every method
   * is a separate row, so DevTools does not collapse the useful names into the
   * unhelpful `Array(n)` output from the old broad inventory.
   */
  function inspect() {
    const rows = [];
    const missing = [];

    for (const [id, exportName] of TARGETS) {
      const entry = moduleFor(id);
      const value = entry?.mod?.[exportName];
      if (typeof value !== "function") {
        missing.push(`${id} :: ${exportName}`);
        continue;
      }

      for (const { name: method, fn } of prototypeMethods(value)) {
        const source = Function.prototype.toString.call(fn);
        rows.push({
          module: id,
          class: exportName,
          method,
          mentions: wordsIn(`${method} ${source}`).join(", "),
          preview: preview(fn),
        });
      }
    }

    console.group(TAG, `focused renderer report: ${rows.length} methods`);
    console.table(rows);
    if (missing.length) console.warn(TAG, "not loaded yet", missing);
    console.log(TAG, "Copy this focused table. It is read-only and does not patch the client.");
    console.groupEnd();
    return rows;
  }

  // Keep the prior name working, but make it the same reliable one-command
  // report rather than a second, differently shaped console workflow.
  const inspectRenderPath = inspect;

  /** Print one method body if a deeper look is needed after the focused table. */
  function show(id, exportName, method) {
    const entry = moduleFor(id);
    const descriptor = Object.getOwnPropertyDescriptor(entry?.mod?.[exportName]?.prototype || {}, method);
    const fn = descriptor?.value;
    if (typeof fn !== "function") {
      console.warn(TAG, "method not found", { id, exportName, method });
      return undefined;
    }
    const source = Function.prototype.toString.call(fn);
    console.log(TAG, `${id} :: ${exportName}.${method}`, source);
    return source;
  }

  window.__cdcPlayerColours = {
    inspect,
    inspectRenderPath,
    moduleTable,
    show,
    install,
    apply,
    setEnemyColor,
    setEnabled,
    getState: () => ({ ...state, colorOrder: [...state.colorOrder], originals: state.originals.size }),
  };

  const boot = () => {
    if (install()) return;
    setTimeout(boot, 250);
  };
  boot();
  console.info(TAG, "loaded. Run __cdcPlayerColours.inspect() in the game console.");
})();
