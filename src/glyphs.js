/**
 * Companion for Chrono Divide — the tech-building pictograms, on their own.
 *
 * They live outside src/hq-preview.js because three places draw them and only
 * one of them can load the renderer: the map render itself (game tab), the
 * options page, which composites the badges over a full render that no longer
 * has them baked in, and scripts/glyph-sheet.mjs, which reads this file to
 * build the sheet. A copy in any of those would drift.
 *
 * Nothing here touches the game client, the DOM or storage — it is paths and
 * two lookup tables — so the file is safe to load anywhere a canvas exists.
 */
(() => {
  // A pictogram nobody owns yet. White rather than the full render's green:
  // green is already a colour on the thumbnail's palette (grass), and white is
  // the one that never means a player.
  const ICON_NEUTRAL = "#ffffff";

  /**
   * What a tech building is *for*, drawn in a 24×24 box.
   *
   * A thumbnail cannot show a building — at 400px an oil derrick is four grey
   * pixels — but it can show what taking one gets you, which is the only reason
   * anyone hunts for a tech building on a preview.
   *
   * Canvas calls rather than SVG path data: the shapes are written and
   * corrected here, and an arc with an angle on it is something a person can
   * check. Canvas angles run clockwise from +x with y downwards, so 1.5π is up.
   */
  const ICON_GLYPHS = {
    /** Oil derrick — money. */
    drop(c) {
      c.beginPath();
      // The bowl sits low in the box and the tail runs long and thin above it:
      // the sides leave the tip vertical and hold that most of the way down,
      // flaring only where they meet the circle. Each side's second handle is
      // directly above its tangent point, so the flare arrives on the bowl
      // without a seam.
      const bowl = { y: 15.8, r: 7.3 };
      c.moveTo(12, 1.5);
      c.bezierCurveTo(12, 8.6, 12 - bowl.r, 12.4, 12 - bowl.r, bowl.y);
      c.arc(12, bowl.y, bowl.r, Math.PI, 0, true);
      c.bezierCurveTo(12 + bowl.r, 12.4, 12, 8.6, 12, 1.5);
      c.fill();
    },
    /** Hospital — heals infantry. */
    cross(c) {
      c.beginPath();
      c.rect(9.5, 3, 5, 18);
      c.rect(3, 9.5, 18, 5);
      c.fill();
    },
    /** Airport — a paradrop. */
    parachute(c) {
      // A dome closed by three scallops rather than a flat chord: the scalloped
      // hem is what makes a half-disc read as canopy fabric. They curve *up*
      // between the lines, which is the way the load hangs — the fabric is
      // pulled down at every point a line takes it and billows between them, so
      // the hanging points are the low corners. Curving them down instead put
      // the fabric's own weight where the rigging is and read as a cloud.
      // The seams are left out — at 18px they close up into a grey smear.
      const hem = 10.4; // where the fabric ends and the rigging starts
      const rx = 9.5;
      const ry = 8.0; // a canopy is wider than it is tall
      const joint = 3.4; // half-width of the middle panel
      const lift = 3.4; // control offset, so a panel billows half that above the hem
      const load = [12, 20.6];
      const hangs = [12 + rx, 12 + joint, 12 - joint, 12 - rx];
      c.beginPath();
      c.ellipse(12, hem, rx, ry, 0, Math.PI, 0);
      for (let i = 0; i < 3; i++) {
        const [a, b] = [hangs[i], hangs[i + 1]];
        c.quadraticCurveTo((a + b) / 2, hem - lift, b, hem);
      }
      c.fill();
      // Rigging, in the canopy's own ink and drawn over it, so each line *starts
      // inside the fabric* and emerges from it. Ending them on the hem drew a
      // corner at every hanging point — four little notches where a straight
      // edge met a curve; sunk, those corners are under the fill and what shows
      // is a line coming out of the canopy. They meet at the load's centre for
      // the same reason: the disc covers where they cross, and stopping short of
      // it drew a wedge with corners of its own.
      //
      // The outer pair cannot sink straight up — the hanging point is the dome's
      // widest, so anything above it is outside — so it rides the dome's own
      // edge at that height, which is also what keeps its outer side flush with
      // the canopy rather than poking past it.
      const sink = 1.8;
      const ride = rx * Math.sqrt(1 - (sink / ry) ** 2) * 0.97;
      const tops = [12 + ride, 12 + joint, 12 - joint, 12 - ride];
      c.lineWidth = 0.6;
      c.beginPath();
      tops.forEach((x) => {
        c.moveTo(x, hem - sink);
        c.lineTo(load[0], load[1]);
      });
      c.stroke();
      c.beginPath();
      c.arc(load[0], load[1], 2, 0, Math.PI * 2);
      c.fill();
    },
    /**
     * Repair — worn by both buildings that give it, in two forms.
     *
     * `CAMACH` (Tech Machine Shop) sets `UnitsGainSelfHeal=1`: your vehicles
     * repair themselves wherever they are. `CAOUTP` (Tech Outpost) sets
     * `UnitRepair=yes` with one dock: you drive a damaged vehicle in. Both read
     * out of the game's own rules text rather than guessed from the client.
     *
     * They share the glyph deliberately (user's call, 2026-08-09): at 18px the
     * distinction between "repairs here" and "repairs everywhere" is finer than
     * the mark can carry, and what the preview is for is *where the repair is*.
     * `CAOUTP` also shoots (`Primary=HoverMissile`), which the glyph drops.
     */
    wrench(c) {
      // One filled outline of straight edges — strokes with round caps read as a
      // hook, a spanner is all corners. Points are given on the tool's own axes:
      // `along` runs butt → jaw, `across` is half-width, so the numbers below
      // are the spanner's dimensions and can be checked as such.
      const D = Math.SQRT1_2; // the tool lies on the 45° diagonal
      const at = (along, across) => [
        15.0 + D * (along + across),
        9.0 + D * (across - along),
      ];
      const outline = [
        at(-16.5, 1.7), // butt
        at(-3.6, 1.7), // neck
        at(-1.2, 3.6), // the shoulder flares out to the head
        at(4.2, 3.6),
        at(5.0, 2.8), // the prong ends chamfered, the way a jaw is ground
        at(5.0, 1.9),
        at(0.6, 1.9), // down one side of the slot
        at(0.6, -1.9), // across its flat bottom — a slot, not a notch
        at(5.0, -1.9),
        at(5.0, -2.8),
        at(4.2, -3.6),
        at(-1.2, -3.6),
        at(-3.6, -1.7),
        at(-16.5, -1.7),
      ];
      c.beginPath();
      outline.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.closePath();
      c.fill();
    },
    /** Secret lab — a bonus unit. */
    flask(c) {
      c.beginPath();
      c.moveTo(9.5, 3);
      c.lineTo(9.5, 10);
      c.lineTo(4, 19.5);
      c.quadraticCurveTo(3.2, 21.5, 5.4, 21.5);
      c.lineTo(18.6, 21.5);
      c.quadraticCurveTo(20.8, 21.5, 20, 19.5);
      c.lineTo(14.5, 10);
      c.lineTo(14.5, 3);
      c.closePath();
      c.fill();
      c.lineCap = "round";
      c.lineWidth = 2.4;
      c.beginPath();
      c.moveTo(8.4, 3);
      c.lineTo(15.6, 3);
      c.stroke();
    },
    /** Worth taking, and this table has no glyph for it. */
    marker(c) {
      c.beginPath();
      c.moveTo(12, 3);
      c.lineTo(20, 12);
      c.lineTo(12, 21);
      c.lineTo(4, 12);
      c.closePath();
      c.fill();
    },
  };

  /**
   * Per-glyph size correction, applied to whatever box a style asks for.
   *
   * The glyphs share a 24×24 box but do not fill it equally. The parachute is a
   * canopy with air under it and rigging thin enough to disappear; the wrench is
   * a thin tool lying along one diagonal, so most of its box is empty on both
   * sides of it. At the same box each carries about half the ink of the cross or
   * the droplet and reads as the smaller mark. The numbers are optical — set by
   * looking at the marks side by side in `scripts/glyph-sheet.mjs`, not derived
   * from the paths, and trimmed from 1.5 to 1.3 once they were seen on a map
   * rather than on the sheet's dark card.
   */
  const ICON_SCALE = { parachute: 1.3, wrench: 1.3 };

  /**
   * Which glyph a map-placed structure gets, keyed by the object name the map
   * writes — the name `__cdcHq.list()` prints, which is also where an unmatched
   * one shows up. Anything outlined but absent from this table falls back to
   * `marker`, so an unfamiliar tech structure is marked rather than dropped.
   */
  const BUILDING_ICONS = {
    CAOILD: "drop",
    CAHOSP: "cross",
    CAAIRP: "parachute",
    CAMACH: "wrench",
    CASLAB: "flask",
    CAOUTP: "wrench",
  };

  /**
   * One glyph, centred on (cx, cy), sized to `box`, in `color`.
   *
   * The halo rather than a backing disc is what lets the glyph keep the whole
   * mark: it follows the shape instead of boxing it. Shadow geometry is in device
   * pixels — the canvas transform does not reach it — so the blur is a fixed
   * fraction of the box whatever the box is.
   */
  function drawGlyph(ctx, glyph, cx, cy, box, color) {
    const draw = ICON_GLYPHS[glyph];
    if (!draw) return false;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = Math.max(1.5, box * 0.16);
    // Each glyph is written in its own 24×24 box and scaled onto the mark, so the
    // line widths inside them are in glyph units, not pixels.
    ctx.translate(cx - box / 2, cy - box / 2);
    ctx.scale(box / 24, box / 24);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    draw(ctx);
    ctx.restore();
    return true;
  }

  /** The box a glyph asks for, given the style's size. */
  function glyphBox(glyph, size) {
    return size * (ICON_SCALE[glyph] || 1);
  }

  window.__cdcGlyphs = {
    ICON_GLYPHS,
    ICON_SCALE,
    ICON_NEUTRAL,
    BUILDING_ICONS,
    drawGlyph,
    glyphBox,
  };
  })();

