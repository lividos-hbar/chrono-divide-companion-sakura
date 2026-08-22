(() => {
  "use strict";

  const TAG = "[cd-companion/player-colours]";
  const WORDS = ["color", "colour", "palette", "player", "owner", "team", "render", "sprite", "material", "remap"];

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
    return Object.getOwnPropertyNames(value.prototype).filter((name) => name !== "constructor");
  }

  function wordsIn(text) {
    const lower = text.toLowerCase();
    return WORDS.filter((word) => lower.includes(word));
  }

  function preview(fn) {
    return Function.prototype.toString.call(fn).replace(/\s+/g, " ").slice(0, 280);
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

      for (const method of prototypeMethods(value)) {
        const fn = value.prototype[method];
        if (typeof fn !== "function") continue;
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
    const fn = entry?.mod?.[exportName]?.prototype?.[method];
    if (typeof fn !== "function") {
      console.warn(TAG, "method not found", { id, exportName, method });
      return undefined;
    }
    const source = Function.prototype.toString.call(fn);
    console.log(TAG, `${id} :: ${exportName}.${method}`, source);
    return source;
  }

  window.__cdcPlayerColours = { inspect, inspectRenderPath, moduleTable, show };
  console.info(TAG, "loaded. Run __cdcPlayerColours.inspect() in the game console.");
})();
