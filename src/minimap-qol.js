/**
 * Minimap QoL
 *
 * Darkens terrain/shroud so unit and radar colours are easier to read while
 * preserving tiles that the client has already marked with a useful radar
 * colour. This is a local rendering change only; it does not alter map state,
 * shroud state, or multiplayer simulation state.
 *
 * The hook mirrors the currently working client-side MinimapModel patch supplied
 * by El Presidente. It is deliberately isolated so the feature can be removed
 * or extended without touching the rest of the companion.
 */
(() => {
  "use strict";

  const TAG = "[cd-companion/minimap-qol]";
  const DEFAULTS = {
    unexplored: "#000000",
    darkened: "#080808",
    terrain: "#141414",
  };

  const state = {
    enabled: true,
    colors: { ...DEFAULTS },
    installed: false,
    rendererPatched: false,
  };

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

      const originalGetTileColor = Model.prototype.getTileColor;

      // Do not install twice if the script is re-evaluated.
      if (Model.prototype.__cdcMinimapQol) {
        state.installed = true;
        return true;
      }

      Model.prototype.getTileColor = function (tile) {
        const index = tile.rx + tile.ry * this.stride;
        const original = originalGetTileColor.call(this, tile);

        if (!state.enabled) return original;

        // Preserve the colour used by the game's radar/technology rendering.
        const hasRadarColour =
          this.tileWithTechnos?.[index] &&
          this.tileColors?.[index] !== this.tiles.getTileRadarColor(tile).getHex();

        if (hasRadarColour) return original;

        if (this.shroud?.getShroudType(tile) === ShroudType.Unexplored) {
          return state.colors.unexplored;
        }

        if (this.shroud?.isFlagged(tile, ShroudFlag.Darken)) {
          return state.colors.darkened;
        }

        return state.colors.terrain;
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
      console.info(TAG, "installed", state.colors);
      return true;
    } catch (error) {
      console.warn(TAG, "failed to install", error);
      return false;
    }
  };

  // Expose a tiny local API so we can experiment from DevTools before wiring
  // these settings into the companion options page.
  window.__cdcMinimapQol = {
    install,
    getState: () => ({
      enabled: state.enabled,
      colors: { ...state.colors },
      installed: state.installed,
      rendererPatched: state.rendererPatched,
    }),
    setEnabled(enabled) {
      state.enabled = !!enabled;
    },
    setColors(colors = {}) {
      state.colors = {
        ...state.colors,
        ...Object.fromEntries(
          Object.entries(colors).filter(([key, value]) => key in DEFAULTS && typeof value === "string")
        ),
      };
    },
    resetColors() {
      state.colors = { ...DEFAULTS };
    },
  };

  // SystemJS is available during normal client runtime; retry briefly if the
  // extension script happened to run before the client exposed it.
  const boot = () => {
    if (window.SystemJS?.import) {
      install();
      return;
    }
    setTimeout(boot, 250);
  };
  boot();
})();
