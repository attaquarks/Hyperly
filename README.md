# Hyperly

_One overlay, no tab, no trace._

[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri-orange)](https://tauri.app/)
[![Frontend](https://img.shields.io/badge/Frontend-React%20%2B%20TypeScript-blue)](https://react.dev/)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D4)](https://www.microsoft.com/windows)

**Hyperly is a privacy-first AI overlay for the desktop.** It floats above whatever
you are doing — a video call, a terminal, a browser tab — and answers questions,
transcribes the conversation, and captures your screen without ever becoming another
window to manage. No account. No bot joining your calls. Nothing you do leaves your
machine except the API calls you configure yourself.

Built with **Tauri 2 + React + TypeScript**. The speech models ship inside the
installer, and Hyperly is free forever on your own provider keys.

---

## Two modes

### Ask — an answer to anything on screen

Type a question, dictate it with push-to-talk, or hand Hyperly your screen: full
screen capture, drag-select a region, attached files, or **Use image** so every
message carries a fresh screenshot. Text files and PDFs are parsed locally and stay
in context for follow-up questions. Answers stream in as Markdown with suggested
follow-up chips, and every conversation is saved to a local database you can
search, export, or delete.

### Listen — live transcription of both sides of a conversation

Press **Start** and Hyperly transcribes two channels at the same time:

- **User** — your microphone
- **System** — whatever the computer is playing (Zoom, Teams, a video in another tab)

The two stay separate end to end — in the transcript, and in what the model is
told — so it always knows what *you* said versus what the meeting said, even when
you talk over each other. Three capture behaviours: **Manual** (you send a clip
when you decide), **Auto** (responds when the conversation pauses or asks
something), and **Questions** (answers questions from the room, keeps the rest for
you). The microphone is never opened until you accept the in-app consent prompt,
and the capture engine never starts on its own.

---

## Highlights

- **Self-contained** — Silero VAD and the ONNX runtime are bundled
  (`public/vad/`); a first run needs no model downloads and works offline.
- **Invisible by design** — the overlay is built to stay out of screen shares,
  recordings and screenshots, never steals focus from the app you are in, and the
  taskbar icon can be hidden too.
- **Bring your own keys** — any LLM or speech-to-text provider through an HTTP
  (curl) template; model lists auto-detect on OpenAI-compatible endpoints,
  including local servers such as Ollama. Your account, your limits — none from us.
- **Private by architecture** — chats, meetings, transcripts and files live in a
  local SQLite database on your machine; provider keys stay in local settings.
  There is no Hyperly cloud, and nothing you write trains anything.
- **Keyboard-first** — global hotkeys summon it from inside any app (table below),
  and single keys scroll the answer or transcript once the overlay has focus.
- **Everything else** — light and dark themes, a relay panel with searchable
  history, custom prompts with knowledge files, a document library, and a full
  dashboard in its own window.

---

## Run it on another machine

Nothing is baked in at build time — there is **no `.env` to copy**. Provider keys,
endpoints and prompts are entered in the app's own Settings on whichever machine
it runs on (the `.env.example` in this repo exists only to document that rule).

### 1. Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 22.6** and npm 10+ | Node 22 LTS or 24 recommended. The regression-guard suite needs 22.6+ (TypeScript type-stripping) and two guards import `node:sqlite` (22.5+). |
| **Rust stable** via [rustup](https://rustup.rs) | Windows: the MSVC toolchain with the C++ build tools, or MinGW64 — [BUILD.md](./BUILD.md) covers both and the PATH setup. |
| **WebView2 runtime** (Windows) | Preinstalled on Windows 11; on Windows 10 install the [Evergreen runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/). |
| macOS / Linux | Buildable from the same commands (Xcode CLT on macOS, Tauri's system packages plus PulseAudio on Linux). Windows is the primary tested target. |

### 2. Get the code

```powershell
git clone https://github.com/attaquarks/Hyperly.git
cd Hyperly
npm install
```

### 3. Run in development

```powershell
npm run tauri dev
```

The first run compiles the Rust backend and takes a few minutes; after that the
overlay window opens. Port **1420** must be free — Vite runs in strict-port mode,
so stop any other dev instance first. (On Windows the `npm run tauri` wrapper
locates cargo and falls back to the GNU toolchain automatically; see BUILD.md.)

### 4. First-run setup, inside the app

1. **Microphone** — the first capture shows Hyperly's own consent prompt; nothing
   records until you accept. On Windows also allow *Settings → Privacy →
   Microphone* for desktop apps, or capture will be silent.
2. **Audio settings** — pick your input device. System-audio capture follows the
   default output device, so set that to the device the meeting plays through.
3. **Providers** — Settings → AI and Speech-to-text: paste an API key or point at
   a local endpoint. Nothing is needed just to build and launch.
4. **Then** — Listen → *Start*, or focus the Ask panel and press *Space*.

### 5. Verify the checkout

```powershell
npm run guards      # 17/17 regression guards (needs Node >= 22.6)
npx tsc --noEmit    # type-check
```

CI runs both of those plus `cargo check`. All three green = the checkout is sound.

### 6. Build an installer

```powershell
npm run tauri build
```

The bundle lands in `src-tauri\target\release\bundle\` (`.msi` / `.exe`; `.app` /
`.dmg` on macOS). Toolchain deep-dives and Windows troubleshooting live in
[BUILD.md](./BUILD.md).

---

## Global shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+D` | Open / close the dashboard |
| `Ctrl+\` | Show / hide the overlay |
| `Ctrl+Shift+I` | Bring the overlay forward and focus the composer |
| `Ctrl+Shift+A` | Voice input (Ask push-to-talk) |
| `Ctrl+Shift+M` | Toggle system-audio capture (Listen) |
| `Ctrl+Shift+S` | Screenshot, routed to the panel you were last on |

With a panel focused, **Space** starts/stops capture in Listen and pushes to talk
in Ask — except in a text field, where it types a space. Every binding is
rebindable under Settings → Shortcuts.

---

## Download

Pre-built installers are published on the
[Releases](https://github.com/attaquarks/Hyperly/releases) page (`.msi` / `.exe`).
No account is needed, and there is no auto-updater — new builds appear on Releases.

---

## Repository layout

| Path | What it holds |
|---|---|
| `src/` | React + TypeScript frontend (overlay, dashboard, settings) |
| `src-tauri/` | Rust backend — audio capture, VAD loop, windows, SQLite |
| `scripts/` | Regression guards behind `npm run guards` |
| `public/vad/` | Bundled speech runtime (Silero VAD, ONNX runtime, worklet) |
| `BUILD.md` | Toolchain setup and troubleshooting |

---

## Feedback & bug reports

Found a bug or have an idea? Open a
[GitHub issue](https://github.com/attaquarks/Hyperly/issues).

## License

Hyperly is released under the **GNU General Public License v3.0** — see
[LICENSE](./LICENSE). The code is open; the brand is `Hyperly`, owned by this
repository. Hyperly began as a fork of Pluely v0.x (GPL-3.0): the Pro, payment
and analytics layers were removed, the remainder rebranded and re-released as
Hyperly. If you fork it, pick your own name and identifiers (`productName` and
`identifier` in `src-tauri/tauri.conf.json`).

## Acknowledgments

- **[Tauri](https://tauri.app/)** — desktop framework
- **[tauri-nspanel](https://github.com/ahkohd/tauri-nspanel)** — macOS native panel integration for Tauri
- **[shadcn/ui](https://ui.shadcn.com/)** — UI components
- **[@ricky0123/vad-web](https://github.com/ricky0123/vad-web)** and **[Silero VAD](https://github.com/snakers4/silero-vad)** — the bundled voice activity detector
- **[Pluely](https://github.com/iamsrikanthnani/pluely)** — the GPL-3.0 codebase Hyperly was forked from

## Links

- **Repository:** [github.com/attaquarks/Hyperly](https://github.com/attaquarks/Hyperly)
- **Issues:** [GitHub Issues](https://github.com/attaquarks/Hyperly/issues)
- **Releases:** [GitHub Releases](https://github.com/attaquarks/Hyperly/releases)

4. **Then** — Listen → *Start*, or focus the Ask panel and press *Space*.
