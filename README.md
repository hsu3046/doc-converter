# 📄 doc-converter

## Tagline-en

Turn chaotic evidence into clean Markdown — OCR scans, transcribe audio, and split chat logs in seconds with Gemini AI.

## Tagline-ko

손으로 쓴 메모도, 녹음 파일도, 카카오톡 대화도 — Gemini AI 하나로 깔끔한 Markdown 문서로 바꿔드립니다.

## Tagline-ja

手書きメモも、録音ファイルも、チャットログも — Gemini AIが一気にMarkdownへ変換します。

---

## Summary-en

Evidence documentation shouldn't require hours of manual transcription. Whether it's a stack of handwritten notes, a voice recording from a meeting, or months of chat history, the raw material is always messy — and turning it into a readable, searchable document takes too long. doc-converter changes that. It runs your files through a two-pass Gemini AI pipeline that extracts text with high accuracy, then cleans and structures it into well-formatted Markdown. Drop your files into the browser UI, watch the progress stream in real time, and get polished documents ready for use — all without leaving your machine.

## Summary-ko

중요한 기록을 직접 타이핑하며 옮기는 작업은 생각보다 훨씬 고됩니다. 손글씨 문서, 오랜 녹음 파일, 수백 건의 채팅 대화 — 원본은 언제나 제각각이고 정리에는 시간이 걸리죠. doc-converter는 이 문제를 해결합니다. Gemini AI 기반의 2-Pass 파이프라인이 OCR, 음성 전사, 채팅 분할을 자동으로 처리하고, 결과는 날짜별로 정리된 Markdown 파일로 깔끔하게 저장됩니다. 브라우저 UI에서 파일을 올리면 실시간으로 진행 상황을 확인할 수 있어, 복잡한 설정 없이 바로 시작할 수 있습니다.

## Summary-ja

手書きの記録を一文字ずつタイピングし直す作業は、思った以上に骨が折れます。走り書きのメモ、長時間の録音、膨大なチャット履歴 — 素材はいつもバラバラで、整理には時間がかかります。doc-converterはそのストレスをなくします。Gemini AIによる2パスパイプラインがOCR・音声書き起こし・チャット分割を自動処理し、結果は日付ごとに整理されたMarkdownとして保存されます。ブラウザUIにファイルをアップロードすれば、進捗をリアルタイムで確認しながら、すぐに使えるドキュメントが手に入ります。

---

## ✨ What It Does

- **OCR with confidence** — Runs a two-pass Gemini AI scan on handwritten images and PDFs, correcting errors in the second pass for higher accuracy.
- **Transcribes audio intelligently** — Converts voice recordings (`.m4a`, `.mp3`, etc.) into two Markdown files: one timestamped verbatim log and one cleaned-up clean transcript. Long files (≤ 2.5h, ≤ 250MB) are auto-split into 10-minute chunks, processed in parallel, and reconciled to keep speaker labels consistent across chunks.
- **Splits chat logs by date** — Parses KakaoTalk and Instagram CSV/HTML exports and automatically slices them into 7-day chunked Markdown files.
- **Generates meeting notes from transcripts** — Converts a transcript into structured meeting notes using a Markdown "skill" template (frontmatter `name` + body). Ships with one built-in `general` template; drop your own `.md` files into `~/.doc-converter/meeting-templates/` (or upload via the UI) for 1:1, standup, retro, sales-call, etc.
- **Streams progress in real time** — Uses Server-Sent Events (SSE) to push live phase updates (`Pass 1 → Pass 2`) directly to the browser UI without polling.
- **Handles extreme-resolution PDFs gracefully** — Auto-detects oversized scans that exceed Gemini's limits and falls back to a local `poppler` rasterization pipeline.
- **Runs anywhere via CLI or browser** — Supports both a command-line interface for scripting and a full browser-based drag-and-drop UI on `localhost`.
- **Preserves CJK filenames** — Fixes the known `multer`/`busboy` Latin-1 encoding bug so Korean and Japanese filenames pass through without corruption.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js (ESM, `"type": "module"`) |
| Language | TypeScript (Strict) |
| AI Engine | Google Gemini (`@google/genai`) |
| CLI Framework | Commander.js |
| Web Server | Express 5 |
| File Upload | Multer |
| Progress Streaming | Server-Sent Events (SSE) |
| CSV Parsing | csv-parse |
| Local PDF Fallback | poppler (`pdftoppm`) |

---

## 📦 Installation

```bash
git clone https://github.com/KnowAI/doc-converter.git
cd doc-converter
npm install
cp .env.example .env.local   # Fill in your GEMINI_API_KEY
```

**Run the browser UI:**

```bash
npm run ui -- --port 4000
# Open http://localhost:4000
```

**Run the CLI directly:**

```bash
# OCR: handwritten images or PDFs
npx tsx src/cli.ts ocr ./scans/*.jpg -o ./output

# Transcribe audio
npx tsx src/cli.ts transcribe ./recordings/*.m4a -o ./output

# Split chat log
npx tsx src/cli.ts chat-split ./exports/kakao.csv -o ./output

# Generate meeting notes from a transcript
npx tsx src/cli.ts meeting-notes ./output/meeting_clean.md -t general -o ./output

# Detail level: concise | standard | detailed | verbatim (default: standard)
npx tsx src/cli.ts meeting-notes ./output/meeting_clean.md -t detailed -d detailed

# List available templates (builtin + ~/.doc-converter/meeting-templates/)
npx tsx src/cli.ts meeting-notes --list

# One-shot: transcribe + meeting notes in a single run
npx tsx src/cli.ts transcribe ./meeting.mp3 --notes detailed --notes-detail detailed
```

### Built-in templates
- `general` — concise summary (요약/결정/논점/액션/후속질문)
- `detailed` — topic-by-topic with **verbatim quotes** + decisions + actions, suitable for serious record-keeping
- `team-sync` — full project-meeting record (정보공유 / 아이디어 / 결정·브랜딩 / 우선도별 To-Do / 향후 일정)

### Detail levels
- `concise` — 5~7 lines max, no quotes
- `standard` — balanced (default)
- `detailed` — paragraph-per-topic, 1~3 verbatim quotes per topic
- `verbatim` — heavy on original quotes, 5~10 sentences per topic

### LLM providers
Two providers available — pick per request via the UI radio button or `--provider` CLI flag:
- `claude` (default) — Claude Sonnet 4.6 via `CLAUDE_API_KEY`
- `gemini` — Gemini 3 Pro via `GEMINI_API_KEY` (required for OCR / 음성 변환 regardless)

### Custom meeting note templates

Drop a Markdown file into `~/.doc-converter/meeting-templates/` (auto-created on first run). Format:

```markdown
---
name: 1:1 Meeting Notes
description: Manager + direct report — bidirectional commitments
language: ko
---

당신은 미팅 transcript을 보고 아래 구조로 한국어 마크다운 미팅 노트를 작성합니다.

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

`name` is required. The body is injected verbatim into the LLM prompt — describe the structure however you like.

**Optional: Install poppler for large PDF fallback**

```bash
brew install poppler
```

**Required for long audio (> 9 min): Install ffmpeg**

```bash
brew install ffmpeg
```

---

## 📁 Project Structure

```
doc-converter/
├── src/
│   ├── cli.ts                  # CLI entry point (Commander.js)
│   ├── commands/
│   │   ├── ocr.ts              # OCR command handler
│   │   ├── transcribe.ts       # Audio transcription command
│   │   └── chat-split.ts       # Chat log splitting command
│   ├── services/
│   │   ├── gemini.ts           # Gemini API client & 2-pass OCR logic
│   │   ├── ocr-pipeline.ts     # Full OCR pipeline (poppler fallback)
│   │   ├── audio-pipeline.ts   # Audio → Markdown pipeline
│   │   └── chat-processor.ts   # Chat log parser (KakaoTalk, Instagram)
│   ├── ui/
│   │   └── server.ts           # Express server + SSE streaming
│   ├── templates/              # Markdown output templates
│   ├── types/                  # Shared TypeScript type definitions
│   └── utils/                  # Shared helper utilities
├── docs/
│   └── MEMORY.md               # Project-specific decisions & bug log
├── dist/                       # Compiled JS output (gitignored)
├── .env.example                # Environment variable template
├── .env.local                  # API keys (never commit)
├── tsconfig.json
└── package.json
```

---

## 🗺 Roadmap

- [ ] Web UI drag-and-drop file upload with progress bar
- [ ] PDF batch processing with queue management
- [ ] Support for additional chat platforms (LINE, Telegram)
- [ ] Docker image for server deployment
- [ ] Output format options (plain text, HTML, PDF)
- [ ] Confidence score per OCR line with highlight UI

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat(scope): add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html).

---

*Built by [KnowAI](https://knowai.space) · © 2026 KnowAI*
