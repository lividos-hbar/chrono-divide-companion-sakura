/**
 * The extension's icon, drawn from one description instead of four files.
 *
 *   node scripts/gen-icon.mjs            # icons/icon-{16,32,48,128}.png + store/logo-300.png
 *   node scripts/gen-icon.mjs --check    # regenerate to a temp dir and diff — CI-shaped
 *
 * An icon is a shape, not a picture, and four hand-drawn PNGs drift the moment
 * one of them is touched. The shape lives here as an SVG and every size is
 * rendered from it at its own dimensions — rendering once large and downscaling
 * is what turns a 2px stroke into grey fog at 16px.
 *
 * **The renderer is a browser**, for the reason `site/encode.mjs` gives: this
 * repo has no `package.json`, so there is no `sharp` and nowhere to hang one,
 * and the globally installed Playwright rasterises SVG as well as a library
 * would.
 *
 * The shape: the isometric diamond a Red Alert 2 map is, in the options page's
 * accent yellow, on the options page's own dark tile — a toolbar can be light
 * or dark and `#ffe000` disappears into a light one, so the icon carries its
 * own background rather than trusting the toolbar's. The punched dot is a spawn
 * mark, which is the thing the extension puts on a map.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/** Playwright is global, not a dependency here; on Windows an absolute path is a specifier only as a URL. */
const PLAYWRIGHT = "file:///C:/Program Files/nodejs/node_modules/playwright/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// The options page's palette (src/options.css), so the icon and the page it
// opens are visibly the same product.
const TILE = "#12120f";
const EDGE = "#34342c";
const ACCENT = "#ffe000";

/** Package icons go in the package; the 300 is an Edge listing asset and does not ship. */
const TARGETS = [
  { size: 16, out: "icons/icon-16.png" },
  { size: 32, out: "icons/icon-32.png" },
  { size: 48, out: "icons/icon-48.png" },
  { size: 128, out: "icons/icon-128.png" },
  { size: 300, out: "store/logo-300.png" },
];

/**
 * Every measurement is a fraction of the icon's own size, so the shape is the
 * same at 16 and at 300 and no size needs its own tuning.
 *
 * The diamond is 2:1 because that is the projection the game draws in. At 16px
 * it is 12x6 device pixels, which is why nothing else is competing for the
 * space: an outline, a legend or a second colour all read as noise there.
 */
function svg(size) {
  const s = size;
  const radius = s * 0.22;
  // The border is hairline by design — at 16px anything thicker eats the tile.
  const border = Math.max(1, Math.round(s * 0.02));
  const cx = s / 2;
  const cy = s / 2;
  const halfW = s * 0.39;
  const halfH = s * 0.195;
  // Up and left of centre, where a north-west spawn sits. It has to stay well
  // inboard of the western tip: the diamond's height falls off with distance
  // from the centre, and a mark that reaches the edge reads as a bite taken out
  // of the shape rather than as a mark on it. At 0.30 of the half-width the
  // diamond is still 0.70 of its half-height tall, which clears the dot twice
  // over.
  const markX = cx - halfW * 0.30;
  const markY = cy - halfH * 0.25;
  const markR = Math.max(1.1, s * 0.068);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect x="${border / 2}" y="${border / 2}" width="${s - border}" height="${s - border}"
        rx="${radius}" fill="${TILE}" stroke="${EDGE}" stroke-width="${border}"/>
  <path d="M ${cx} ${cy - halfH} L ${cx + halfW} ${cy} L ${cx} ${cy + halfH} L ${cx - halfW} ${cy} Z"
        fill="${ACCENT}"/>
  <circle cx="${markX}" cy="${markY}" r="${markR}" fill="${TILE}"/>
</svg>`;
}

const check = process.argv.includes("--check");
const outRoot = check ? join(tmpdir(), "cd-icon-check") : root;

const { chromium } = await import(PLAYWRIGHT);
const browser = await chromium.launch();
// One page for the whole run: a launch costs about a second and there are five
// images, so a browser per image would be the entire run.
const page = await browser.newPage();

const written = [];
for (const { size, out } of TARGETS) {
  await page.setViewportSize({ width: size, height: size });
  // `deviceScaleFactor` is left at 1 deliberately — the output must be exactly
  // `size` device pixels, and a HiDPI page would silently render it at 2x.
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg(size)}`,
  );
  const png = await page.locator("svg").screenshot({ omitBackground: true });
  const path = join(outRoot, out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  written.push({ out, size, bytes: png.length, path });
}
await browser.close();

if (check) {
  const drift = written.filter(({ out, path }) => {
    const live = join(root, out);
    return !existsSync(live) || !readFileSync(live).equals(readFileSync(path));
  });
  for (const { out } of drift) console.error(`drift: ${out} does not match what this script draws`);
  console.log(drift.length ? `icons: ${drift.length} of ${written.length} STALE` : `icons: ${written.length} match`);
  process.exit(drift.length ? 1 : 0);
}

for (const { out, size, bytes } of written) console.log(`${out.padEnd(22)} ${size}x${size}  ${bytes} B`);
