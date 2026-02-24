# Stanley-X Extension

Chrome extension (Manifest V3) built with WXT.

## Development

```bash
pnpm install
pnpm dev
```

Load `.output/chrome-mv3` in `chrome://extensions` (Developer mode).

## Backend (X Draft Generation)

Build and run the TypeScript backend:

```bash
pnpm backend:build
pnpm backend:dev
```

It starts on `http://localhost:8787`.

`.env` loading:

- Reads from root: `stanley-x-extension/.env`
- Also supports: `stanley-x-extension/backend/.env`
- Environment variables already exported in your shell take precedence.

Environment variables:

- `GROQ_API_KEY` (optional for real LLM output)
- `GROQ_MODEL` (optional, default: `llama-3.3-70b-versatile`)
- `GROQ_BASE_URL` (optional, default: `https://api.groq.com/openai/v1`)
- `PORT` (optional, default: `8787`)

If `GROQ_API_KEY` is missing, backend returns a deterministic mock rewrite so you can test flow without token spend.

Request contract:

- `POST /v1/x-draft`
- body:
  - `threadId: string`
  - `sourceText: string`
  - `sourceHash: string`
  - `previousSourceText: string | null`
  - `force: boolean`

The backend uses:

- hash cache (`threadId + sourceHash`)
- significance gating against last generated source per thread
- optional LLM generation when change is large enough

## Build

```bash
pnpm build
```

## Full Local Test Flow

1. Start extension dev server:
   - `pnpm dev`
2. Start backend server in another terminal:
   - `pnpm backend:build`
   - `pnpm backend:dev`
3. Load `.output/chrome-mv3-dev` in `chrome://extensions`.
4. Open a Stanley thread page and toggle to X mode.
5. You should see:
   - cached/mocked/generated X draft in the replacement preview area
   - background logs for backend requests
