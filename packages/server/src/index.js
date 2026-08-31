import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { generateToken, readToken, writeToken } from "@editbar/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

const PORT = process.env.PORT || 4000;
const OVERRIDES_FILE =
  process.env.OVERRIDES_FILE ||
  path.join(__dirname, "..", "data", "overrides.json");
const TOKEN_FILE =
  process.env.TOKEN_FILE || path.join(__dirname, "..", "data", "token.txt");
const WIDGET_FILE = path.join(ROOT, "packages", "widget", "src", "widget.js");
const DEMO_DIR = path.join(ROOT, "examples", "vanilla-html");

// Express's own trust-proxy values: true/false, a hop count, or a subnet
// name/list (e.g. "loopback", "10.0.0.0/8"). Needed whenever this server
// sits behind a reverse proxy (nginx, Caddy, a PaaS edge) — without it,
// req.ip (and the /setup loopback check) sees the proxy's own address
// instead of the real client, which is 127.0.0.1 for any reverse proxy
// running on the same host.
function parseTrustProxy(value) {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

let EDIT_TOKEN = process.env.EDIT_TOKEN;
let tokenFile = null;

if (EDIT_TOKEN) {
  console.log(
    "[editbar] using EDIT_TOKEN from the environment (rotation via the Settings panel is disabled while this is set)."
  );
} else {
  tokenFile = TOKEN_FILE;
  EDIT_TOKEN = await readToken(TOKEN_FILE);
  if (EDIT_TOKEN) {
    console.log(`[editbar] loaded existing admin token from ${TOKEN_FILE}`);
  } else {
    EDIT_TOKEN = generateToken();
    await writeToken(TOKEN_FILE, EDIT_TOKEN);
    console.log(`[editbar] generated a new admin token, saved to ${TOKEN_FILE}`);
  }
  console.log(`[editbar] admin token: ${EDIT_TOKEN}`);
  console.log(
    `[editbar] visit http://localhost:${PORT}/setup once for a copy-paste-friendly setup page.`
  );
}

const app = createApp({
  editToken: EDIT_TOKEN,
  tokenFile,
  serverStartedAt: Date.now(),
  overridesFile: OVERRIDES_FILE,
  widgetFile: WIDGET_FILE,
  demoDir: DEMO_DIR,
  trustProxy: TRUST_PROXY,
});

app.listen(PORT, () => {
  console.log(`[editbar] server listening on http://localhost:${PORT}`);
  console.log(`[editbar] demo page: http://localhost:${PORT}/demo`);
  if (TRUST_PROXY === undefined) {
    console.log(
      "[editbar] TRUST_PROXY is unset — if this server sits behind a reverse proxy (nginx, Caddy, a PaaS edge), set TRUST_PROXY so /setup can tell real remote visitors from the proxy's own loopback connection."
    );
  }
});
