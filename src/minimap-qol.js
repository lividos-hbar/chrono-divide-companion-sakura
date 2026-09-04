/** Persistent minimap colour treatment. Runs in the game world. */
(() => {
  "use strict";

  const TAG = "[cd-companion/minimap]";
  const DEFAULTS = {
    on: true, litLo: 0.10, litHi: 0.34, shLo: 0.03, shHi: 0.09,
    sat: 0.25, oreLift: 0.06, unit: 1, halo: 0,
  };
  const RANGE = {
    litLo: [0, 0.6], litHi: [0, 0.8], shLo: [0, 0.4], shHi: [0, 0.5],
    sat: [0, 1], oreLift: [0, 0.3], unit: [0.5, 2], halo: [0, 1],
  };
  const ORE = 0xadaa84;
  const state = { ...DEFAULTS, installed: false, repaint: false };

  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  const byte = (value) => clamp(Math.round(value), 0, 255);
  const hex = (value) => value.toString(16).padStart(6, "0");
  const luminance = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  function readPrefs(prefs) {
    const saved = prefs && prefs.minimapRadar;
    if (!saved || typeof saved !== "object") return;
    for (const [key, [lo, hi]] of Object.entries(RANGE)) {
      if (Number.isFinite(saved[key])) state[key] = clamp(saved[key], lo, hi);
    }
    if (typeof saved.on === "boolean") state.on = saved.on;
    if (state.litLo > state.litHi) state.litHi = state.litLo;
    if (state.shLo > state.shHi) state.shHi = state.shLo;
    state.repaint = true;
  }

  function persist() {
    window.postMessage({ source: "cdc-page", type: "prefs-set", prefs: { minimapRadar: snapshot() } }, "*");
  }

  function snapshot() {
    const out = { on: state.on };
    for (const key of Object.keys(RANGE)) out[key] = state[key];
    return out;
  }

  function spread(model) {
    let min = 1;
    let max = 0;
    for (let i = 0; i < model.tileColors.length; i++) {
      if (model.tileWithTechnos[i]) continue;
      const colour = model.tileColors[i];
      if (colour === undefined) continue;
      const light = luminance((colour >> 16) & 255, (colour >> 8) & 255, colour & 255);
      min = Math.min(min, light);
      max = Math.max(max, light);
    }
    return { lo: min, span: Math.max(0.001, max - min) };
  }

  function band(colour, lo, hi, saturation, range) {
    const r = (colour >> 16) & 255;
    const g = (colour >> 8) & 255;
    const b = colour & 255;
    const light = luminance(r, g, b);
    const target = lo + clamp((light - range.lo) / range.span, 0, 1) * (hi - lo);
    const gain = light ? target / light : 0;
    const grey = target * 255;
    return (byte(grey + saturation * (r * gain - grey)) << 16) |
      (byte(grey + saturation * (g * gain - grey)) << 8) |
      byte(grey + saturation * (b * gain - grey));
  }

  function brighten(colour, gain) {
    return (byte(((colour >> 16) & 255) * gain) << 16) |
      (byte(((colour >> 8) & 255) * gain) << 8) |
      byte((colour & 255) * gain);
  }

  function mix(a, b, amount) {
    return (byte(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * amount) << 16) |
      (byte(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * amount) << 8) |
      byte((a & 255) + ((b & 255) - (a & 255)) * amount);
  }

  function neighbourOwner(model, tile) {
    const height = model.tileColors.length / model.stride;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = tile.rx + dx;
      const y = tile.ry + dy;
      if (x < 0 || y < 0 || x >= model.stride || y >= height) continue;
      const index = x + y * model.stride;
      if (model.tileWithTechnos[index]) return model.tileColors[index];
    }
    return undefined;
  }

  async function install() {
    if (state.installed) return true;
    try {
      const sys = window.System || window.SystemJS;
      const [mm, mr, ms] = await Promise.all([
        sys.import("engine/renderable/entity/map/MinimapModel"),
        sys.import("engine/renderable/entity/map/MinimapRenderer"),
        sys.import("game/map/MapShroud"),
      ]);
      const Model = mm.MinimapModel;
      const Renderer = mr.MinimapRenderer;
      const { ShroudType, ShroudFlag } = ms;
      if (!Model?.prototype?.getTileColor || !Renderer?.prototype?.renderIncremental) return false;
      if (Model.prototype.__cdcRadarCustomizer) return (state.installed = true);

      const originalColour = Model.prototype.getTileColor;
      Model.prototype.getTileColor = function (tile) {
        if (!state.on) return originalColour.call(this, tile);
        if (!this.__cdcRadarSpread) this.__cdcRadarSpread = spread(this);
        const index = tile.rx + tile.ry * this.stride;
        if (this.shroud?.getShroudType(tile) === ShroudType.Unexplored && !this.aboveShroudTiles[index]) return "#000000";
        const colour = this.tileColors[index];
        if (this.tileWithTechnos[index]) return "#" + hex(brighten(colour, state.unit));
        const dark = this.shroud?.isFlagged(tile, ShroudFlag.Darken);
        const lo = dark ? state.shLo : state.litLo;
        const hi = dark ? state.shHi : state.litHi;
        let result = colour === ORE
          ? band(colour, lo + state.oreLift, hi + state.oreLift, 1, this.__cdcRadarSpread)
          : band(colour, lo, hi, state.sat, this.__cdcRadarSpread);
        if (state.halo) {
          const owner = neighbourOwner(this, tile);
          if (owner !== undefined) result = mix(result, brighten(owner, state.unit), state.halo);
        }
        return "#" + hex(result);
      };
      Object.defineProperty(Model.prototype, "__cdcRadarCustomizer", { value: true });

      const originalIncremental = Renderer.prototype.renderIncremental;
      Renderer.prototype.renderIncremental = function (tiles) {
        if (state.repaint) {
          state.repaint = false;
          this.renderFull();
          return;
        }
        return originalIncremental.call(this, tiles);
      };
      state.installed = true;
      console.info(TAG, "installed", snapshot());
      return true;
    } catch (error) {
      console.warn(TAG, "could not install", error);
      return false;
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "cdc-bridge" || data.type !== "config") return;
    readPrefs(data.prefs);
  });

  window.__cdcMinimapQol = {
    getState: () => snapshot(),
    set(patch) {
      readPrefs({ minimapRadar: { ...snapshot(), ...patch } });
      persist();
    },
    reset() {
      Object.assign(state, DEFAULTS, { repaint: true });
      persist();
    },
  };

  const boot = () => (window.System || window.SystemJS)?.import ? install() : setTimeout(boot, 250);
  boot();
})();
