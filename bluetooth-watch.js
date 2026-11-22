// hyadeOSS - tells the desktop when a Bluetooth device connects or disconnects.
// (C) 2026 mariowstech and the hyadeOSS team - Licensed under the Apache License, Version 2.0
//
// A single helper (tools/bluetooth-watch.ps1) stays running while a desktop is listening, so
// watching costs a few property reads rather than a new PowerShell every few seconds.
// GET /api/system/bt-events is a Server-Sent Events stream of its lines.
//
// Linux (BlueZ) and macOS (blueutil) have no such helper to keep alive: the same events come from
// asking the system for the connected devices every few seconds and announcing what changed
// (lib/platform.js, diffBluetooth). Windows keeps its PowerShell helper.

const path = require("path");
const { spawn } = require("child_process");
const platformLayer = require("./lib/platform");

const SCRIPT = path.join(__dirname, "tools", "bluetooth-watch.ps1");
const RESTART_DELAY_MS = 5000;
const KEEPALIVE_MS = 25000;

const POLL_MS = 3000;

const listeners = new Set();
let helper = null;
let restartTimer = null;
let pollTimer = null;
let polling = false;
let known = null; // mac -> last seen state; null until the first listing, which is not announced

function broadcast(line) {
  listeners.forEach(res => res.write(`data: ${line}\n\n`));
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const devices = await platformLayer.listBluetooth(process.platform, undefined, { onlyConnected: true });
    const { next, events } = platformLayer.diffBluetooth(known || new Map(), devices);
    // Devices that were already connected when watching began are not announced: only changes are.
    if (known) events.forEach(event => broadcast(JSON.stringify(event)));
    known = next;
  } catch { /* no Bluetooth tool or no adapter: nothing to announce, try again later */ }
  polling = false;
}

function startPolling() {
  if (pollTimer) return;
  known = null;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}

function startHelper() {
  if (process.platform === "linux" || process.platform === "darwin") return startPolling();
  if (helper || process.platform !== "win32") return;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-ParentPid", String(process.pid)], {
    windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
  });
  helper = child;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) broadcast(line);
    }
  });
  child.on("exit", () => {
    if (helper === child) helper = null;
    if (listeners.size) restartTimer = setTimeout(startHelper, RESTART_DELAY_MS);
  });
}

function stopHelper() {
  clearInterval(pollTimer);
  pollTimer = null;
  clearTimeout(restartTimer);
  if (helper) helper.kill();
  helper = null;
}

function registerBluetoothWatchRoutes(app, { requireAuth }) {
  app.get("/api/system/bt-events", requireAuth, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    listeners.add(res);
    startHelper();
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
    req.on("close", () => {
      clearInterval(keepalive);
      listeners.delete(res);
      if (!listeners.size) stopHelper();
    });
  });
  process.on("exit", stopHelper);
}

module.exports = { registerBluetoothWatchRoutes };
