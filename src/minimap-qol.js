(() => {
  "use strict";

  const TAG = "[cd-companion/minimap-qol]";
  const DEFAULTS = {
    enabled: true,
    preserveRadarColors: true,
    unexplored: "#000000",
    darkened: "#080808",
    terrain: "#141414",
  };

  const state = { ...DEFAULTS, installed: false, rendererPatched: false };

  function applyPrefs(prefs = {}) {
    if (typeof prefs.minimapEnabled === "boolean") state.enabled = prefs.minimapEnabled;
    if (typeof prefs.minimapPreserveRadarColors === "boolean") {
      state.preserveRadarColors = prefs.minimapPreserveRadarColors;
    }
    if (typeof prefs.minimapUnexplored === "string") state.unexplored = prefs.minimapUnexplored;
    if (typeof prefs.minimapDarkened === "string") state.darkened = prefs.minimapDarkened;
    if (typeof prefs.minimapTerrain === "string") state.terrain = prefs.minimapTerrain;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "cdc-bridge" || data.type !== "config") return;
    applyPrefs(data.prefs);
    if (window.__cdcMinimapQol?.refresh) window.__cdcMinimapQol.refresh();
  });

  const install = async () => {
    if (state.installed) return true;

    try {
      const [modelModule, rendererModule, shroudModule] = await Promise.all([
        SystemJS.import("engine/renderable/entity/map/MinimapModel"),
        SystemJS.import("engine/renderable/entity/map/MinimapRenderer"),
        SystemJS.import("game/map/MapShroud"),
      ]);

      const Model = modelModule.MinimapModel;
      const Renderer = rendererModule.MinimapRenderer;
      const ShroudType = shroudModule.ShroudType;
      const ShroudFlag = shroudModule.ShroudFlag;

      if (!Model?.prototype?.getTileColor) {
        console.warn(TAG, "MinimapModel.getTileColor was not found");
        return false;
      }

      if (Model.prototype.__cdcMinimapQol) {
        state.installed = true;
        return true;
      }

      const originalGetTileColor = Model.prototype.getTileColor;

      Model.prototype.getTileColor = function (tile) {
        const index = tile.rx + tile.ry * this.stride;
        const original = originalGetTileColor.call(this, tile);
        if (!state.enabled) return original;

        // This is the likely source of the observed "twinkle": a moving unit
        // changes tileWithTechnos/tileColors, causing a tile to alternate between
        // the original terrain colour and our dark colour. The setting lets us
        // deliberately remove that dependency and test whether the renderer's
        // separate unit layer is sufficient to keep unit colours visible.
        if (state.preserveRadarColors) {
          const hasRadarColour =
            this.tileWithTechnos?.[index] &&
            this.tileColors?.[index] !== this.tiles.getTileRadarColor(tile).getHex();
          if (hasRadarColour) return original;
        }

        if (this.shroud?.getShroudType(tile) === ShroudType.Unexplored) return state.unexplored;
        if (this.shroud?.isFlagged(tile, ShroudFlag.Darken)) return state.darkened;
        return state.terrain;
      };

      Object.defineProperty(Model.prototype, "__cdcMinimapQol", {
        value: true,
        configurable: false,
        enumerable: false,
      });

      if (Renderer?.prototype?.renderIncremental && Renderer.prototype.renderFull) {
        const originalIncremental = Renderer.prototype.renderIncremental;
        let firstRender = true;
        Renderer.prototype.renderIncremental = function (tile) {
          if (firstRender) {
            firstRender = false;
            return this.renderFull();
          }
          return originalIncremental.call(this, tile);
        };
        state.rendererPatched = true;
      }

      state.installed = true;
      console.info(TAG, "installed", { ...state });
      return true;
    } catch (error) {
      console.warn(TAG, "failed to install", error);
      return false;
    }
  };

  window.__cdcMinimapQol = {
    install,
    refresh() {
      // getTileColor is evaluated by the normal incremental renderer. A full
      // redraw is deliberately not forced on every settings change because
      // doing so can itself create visible flicker while a unit is moving.
      console.info(TAG, "settings updated", { ...state });
    },
    getState: () => ({ ...state }),
    setEnabled(enabled) { state.enabled = !!enabled; },
    setPreserveRadarColors(enabled) { state.preserveRadarColors = !!enabled; },
    setColors(colors = {}) {
      for (const key of ["unexplored", "darkened", "terrain"]) {
        if (typeof colors[key] === "string") state[key] = colors[key];
      }
    },
    reset() {
      Object.assign(state, DEFAULTS);
    },
  };

  const boot = () => {
    if (window.SystemJS?.import) {
      install();
      return;
    }
    setTimeout(boot, 250);
  };
  boot();
})();
