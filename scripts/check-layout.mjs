/**
 * The settings columns cannot be squeezed narrower than their own contents.
 *
 *   node scripts/check-layout.mjs
 *
 * The defect this exists for: the settings tab is a flex row of `.setgroup`
 * columns, and it was written as `flex: 1 1 0; min-width: 0` — every column
 * takes an equal share of whatever there is. That is fine for two columns and
 * fine for three; at four, each share fell to about 284px while a `.keyrow` is
 * 314px that cannot shrink at all, so the Hotkeys column's buttons hung out of
 * it. **Nothing failed.** The column count is in the markup, the widths are in
 * the stylesheet, and the arithmetic between them was in nobody's head — which
 * is the shape of a defect that recurs, because the next column will be added
 * by someone who has never read this file.
 *
 * So the two halves are pinned together here:
 *
 *   - **the floor covers the contents.** Every chain of fixed widths that can
 *     appear inside a settings column is added up and asserted to fit the
 *     floor `.setgroup` declares. Add a control with a hard minimum wider than
 *     the column can ever be and this goes red, naming it, instead of the page
 *     going wrong on a window nobody happened to test at;
 *   - **the row wraps rather than squeezes.** With `flex-wrap` on and a floor
 *     that is a real minimum, a column that does not fit moves to the next line
 *     and no column is ever below its floor — so the count in the markup stops
 *     being a thing the stylesheet has to know.
 *
 * It reads the stylesheet as text. A checker that resolved the cascade would
 * need a browser, and the two facts this is about — a declared minimum and a
 * declared floor — are literals in one file either way.
 *
 * What is NOT checked here is how any of it *looks*. This says a column is
 * never narrower than the things inside it; whether the result is handsome is
 * a human's call, and it always was.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The stylesheet with its prose taken out.
 *
 * Not tidiness: this file's own comments quote the rules they are about — the
 * `.setgroup` block explains itself by naming the `border-left` divider it
 * replaced, braces and all — so a reader that kept the comments would find a
 * rule that does not exist and stop reading a block at a brace inside a
 * sentence.
 */
const css = readFileSync(join(here, "..", "src", "options.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);
const html = readFileSync(join(here, "..", "src", "options.html"), "utf8");

const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

/**
 * The body of one rule, by its exact selector.
 *
 * Exact, not "contains": `.setgroup` and `.setgroup-wide` are different rules
 * about different things, and a substring match would read the second as the
 * first depending on which came earlier in the file.
 */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = new RegExp(`(^|[},/*\\s])${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return at ? at[2] : null;
}

/** One declaration's value, or null. */
function decl(selector, property) {
  const body = rule(selector);
  if (body === null) return null;
  const at = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "m").exec(body);
  return at ? at[1].trim() : null;
}

/** The px number in a value, or null — `min(340px, 100%)` counts as 340. */
function px(value) {
  if (value === null) return null;
  const at = /(-?\d+(?:\.\d+)?)px/.exec(value);
  return at ? Number(at[1]) : null;
}

/**
 * Every declaration this check depends on, read once.
 *
 * A null in here is not one thing, and the difference decides who is at fault:
 * `.settings` with no `flex-wrap` and `.setgroup` with no floor are the defect
 * itself, and fail below by name. A part of a fixed-width chain that has gone
 * is this file being out of date about a control that changed shape, and fails
 * as the chain it belongs to. Only the page cap stops the run — it is the one
 * number here that is about the page rather than about this feature, and
 * without it none of the arithmetic means anything.
 */
const read = {
  "the column floor": decl(".setgroup", "flex"),
  "the column min-width": decl(".setgroup", "min-width"),
  "the row's wrapping": decl(".settings", "flex-wrap"),
  "the row's gap": decl(".settings", "gap"),
  "the page cap": decl(".wrap", "max-width") || decl("body", "max-width"),
  "the key row's gap": decl(".keyrow", "gap"),
  "the key label's width": decl(".keylabel", "min-width"),
  "the key button's width": decl(".keybtn", "min-width"),
  "the build picker's width": decl(".buildadd select", "min-width"),
  "the build picker's gap": decl(".buildadd", "gap"),
};
if (read["the page cap"] === null) {
  console.error("could not read the page's own max-width out of src/options.css — this check is out of date");
  process.exit(1);
}

// --- the floor ----------------------------------------------------------------

const floor = px(read["the column floor"]);
const minWidth = px(read["the column min-width"]);

/**
 * Whether there is a floor at all, and every check below that needs a number
 * asks this first.
 *
 * `flex: 1 1 0` — the declaration this whole file exists because of — has no px
 * in it, so `floor` is null and the arithmetic downstream would run against
 * zero. Comparing anything to zero passes, which would have made the guard
 * report the defect as four failures and five passes about a column that has no
 * width. A missing floor fails everything that depended on it, by name.
 */
const haveFloor = floor !== null && floor > 0;
const noFloor = `no px floor declared — flex: ${read["the column floor"] ?? "(no flex at all)"}`;

check(
  "a settings column declares a floor in px, not a share of what is left",
  haveFloor && !/\b1\s+1\s+0\b/.test(read["the column floor"]),
  `flex: ${read["the column floor"] ?? "(no flex at all)"}`
);

check(
  "and min-width agrees with it, so the floor is a floor and not a preference",
  haveFloor && minWidth === floor,
  haveFloor ? `flex-basis ${floor}px vs min-width ${minWidth}px` : noFloor
);

// A window narrower than one column still has to fit the page: `min()` is what
// lets the floor give way there and nowhere else.
check(
  "with a way out for a window narrower than one column",
  read["the column min-width"] !== null && /min\(/.test(read["the column min-width"]),
  read["the column min-width"] ?? "no min-width declared"
);

// --- what has to fit inside it ------------------------------------------------

/**
 * The chains of fixed width that live inside a settings column.
 *
 * Each is a row whose parts cannot shrink, so its total is a hard minimum for
 * the column around it. Anything added to a settings column that has a
 * `min-width` or a fixed `width` belongs in this list — that is the whole
 * bargain, and it is cheaper than finding out from a screenshot.
 */
const chains = [
  {
    what: ".keyrow (the hotkey bindings)",
    parts: [
      ["the key label's width", 1],
      ["the key row's gap", 1],
      ["the key button's width", 1],
    ],
  },
  {
    what: ".buildadd (the build-hotkey picker)",
    parts: [
      ["the build picker's width", 1],
      ["the build picker's gap", 1],
    ],
  },
];

// The recolour rows are the newest inhabitant of a settings column and the
// reason this check exists, so their fixed parts are added up too even though
// the picker beside them can shrink.
const recolour = [
  decl(".recolour", "padding-left"),
  decl(".recolour-label", "flex"),
  decl(".recolour-ordinal", "flex"),
  decl(".recolour-swatch", "width"),
  decl(".recolour-row", "gap"),
];
if (recolour.every((value) => value !== null)) {
  const gap = px(decl(".recolour-row", "gap")) || 0;
  chains.push({
    what: ".recolour-row (the player-colour rows)",
    fixed:
      (px(decl(".recolour", "padding-left")) || 0) +
      (px(decl(".recolour-label", "flex")) || 0) +
      (px(decl(".recolour-ordinal", "flex")) || 0) +
      (px(decl(".recolour-swatch", "width")) || 0) +
      gap * 3,
  });
} else {
  check(
    "the player-colour rows are still made of the parts this check adds up",
    false,
    "one of .recolour / .recolour-label / .recolour-ordinal / .recolour-swatch / .recolour-row is gone"
  );
}

for (const chain of chains) {
  const unreadable =
    chain.parts === undefined ? [] : chain.parts.filter(([what]) => px(read[what]) === null);
  if (unreadable.length) {
    check(
      `${chain.what} fits a column at its floor`,
      false,
      "cannot read " + unreadable.map(([what]) => what).join(", ") + " — this check is out of date"
    );
    continue;
  }
  const total =
    chain.fixed !== undefined
      ? chain.fixed
      : chain.parts.reduce((sum, [what, times]) => sum + (px(read[what]) || 0) * times, 0);
  check(
    `${chain.what} fits a column at its floor`,
    haveFloor && total <= floor,
    haveFloor ? `${total}px of fixed width against a ${floor}px floor` : `${total}px of fixed width, ${noFloor}`
  );
}

// --- and the row wraps rather than squeezing ----------------------------------

// Not "out of date" when it is missing: a `.settings` with no `flex-wrap` is
// the row squeezing its columns again, which is the whole defect.
check(
  "the settings row wraps",
  read["the row's wrapping"] === "wrap",
  read["the row's wrapping"] === null
    ? "no flex-wrap on .settings — the row squeezes its columns instead of wrapping them"
    : `flex-wrap: ${read["the row's wrapping"]}`
);

// The rule that cannot survive wrapping: a divider drawn between siblings lands
// on the left of the first column of every row after the first, where there is
// no neighbour — and CSS cannot say which column that is.
check(
  "the divider is not drawn between siblings",
  rule(".setgroup + .setgroup") === null,
  rule(".setgroup + .setgroup") === null
    ? "no adjacency rule"
    : "a `.setgroup + .setgroup` rule is back — on a wrapped row it draws against nothing"
);
check(
  "it is a rule the orientation cannot get wrong",
  decl(".setgroup", "border-top") !== null,
  decl(".setgroup", "border-top") || "the divider is not on the top of each group"
);

// --- the arithmetic nobody was doing ------------------------------------------

{
  const cap = px(read["the page cap"]);
  const columnGap = px((read["the row's gap"] ?? "0px").split(/\s+/).pop()) ?? 0;
  const fits = haveFloor ? Math.max(1, Math.floor((cap + columnGap) / (floor + columnGap))) : 0;
  const declared = [...html.matchAll(/<div class="settings">([\s\S]*?)\n      <\/div>/g)].map(
    (m) => (m[1].match(/class="setgroup\b/g) || []).length
  );
  check(
    "the page is wide enough for a column at all",
    haveFloor && cap >= floor,
    haveFloor ? `${cap}px page against a ${floor}px column` : noFloor
  );
  // Not a failure when a row declares more than fits — that is exactly the case
  // wrapping is for, and turning it into one would re-create the rule that a
  // column count has to be known in advance. It is reported so the number is
  // somewhere other than in a screenshot.
  check(
    "every settings row is accounted for",
    declared.length > 0 && declared.every((n) => n >= 1),
    haveFloor
      ? `${declared.join(", ")} column(s) per row; ${fits} fit at the ${cap}px cap, the rest wrap`
      : `${declared.join(", ")} column(s) per row; ${noFloor}, so how many fit is unanswerable`
  );
}

// ------------------------------------------------------------------------------

for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL"));
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`\n${results.length} checks, all passing`);
