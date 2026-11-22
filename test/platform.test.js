// Tests for lib/platform.js: the Linux and macOS side of Wi-Fi, Bluetooth and media.
// No real tool is needed: parsers get sample output, and the async functions get a fake runner.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const platform = require("../lib/platform");
const { createZip, extractZip } = require("../lib/zip");

// A runner that answers from a table of "file arg arg" -> stdout (or an Error), and records calls.
function fakeRunner(table) {
  const calls = [];
  const runner = async (file, args = []) => {
    const key = [file, ...args].join(" ");
    calls.push(key);
    const answer = table[key];
    if (answer === undefined) { const error = new Error(`spawn ${file} ENOENT`); error.code = "ENOENT"; throw error; }
    if (answer instanceof Error) throw answer;
    return { stdout: answer, stderr: "" };
  };
  runner.calls = calls;
  return runner;
}

test("nmcli lines are split on unescaped colons only", () => {
  assert.deepEqual(platform.splitNmcliLine("*:Home\\: 5G:80:WPA2"), ["*", "Home: 5G", "80", "WPA2"]);
  assert.deepEqual(platform.splitNmcliLine("no\\\\slash:1"), ["no\\slash", "1"]);
});

test("a Wi-Fi list keeps one entry per network, strongest first, connected on top", () => {
  const out = [" :Cafe:40:WPA2", "*:Home\\: 5G:70:WPA2", " :Home\\: 5G:90:WPA2", " :Open:55:", " ::30:WPA2", " :Hidden:20:--"].join("\n");
  const networks = platform.parseNmcliWifiList(out);
  assert.deepEqual(networks.map(n => n.ssid), ["Home: 5G", "Open", "Cafe", "Hidden"]);
  assert.equal(networks[0].connected, true);
  assert.equal(networks[0].signal, 90);
  assert.equal(networks.find(n => n.ssid === "Open").secured, false);
  assert.equal(networks.find(n => n.ssid === "Hidden").secured, false);
});

test("the active network comes from nmcli, networksetup or nothing", async () => {
  assert.equal(platform.parseNmcliActiveSsid("no:Other\nyes:Home\\: 5G\n"), "Home: 5G");
  assert.equal(platform.parseNmcliActiveSsid("no:Other\n"), null);
  assert.equal(platform.parseNetworksetupWifi("Current Wi-Fi Network: Home\n"), "Home");
  assert.equal(platform.parseNetworksetupWifi("You are not associated with an AirPort network.\n"), null);

  const linux = fakeRunner({ "nmcli -t -f ACTIVE,SSID dev wifi": "yes:Home\n" });
  assert.equal(await platform.getWifiSsid("linux", linux), "Home");
  // No NetworkManager: the older tool answers.
  const old = fakeRunner({ "iwgetid -r": "Cafe\n" });
  assert.equal(await platform.getWifiSsid("linux", old), "Cafe");
  assert.equal(await platform.getWifiSsid("linux", fakeRunner({})), null);
});

test("macOS finds its Wi-Fi device instead of assuming en0", async () => {
  const ports = "Hardware Port: Ethernet\nDevice: en4\nEthernet Address: aa\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: bb\n";
  assert.equal(platform.parseMacWifiDevice(ports), "en1");
  const runner = fakeRunner({
    "networksetup -listallhardwareports": ports,
    "networksetup -getairportnetwork en1": "Current Wi-Fi Network: Home\n"
  });
  assert.equal(await platform.getWifiSsid("darwin", runner), "Home");
});

test("joining a network never builds a shell string", () => {
  assert.deepEqual(platform.connectWifiArgs("linux", "My $Net", "pa'ss\"word;"), ["nmcli", ["dev", "wifi", "connect", "My $Net", "password", "pa'ss\"word;"]]);
  assert.deepEqual(platform.connectWifiArgs("linux", "Open", ""), ["nmcli", ["dev", "wifi", "connect", "Open"]]);
  assert.deepEqual(platform.connectWifiArgs("darwin", "Home", "pw", "en1"), ["networksetup", ["-setairportnetwork", "en1", "Home", "pw"]]);
  assert.equal(platform.connectWifiArgs("win32", "x", "y"), null);
});

test("macOS reports a failed join even though networksetup exits 0", async () => {
  const runner = fakeRunner({
    "networksetup -listallhardwareports": "Hardware Port: Wi-Fi\nDevice: en0\n",
    "networksetup -setairportnetwork en0 Home bad": "Failed to join network Home.\nError: -3900\n"
  });
  await assert.rejects(() => platform.connectWifi("darwin", "Home", "bad", runner), /Failed to join/);
});

test("a macOS scan falls back to the current network when airport is gone", async () => {
  const runner = fakeRunner({
    "networksetup -listallhardwareports": "Hardware Port: Wi-Fi\nDevice: en0\n",
    "networksetup -getairportnetwork en0": "Current Wi-Fi Network: Home\n"
  });
  const networks = await platform.scanWifi("darwin", runner);
  assert.deepEqual(networks.map(n => [n.ssid, n.connected]), [["Home", true]]);
});

test("the airport scan reads names with spaces", () => {
  const out = [
    "                            SSID BSSID             RSSI CHANNEL HT CC SECURITY (auth/unicast/group)",
    "                       Home Net aa:bb:cc:dd:ee:ff -50  36      Y  IT WPA2(PSK/AES/AES)",
    "                           Open 11:22:33:44:55:66 -80  1       Y  IT NONE"
  ].join("\n");
  const networks = platform.parseAirportScan(out);
  assert.deepEqual(networks.map(n => n.ssid), ["Home Net", "Open"]);
  assert.equal(networks[0].signal, 100);
  assert.equal(networks[1].secured, false);
});

test("bluetoothctl output becomes devices with their state", () => {
  const list = "Device AA:BB:CC:DD:EE:01 WH-1000XM4\n[NEW] Device AA:BB:CC:DD:EE:02 Magic Mouse\nnot a device\n";
  assert.deepEqual(platform.parseBluetoothctlDevices(list), [
    { mac: "AA:BB:CC:DD:EE:01", name: "WH-1000XM4" },
    { mac: "AA:BB:CC:DD:EE:02", name: "Magic Mouse" }
  ]);
  const info = platform.parseBluetoothctlInfo("Device AA:BB:CC:DD:EE:01 (public)\n\tName: WH-1000XM4\n\tAlias: Headphones\n\tIcon: audio-headset\n\tPaired: yes\n\tConnected: yes\n\tBattery Percentage: 0x64 (100)\n");
  assert.deepEqual(info, { connected: true, paired: true, icon: "audio-headset", name: "Headphones", battery: 100 });
  assert.equal(platform.parseBluetoothctlInfo("Connected: no\n").connected, false);
});

test("blueutil lines are not all 'connected' just because they say 'not connected'", () => {
  const out = [
    'address: aa-bb-cc-dd-ee-01, connected, not favourite, paired, name: "AirPods", recent access date: 2026-01-01',
    'address: aa-bb-cc-dd-ee-02, not connected, not favourite, paired, name: "Magic Keyboard", recent access date: 2026-01-01'
  ].join("\n");
  const devices = platform.parseBlueutilDevices(out);
  assert.deepEqual(devices.map(d => [d.mac, d.connected, d.type]), [["AA:BB:CC:DD:EE:01", true, "earbuds"], ["AA:BB:CC:DD:EE:02", false, "keyboard"]]);
});

test("Linux lists every paired device with its own state", async () => {
  const runner = fakeRunner({
    "bluetoothctl devices": "Device AA:BB:CC:DD:EE:01 Buds\nDevice AA:BB:CC:DD:EE:02 Speaker\n",
    "bluetoothctl info AA:BB:CC:DD:EE:01": "Name: Buds\nIcon: audio-headset\nConnected: yes\nBattery Percentage: 0x32 (50)\n",
    "bluetoothctl info AA:BB:CC:DD:EE:02": "Name: Speaker\nIcon: audio-card\nConnected: no\n"
  });
  const devices = await platform.listBluetooth("linux", runner);
  assert.deepEqual(devices.map(d => [d.name, d.type, d.connected, d.battery]), [["Buds", "headphones", true, 50], ["Speaker", "speaker", false, null]]);
});

test("a watcher listing uses the Connected filter, and still works on an older BlueZ", async () => {
  const modern = fakeRunner({
    "bluetoothctl devices Connected": "Device AA:BB:CC:DD:EE:01 Buds\n",
    "bluetoothctl info AA:BB:CC:DD:EE:01": "Connected: yes\nBattery Percentage: 0x32 (50)\n"
  });
  assert.equal((await platform.listBluetooth("linux", modern, { onlyConnected: true })).length, 1);

  const old = fakeRunner({
    "bluetoothctl devices Connected": Object.assign(new Error("bad"), { code: 1 }),
    "bluetoothctl devices": "Device AA:BB:CC:DD:EE:01 Buds\nDevice AA:BB:CC:DD:EE:02 Speaker\n",
    "bluetoothctl info AA:BB:CC:DD:EE:01": "Connected: yes\n",
    "bluetoothctl info AA:BB:CC:DD:EE:02": "Connected: no\n"
  });
  assert.deepEqual((await platform.listBluetooth("linux", old, { onlyConnected: true })).map(d => d.mac), ["AA:BB:CC:DD:EE:01"]);
});

test("Bluetooth power uses whichever tool works, and fails only when none does", async () => {
  const both = fakeRunner({ "rfkill unblock bluetooth": "", "bluetoothctl power on": "Changing power on succeeded\n" });
  await platform.setBluetoothPower("linux", true, both);
  assert.deepEqual(both.calls, ["rfkill unblock bluetooth", "bluetoothctl power on"]);

  const onlyRfkill = fakeRunner({ "bluetoothctl power off": "Failed to set power off: org.bluez.Error.Failed\n", "rfkill block bluetooth": "" });
  await platform.setBluetoothPower("linux", false, onlyRfkill);

  await assert.rejects(() => platform.setBluetoothPower("linux", false, fakeRunner({})));
});

test("diffBluetooth announces only changes, never the first listing's devices twice", () => {
  const buds = { mac: "A", name: "Buds", type: "earbuds", connected: true, battery: null };
  const first = platform.diffBluetooth(new Map(), [buds]);
  assert.deepEqual(first.events.map(e => e.event), ["connected"]);

  const same = platform.diffBluetooth(first.next, [buds]);
  assert.deepEqual(same.events, []);

  const battery = platform.diffBluetooth(same.next, [{ ...buds, battery: 80 }]);
  assert.deepEqual(battery.events.map(e => [e.event, e.battery]), [["battery", 80]]);

  const gone = platform.diffBluetooth(battery.next, []);
  assert.deepEqual(gone.events.map(e => e.event), ["disconnected"]);
});

test("bluetooth types use the names the desktop already draws", () => {
  assert.equal(platform.bluetoothType("audio-headphones", ""), "headphones");
  assert.equal(platform.bluetoothType("input-mouse", ""), "mouse");
  assert.equal(platform.bluetoothType("", "AirPods Pro"), "earbuds");
  assert.equal(platform.bluetoothType("", "Something"), "bluetooth");
});

test("playerctl sessions are read in milliseconds, and Spotify wins unless any player is asked for", () => {
  const sep = platform.MPRIS_SEPARATOR;
  const line = (...fields) => fields.join(sep);
  const out = [
    line("firefox", "Playing", "Artist A", "Video", "", "5000000", "60000000", "https://img/a.jpg"),
    line("spotify", "Paused", "Artist B", "Song", "Album", "1000000", "200000000", "file:///tmp/cover.png")
  ].join("\n");
  const sessions = platform.parsePlayerctlSessions(out);
  assert.equal(sessions[1].positionMs, 1000);
  assert.equal(sessions[1].durationMs, 200000);
  assert.equal(sessions[0].isPlaying, true);
  assert.equal(platform.pickMediaSession(sessions, false).app, "spotify");
  assert.equal(platform.pickMediaSession(sessions, true).app, "firefox");
  assert.equal(platform.pickMediaSession([], true), null);
});

test("playerctl controls follow the desktop's commands", () => {
  assert.deepEqual(platform.playerctlControlArgs("toggle", "spotify"), ["-p", "spotify", "play-pause"]);
  assert.deepEqual(platform.playerctlControlArgs("prev", null), ["previous"]);
  assert.deepEqual(platform.playerctlControlArgs("seek 90500", "spotify"), ["-p", "spotify", "position", "90.5"]);
  assert.equal(platform.playerctlControlArgs("seek nope", "spotify"), null);
  assert.equal(platform.playerctlControlArgs("explode", "spotify"), null);
});

test("media says 'not available' where it cannot work, and 'nothing playing' when it can", async () => {
  assert.equal((await platform.getMediaSession("darwin", false, fakeRunner({}))).unsupported, true);
  const missing = await platform.getMediaSession("linux", false, fakeRunner({}));
  assert.equal(missing.unsupported, true);
  assert.match(missing.error, /playerctl/);

  const none = fakeRunner({ ["playerctl -a metadata --format " + platform.MPRIS_FORMAT]: Object.assign(new Error("No players found"), { code: 1 }) });
  assert.deepEqual(await platform.getMediaSession("linux", false, none), { ok: true, session: null });
});

test("controlling the player targets the player that was picked", async () => {
  const format = platform.MPRIS_FORMAT;
  const sep = platform.MPRIS_SEPARATOR;
  const runner = fakeRunner({
    ["playerctl -a metadata --format " + format]: ["spotify", "Playing", "A", "T", "", "0", "1000000", ""].join(sep) + "\n",
    "playerctl -p spotify next": ""
  });
  assert.deepEqual(await platform.controlMedia("linux", "next", false, runner), { ok: true });
});

test("extractZip writes files and refuses names that escape the folder", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "hyadeos-zip-"));
  try {
    const good = createZip([{ name: "disk/server.js", data: Buffer.from("console.log(1)") }]);
    assert.equal(extractZip(good, path.join(folder, "ok")), 1);
    assert.equal(fs.readFileSync(path.join(folder, "ok", "disk", "server.js"), "utf8"), "console.log(1)");

    for (const name of ["../escape.txt", "a/../../escape.txt", "/abs.txt", "C:evil.txt"]) {
      assert.throws(() => extractZip(createZip([{ name, data: Buffer.from("x") }]), path.join(folder, "bad")), /Unsafe path/, name);
    }
    assert.equal(fs.existsSync(path.join(folder, "escape.txt")), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
