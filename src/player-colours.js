(() => {
  "use strict";

  const TAG = "[cd-companion/player-colours]";
  const COLOUR_WORDS = ["color", "colour", "palette", "player", "owner", "team"];
  const RENDER_WORDS = ["render", "sprite", "material", "minimap", "radar", "remap"];
  const WORDS = [...COLOUR_WORDS, ...RENDER_WORDS];
  const MAX_RENDER_CANDIDATES = 80;

  function moduleTable() {
    const modules = window.System?._loader?.modules;
    return modules ? Object.entries(modules) : [];
  }

  function moduleFor(id) {
    for (const [moduleId, record] of moduleTable()) {
      if (moduleId === id || moduleId.endsWith(`/${id}`)) return record?.module || record;
    }
    return undefined;
  }

  function prototypeMethods(value) {
    if (!value?.prototype) return [];
    return Object.getOwnPropertyNames(value.prototype).filter((name) => name !== "constructor");
  }

  function matchingWords(text) {
    const lower = text.toLowerCase();
    return WORDS.filter((word) => lower.includes(word));
  }

  function sourcePreview(fn) {
    return Function.prototype.toString
      .call(fn)
      .replace(/\s+/g, " ")
      .slice(0, 220);
  }

  /**
   * Broad inventory retained for compatibility with the original diagnostic.
   * `inspectRenderPath` below is the useful follow-up: it searches method
   * bodies as well as names, then ranks methods which bridge colour state and
   * the renderer. This avoids treating every three.js material as a lead.
   */
  function inspect() {
    const candidates = [];

    for (const [id, record] of moduleTable()) {
      const mod = record?.module || record;
      if (!mod || typeof mod !== "object") continue;

      const moduleName = id.toLowerCase();
      const moduleHit = /render|radar|mini|map|unit|entity|color|colour|player|owner|team|palette|sprite/.test(moduleName);

      for (const [exportName, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;

        const methods = prototypeMethods(value);
        const text = `${id} ${exportName} ${methods.join(" ")}`.toLowerCase();
        if (moduleHit || matchingWords(text).length) {
          const hits = methods.filter((name) => matchingWords(name).length);
          candidates.push({ id, exportName, methods: hits });
        }
      }
    }

    console.group(TAG, `found ${candidates.length} candidate exports`);
    console.table(candidates);
    console.log(TAG, "Run __cdcPlayerColours.inspectRenderPath() for the ranked renderer leads.");
    console.groupEnd();
    return candidates;
  }

  /**
   * Find methods whose *implementation* mentions a colour concept and a render
   * concept. The client's useful methods are often minified, so their names
   * alone cannot identify the palette/remap boundary.
   */
  function inspectRenderPath() {
    const candidates = [];

    for (const [id, record] of moduleTable()) {
      if (id.includes("/three")) continue;
      const mod = record?.module || record;
      if (!mod || typeof mod !== "object") continue;

      for (const [exportName, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;
        for (const method of prototypeMethods(value)) {
          const fn = value.prototype[method];
          if (typeof fn !== "function") continue;

          const source = Function.prototype.toString.call(fn);
          const nameWords = matchingWords(`${id} ${exportName} ${method}`);
          const sourceWords = matchingWords(source);
          const colourWords = COLOUR_WORDS.filter((word) => nameWords.includes(word) || sourceWords.includes(word));
          const renderWords = RENDER_WORDS.filter((word) => nameWords.includes(word) || sourceWords.includes(word));
          if (!colourWords.length || !renderWords.length) continue;

          // Prefer the junctions with player/owner/palette information over a
          // generic material method. The score only orders the report; it does
          // not alter a game object or renderer.
          const score = colourWords.length * 3 + renderWords.length * 2 +
            (colourWords.some((word) => word === "player" || word === "owner") ? 4 : 0) +
            (colourWords.includes("palette") ? 3 : 0);
          candidates.push({
            score,
            id,
            exportName,
            method,
            colourWords: colourWords.join(", "),
            renderWords: renderWords.join(", "),
            preview: sourcePreview(fn),
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const report = candidates.slice(0, MAX_RENDER_CANDIDATES);
    console.group(TAG, `found ${candidates.length} colour/render method candidates; showing ${report.length}`);
    console.table(report);
    console.log(TAG, "Use __cdcPlayerColours.show(id, exportName, method) to print one complete method body.");
    console.groupEnd();
    return report;
  }

  /** Print a selected method without mutating its prototype or game state. */
  function show(id, exportName, method) {
    const mod = moduleFor(id);
    const value = mod?.[exportName];
    const fn = value?.prototype?.[method];
    if (typeof fn !== "function") {
      console.warn(TAG, "method not found", { id, exportName, method });
      return undefined;
    }
    const source = Function.prototype.toString.call(fn);
    console.group(TAG, `${id} :: ${exportName}.${method}`);
    console.log(source);
    console.groupEnd();
    return source;
  }

  window.__cdcPlayerColours = { inspect, inspectRenderPath, moduleTable, show };
  console.info(TAG, "loaded. Run __cdcPlayerColours.inspectRenderPath() in the game console.");
})();
