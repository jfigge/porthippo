// cdp.mjs — Minimal Chrome DevTools Protocol client for driving the Jump Hippo
// renderer and capturing documentation screenshots. Uses the `ws` package from
// src/node_modules (run with the local Node, not Electron).
//
// Paths are resolved relative to the repo root (this file's grandparent dir) so
// the pipeline survives a repo rename — don't hardcode an absolute project path.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { default: WebSocket } = await import(
  pathToFileURL(join(ROOT, "src/node_modules/ws/index.js")).href
);

const HOST = "http://localhost:9222";
// Captures land in the gitignored full-res originals dir; a downscale step (see
// .docs-build/README.md) derives the 50% copies bundled in src/web/docs/images.
export const IMG_DIR = join(ROOT, "docs-originals/images");

export async function pageTarget() {
  const res = await fetch(`${HOST}/json`);
  const targets = await res.json();
  // Prefer the main app window (index.html) over the docs window (docs.html).
  const page =
    targets.find((t) => t.type === "page" && /index\.html/.test(t.url || "")) ||
    targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target found");
  return page.webSocketDebuggerUrl;
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  static async connect() {
    const url = await pageTarget();
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((r, e) => {
      ws.once("open", r);
      ws.once("error", e);
    });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  // Evaluate an expression in the page; returns the JSON value.
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        "eval error: " +
          (r.exceptionDetails.exception?.description ||
            r.exceptionDetails.text),
      );
    }
    return r.result.value;
  }
  // Lock the rendered viewport to a fixed size for deterministic, crisp shots.
  // Default 1280×800 @2× → 2560×1600 — both are valid Mac App Store screenshot
  // sizes (16:10), so the same captures serve the guide and a store listing.
  async setViewport(width = 1280, height = 800, scale = 2) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
  }
  async shot(name, { clip } = {}) {
    const params = { format: "png", captureBeyondViewport: false };
    if (clip) params.clip = { ...clip, scale: 1 };
    const r = await this.send("Page.captureScreenshot", params);
    const path = `${IMG_DIR}/${name}.png`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  }
  // Bounding box (CSS px) of the first element matching selector, for clipped shots.
  async rect(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
  }
  async sleep(ms) {
    await this.eval(`new Promise(r => setTimeout(r, ${ms}))`);
  }
  close() {
    this.ws.close();
  }
}
