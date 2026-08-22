(() => {
  "use strict";

  const TAG = "[cd-companion/player-colours]";

  function moduleTable() {
    const modules = window.System?._loader?.modules;
    return modules ? Object.entries(modules) : [];
  }

  function inspect() {
    const candidates = [];

    for (const [id, record] of moduleTable()) {
      const mod = record?.module || record;
      if (!mod || typeof mod !== "object") continue;

      const moduleName = id.toLowerCase();
      const moduleHit = /render|radar|mini|map|unit|entity|color|colour|player|owner|team|palette|sprite/.test(moduleName);

      for (const [exportName, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;

        const proto = value.prototype;
        const methods = proto ? Object.getOwnPropertyNames(proto) : [];
        const text = `${id} ${exportName} ${methods.join(" ")}`.toLowerCase();
        if (moduleHit || /color|colour|palette|team|player|owner|render|sprite|material/.test(text)) {
          const hits = methods.filter((name) => /color|colour|palette|team|player|owner|render|sprite|material/i.test(name));
          candidates.push({ id, exportName, methods: hits });
        }
      }
    }

    console.group(TAG, `found ${candidates.length} candidate exports`);
    console.table(candidates);
    console.log(TAG, "Useful next step: inspect the candidate whose method is called when a unit is rendered, then hook that method to substitute a local display colour.");
    console.groupEnd();
    return candidates;
  }

  window.__cdcPlayerColours = { inspect, moduleTable };
  console.info(TAG, "loaded. Run __cdcPlayerColours.inspect() in the game console.");
})();
