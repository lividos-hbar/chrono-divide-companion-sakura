/**
 * TEST FIXTURE — the cameo sheet's **drawing contract**, with the real index and
 * the real geometry, and a stand-in where the pixels go.
 *
 * Source: a retail Red Alert 2 install, via scripts/gen-cameos.mjs on 2026-08-19 — 101 ids across 88 pictures. The index is src/cameos.js's, unchanged; the sheet it indexes was left behind.
 *
 * `cols`, `cell` and `size` are src/cameos.js's own numbers, read out of it
 * rather than invented: 16 columns of 60×36 over a 960×216 sheet, which is 88
 * pictures rounded up to six rows. They are *geometry* — how a sheet is laid
 * out — and copying a layout is not copying artwork, which is the whole reason
 * they can be here while the 190 KB of Red Alert 2 sidebar art they address
 * cannot. The index is bookkeeping of the same kind: 101 object ids and the cell
 * numbers they were assigned across 88 distinct pictures.
 *
 * `sheet` is a **synthetic placeholder** — a 1×1 fully transparent PNG, made
 * here, containing not one pixel of anybody's art. It is enough because nothing
 * decodes it: src/replay-view.js interpolates it into a CSS `url()` and writes
 * that onto the document root as `--cdc-cameo-sheet`, and every check that
 * exercises the renderer asserts the property was *written*, never what it
 * decodes to. A check that ever needs real pixels needs a real client, not a
 * fixture.
 *
 * 2 of the keys are `sw:<rules section>` superweapons, which are not objects
 * but are named the same way in a build-grid layout. An id that is absent has no
 * cameo in the game's own art — mostly civilian scenery and cut content.
 *
 * It publishes `window.__cdcCameos` so a check loads it exactly as it loaded the
 * shipped file. Read by scripts/check-chords.mjs (which asks only
 * `index[name] === undefined`) and site/check-replays.mjs (which asks that the
 * global is published at all); carrying the four contract keys is what lets a
 * check of the renderer load this in place of the sheet the extension used to
 * ship.
 *
 * Rebuilt from a harvest by scripts/fixture-replay-types.mjs.
 * Do not edit the index by hand.
 */
(() => {
  "use strict";
  window.__cdcCameos = {
    // The drawing contract: the four keys every reader of __cdcCameos expects.
    cols: 16,
    cell: { width: 60, height: 36 },
    size: { width: 960, height: 216 },
    sheet:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
    index: {
          "ADOG": 55,
          "AEGIS": 70,
          "AMCV": 56,
          "AMRADR": 34,
          "APOC": 58,
          "ATESLA": 24,
          "BEAG": 85,
          "CARRIER": 63,
          "CCOMAND": 47,
          "CIVAN": 49,
          "CLEG": 45,
          "CMIN": 79,
          "CMON": 79,
          "DESO": 43,
          "DEST": 68,
          "DLPH": 75,
          "DOG": 44,
          "DRED": 72,
          "DRON": 66,
          "DTRUCK": 62,
          "E1": 35,
          "E2": 36,
          "ENGINEER": 38,
          "FLAKT": 53,
          "FV": 83,
          "GAAIRC": 34,
          "GACNST": 56,
          "GACSPH": 20,
          "GADEPT": 3,
          "GAGAP": 27,
          "GAOREP": 33,
          "GAPILE": 2,
          "GAPILL": 30,
          "GAPOWR": 0,
          "GAREFN": 1,
          "GASPYSAT": 26,
          "GATECH": 4,
          "GAWALL": 9,
          "GAWEAP": 5,
          "GAWEAT": 21,
          "GAYARD": 17,
          "GHOST": 40,
          "GTGCAN": 28,
          "HARV": 57,
          "HORV": 57,
          "HTK": 67,
          "HTNK": 59,
          "HYD": 81,
          "IVAN": 42,
          "JUMPJET": 39,
          "LCRF": 71,
          "MGTK": 82,
          "MTNK": 61,
          "NACLON": 32,
          "NACNST": 76,
          "NADEPT": 19,
          "NAFLAK": 31,
          "NAHAND": 8,
          "NAIRON": 18,
          "NALASR": 15,
          "NAMISL": 23,
          "NANRCT": 29,
          "NAPOWR": 6,
          "NAPSIS": 14,
          "NARADR": 10,
          "NAREFN": 12,
          "NASAM": 16,
          "NATECH": 7,
          "NAWALL": 13,
          "NAWEAP": 11,
          "NAYARD": 25,
          "ORCA": 84,
          "PENTGEN": 37,
          "PRES": 37,
          "PTROOP": 48,
          "SAPC": 60,
          "SENGINEER": 38,
          "SHAD": 73,
          "SHK": 37,
          "SMCV": 76,
          "SNIPE": 51,
          "SPY": 46,
          "SQD": 74,
          "SREF": 80,
          "SSRV": 37,
          "SUB": 69,
          "TANY": 52,
          "TERROR": 54,
          "TESLA": 22,
          "TNKD": 77,
          "TRUCKA": 62,
          "TTNK": 78,
          "V3": 64,
          "VLAD": 63,
          "VLADIMIR": 37,
          "XCOMET": 59,
          "YURI": 41,
          "YURIPR": 50,
          "ZEP": 65,
          "sw:AmericanParaDropSpecial": 86,
          "sw:ParaDropSpecial": 87
    },
  };
})();
