// hyadeOSS - the OS compatibility layer: how the same Wi-Fi, Bluetooth and media features
// are asked of Linux and macOS (Windows keeps its PowerShell helpers, see lib/windows-radios.ps1).
// (C) 2026 mariowstech and the hyadeOSS team - Licensed under the Apache License, Version 2.0
//
// Everything here is split into two kinds of function so it can be tested on any machine:
//  - parse*(text) and *Args(...) are pure: they turn a tool's output into data, or data into
//    an argument list. No shell is ever involved, so no value can break out of its argument.
//  - the async functions take a `run(file, args)` that resolves to { stdout } and rejects when
//    the tool is missing or fails. The default `run` is execFile; tests pass a fake one.

const { execFile } = require("child_process");

const DEFAULT_TIMEOUT_MS = 10000;

function run(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function isMissingTool(error) {
  return Boolean(error) && error.code === "ENOENT";
}

// ---------------------------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------------------------

// nmcli's terse mode separates fields with ":" and writes a ":" or "\" inside a value as "\:"
// or "\\". Splitting on ":" alone cuts a network called "Home: 5G" in two.
function splitNmcliLine(line) {
  const fields = [];
  let current = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "\\" && index + 1 < line.length) current += line[++index];
    else if (char === ":") { fields.push(current); current = ""; }
    else current += char;
  }
  fields.push(current);
  return fields;
}

// `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY dev wifi list` -> [{ ssid, signal, secured, connected }]
// One entry per network name (an access point repeats for every band), strongest first, the
// connected one on top.
function parseNmcliWifiList(stdout) {
  const byName = new Map();
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const [inUse, ssid, signal, security] = splitNmcliLine(line);
    if (!ssid || !ssid.trim()) continue;
    const entry = {
      ssid: ssid.trim(),
      signal: Math.max(0, Math.min(100, parseInt(signal, 10) || 0)),
      secured: Boolean(security) && security !== "--",
      connected: String(inUse || "").trim() === "*"
    };
    const known = byName.get(entry.ssid);
    if (!known) byName.set(entry.ssid, entry);
    else {
      known.connected = known.connected || entry.connected;
      known.signal = Math.max(known.signal, entry.signal);
    }
  }
  return [...byName.values()].sort((a, b) => b.connected - a.connected || b.signal - a.signal);
}

// `nmcli -t -f ACTIVE,SSID dev wifi` -> the name of the network in use, or null.
function parseNmcliActiveSsid(stdout) {
  for (const line of String(stdout).split("\n")) {
    const [active, ssid] = splitNmcliLine(line);
    if (active === "yes" && ssid && ssid.trim()) return ssid.trim();
  }
  return null;
}

// `networksetup -getairportnetwork en0` -> "Current Wi-Fi Network: Home", or a sentence saying
// there is none ("You are not associated with an AirPort network.").
function parseNetworksetupWifi(stdout) {
  const match = /^Current (?:Wi-Fi|AirPort) Network:\s*(.+)$/m.exec(String(stdout));
  return match && match[1].trim() ? match[1].trim() : null;
}

// `networksetup -listallhardwareports` -> the device that is the Wi-Fi port ("en0" on most
// Macs, but not on all: a Mac with an extra adapter can number them differently).
function parseMacWifiDevice(stdout) {
  const blocks = String(stdout).split(/\n\s*\n/);
  for (const block of blocks) {
    if (!/^Hardware Port:\s*(Wi-Fi|AirPort)\s*$/m.test(block)) continue;
    const device = /^Device:\s*(\S+)\s*$/m.exec(block);
    if (device) return device[1];
  }
  return null;
}

// macOS 14.4 removed the old `airport` tool, so the device is looked up once and remembered.
let macWifiDevice;
async function getMacWifiDevice(runner = run) {
  if (macWifiDevice !== undefined && runner === run) return macWifiDevice;
  let device = null;
  try { device = parseMacWifiDevice((await runner("networksetup", ["-listallhardwareports"])).stdout); } catch { /* none */ }
  device = device || "en0";
  if (runner === run) macWifiDevice = device;
  return device;
}

// The name of the network this machine is on, or null. Windows is handled by server.js (netsh).
async function getWifiSsid(platform, runner = run) {
  if (platform === "linux") {
    try {
      const ssid = parseNmcliActiveSsid((await runner("nmcli", ["-t", "-f", "ACTIVE,SSID", "dev", "wifi"])).stdout);
      if (ssid) return ssid;
    } catch { /* no NetworkManager: try the older tool */ }
    try {
      const name = (await runner("iwgetid", ["-r"])).stdout.trim();
      return name || null;
    } catch { return null; }
  }
  if (platform === "darwin") {
    const device = await getMacWifiDevice(runner);
    // Recent macOS hides the name from programs that have no Location permission: then the
    // answer is "not associated" even while connected. Nothing more can be done from here.
    try { return parseNetworksetupWifi((await runner("networksetup", ["-getairportnetwork", device])).stdout); } catch { return null; }
  }
  return null;
}

const MAC_AIRPORT_TOOL = "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport";

// `airport -s` -> networks. The tool is gone on macOS 14.4 and later: the caller then falls back
// to the one network it can still name.
function parseAirportScan(stdout) {
  const networks = [];
  const lines = String(stdout).trim().split("\n").slice(1);
  for (const line of lines) {
    // The name comes first and may contain spaces: the BSSID (aa:bb:..) marks where it ends.
    const match = /^\s*(.+?)\s+((?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2})\s+(-?\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/i.exec(line);
    if (!match) continue;
    const rssi = parseInt(match[3], 10);
    networks.push({
      ssid: match[1],
      signal: Math.min(100, Math.max(0, (rssi + 100) * 2)),
      secured: match[4].trim() !== "NONE"
    });
  }
  return networks;
}

async function scanWifi(platform, runner = run) {
  if (platform === "linux") {
    const result = await runner("nmcli", ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list", "--rescan", "yes"]);
    return parseNmcliWifiList(result.stdout);
  }
  if (platform === "darwin") {
    const current = await getWifiSsid(platform, runner);
    let networks = [];
    try { networks = parseAirportScan((await runner(MAC_AIRPORT_TOOL, ["-s"])).stdout); } catch { /* removed in macOS 14.4 */ }
    const seen = new Set();
    networks = networks.filter(n => (seen.has(n.ssid) ? false : seen.add(n.ssid))).map(n => ({ ...n, connected: n.ssid === current }));
    if (current && !seen.has(current)) networks.unshift({ ssid: current, signal: 100, secured: true, connected: true });
    return networks.sort((a, b) => b.connected - a.connected || b.signal - a.signal);
  }
  return [];
}

// File and arguments to join a network. Never a shell string, so any password is allowed.
function connectWifiArgs(platform, ssid, password, macDevice = "en0") {
  if (platform === "linux") {
    const args = ["dev", "wifi", "connect", ssid];
    if (password) args.push("password", password);
    return ["nmcli", args];
  }
  if (platform === "darwin") {
    const args = ["-setairportnetwork", macDevice, ssid];
    if (password) args.push(password);
    return ["networksetup", args];
  }
  return null;
}

async function connectWifi(platform, ssid, password, runner = run) {
  const device = platform === "darwin" ? await getMacWifiDevice(runner) : undefined;
  const command = connectWifiArgs(platform, ssid, password, device);
  if (!command) throw new Error("Connecting to Wi-Fi is not supported on this system.");
  const result = await runner(command[0], command[1]);
  // networksetup exits 0 even when it fails: its message is the only sign.
  if (platform === "darwin" && /Failed|Error|Could not/i.test(result.stdout)) throw new Error(result.stdout.trim());
}

async function setWifiPower(platform, on, runner = run) {
  if (platform === "linux") return runner("nmcli", ["radio", "wifi", on ? "on" : "off"]);
  if (platform === "darwin") return runner("networksetup", ["-setairportpower", await getMacWifiDevice(runner), on ? "on" : "off"]);
  throw new Error("Not supported on this system.");
}

// ---------------------------------------------------------------------------------------
// Bluetooth
// ---------------------------------------------------------------------------------------

// Same names Windows gives (see tools/bluetooth-types.ps1), which the desktop already draws.
function bluetoothType(icon, name) {
  const byIcon = {
    "audio-headphones": "headphones", "audio-headset": "headphones", "audio-card": "speaker",
    "phone": "smartphone", "input-mouse": "mouse", "input-keyboard": "keyboard", "input-tablet": "pen"
  }[String(icon || "").toLowerCase()];
  if (byIcon) return byIcon;
  const label = String(name || "").toLowerCase();
  if (/airpods|buds|earbud|pods/.test(label)) return "earbuds";
  if (/speaker|boom|soundbar|charge|flip|jbl/.test(label)) return "speaker";
  if (/head|wh-|qc\d|momentum/.test(label)) return "headphones";
  if (/mouse|mx master/.test(label)) return "mouse";
  if (/keyboard|keys/.test(label)) return "keyboard";
  if (/iphone|pixel|galaxy|phone/.test(label)) return "smartphone";
  return "bluetooth";
}

// `bluetoothctl devices [Connected]` -> [{ mac, name }]
function parseBluetoothctlDevices(stdout) {
  const devices = [];
  for (const line of String(stdout).split("\n")) {
    const match = /^(?:\[[^\]]*\]\s*)?Device\s+([0-9A-F:]{17})\s+(.+)$/i.exec(line.trim());
    if (match) devices.push({ mac: match[1].toUpperCase(), name: match[2].trim() });
  }
  return devices;
}

// `bluetoothctl info <mac>` -> what the device says about itself.
function parseBluetoothctlInfo(stdout) {
  const text = String(stdout);
  const battery = /Battery Percentage:\s*0x[0-9a-f]+\s*\((\d+)\)/i.exec(text);
  return {
    connected: /^\s*Connected:\s*yes\s*$/im.test(text),
    paired: /^\s*Paired:\s*yes\s*$/im.test(text),
    icon: (/^\s*Icon:\s*(\S+)/im.exec(text) || [])[1] || "",
    // The alias is the name the user chose (it defaults to the device's own name).
    name: ((/^\s*Alias:\s*(.+)$/im.exec(text) || /^\s*Name:\s*(.+)$/im.exec(text) || [])[1] || "").trim(),
    battery: battery ? Math.max(0, Math.min(100, Number(battery[1]))) : null
  };
}

// `blueutil --paired|--connected` -> one line per device:
//   address: 00-11-22-33-44-55, not connected, not favourite, paired, name: "Buds", recent access date: ...
function parseBlueutilDevices(stdout) {
  const devices = [];
  for (const line of String(stdout).split("\n")) {
    const mac = /address:\s*([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i.exec(line);
    if (!mac) continue;
    const name = /name:\s*"([^"]*)"/.exec(line);
    // "not connected" contains "connected": the word only counts when it is not negated.
    const connected = /(?:^|,\s*)connected\s*(?:,|$)/.test(line.replace(/name:\s*"[^"]*"/, ""));
    const label = name ? name[1] : "Bluetooth device";
    devices.push({ mac: mac[1].replace(/-/g, ":").toUpperCase(), name: label, type: bluetoothType("", label), connected, battery: null });
  }
  return devices;
}

async function bluetoothctlInfo(mac, runner) {
  try { return parseBluetoothctlInfo((await runner("bluetoothctl", ["info", mac])).stdout); }
  catch { return null; }
}

// Paired devices with their live state: [{ mac, name, type, connected, battery }].
// `onlyConnected` is cheaper (a watcher asks every few seconds): one listing, and details only
// for the few devices that are connected.
async function listBluetooth(platform, runner = run, { onlyConnected = false } = {}) {
  if (platform === "darwin") {
    const flag = onlyConnected ? "--connected" : "--paired";
    const devices = parseBlueutilDevices((await runner("blueutil", [flag])).stdout);
    return onlyConnected ? devices.map(device => ({ ...device, connected: true })) : devices;
  }
  if (platform !== "linux") return [];

  let listed;
  if (onlyConnected) {
    try { listed = parseBluetoothctlDevices((await runner("bluetoothctl", ["devices", "Connected"])).stdout); }
    catch (error) { if (isMissingTool(error)) throw error; /* BlueZ older than 5.65 has no filter */ }
  }
  const everything = listed === undefined;
  if (everything) listed = parseBluetoothctlDevices((await runner("bluetoothctl", ["devices"])).stdout);

  const devices = await Promise.all(listed.map(async device => {
    const info = await bluetoothctlInfo(device.mac, runner);
    const connected = info ? info.connected : !everything;
    return { mac: device.mac, name: (info && info.name) || device.name, type: bluetoothType(info && info.icon, device.name), connected, battery: info ? info.battery : null };
  }));
  return onlyConnected ? devices.filter(device => device.connected) : devices;
}

async function setBluetoothPower(platform, on, runner = run) {
  if (platform === "darwin") return runner("blueutil", ["-p", on ? "1" : "0"]);
  if (platform !== "linux") throw new Error("Not supported on this system.");
  // rfkill frees or blocks the radio itself, bluetoothctl powers the adapter: either one may be
  // missing or refused, and the toggle worked when at least one of them did.
  const steps = on
    ? [["rfkill", ["unblock", "bluetooth"]], ["bluetoothctl", ["power", "on"]]]
    : [["bluetoothctl", ["power", "off"]], ["rfkill", ["block", "bluetooth"]]];
  let worked = false;
  let lastError = null;
  for (const [file, args] of steps) {
    try {
      const result = await runner(file, args);
      // bluetoothctl prints "Failed to set power ..." and still exits 0.
      if (file === "bluetoothctl" && /Failed/i.test(result.stdout)) throw new Error(result.stdout.trim());
      worked = true;
    } catch (error) { lastError = error; }
  }
  if (!worked) throw lastError || new Error("Could not change Bluetooth.");
}

async function connectBluetooth(platform, mac, connect, runner = run) {
  if (platform === "linux") {
    const result = await runner("bluetoothctl", [connect ? "connect" : "disconnect", mac], { timeout: 20000 });
    if (/Failed to (?:connect|disconnect)/i.test(result.stdout)) throw new Error(result.stdout.trim());
    return;
  }
  if (platform === "darwin") return runner("blueutil", [connect ? "--connect" : "--disconnect", mac]);
  throw new Error("Not supported on this system.");
}

// What changed between two listings (each a list of listBluetooth results).
// `previous` is a Map of mac -> { connected, battery }; the new map is returned with the events,
// so a watcher only has to broadcast them: { event: connected|disconnected|battery, name, mac, type, battery }.
function diffBluetooth(previous, devices) {
  const next = new Map();
  const events = [];
  for (const device of devices) {
    next.set(device.mac, { connected: device.connected, battery: device.battery, name: device.name, type: device.type });
    const before = previous.get(device.mac);
    const wasConnected = Boolean(before && before.connected);
    if (device.connected && !wasConnected) events.push({ event: "connected", name: device.name, mac: device.mac, type: device.type, battery: device.battery });
    else if (!device.connected && wasConnected) events.push({ event: "disconnected", name: device.name, mac: device.mac, type: device.type, battery: device.battery });
    else if (device.connected && device.battery !== null && before && before.battery !== device.battery) events.push({ event: "battery", name: device.name, mac: device.mac, type: device.type, battery: device.battery });
  }
  // A device that vanished from the list while connected counts as disconnected.
  for (const [mac, before] of previous) {
    if (!next.has(mac) && before.connected) events.push({ event: "disconnected", name: before.name, mac, type: before.type, battery: before.battery });
  }
  return { next, events };
}

// ---------------------------------------------------------------------------------------
// What is playing (Linux: MPRIS through playerctl)
// ---------------------------------------------------------------------------------------

const MPRIS_SEPARATOR = "\u001f";
const MPRIS_FORMAT = ["{{playerName}}", "{{status}}", "{{artist}}", "{{title}}", "{{album}}", "{{position}}", "{{mpris:length}}", "{{mpris:artUrl}}"].join(MPRIS_SEPARATOR);

// `playerctl -a metadata --format ...` -> one session per player. playerctl reports times in
// microseconds; the desktop wants milliseconds.
function parsePlayerctlSessions(stdout) {
  const sessions = [];
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const [app, status, artist, title, album, position, length, art] = line.split(MPRIS_SEPARATOR);
    if (!app) continue;
    const durationMs = Math.max(0, Math.round((Number(length) || 0) / 1000));
    sessions.push({
      app,
      title: title || "",
      artist: artist || "",
      album: album || "",
      isPlaying: String(status).toLowerCase() === "playing",
      positionMs: Math.max(0, Math.min(Math.round((Number(position) || 0) / 1000), durationMs || Infinity)),
      durationMs,
      canSeek: durationMs > 0,
      artUrl: art || ""
    });
  }
  return sessions;
}

// Spotify is preferred unless the caller asked for "any": same rule as the Windows helper.
function pickMediaSession(sessions, anyPlayer) {
  const pool = anyPlayer ? sessions : (sessions.filter(s => /spotify/i.test(s.app)).length ? sessions.filter(s => /spotify/i.test(s.app)) : sessions);
  return pool.find(s => s.isPlaying) || pool[0] || null;
}

// playerctl command for the desktop's protocol: toggle | play | pause | next | prev | seek <ms>.
function playerctlControlArgs(command, player) {
  const [name, argument] = String(command).split(" ");
  const base = player ? ["-p", player] : [];
  switch (name) {
    case "toggle": return [...base, "play-pause"];
    case "play": return [...base, "play"];
    case "pause": return [...base, "pause"];
    case "next": return [...base, "next"];
    case "prev": return [...base, "previous"];
    case "seek": {
      const ms = Number(argument);
      return Number.isFinite(ms) ? [...base, "position", String(Math.max(0, ms) / 1000)] : null;
    }
    default: return null;
  }
}

async function getMediaSession(platform, anyPlayer, runner = run) {
  if (platform !== "linux") return { ok: false, unsupported: true, error: "Not available on this system." };
  let result;
  try { result = await runner("playerctl", ["-a", "metadata", "--format", MPRIS_FORMAT]); }
  catch (error) {
    if (isMissingTool(error)) return { ok: false, unsupported: true, error: "Install playerctl to see what is playing." };
    // playerctl exits with an error when no player is running: that is just "nothing playing".
    return { ok: true, session: null };
  }
  const session = pickMediaSession(parsePlayerctlSessions(result.stdout), anyPlayer);
  return { ok: true, session };
}

async function controlMedia(platform, command, anyPlayer, runner = run) {
  if (platform !== "linux") return { ok: false, unsupported: true, error: "Not available on this system." };
  const current = await getMediaSession(platform, anyPlayer, runner);
  if (!current.ok) return current;
  if (!current.session) return { ok: false, error: "Nothing is playing." };
  const args = playerctlControlArgs(command, current.session.app);
  if (!args) return { ok: false, error: "Unknown command." };
  try { await runner("playerctl", args); return { ok: true }; }
  catch { return { ok: false, error: "The player did not accept the command." }; }
}

module.exports = {
  run, isMissingTool,
  splitNmcliLine, parseNmcliWifiList, parseNmcliActiveSsid, parseNetworksetupWifi, parseMacWifiDevice, parseAirportScan,
  getWifiSsid, scanWifi, connectWifiArgs, connectWifi, setWifiPower,
  bluetoothType, parseBluetoothctlDevices, parseBluetoothctlInfo, parseBlueutilDevices,
  listBluetooth, setBluetoothPower, connectBluetooth, diffBluetooth,
  parsePlayerctlSessions, pickMediaSession, playerctlControlArgs, getMediaSession, controlMedia, MPRIS_FORMAT, MPRIS_SEPARATOR
};
