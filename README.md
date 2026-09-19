# Hyperly

_One overlay, no tab, no trace._

<a href="https://github.com/attaquarks/Hyperly">
  <img src="/images/hyperly-v1-listen.png" alt="The Hyperly overlay in Listen mode: live transcript, prompt tabs, and the answer panel, floating over the desktop" width="100%" />
</a>

<p align="center"><i>The actual overlay in Listen mode, floating over the desktop. Invisible on screen shares.</i></p>

---

[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri-orange)](https://tauri.app/)
[![Frontend](https://img.shields.io/badge/Frontend-React%20%2B%20TypeScript-blue)](https://react.dev/)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue)](./LICENSE)
[![Windows](https://img.shields.io/badge/Platform-Windows-0078D4)](https://www.microsoft.com/windows)

> **Your invisible AI, over everything you do.** Ask about anything on your screen. Listen to any conversation and have the right answer before you need it. One overlay, no tab, no trace. Invisible on screen shares, and no bot ever joins your calls.

Hyperly is a privacy-first, AI-powered desktop overlay for Windows. It started life as a fork of Pluely v0.x (GPL-3.0); the Pro / payment / analytics layer was removed and the rest of the app was kept intact, then re-branded and re-released as Hyperly. The source here is yours to read, audit, and modify.

## ✨ What is Hyperly?

Hyperly is a translucent overlay that floats on top of any application. It has two main modes plus a full dashboard.

|         🪶 **Lightweight**          |             🕶️ **Invisible**             |                ⚡ **Instant**                |
| :---------------------------------: | :--------------------------------------: | :------------------------------------------: |
|      **9 to 16 MB** installer       | Hidden from screen shares and recordings |  Launches in under 100ms, answers in a tap   |
| A fraction of Electron alternatives | No meeting bot, no participant, no trace | Global hotkeys summon it from inside any app |
|   Minimal CPU and RAM, even live    |  Can hide from the taskbar too           |    Streaming answers, live transcription     |

## 💬 Ask mode

<img src="/images/hyperly-v1-ask.gif" alt="Ask mode: attach a screenshot, ask a question, get a streamed answer with follow-up suggestions" width="100%" />

Type a question, dictate it with push-to-talk, or let Hyperly see your screen: capture it, drag-select a region, attach files, or turn on **Use image** so every message carries a fresh screenshot. Documents go through built-in OCR and stay in context for follow-up questions. Answers stream in as Markdown, and everything is saved locally where you can search, export, or delete it.

## 🎧 Listen mode

<img src="/images/hyperly-v1-listen.gif" alt="Listen mode: live transcript of a meeting, an automatic suggested answer, and one-tap follow-up chips" width="100%" />

Hit **Start** and Hyperly transcribes your mic and system audio live, with speaker labels and language selection. In **manual** mode (the default), you decide when to send a clip for an AI answer. In **auto** mode, automatic responses fire when someone asks a question, after every pause, or only when you tap Suggest. Smart follow-up chips appear under each answer, generated from the actual conversation. Every session is saved as a meeting with its full transcript.

## 🧰 What else is in the box

- **Free forever with your own keys**: connect any LLM or speech-to-text provider through a curl template — model lists auto-detect on OpenAI-compatible endpoints — or plug in the AI CLIs you already have (Claude Code, Gemini CLI, Codex, Qwen Code, Ollama). No limits from us; it's your account.
- **Real stealth**: excluded from screen capture, absent from recordings and screenshots, never steals focus from the app you're in, and the icon can disappear from the taskbar.
- **Keyboard-first**: global hotkeys for summon, capture, and listening; single keys scroll the answer and transcript once the overlay has focus.
- **Private by architecture**: chats, meetings, transcripts, and files live in a local SQLite database on your machine. Your own provider keys stay local. Your conversations never train anything.
- **Light & dark themes**, a relay panel with sidebar to browse past conversations, custom prompts with knowledge files, and a document library.

## 📥 Download & install

Pre-built installers are published on the [Releases](https://github.com/attaquarks/Hyperly/releases) page.

**Available formats:** `.msi` / `.exe` (Windows)

No account is needed to start. Updates ship automatically.

## 🛠 Build from source

See [BUILD.md](./BUILD.md) for prerequisites and step-by-step build instructions. The short version on Windows + WSL is:

```powershell
cd C:\Users\Atta\Documents\Projects\Hyperly
npm install
npm run tauri build
```

The output lands in `src-tauri\target\release\bundle\`.

## 🐛 Feedback & bug reports

Found a bug or have an idea? Open a [GitHub issue](https://github.com/attaquarks/Hyperly/issues).

## 📄 License

Hyperly is released under the **GNU General Public License v3.0**. See [LICENSE](./LICENSE) for the full text. The code is open; the brand is `Hyperly`, owned by this repository. If you fork it, please pick your own name and identifier (see the `productName` and `identifier` fields in `src-tauri/tauri.conf.json`).

## 🙏 Acknowledgments

- **[Tauri](https://tauri.app/)** — desktop framework
- **[tauri-nspanel](https://github.com/ahkohd/tauri-nspanel)** — macOS native panel integration for Tauri
- **[shadcn/ui](https://ui.shadcn.com/)** — UI components
- **[Pluely](https://github.com/iamsrikanthnani/pluely)** — the GPL-3.0 codebase Hyperly was forked from

## 🔗 Links

- **Repository:** [github.com/attaquarks/Hyperly](https://github.com/attaquarks/Hyperly)
- **Issues:** [GitHub Issues](https://github.com/attaquarks/Hyperly/issues)
- **Releases:** [GitHub Releases](https://github.com/attaquarks/Hyperly/releases)
