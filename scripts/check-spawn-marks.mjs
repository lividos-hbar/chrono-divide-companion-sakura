/**
 * Run the spawn-marker detector out of src/companion.js — the file as shipped —
 * against bitmaps built here.
 *
 *   node scripts/check-spawn-marks.mjs
 *
 * The detector decides whether a map's own preview already marks a start
 * position, and everything downstream hangs off that one boolean: a marker it
 * misses means a dot drawn on top of one that was already there, a marker it
 * imagines means a start position left unmarked with no way to ask for it. The
 * threshold is a guess about somebody else's map editor, so it is worth being
 * able to change it and see what moves.
 *
 * `markedNatively` reads a decoded preview as a flat RGB array and touches no
 * DOM, so it runs here — but it lives inside a file that expects a browser, so
 * the context below is the smallest one companion.js will load in. Loading the
 * real file rather than a copy of the function is the point: a copy would go on
 * passing while the shipped one drifted.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "companion.js"), "utf8");

// Enough of a 2D context for the whole preview path: the decode fills an
// ImageData, the upscale draws it, the dots are arcs. Every arc is recorded,
// because "did it draw dots, and how many" is what the last checks ask.
const arcs = [];

const context2d = () => ({
  scale() {},
  drawImage() {},
  beginPath() {},
  arc(x, y) {
    arcs.push({ x, y });
  },
  fill() {},
  stroke() {},
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  putImageData() {},
});

const element = () => ({
  width: 0,
  height: 0,
  getContext: context2d,
  toDataURL: () => "data:image/png;base64,stub",
  style: { setProperty() {} },
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  append() {},
  appendChild() {},
  insertBefore() {},
  remove() {},
  setAttribute() {},
  removeAttribute() {},
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
});

const document = {
  createElement: element,
  head: element(),
  body: element(),
  documentElement: element(),
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
};

const window = {
  document,
  addEventListener() {},
  removeEventListener() {},
  postMessage() {},
  requestAnimationFrame() {},
  navigator: { userAgent: "node" },
  location: { href: "" },
};
window.window = window;

vm.runInContext(
  source,
  vm.createContext({
    ...window,
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Image: function Image() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  })
);

const { marksItsOwnSpawns, vividNear, startPositions, renderPreview, NATIVE_MARK, state } = window.__cdc;

const W = 64;
const H = 64;

/** A patch of the sort of thing a preview is made of, with a fixed wobble. */
function terrain(base = [74, 96, 58], wobble = 12) {
  const data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const n = (((x * 7 + y * 13) % (wobble * 2)) - wobble) | 0;
      data[i] = Math.max(0, Math.min(255, base[0] + n));
      data[i + 1] = Math.max(0, Math.min(255, base[1] + n));
      data[i + 2] = Math.max(0, Math.min(255, base[2] + n));
    }
  }
  return { data, width: W, height: H };
}

function blob(bmp, cx, cy, r, [red, green, blue]) {
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue;
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const i = (py * W + px) * 3;
      bmp.data[i] = red;
      bmp.data[i + 1] = green;
      bmp.data[i + 2] = blue;
    }
  }
  return bmp;
}

const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " (" + detail + ")" : ""}`);

// Two start positions, in the decoded bitmap's own pixels.
const A = { x: 12, y: 12 };
const B = { x: 50, y: 48 };
const at = (bmp) => marksItsOwnSpawns(bmp, [A, B], 1);

check("bare terrain marks nothing", !at(terrain()));

check(
  "the same red dot at both spawns is a marker scheme",
  at(blob(blob(terrain(), A.x, A.y, 2, [255, 0, 0]), B.x, B.y, 2, [255, 0, 0]))
);

check(
  "so is the same yellow one — the colour is not the point",
  at(blob(blob(terrain(), A.x, A.y, 2, [255, 220, 0]), B.x, B.y, 2, [255, 220, 0]))
);

// The case this rule exists for. A desert preview is bright and full of
// red-brown rock; "is there something red near this spawn" answered yes on
// Arabian Oasis, which marks nothing, and it got no dots of ours at all.
const desert = terrain([150, 118, 86], 40);
check("desert terrain marks nothing", !at(desert), JSON.stringify([...vividNear(desert, A.x, A.y)]));

const rocky = blob(terrain([150, 118, 86], 40), A.x + 3, A.y - 2, 2, [178, 96, 62]);
check("nor does a patch of red-brown rock by one spawn", !at(rocky));

check(
  "a marker at one spawn only is not a scheme",
  !at(blob(terrain(), A.x, A.y, 2, [255, 0, 0]))
);

check(
  "two different colours are not one either",
  !at(blob(blob(terrain(), A.x, A.y, 2, [255, 0, 0]), B.x, B.y, 2, [0, 200, 255]))
);

check(
  "a marker several pixels off the start position still counts",
  at(blob(blob(terrain(), A.x + 6, A.y, 2, [255, 0, 0]), B.x - 6, B.y, 2, [255, 0, 0]))
);

check(
  "one stray vivid pixel at each spawn is not a marker",
  !(() => {
    const bmp = terrain();
    for (const p of [A, B]) {
      const i = (p.y * W + p.x) * 3;
      bmp.data[i] = 255;
      bmp.data[i + 1] = 0;
      bmp.data[i + 2] = 0;
    }
    return at(bmp);
  })(),
  `it takes ${NATIVE_MARK.pixels}`
);

check(
  "a marker in the corner does not read past the bitmap",
  marksItsOwnSpawns(blob(blob(terrain(), 1, 1, 2, [255, 0, 0]), 62, 62, 2, [255, 0, 0]), [{ x: 0, y: 0 }, { x: 63, y: 63 }], 1)
);

// --- where it looks ---------------------------------------------------------
//
// The positions come out of the client's own `drawStartLocations`, recorded off
// the `dxyToCanvas` it calls for each one. The client then **mutates the object
// it was handed back** — `point.x /= scale`, because the context it draws
// through already carries the upscale — so recording the reference instead of a
// copy divided every position by 2 or 4 a moment later. The dots landed near the
// top-left corner, and the detector sampled bare terrain there and reported
// every start position as unmarked. One aliasing bug, both symptoms; this is it
// pinned down.
function clientThatMutatesWhatItReturns() {
  function Renderer() {}
  Renderer.prototype.dxyToCanvas = (x, y) => ({ x: x * 10, y: y * 20 });
  Renderer.prototype.drawStartLocations = function (canvas, mapFile, target, scale) {
    for (const loc of mapFile.startingLocations) {
      const point = this.dxyToCanvas(loc.x, loc.y, canvas, mapFile.localSize);
      point.x /= scale; // the trap, exactly as the client springs it
      point.y /= scale;
    }
  };
  return Renderer;
}

state.modules.MapPreviewRenderer = clientThatMutatesWhatItReturns();
state.modules.IsoCoords = null;

const positions = startPositions(
  {
    startingLocations: [
      { x: 3, y: 5 },
      { x: 7, y: 11 },
    ],
    localSize: { x: 0, y: 0, width: 100, height: 100 },
    fullSize: { width: 100, height: 100 },
  },
  800,
  600,
  4
);

check("a position is recorded for every start", positions.length === 2, `${positions.length} of 2`);
check(
  "in canvas pixels, not divided by the upscale",
  JSON.stringify(positions) === JSON.stringify([{ x: 30, y: 100 }, { x: 70, y: 220 }]),
  JSON.stringify(positions)
);

// --- one marker settles it for the whole map --------------------------------
//
// Per-position was the first rule and it is worse: the marker a map draws and
// the start cell the client computes only roughly agree, so on a marked map a
// position or two came out "missed" and got a second dot beside the first.

function previewOf(bmp, starts) {
  arcs.length = 0;
  state.modules.MapPreviewRenderer = clientThatMutatesWhatItReturns();
  state.modules.IsoCoords = null;
  return renderPreview({
    decodePreviewImage: () => bmp,
    startingLocations: starts,
    localSize: { x: 0, y: 0, width: W, height: H },
    fullSize: { width: W, height: H },
  });
}

// The fake `dxyToCanvas` is (x·10, y·20) and a 64px preview is upscaled 4×, so
// these two starts land on raw pixels (2.5, 5) and (50, 60) — far enough apart
// that a marker on the first says nothing about the second. That separation is
// the whole point: under the per-position rule this map came back with one dot.
const STARTS = [
  { x: 1, y: 1 },
  { x: 20, y: 12 },
];

const both = previewOf(
  blob(blob(terrain(), 3, 5, 2, [255, 0, 0]), 50, 60, 2, [255, 0, 0]),
  STARTS
);
check("a map that marks its spawns gets no dots at all", arcs.length === 0, `${arcs.length} drawn`);
check("and no second picture to toggle", both.fixed === null && both.missed === 0);

const bare = previewOf(terrain(), STARTS);
check("a map that marks none gets a dot for every spawn", arcs.length === 2, `${arcs.length} drawn`);
check("and a second picture", typeof bare.fixed === "string" && bare.missed === 2);

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
