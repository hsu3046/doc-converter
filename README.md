# Doc Converter

## Tagline-en

From handwritten notes to recordings and chat logs, organize scattered records into clean and easy-to-read documents.

## Tagline-ko

손글씨 메모, 녹음 파일, 채팅 기록까지. 흩어진 기록들을 자동으로 정리하고 읽기 쉬운 문서 형태로 변환해보세요.

## Tagline-ja

手書きメモ、録音データ、チャット履歴まで。散らばった記録を整理し、読みやすいドキュメントとして残せます。

---

## Summary-en

Organizing important records often takes far more time than expected.
Handwritten notes, long audio recordings, hundreds of chat messages — every source looks different, and sorting everything manually can quickly become exhausting.

Doc Converter is designed to make that process feel simpler and more natural.

It can read text from document images, turn speech into text, and organize long chat histories into a cleaner, easier-to-read format.
The results are saved as date-based files, making it easier to search, manage, and continue working later.

Long meeting recordings can also be automatically turned into transcripts and meeting notes,
with customizable formats that fit your own workflow and style.

A simpler way to keep scattered records
organized, readable, and easier to manage.

## Summary-ko

중요한 기록을 정리하는 일은 생각보다 훨씬 많은 시간을 필요로 합니다.
손글씨 메모, 긴 녹음 파일, 수백 개의 채팅 대화까지.
자료는 항상 제각각이고, 필요한 내용만 다시 정리하는 과정도 꽤 번거롭죠.

Doc Converter는 그런 흐름을 조금 더 자연스럽고 편하게 정리해주는 툴입니다.

문서 이미지 속 글자를 읽어내고, 음성을 텍스트로 변환하고, 긴 채팅 기록도 보기 쉽게 정리해줍니다.
완성된 결과는 날짜별로 파일 형태로 저장되어, 필요한 내용을 다시 찾거나 이어서 관리하기 쉽습니다.

긴 회의 녹음 파일도 자동으로 녹취록과 회의록 형태로 정리할 수 있으며,
회의록 스타일 역시 원하는 방식에 맞게 직접 커스터마이즈할 수 있습니다.

흩어진 기록들을,
조금 더 읽기 쉽고 관리하기 편한 형태로 남길 수 있도록.

## Summary-ja

大切な記録を整理する作業は、思っている以上に時間がかかります。
手書きのメモ、長時間の録音データ、何百件ものチャット履歴まで。
資料の形式はいつもバラバラで、必要な内容だけを整理し直すのも意外と大変です。

Doc Converter は、そんな流れをもっと自然でスムーズに整えるためのツールです。

書類画像の文字を読み取り、音声をテキスト化し、長いチャット履歴も見やすく整理してくれます。
整理されたデータは日付ごとのファイルとして保存されるため、後から必要な内容を探したり、続けて管理するのも簡単です。

長時間の会議録音も、自動で文字起こしや議事録として整理でき、
議事録のスタイルも好みに合わせて自由にカスタマイズできます。

散らばった記録を、
もっと読みやすく、管理しやすい形で残せるように。

---

## ✨ What It Does

- **OCR — handwriting & PDF → Markdown** — 2-pass Gemini scan: Pass 1 (Flash) extracts raw text and marks unclear glyphs with `[?]`, Pass 2 (Pro) re-reads the original alongside Pass 1 output to fix typos, recover `[?]` from context, and structure the result as Markdown. Oversized PDFs auto-fall back to local `poppler` rasterization.
- **Audio → text** — speech recordings (`.m4a`, `.mp3`, `.wav`, `.qta`, `.aac`, `.ogg`, `.flac`) become two Markdown files: a timestamped verbatim log and a clean reading version. Long recordings (≤ 4h, ≤ 1GB) auto-split into 10-min chunks and process **sequentially**, with each chunk's last few utterances injected as context to the next chunk's prompt — speaker labels stay consistent across chunks (no post-hoc reconciliation needed). Recording timestamp metadata (m4a / mp4 `creation_time`) is preserved in the frontmatter.
- **VAD — silence trimming before STT** *(default ON)* — local **Silero VAD** (ONNX, no network call, no API cost) detects speaker utterances and trims dead air *before* the Gemini upload. Robust to café / office background noise unlike dB-threshold silence detection. Typical 30–40% reduction in Gemini input duration on real meeting recordings; meeting-note timestamps are remapped back to original recording time so `[HH:MM:SS]` markers still match the wall clock. Uses ffmpeg's `concat` demuxer for fast assembly (handles 400+ segments in ~30s).
- **Meeting notes — transcript → structured notes** — converts any transcript into structured meeting notes using a Markdown "skill" template (frontmatter + body, Anthropic Skills pattern). Ships with three built-in templates (`general`, `detailed`, `team-sync`); drop your own `.md` into `~/.doc-converter/meeting-templates/` (or upload via the UI) for 1:1, standup, retro, sales-call, etc. Two LLM providers (Claude Sonnet 4.6 default, Gemini 3.1 Pro) and four detail levels (`concise`, `standard`, `detailed`, `verbatim`).
- **Chat log → date-bucketed Markdown** — parses KakaoTalk CSV and Instagram HTML exports, slices conversations into 7-day chunks, one Markdown file per bucket.
- **Speaker management UI** — after transcription, every detected speaker shows up with utterance count + share-of-talk; a single click renames a label across the whole transcript or deletes all utterances from a speaker (useful for filtering background noise or third-party labels).
- **Real-time progress streaming** — Server-Sent Events stream live phase updates (`Pass 1 → Pass 2`, `청크 3/12 처리 중…`) to the browser UI without polling. Cost + token usage shown per request.
- **Error tracing** — every catchable failure is captured to `~/.doc-converter/logs/YYYY-MM-DD.jsonl` with full stack, `err.cause` chain (5 levels deep — catches the real culprit behind Node fetch's wrapped `fetch failed`), HTTP status, response body (truncated to 1 KB), and context (`jobId / chunkIndex / model / filename`). The UI shows a **상세 (Details)** button next to every ❌ progress line that opens a modal with the structured trace; the modal footer has a **Open logs folder** button (Finder on Electron, clipboard copy on web). Network errors (`ECONNRESET / UND_ERR_SOCKET / fetch failed / ETIMEDOUT`) and HTTP 429/5xx now auto-retry up to 4 times with exponential backoff at every layer (Gemini File API upload, polling, and `generateContent`).
- **Three ways to run** — macOS Electron app (`.dmg`, end users), browser UI on `localhost` (`npm run ui`), or a Commander.js CLI for scripting.
- **CJK-safe everywhere** — fixes the `multer`/`busboy` Latin-1 filename bug so Korean/Japanese filenames survive upload + frontmatter. STT prompt outputs Korean speaker labels (`화자A`, `화자B`).

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js (ESM, `"type": "module"`) |
| Language | TypeScript (Strict) |
| AI Engines | Google Gemini (`@google/genai`) + Anthropic Claude (`@anthropic-ai/sdk`) |
| Voice Activity Detection | **Silero VAD v5** (ONNX) + `onnxruntime-node` — fully local, ~2 MB model bundled |
| Desktop App | Electron 42 + electron-builder (`.dmg` for macOS arm64) |
| Audio Tooling | `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` (npm bundled, no system install) |
| PDF Fallback | `pdf-poppler` (npm bundled) |
| CLI Framework | Commander.js |
| Web Server | Express 5 |
| File Upload | Multer |
| Progress Streaming | Server-Sent Events (SSE) |
| CSV Parsing | csv-parse |
| API Key Storage | macOS Keychain via `security` CLI (Electron) |
| UI Icons | Lucide |

---

## 📦 Installation

### macOS desktop app (Electron — recommended for end users)

No Node, ffmpeg, or terminal required.

1. Build the `.dmg` (one-time, on a developer machine):
   ```bash
   npm install
   npm run dist:mac
   # → dist-electron/Doc Converter-1.0.0-arm64.dmg  (Apple Silicon)
   ```
   > Single-arch (arm64) build by default. For Intel Macs, edit `electron-builder.yml` to add `- x64` to `mac.target.arch` and rebuild.

2. Distribute the `.dmg`. Each user:
   - Double-click the `.dmg` → drag **Doc Converter** into **Applications**
   - **First launch**: macOS shows an "unidentified developer" warning (the app is unsigned)
     → Finder → right-click → **Open** → **Open** again (one-time only)
   - Click **Settings (⚙️)** in the header → enter `GEMINI_API_KEY` and `CLAUDE_API_KEY`
     - Keys are stored securely in macOS Keychain (not on disk)
     - Get keys: [Google AI Studio](https://aistudio.google.com/apikey) · [Anthropic Console](https://console.anthropic.com/settings/keys)

3. Output files auto-save to `~/Documents/Doc Converter Output/`; custom templates live in `~/.doc-converter/meeting-templates/`. Both folders are reachable from the menu bar.

`ffmpeg`, `ffprobe`, and `poppler` are all bundled inside the app — **no separate install needed**.

### Developer install (CLI / Web UI / source contribution)

```bash
git clone https://github.com/hsu3046/doc-converter.git
cd doc-converter
npm install
cp .env.example .env.local   # Fill in GEMINI_API_KEY and CLAUDE_API_KEY
```

**Run the browser UI:**

```bash
npm run ui -- --port 4000
# Open http://localhost:4000
```

**Run the Electron app in dev mode:**

```bash
npm run dev:electron
```

**Run the CLI directly:**

```bash
# OCR: handwritten images or PDFs
npx tsx src/cli.ts ocr ./scans/*.jpg -o ./output

# Transcribe audio (add --trim-silence to drop dead air via local VAD before upload)
npx tsx src/cli.ts transcribe ./recordings/*.m4a -o ./output
npx tsx src/cli.ts transcribe ./meeting.qta --trim-silence -o ./output

# Split chat log
npx tsx src/cli.ts chat-split ./exports/kakao.csv -o ./output

# Generate meeting notes from a transcript
npx tsx src/cli.ts meeting-notes ./output/meeting_clean.md -t general -o ./output

# Detail level + provider
npx tsx src/cli.ts meeting-notes ./output/meeting_clean.md -t detailed -d detailed -p claude

# List available templates (builtin + ~/.doc-converter/meeting-templates/)
npx tsx src/cli.ts meeting-notes --list

# One-shot: transcribe + meeting notes in a single run
npx tsx src/cli.ts transcribe ./meeting.mp3 --notes detailed --notes-detail detailed --notes-provider claude
```

#### Built-in templates
- **`general`** — concise summary (Summary / Decisions / Discussion / Actions / Open Questions)
- **`detailed`** — topic-by-topic with verbatim quotes + decisions + actions, suitable for serious record-keeping
- **`team-sync`** — full project-meeting record (Information Sharing / Idea Flash / Decisions·Branding / Priority-banded To-Do / Upcoming Schedule)

#### Detail levels
- **`concise`** — 5–7 lines max, no quotes
- **`standard`** — balanced (default)
- **`detailed`** — paragraph-per-topic, 1–3 verbatim quotes per topic
- **`verbatim`** — heavy on original quotes, 5–10 sentences per topic

#### LLM providers
Pick per request via the UI radio button or `--provider` / `--notes-provider` CLI flag:
- **`claude`** (default) — Claude Sonnet 4.6 via `CLAUDE_API_KEY`
- **`gemini`** — Gemini 3.1 Pro via `GEMINI_API_KEY` (also required for OCR and audio regardless of provider choice)

#### Custom meeting note templates

Drop a Markdown file into `~/.doc-converter/meeting-templates/` (auto-created on first run). Format:

```markdown
---
name: 1:1 Meeting Notes
description: Manager + direct report — bidirectional commitments
language: ko
---

You are writing meeting notes from the transcript below using the structure that follows.

## Topics Discussed
...

## Decisions
- ...

## Manager Action Items
- [ ] ...

## Direct Report Action Items
- [ ] ...

## Next 1:1 Agenda
- ...
```

`name` is required. The entire body is injected verbatim into the LLM prompt — describe the structure however you like.

#### System dependencies (developer install only)

CLI mode (`npx tsx …`) needs `ffmpeg` and `poppler` for audio chunk splitting and PDF rasterization fallback:

```bash
brew install ffmpeg poppler
```

> Electron app users get these bundled inside the app — no extra install.

---

## 📁 Project Structure

```
doc-converter/
├── electron/
│   ├── main.cjs                # Electron main process (CJS — required for `electron` import)
│   └── preload.cjs             # IPC bridge (Settings, folder access, download toast)
├── src/
│   ├── cli.ts                  # CLI entry point (Commander.js)
│   ├── commands/
│   │   ├── ocr.ts              # OCR command handler
│   │   ├── transcribe.ts       # Audio transcription command
│   │   ├── chat-split.ts       # Chat log splitting command
│   │   └── meeting-notes.ts    # Meeting notes command
│   ├── services/
│   │   ├── gemini.ts           # Gemini API client + retry wrapper
│   │   ├── anthropic.ts        # Claude API client
│   │   ├── ocr-pipeline.ts     # OCR 2-pass pipeline (poppler fallback)
│   │   ├── audio-pipeline.ts   # Sequential chunk audio pipeline
│   │   ├── meeting-notes-pipeline.ts  # Notes generation (template + provider)
│   │   ├── chat-processor.ts   # Chat log parser (KakaoTalk, Instagram)
│   │   └── template-loader.ts  # Built-in + user templates
│   ├── meeting-templates/builtin/      # general.md / detailed.md / team-sync.md
│   ├── ui/
│   │   ├── server.ts           # Express server + SSE streaming
│   │   └── public/index.html   # Browser UI (used by both Web and Electron)
│   ├── templates/              # Output frontmatter builder
│   ├── types/                  # Shared TypeScript type definitions
│   └── utils/
│       ├── audio-splitter.ts   # ffmpeg chunking + recording-time probe
│       ├── pdf-extractor.ts    # poppler PDF → PNG fallback
│       ├── vad.ts              # Silero VAD ONNX wrapper (local speech detection)
│       ├── trim-silence.ts     # VAD → ffmpeg concat-demuxer trim + timestamp map
│       ├── error-logger.ts     # ~/.doc-converter/logs/*.jsonl + ring buffer
│       └── file-io.ts
├── assets/
│   └── silero_vad.onnx         # Silero VAD v5 model (bundled, 2.24 MB)
├── electron-builder.yml        # macOS .dmg build config
├── build/icon.icns             # App icon (gitignored — generate via iconutil)
├── docs/
│   ├── MEMORY.md               # Project-specific decisions & bug log
│   └── IDEAS.md                # Deferred improvement ideas (with rationale)
├── dist/                       # Compiled JS output (gitignored)
├── dist-electron/              # .dmg build output (gitignored)
├── .env.example                # Environment variable template
├── .env.local                  # API keys (never commit)
├── tsconfig.json
└── package.json
```

---

## 🗺 Roadmap

See [`docs/IDEAS.md`](docs/IDEAS.md) for analyzed-but-deferred items with full rationale and trigger conditions:

1. **OCR cross-validation** — replace 2-pass (Flash + Pro) with Flash×N + reconciliation pass (~70% cost savings, pending quality validation)
2. **iPhone support** — PWA + Mac host / Capacitor sideload / native Swift options
3. **Vercel deployment** — full feature set with Webhook + Batch (Pro plan, ~10 dev-days)
4. **Meeting history RAG / Knowledge Graph / To-Do tracking** — accumulate past meetings, auto-inject context into new ones, track action items across meetings (SQLite + sqlite-vec, optional LangChain `LLMGraphTransformer`)

---

## 🤝 Contributing

Contributions are welcome:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat(scope): add amazing feature'`)
4. Push (`git push origin feat/amazing-feature`)
5. Open a Pull Request

Before non-trivial changes, please skim [`docs/MEMORY.md`](docs/MEMORY.md) — it captures load-bearing decisions (sequential audio pipeline, Electron CJS main process, asar path conversion, etc.) that are easy to break unintentionally.

---

## 📄 License

[GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html).

---

*Built by [KnowAI](https://knowai.space) · © 2026 KnowAI*
