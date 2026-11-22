// hyadeOSS - what is playing on this PC: the Windows media session (SMTC) on Windows, and MPRIS
// (through the `playerctl` tool) on Linux.
// (C) 2026 mariowstech and the hyadeOSS team - Licensed under the Apache License, Version 2.0
//
// Works with the Spotify desktop app (and other players) without any account or API key,
// so it is the fallback when the Spotify Web API is unavailable (e.g. no Premium).
// A single PowerShell helper (tools/media-session.ps1) is kept alive and spoken to over
// stdin/stdout, one JSON line per command. On Linux no helper is kept: each command runs playerctl
// (lib/platform.js). macOS has no equivalent that works without a prompt, so it answers "not
// available" and the desktop hides the feature.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { fileURLToPath } = require("url");
const platformLayer = require("./lib/platform");

const SCRIPT = path.join(__dirname, "tools", "media-session.ps1");
const COMMAND_TIMEOUT_MS = 8000;
const IDLE_SHUTDOWN_MS = 2 * 60 * 1000;

let helper = null;
let buffer = "";
const waiting = [];   // resolvers, in command order
let idleTimer = null;

function stopHelper() {
  if (helper) helper.kill();
  helper = null;
}

function startHelper() {
  helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], {
    windowsHide: true, stdio: ["pipe", "pipe", "ignore"]
  });
  buffer = "";
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const next = waiting.shift();
      if (!next) continue;
      try { next.resolve(JSON.parse(line)); } catch (e) { next.resolve({ ok: false, error: "Bad response from media helper." }); }
    }
  });
  helper.on("exit", () => {
    helper = null;
    while (waiting.length) waiting.shift().resolve({ ok: false, error: "Media helper stopped." });
  });
}

// Cover art from MPRIS is a file:// or https:// address; the desktop shows a data: or https: image.
const MAX_COVER_BYTES = 2 * 1024 * 1024;
function coverImage(artUrl) {
  if (!artUrl) return null;
  if (/^https:\/\//i.test(artUrl)) return artUrl;
  if (!/^file:\/\//i.test(artUrl)) return null;
  try {
    const file = fileURLToPath(artUrl);
    if (fs.statSync(file).size > MAX_COVER_BYTES) return null;
    const type = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[path.extname(file).toLowerCase()];
    return type ? `data:${type};base64,${fs.readFileSync(file).toString("base64")}` : null;
  } catch { return null; }
}

async function sendPlayerctl(command) {
  const anyPlayer = command.startsWith("any:");
  const plain = anyPlayer ? command.slice(4) : command;
  if (plain === "get") {
    const result = await platformLayer.getMediaSession(process.platform, anyPlayer);
    if (!result.ok || !result.session) return result;
    const { artUrl, ...session } = result.session;
    return { ok: true, session: { ...session, image: coverImage(artUrl) } };
  }
  return platformLayer.controlMedia(process.platform, plain, anyPlayer);
}

function send(command) {
  if (process.platform === "linux") return sendPlayerctl(command);
  if (process.platform !== "win32") return Promise.resolve({ ok: false, unsupported: true, error: "Not available on this system." });
  if (!helper) startHelper();
  // Stop the helper when nobody has asked anything for a while.
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopHelper, IDLE_SHUTDOWN_MS);
  return new Promise(resolve => {
    const entry = { resolve };
    const timer = setTimeout(() => {
      // A stuck helper would desynchronise every later answer: restart it.
      stopHelper();
      resolve({ ok: false, error: "Media helper timed out." });
    }, COMMAND_TIMEOUT_MS);
    entry.resolve = value => { clearTimeout(timer); resolve(value); };
    waiting.push(entry);
    helper.stdin.write(command + "\n");
  });
}

function registerMediaSessionRoutes(app, { requireAuth }) {
  app.get("/api/media/session", requireAuth, async (req, res) => {
    const result = await send(req.query.any === "1" ? "any:get" : "get");
    if (!result.ok) return res.status(result.unsupported ? 501 : 502).json({ success: false, error: result.error });
    res.json({ success: true, session: result.session || null });
  });

  app.post("/api/media/control", requireAuth, async (req, res) => {
    const { action, value } = req.body || {};
    const commands = { toggle: "toggle", play: "play", pause: "pause", next: "next", previous: "prev" };
    let command = commands[action];
    if (action === "seek" && Number.isFinite(Number(value))) command = `seek ${Math.max(0, Math.round(Number(value)))}`;
    if (!command) return res.status(400).json({ success: false, error: "Unknown action." });
    const result = await send((req.body?.any ? "any:" : "") + command);
    if (!result.ok) return res.status(502).json({ success: false, error: result.error || "The player did not accept the command." });
    res.json({ success: true });
  });
}

process.on("exit", stopHelper);

module.exports = { registerMediaSessionRoutes };
