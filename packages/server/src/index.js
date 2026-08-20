import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || "development";
const OVERRIDES_FILE =
  process.env.OVERRIDES_FILE ||
  path.join(__dirname, "..", "data", "overrides.json");
const WIDGET_FILE = path.join(ROOT, "packages", "widget", "src", "widget.js");
const DEMO_DIR = path.join(ROOT, "examples", "vanilla-html");

let EDIT_TOKEN = process.env.EDIT_TOKEN;
if (!EDIT_TOKEN) {
  if (NODE_ENV === "development") {
    EDIT_TOKEN = "dev-token";
    console.warn(
      "[editbar] EDIT_TOKEN not set — using an insecure default token for local development only."
    );
  } else {
    console.error(
      `[editbar] refusing to start: EDIT_TOKEN must be set when NODE_ENV=${NODE_ENV}.`
    );
    process.exit(1);
  }
}

const app = createApp({
  editToken: EDIT_TOKEN,
  overridesFile: OVERRIDES_FILE,
  widgetFile: WIDGET_FILE,
  demoDir: DEMO_DIR,
});

app.listen(PORT, () => {
  console.log(`[editbar] server listening on http://localhost:${PORT}`);
  console.log(`[editbar] demo page: http://localhost:${PORT}/demo`);
});
