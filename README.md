<img width="450" alt="HyadeOSS" src="https://github.com/user-attachments/assets/41c7b3f5-6e0e-47d4-8984-e549f3be257e" />

# hyadeOSS Beta

> **This is the beta channel.** It gets new things before [stable](https://github.com/hyadeOSS/stable),
> and it may have bugs. Switch to it in **Settings › Updates**, and go back to stable the same way.
>
> **New in this beta: the same hyadeOSS on Windows, Linux and macOS.** Wi-Fi, Bluetooth, what is
> playing and Sandbox no longer need Windows tools. See [Linux and macOS](#linux-and-macos).

**A light, modern desktop that runs on your PC**: its own design, accounts, an app store
and safe automatic updates. Open source, no ads, no data collected.

## Download

**[Download hyadeOSS for Windows](https://github.com/HyadeOSS/stable/releases)** —
the installer needs nothing else (no Git, no Node.js). Your data lives in your Windows user
folder, so updates and reinstalls never touch it.

Already using hyadeOSS? It updates itself: **Settings › Updates › Check for updates**.

## Linux and macOS

hyadeOSS is still an Electron app: it needs Node.js 22 and, to start the desktop, Electron.

```bash
npm install
npm run desktop
```

What each system uses for its own hardware (all optional: a feature whose tool is missing is
simply empty or off, never an error):

| Feature | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Wi-Fi: status, scan, connect, on/off | PowerShell + netsh | NetworkManager (`nmcli`) | `networksetup` |
| Bluetooth: devices, connect, on/off | Windows Bluetooth | BlueZ (`bluetoothctl`, `rfkill`) | `blueutil` |
| Connect/disconnect alerts with battery | Windows Bluetooth | `bluetoothctl` | `blueutil` |
| What is playing | Windows media session | `playerctl` | not available yet |
| Windows keys (Win+S, Win+W…) | system hook | the Super key, inside the window | the Command key, inside the window |

Known limits: on macOS 14.4 and later the Wi-Fi name is hidden from programs that have no Location
permission, and the old `airport` scanner is gone, so the list may show only the network you are on.

## What you get

- **A real desktop.** Start, windows that snap, virtual desktops, and the Windows keys
  working inside hyadeOSS (Win, Win+L, Win+D, Win+arrows, Win+V, Win+Shift+S…).
- **Global search** (Win+S): apps, your files, settings and quick calculations.
- **Widgets** (Win+W): clock, weather, today's events, notes and what is playing.
- **Live wallpapers** (MP4, WebM, GIF), a dynamic island for music, timers and updates.
- **Accounts.** Several users with their own password and files, a guest account,
  parental controls and a personal backup.
- **App store.** Apps from GitHub, with the permissions they ask for shown before you
  install, and optional automatic updates.
- **Safe updates.** Every release is checked before it is applied, and hyadeOSS goes back
  to the previous version by itself if an update does not start.
- **Private by default.** The optional anonymous usage count sends only the version and
  update channel, once a day, and only if you turn it on.

## Build apps for hyadeOSS

hyadeOSS apps are web pages in a GitHub repository. The SDK gives them notifications, files
(with the user's permission), the system theme and more. See the developer guide in the
[hyadeOSS organisation](https://github.com).

## Community

- Website: [hyadeoss.github.io](https://hyadeoss.github.io)
- TikTok: [@mariowos](https://tiktok.com)
- Report a bug or suggest a feature on our Discord, or open an issue here.

## License

Apache License 2.0. hyadeOSS uses open-source fonts from Google Fonts and community
npm packages; all credit goes to their authors.
