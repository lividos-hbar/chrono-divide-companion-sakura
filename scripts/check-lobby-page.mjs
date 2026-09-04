/**
 * The lobby-load page is driven by server text, not a client component.  This
 * check keeps that small contract explicit without needing a logged-in client.
 *
 *   node scripts/check-lobby-page.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const companion = readFileSync(join(here, "..", "src", "companion.js"), "utf8");
const frames = readFileSync(join(here, "..", "src", "frames.js"), "utf8");
const checks = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
}

check(
  "the page uses the channel-join line as its readiness boundary",
  /const LOBBY_JOIN_TEXT = "You joined channel ";/.test(companion)
);
check(
  "the page says that Companion loaded and includes the manifest version",
  /`\(CD-Companion\) Successfully loaded version \$\{VERSION\}`/.test(companion)
);
check(
  "the page waits for a real version instead of announcing a placeholder",
  /if \(lobbyPageDelivered \|\| VERSION === "\?" \|\| !lobbyJoinedChannel\(\)\) return false;/.test(companion)
);
check(
  "the page is delivered once and then its observer is released",
  /if \(typeof window\.__cdcPage !== "function" \|\| !window\.__cdcPage\(text\)\) \{[\s\S]*?return false;[\s\S]*?lobbyPageDelivered = true;\s*if \(lobbyPageWatch\) lobbyPageWatch\.disconnect\(\);/.test(companion)
);
check(
  "both a ready bridge and a late chat render can trigger the check",
  /VERSION = data\.version;\s*announce\(\);\s*watchForLobbyPage\(\);/.test(companion) &&
    /watchForLobbyPage\(\);\s*\}\)\(\);/.test(companion)
);
check(
  "the page is replayed through the client message event rather than a custom DOM banner",
  /socket\.dispatchEvent\(new MessageEvent\("message", \{ data \}\)\);/.test(frames) &&
    /cdc-lobby-page/.test(companion) === false
);
check(
  "the page preserves the real channel-join packet as its protocol template",
  /const JOIN_LINE = \/You joined channel/.test(frames) &&
    /pageTemplate = \{ socket, data: event\.data \};/.test(frames)
);

for (const { name, ok, detail } of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
process.exit(checks.some(({ ok }) => !ok) ? 1 : 0);
