/**
 * probe-cameo-harvest.js — can the client hand over every cameo, and how many?
 *
 * Paste into the devtools console (page context) of https://game.chronodivide.com/
 * **on the main menu** — no match, no lobby, no map — and paste back what it
 * prints. It is the fork the harvest run hangs on, asked of the running client
 * rather than of the bundle.
 *
 * READ-ONLY. It opens files out of the VFS, converts SHPs to canvases in memory
 * and measures them. Nothing is written, sent or queued.
 *
 * What it settles, in order:
 *
 *   1. that `Engine`'s rules, art, images and palettes all answer with no game
 *      running — a claim read out of the client's own bundle, which the repo's
 *      palette dump, since deleted, had only ever tested for the palette;
 *   2. **which name says a cameo.** `sidebarImage` is proven for superweapons
 *      (src/companion.js, clientCameoUrl) and for nothing else; for a techno the
 *      recorded route is `Art#getObject(name, type).cameo`. Both are asked, per
 *      object, and the answer decides what the harvester reads;
 *   3. **coverage, both ways** — how many of the 101 ids the committed sheet
 *      carried can be drawn from this client, and how many the client can draw
 *      that the sheet never had. That sheet was 88 pictures for 101 ids out of a
 *      retail install; a client that streams its art may hold fewer, and the
 *      shortfall is what decided that src/cameos.js could go. It has gone, so
 *      this is now how a reader checks the harvest's coverage claim against
 *      their own client rather than taking it on trust;
 *   4. that the palette is the right one. This is the trap of the whole
 *      exercise: a cameo drawn with a palette one byte out of alignment is not
 *      garbage, it is a uniform colour cast — two earlier attempts produced a
 *      convincing Chrono Miner and 85 olive ones, in the offline generator this
 *      repo has since deleted.
 *      Looking at one picture cannot catch that; counting distinct colours
 *      across several can;
 *   5. what a harvested sheet costs in storage, since a browser `toDataURL`
 *      wrote RGBA where the committed sheet was hand-rolled 8-bit indexed.
 */
(async () => {
  const sys = window.System || window.SystemJS;
  if (!sys) throw new Error("SystemJS not on the page — wrong world or wrong page");

  const [engineMod, rulesMod, artMod, objectTypeMod, imageUtilsMod] = await Promise.all(
    [
      "engine/Engine",
      "game/rules/Rules",
      "game/art/Art",
      "engine/type/ObjectType",
      "engine/gfx/ImageUtils",
    ].map((id) => sys.import(id))
  );
  const { Engine } = engineMod;
  const { Rules } = rulesMod;
  const { Art } = artMod;
  const { ObjectType } = objectTypeMod;
  const { ImageUtils } = imageUtilsMod;

  /** The ids the deleted src/cameos.js carried — the coverage baseline this
   * measures against, inlined so this needs no repo. */
  const COMMITTED = [
    "ADOG", "AEGIS", "AMCV", "AMRADR", "APOC", "ATESLA", "BEAG", "CARRIER",
    "CCOMAND", "CIVAN", "CLEG", "CMIN", "CMON", "DESO", "DEST", "DLPH",
    "DOG", "DRED", "DRON", "DTRUCK", "E1", "E2", "ENGINEER", "FLAKT", "FV",
    "GAAIRC", "GACNST", "GACSPH", "GADEPT", "GAGAP", "GAOREP", "GAPILE",
    "GAPILL", "GAPOWR", "GAREFN", "GASPYSAT", "GATECH", "GAWALL", "GAWEAP",
    "GAWEAT", "GAYARD", "GHOST", "GTGCAN", "HARV", "HORV", "HTK", "HTNK",
    "HYD", "IVAN", "JUMPJET", "LCRF", "MGTK", "MTNK", "NACLON", "NACNST",
    "NADEPT", "NAFLAK", "NAHAND", "NAIRON", "NALASR", "NAMISL", "NANRCT",
    "NAPOWR", "NAPSIS", "NARADR", "NAREFN", "NASAM", "NATECH", "NAWALL",
    "NAWEAP", "NAYARD", "ORCA", "PENTGEN", "PRES", "PTROOP", "SAPC",
    "SENGINEER", "SHAD", "SHK", "SMCV", "SNIPE", "SPY", "SQD", "SREF",
    "SSRV", "SUB", "TANY", "TERROR", "TESLA", "TNKD", "TRUCKA", "TTNK", "V3",
    "VLAD", "VLADIMIR", "XCOMET", "YURI", "YURIPR", "ZEP",
    "sw:AmericanParaDropSpecial", "sw:ParaDropSpecial",
  ];

  /** The crop the committed sheet uses: the top 36 of a 60x48 cameo, which is
   *  the picture without the localised name band painted across the bottom. */
  const CELL = { width: 60, height: 36 };
  const COLS = 16;

  // --- 1. is anything there at all ------------------------------------------

  // Both spellings, because the repo has used both: the deleted palette dump
  // read the `Engine.palettes` property, companion.js calls
  // `Engine.getPalettes()`. If those ever stop being the same object, a
  // harvester needs to know which.
  const pick = (obj, method, prop) => {
    let viaMethod = null;
    try {
      viaMethod = typeof obj[method] === "function" ? obj[method]() : null;
    } catch (e) {
      viaMethod = null;
    }
    return {
      value: viaMethod || obj[prop] || null,
      method: !!viaMethod,
      property: !!obj[prop],
      same: viaMethod === obj[prop],
    };
  };

  const imagesAt = pick(Engine, "getImages", "images");
  const palettesAt = pick(Engine, "getPalettes", "palettes");
  const images = imagesAt.value;
  const palettes = palettesAt.value;

  const script = document.querySelector('script[src*="ra2web"]');
  const clientVersion =
    (((script && script.getAttribute("src")) || "").match(/[?&]v=([^&]+)/) || [])[1] || "";

  let rawRules = null;
  let rawArt = null;
  try {
    rawRules = Engine.getRules();
  } catch (e) {
    rawRules = null;
  }
  try {
    rawArt = Engine.getArt();
  } catch (e) {
    rawArt = null;
  }

  const availability = {
    clientVersion: clientVersion || "(unversioned)",
    vfs: !!Engine.vfs,
    getRules: !!rawRules,
    getArt: !!rawArt,
    images: imagesAt,
    palettes: palettesAt,
    note: "no game, player or GameLoader was asked for — this probe never needs one",
  };
  if (!Engine.vfs) throw new Error("No VFS yet — let the client finish booting into the main menu");
  if (!rawRules || !rawArt) throw new Error("No rules or art — are the game files imported?");

  const palette = palettes && palettes.get("cameo.pal");
  if (!palette) throw new Error('No "cameo.pal" in the VFS — are the game files imported?');

  const rules = new Rules(rawRules);

  // The one constructor question worth asking: src/hq-preview.js passes a third
  // `mapFile` argument, and a cameo harvest has no map to pass. If two are
  // refused, the harvester would have to invent a map — a different design.
  let art = null;
  let artArity = "";
  try {
    art = new Art(rules, rawArt);
    artArity = "two arguments (rules, art) — no mapFile needed";
  } catch (e) {
    artArity = `two arguments REFUSED: ${(e && e.message) || e}`;
    try {
      art = new Art(rules, rawArt, undefined);
      artArity += "; three with undefined worked";
    } catch (e2) {
      artArity += `; three with undefined also refused: ${(e2 && e2.message) || e2}`;
    }
  }

  // --- 2. which name says a cameo -------------------------------------------

  const LISTS = [
    ["building", ObjectType.Building],
    ["infantry", ObjectType.Infantry],
    ["vehicle", ObjectType.Vehicle],
    ["aircraft", ObjectType.Aircraft],
  ];

  /** id -> [label, ObjectType], built once out of the client's own four lists. */
  const typeOf = new Map();
  const listSizes = {};
  for (const [label, type] of LISTS) {
    const byName = rules.allObjectRules && rules.allObjectRules.get(type);
    listSizes[label] = byName ? byName.size : 0;
    if (!byName) continue;
    for (const name of byName.keys()) if (!typeOf.has(name)) typeOf.set(name, [label, type]);
  }

  /** Every name this object could be drawn by, and where each came from. */
  function namesFor(id) {
    const known = typeOf.get(id);
    if (!known) return { id, found: false };
    const [label, type] = known;
    const rulesObj = rules.allObjectRules.get(type).get(id);
    let artObj = null;
    let artError = "";
    try {
      artObj = art && art.getObject(id, type);
    } catch (e) {
      artError = (e && e.message) || String(e);
    }
    return {
      id,
      found: true,
      kind: label,
      // The two candidates, plus the indirection the offline generator had to
      // walk by hand: an art section is named after `Image=`, not after the
      // object, so `imageName` is the check that Art#getObject already did it.
      cameo: (artObj && artObj.cameo) || "",
      altCameo: (artObj && artObj.altCameo) || "",
      imageName: (artObj && artObj.imageName) || "",
      sidebarImage: (rulesObj && rulesObj.sidebarImage) || "",
      artError,
    };
  }

  /**
   * An SHP for a picture name, and which spelling the collection wanted.
   * The client hashes filenames uppercased, so case should not matter — should,
   * which is not the same as does.
   */
  function shpFor(name) {
    if (!name) return { shp: null, as: "" };
    const tries = [String(name), String(name).toLowerCase(), String(name).toUpperCase()];
    for (const spelling of tries) {
      try {
        const shp = images.get(spelling + ".shp");
        if (shp) return { shp, as: spelling + ".shp" };
      } catch (e) {
        // A miss throws in some collections and returns undefined in others.
        // Either way the next spelling is the question, not this error.
      }
    }
    return { shp: null, as: "" };
  }

  // --- 3. coverage ----------------------------------------------------------

  /** One 60x36 crop — the same conversion and crop src/companion.js ships. */
  function crop(shp) {
    const full = ImageUtils.convertShpToCanvas(shp, palette);
    const canvas = document.createElement("canvas");
    canvas.width = CELL.width;
    canvas.height = CELL.height;
    canvas
      .getContext("2d")
      .drawImage(full, 0, 0, CELL.width, CELL.height, 0, 0, CELL.width, CELL.height);
    return { canvas, fullWidth: full.width, fullHeight: full.height };
  }

  const started = Date.now();
  let frameLayout = "";

  // Forward: what the committed sheet claims, asked of this client.
  const forward = { drawn: [], noPicture: [], noRules: [], failed: [] };
  for (const id of COMMITTED) {
    if (id.indexOf("sw:") === 0) continue; // answered below, off the superweapon rules
    const n = namesFor(id);
    if (!n.found) {
      forward.noRules.push(id);
      continue;
    }
    const picture = n.cameo || n.sidebarImage;
    if (!picture) {
      forward.noPicture.push(`${id} — no Cameo= and no SidebarImage=`);
      continue;
    }
    const { shp, as } = shpFor(picture);
    if (!shp) {
      forward.noPicture.push(`${id} -> ${picture}.shp is not in the VFS`);
      continue;
    }
    try {
      const drawn = crop(shp);
      if (!frameLayout) frameLayout = `${drawn.fullWidth}x${drawn.fullHeight} for ${picture}.shp`;
      forward.drawn.push({
        id,
        picture,
        as,
        from: n.cameo ? "art.cameo" : "rules.sidebarImage",
      });
    } catch (e) {
      forward.failed.push(`${id} -> ${picture}: ${(e && e.message) || e}`);
    }
  }

  // Reverse: everything this client could draw, under roster()'s own three
  // filters — which is the roster a harvester would actually walk.
  const reverse = { drawn: [], noPicture: [], failed: [] };
  const sheetCells = []; // { key, canvas } in harvest order
  const cellOf = new Map(); // picture name -> cell index, so aliases share a cell
  for (const [label, type] of LISTS) {
    const byName = rules.allObjectRules && rules.allObjectRules.get(type);
    if (!byName) continue;
    for (const [name, object] of byName) {
      if (object.techLevel === -1) continue;
      if (object.buildLimit === 0) continue;
      const owner = object.owner || [];
      if (!owner.length) continue;
      const n = namesFor(name);
      const picture = n.cameo || n.sidebarImage;
      if (!picture) {
        reverse.noPicture.push(`${name} (${label}) — no Cameo=`);
        continue;
      }
      if (cellOf.has(picture)) {
        reverse.drawn.push({ id: name, picture, cell: cellOf.get(picture), alias: true });
        continue;
      }
      const { shp } = shpFor(picture);
      if (!shp) {
        reverse.noPicture.push(`${name} (${label}) -> ${picture}.shp missing`);
        continue;
      }
      try {
        const { canvas } = crop(shp);
        cellOf.set(picture, sheetCells.length);
        reverse.drawn.push({ id: name, picture, cell: sheetCells.length, alias: false });
        sheetCells.push({ key: name, canvas });
      } catch (e) {
        reverse.failed.push(`${name} -> ${picture}: ${(e && e.message) || e}`);
      }
    }
  }

  // --- 4. the two sw: keys --------------------------------------------------

  // A superweapon is not an object, so it has no Image= -> Cameo= chain and the
  // offline generator could never reach it. The client parses SidebarImage= onto
  // the rules, which is the whole reason clientCameoUrl exists.
  const superWeapons = [];
  const swRules = rules.superWeaponRules || null;
  const swSource = swRules ? "rules.superWeaponRules" : "NOT FOUND on Rules";
  if (swRules && typeof swRules.forEach === "function") {
    swRules.forEach((sw, key) => {
      const picture = (sw && sw.sidebarImage) || "";
      const found = picture ? shpFor(picture) : { shp: null };
      let drawn = false;
      let error = "";
      try {
        if (found.shp) {
          crop(found.shp);
          drawn = true;
        }
      } catch (e) {
        error = (e && e.message) || String(e);
      }
      superWeapons.push({
        key: `sw:${(sw && sw.name) || key}`,
        sidebarImage: picture,
        drawn,
        error,
      });
    });
  }

  // --- 5. is the palette the right one --------------------------------------

  // Distinct colours across several pictures. A palette read at the wrong offset
  // renders as a colour cast, not as noise, so the tell is a low count that is
  // still greater than one — checked over more than one picture, because a
  // single flat cameo could honestly be sparse.
  const colourCheck = [];
  for (const cell of sheetCells.slice(0, 6)) {
    const data = cell.canvas.getContext("2d").getImageData(0, 0, CELL.width, CELL.height).data;
    const seen = new Set();
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      opaque++;
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    colourCheck.push({ id: cell.key, colours: seen.size, opaquePixels: opaque });
  }

  // --- 6. what the sheet would cost -----------------------------------------

  const rows = Math.ceil(sheetCells.length / COLS) || 1;
  const sheet = document.createElement("canvas");
  sheet.width = COLS * CELL.width;
  sheet.height = rows * CELL.height;
  const sctx = sheet.getContext("2d");
  sheetCells.forEach((cell, i) => {
    sctx.drawImage(cell.canvas, (i % COLS) * CELL.width, Math.floor(i / COLS) * CELL.height);
  });
  const url = sheet.toDataURL("image/png");

  const report = {
    availability,
    artArity,
    frameLayout,
    listSizes,
    rosterObjects: typeOf.size,
    committed: {
      ids: COMMITTED.length,
      drawn: forward.drawn.length,
      noPicture: forward.noPicture,
      noRules: forward.noRules,
      failed: forward.failed,
      // Which of the two names actually answered, counted: this is the design
      // decision the harvester needs, and the reason both were asked.
      viaArtCameo: forward.drawn.filter((d) => d.from === "art.cameo").length,
      viaSidebarImage: forward.drawn.filter((d) => d.from === "rules.sidebarImage").length,
      spellings: [...new Set(forward.drawn.map((d) => d.as.replace(/^.*?([^.]+)\.shp$/, "$1")))].length,
      caseSensitive: forward.drawn.some((d) => d.as !== d.picture + ".shp"),
    },
    harvest: {
      objectsWithAPicture: reverse.drawn.length,
      distinctPictures: sheetCells.length,
      noPicture: reverse.noPicture.length,
      noPictureSample: reverse.noPicture.slice(0, 20),
      failed: reverse.failed,
    },
    superWeapons: { source: swSource, found: superWeapons },
    palette: { entry0: palette.getColor(0), colourCheck },
    sheet: {
      cols: COLS,
      cell: CELL,
      size: { width: sheet.width, height: sheet.height },
      dataUrlKB: +(url.length / 1024).toFixed(1),
      committedSheetKB: 182.2,
    },
    tookMs: Date.now() - started,
  };

  console.log("=== cameo harvest probe ===");
  console.log(`client ${report.availability.clientVersion}, no match, took ${report.tookMs} ms`);
  console.log(`Art constructor: ${artArity}`);
  console.log(`a converted SHP is ${frameLayout || "(nothing converted)"}`);
  console.log(
    `committed sheet: ${report.committed.drawn}/${report.committed.ids} ids drawable here ` +
      `(${report.committed.viaArtCameo} via art.cameo, ${report.committed.viaSidebarImage} via sidebarImage)`
  );
  if (report.committed.noPicture.length) console.log("  no picture:", report.committed.noPicture);
  if (report.committed.noRules.length) console.log("  no rules object:", report.committed.noRules);
  if (report.committed.failed.length) console.log("  failed:", report.committed.failed);
  console.log(
    `a harvest would draw ${report.harvest.objectsWithAPicture} objects as ` +
      `${report.harvest.distinctPictures} pictures — the committed sheet is 101 ids, 88 pictures`
  );
  console.log("superweapons:", report.superWeapons);
  console.log(`sheet ${sheet.width}x${sheet.height} -> ${report.sheet.dataUrlKB} KB as a PNG data URL`);
  console.table(colourCheck);
  console.log("--- paste the line below back ---");
  console.log(JSON.stringify(report));

  window.__cameoProbe = { report, json: JSON.stringify(report), sheetUrl: url, cells: sheetCells };
  console.log("also on window.__cameoProbe — .sheetUrl is the assembled sheet, .report the object");
  return report;
})();
