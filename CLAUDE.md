# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                              # install deps
npm run build                            # tsc → dist/
npm run dev -- <subcommand> [args]       # tsx src/cli.ts ...
npm run ui -- --port 4000                # browser UI on http://localhost:4000

# CLI subcommands (also runnable as `npx tsx src/cli.ts <cmd>`)
npx tsx src/cli.ts ocr <input> [-o ./output] [-q]      # -q = Pass 1 only (no Pass 2 enhance)
npx tsx src/cli.ts transcribe <input> [-o ./output]
npx tsx src/cli.ts chat-split <input.csv|.html> [-o ./output]

# Ad-hoc test scripts at repo root (run with tsx, not part of a test runner)
npx tsx test.ts                          # smoke / experimental
brew install poppler                     # required for the PDF rasterization fallback
```

There is **no test runner, linter, or formatter configured**. The `test-*.ts` files at the repo root are throwaway scripts, not a suite. Type-check via `npm run build`.

`.env.local` is loaded manually by [src/cli.ts](src/cli.ts) (no dotenv dep). Required: `GEMINI_API_KEY`.

## Architecture

This is a **Node ESM** (`"type": "module"`) TypeScript CLI with an embedded Express UI. All internal imports use `.js` extensions on `.ts` source files (NodeNext resolution) — keep that pattern. `require()` is forbidden; use `import` only (see `docs/MEMORY.md` §4).

### Three pipelines, one shape

Each command (`ocr`, `transcribe`, `chat-split`) maps to a service in [src/services/](src/services/):

- **OCR** — [src/services/ocr-pipeline.ts](src/services/ocr-pipeline.ts): 2-pass Gemini. Pass 1 raw extract (`OCR_FAST`), Pass 2 contextual cleanup + Markdown structuring (`OCR_ENHANCE`). `--quick` skips Pass 2.
- **Audio** — [src/services/audio-pipeline.ts](src/services/audio-pipeline.ts): single Gemini call (`AUDIO`), then locally derives a "clean" version by stripping timestamps from the timestamped output (no second API call).
- **Chat** — [src/services/chat-processor.ts](src/services/chat-processor.ts): pure parsing, no LLM. KakaoTalk CSV uses a custom regex parser (NOT csv-parse — RFC-4180 strictness breaks on real exports). Instagram DM HTML is parsed by class-name regex against Meta's exported markup. Both are then bucketed into 7-day groups via `groupBy7Days`.

All three converge on [src/templates/evidence.ts](src/templates/evidence.ts) `buildEvidenceMarkdown()`, which prepends a fixed-order YAML frontmatter (`type → source → processed → converter [→ date]`). This frontmatter contract is intentional — preserve field order if you touch it.

### Gemini layer

[src/services/gemini.ts](src/services/gemini.ts) exposes two entry points:

- `generateText(model, prompt, inlineData?)` — inline base64. Used for images, audio, and locally-rasterized PDF fallback pages.
- `generateTextWithFileApi(model, prompt, filePath, mimeType, onUploadProgress?)` — uploads via Files API, polls until `ACTIVE`, generates, then **always deletes the uploaded file in `finally`**. Used for native PDF processing.

Model IDs and per-million pricing live in [src/types/index.ts](src/types/index.ts) `MODELS` / `PRICING`. Cost is computed per call via `calcCost()` and aggregated into `CostSummary.breakdown` at the pipeline level — keep the breakdown intact for the UI to display.

### PDF fallback (load-bearing — read before changing)

Some scanned PDFs (uncompressed embedded TIFFs > Gemini's pixel/memory limits) make the Files API throw `INVALID_ARGUMENT`. The OCR pipeline catches this **per pass** and falls back to:

1. `pdftoppm -png -r 150` (poppler) → split into per-page PNGs in a temp dir ([src/utils/pdf-extractor.ts](src/utils/pdf-extractor.ts))
2. Re-call `generateText()` with the PNG array as inline base64
3. `cleanupExtractedImages()` removes the temp dir in `finally`

Pass 1 and Pass 2 each have their own try/catch with this fallback — they're not collapsed because the input prompts differ. Don't rethrow non-`INVALID_ARGUMENT` errors through this path. See `docs/MEMORY.md` §1 for context.

### UI server (SSE-based)

[src/ui/server.ts](src/ui/server.ts) — Express 5 + multer. Architecture:

1. `POST /api/ocr` (or `/api/transcribe`) accepts the upload, **immediately returns `{ jobId }`**, and runs the pipeline in the background.
2. Browser opens `GET /api/progress/:jobId` (SSE). Pipeline progress callbacks emit `progress`/`result`/`error` events on a per-job `EventEmitter`.
3. Jobs are auto-GC'd after 30 min via `setInterval`.

`chat-split` is synchronous (no SSE) because parsing is fast.

**CJK filename gotcha**: multer/busboy decodes multipart filenames as latin-1. The server applies `decodeFilename(s) = Buffer.from(s, 'latin1').toString('utf8')` before any pipeline call. The uploaded temp file then gets renamed with the proper extension (`fs.rename(file.path, file.path + ext)`) because multer writes extensionless temp files and downstream MIME detection in [src/utils/file-io.ts](src/utils/file-io.ts) uses the extension.

### Progress callback contract

Pipelines accept `(step: string, detail?: string) => void`. The CLI commands print these; the UI server forwards them to the SSE emitter. Keep the two-arg shape — both sides depend on it.

## Project conventions

- ESM imports with `.js` suffix on `.ts` files (NodeNext) — non-negotiable.
- Korean strings in user-facing messages, prompts, and error text are intentional (this is a Korean-market tool).
- Output files default to `./output`. Pipelines return content; the CLI/UI layer is responsible for writing.
- See [docs/MEMORY.md](docs/MEMORY.md) before debugging PDF/encoding/SSE issues — it documents the exact traps already hit.
