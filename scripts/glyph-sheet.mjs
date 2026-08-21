/**
 * Build a page that shows every tech-building pictogram, so a glyph can be
 * looked at instead of reasoned about.
 *
 *   node scripts/glyph-sheet.mjs                 -> scripts/glyph-sheet.html
 *   node scripts/glyph-sheet.mjs ../other-tree   -> the same, from another tree
 *
 * Open the page and add `?only=parachute` to inspect one glyph at 340px, where
 * a corner or a tangent that 96px hides is visible.
 *
 * The glyph bodies are spliced out of `src/glyphs.js` verbatim and evaluated in
 * the page, so what you look at is what the preview draws — a copy would go on
 * looking right while the shipped one drifted. What is repeated rather than
 * spliced is the frame around them: the halo, the 24×24 box, the player colours
 * and the 18px mark size, taken from `drawGlyph` and `MARK_STYLES.compact`. That
 * is the one thing here that can fall out of step — a glyph that reads on this
 * page reads on a thumbnail only while these still match.
 *
 * The output is generated, so it is gitignored — regenerate rather than commit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(here, "..");
const source = readFileSync(join(root, "src", "glyphs.js"), "utf8");

/** A `const NAME = { … };` declaration, whether it closes on its own line or not. */
function block(name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`${name} not found in src/glyphs.js`);
  const firstLine = source.slice(start, source.indexOf("\n", start));
  if (firstLine.trimEnd().endsWith("};")) return firstLine;
  const end = source.indexOf("\n  };", start);
  if (end < 0) throw new Error(`${name} has no closing line`);
  return source.slice(start, end + "\n  };".length);
}

const glyphs = block("ICON_GLYPHS");
const icons = block("BUILDING_ICONS");
const scales = block("ICON_SCALE");

// The JSDoc above each glyph is the description already written for it — its
// first sentence, whether it is a one-liner or the head of a block.
const meanings = {};
for (const m of glyphs.matchAll(/\/\*\*([\s\S]*?)\*\/\s*\n\s*(\w+)\(c\)/g)) {
  meanings[m[2]] = m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").trim())
    .find(Boolean);
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>hq-preview glyph sheet</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; padding: 28px; background: #14161a; color: #e6e8ec;
         font: 14px/1.5 "Segoe UI", system-ui, sans-serif }
  h1 { font-size: 18px; margin: 0 0 4px }
  p.sub { margin: 0 0 24px; color: #9aa0aa }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)) }
  .card { background: #1c1f25; border: 1px solid #2a2e36; border-radius: 10px; padding: 14px }
  .top { display: flex; align-items: center; gap: 14px }
  .name { font-family: Consolas, monospace; font-size: 15px; color: #fff }
  .what { color: #9aa0aa; font-size: 13px }
  .keys { font-family: Consolas, monospace; font-size: 12px; color: #ffd60a; margin-top: 2px }
  .real { margin-top: 12px; padding-top: 10px; border-top: 1px solid #2a2e36;
          display: flex; align-items: center; gap: 10px }
  .real span { color: #6f7580; font-size: 12px; margin-right: 4px }
  canvas { image-rendering: pixelated }
  /* Roughly the thumbnail's ground, so the halo is judged against art, not flat black. */
  .real canvas { background: #3f5136; border-radius: 3px }
</style>
<h1>Tech-building pictograms — <code>ICON_GLYPHS</code></h1>
<p class="sub">Spliced from <code>src/glyphs.js</code>. Big glyph for inspection;
the strip below each is the real 18px thumbnail mark — white while unowned, then the six player colours.
Add <code>?only=&lt;glyph&gt;</code> to the URL for one glyph at 340px.</p>
<div class="grid" id="grid"></div>
<script>
const ICON_NEUTRAL = "#ffffff";
const PLAYER_COLORS = ["#3d7bff", "#ff3b30", "#ff9f0a", "#ff5cf0", "#00e0ff", "#ffffff"];
const MEANINGS = ${JSON.stringify(meanings, null, 2)};
(() => {
  ${glyphs}
  ${icons}
  ${scales}

  // The presentation drawStructureIcons() gives a glyph: halo, no backing disc,
  // written in a 24x24 box and scaled onto the mark.
  function paint(canvas, box, color) {
    const dpr = devicePixelRatio || 1;
    canvas.width = box * dpr; canvas.height = box * dpr;
    canvas.style.width = canvas.style.height = box + "px";
    const c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    c.shadowColor = "rgba(0,0,0,0.9)";
    c.shadowBlur = Math.max(1.5, box * 0.16);
    c.scale(box / 24, box / 24);
    c.fillStyle = color; c.strokeStyle = color;
    canvas.glyph(c);
  }

  const byGlyph = {};
  for (const [name, glyph] of Object.entries(BUILDING_ICONS)) (byGlyph[glyph] ||= []).push(name);

  const only = new URLSearchParams(location.search).get("only");
  const BIG = only ? 340 : 96;

  const grid = document.getElementById("grid");
  for (const [glyph, draw] of Object.entries(ICON_GLYPHS)) {
    if (only && glyph !== only) continue;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = \`<div class="top"><canvas class="big"></canvas>
      <div><div class="name">\${glyph}</div>
        <div class="what">\${MEANINGS[glyph] || ""}</div>
        <div class="keys">\${(byGlyph[glyph] || ["fallback"]).join(" ")}</div></div></div>
      <div class="real"><span>18px</span></div>\`;
    // ICON_SCALE is part of the mark, not of the drawing: a glyph that gets a
    // bigger box on the map has to get a bigger one here, or the sheet stops
    // showing what ships.
    const size = (box) => box * (ICON_SCALE[glyph] || 1);
    const big = card.querySelector("canvas.big");
    big.glyph = draw;
    paint(big, size(BIG), ICON_NEUTRAL);
    const strip = card.querySelector(".real");
    for (const color of [ICON_NEUTRAL, ...PLAYER_COLORS]) {
      const c = document.createElement("canvas");
      c.glyph = draw;
      strip.appendChild(c);
      paint(c, size(18), color);
    }
    grid.appendChild(card);
  }
})();
</script>
`;

const out = join(here, "glyph-sheet.html");
writeFileSync(out, html, "utf8");
console.log(`${Object.keys(meanings).length} glyphs -> ${out}`);
