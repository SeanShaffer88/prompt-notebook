# Prompt Notebook

A working personal AI notebook: reusable prompts, immutable versions, real Anthropic-compatible execution, corrections, AI-suggested candidates, experiments, and connected workflows. No npm dependencies. Requires Node.js 22.13 or newer (tested with Node 26).

## Try it in your browser

**[Open the public notebook](https://prompt-notebook-lab.copperbun512.chatgpt.site)** — no installation or login required.

Sample mode is clearly labeled and uses simulated outputs, without any model calls. For real execution, connect your own Anthropic API key in Settings. The key stays in tab memory, is sent over HTTPS only for requested model operations, and is not saved or exported. Reloading clears it.

Each browser has a separate server-saved workspace, identified by a private cookie. Keep cookies to return and export important work; there is no cross-device recovery or backup import yet. The public demo has bounded usage and storage. Hosted source and its security/usage notes are in [`web/PUBLIC-NOTEBOOK.md`](web/PUBLIC-NOTEBOOK.md). The local application below remains independent and can still use Ollama.

## Start

```sh
npm start
```

Open http://127.0.0.1:4317. On Windows, double-click `Start Notebook.cmd`.

If the environment already provides `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, or `ANTHROPIC_BASE_URL`, the server uses those. Otherwise copy `.env.example` to `.env` and configure your Anthropic key and model. You can also enter a key in Settings; that key stays in server memory only and disappears on restart. Endpoint and default model settings persist locally in SQLite. Never commit `.env`.

For local Ollama, start Ollama, install a suitable model, then set the endpoint to `http://127.0.0.1:11434` and the model to its exact installed name, for example `qwen3.5:4b`. No key is required on the local Ollama endpoint. The adapter uses its Anthropic Messages compatibility API and disables thinking for these local runs to keep interactive latency and output-token limits predictable. On this computer, Ollama and the installed model were verified with live inference. After restarting the computer, start Ollama before running local prompts.

## Use the notebook

1. Choose or create a prompt. Use `{{variable_name}}` placeholders. Edit instructions and save a new candidate version. Saved versions are immutable; activating a version is a separate action.
2. Fill inputs and run the selected saved version. Inputs, rendered prompt, actual model, output, token usage, latency and failures are persisted.
3. Correct a response and explain your feedback. Save the correction, then request an AI improvement. Review/edit the suggestion before saving it as a new candidate. Suggestions preserve the original placeholder names and apply only to this prompt.
4. Turn runs or corrections into saved test examples. Set optional contains/excludes phrases, a word limit or a JSON check. Reference answers support human review; they are not scored automatically.
5. In Experiments, select two versions and 1–10 examples. Each example makes two billable model calls. Compare actual outputs and rule results. Passing a small suite is not a guarantee of general quality.
6. Run a workflow. This release supports 2–6 distinct sequential prompts, each with exactly one input variable. Each output becomes the next input. Executions pin the active versions at the start. Changing an active version marks the workflow and affected downstream steps as needing retest. Rerun to verify the new versions; old executions remain intact.
7. Export the notebook backup or a prompt with its versions and tests. Exports contain personal content, but never API keys. Backup import is not yet implemented; retain the SQLite file for complete restoration.

## Data and privacy

The database is `data/notebook.sqlite` (with SQLite WAL files while running). Stop the server before copying the data directory for a backup. Everything except model execution stays on this computer. Prompts, examples and corrections are sent to your configured provider when you request model execution, suggestions or experiments. This app performs no web retrieval or autonomous external actions.

The server binds only to 127.0.0.1, validates Host/Origin, requires a custom request header for writes, escapes generated text, and excludes configuration credentials from storage and exports. This is a single-user local app, with no login or multi-user isolation. Do not expose it to a network or publish it as a public service. Keys are not encrypted at rest if you put them in `.env`; that file is ignored by Git. Model requests have a two-minute timeout; workflow and experiment operations run sequentially. The app serializes writes/model operations to prevent overlapping updates. Interrupted operations are marked failed on restart.

## Development

```sh
npm test
npm run check
```

Tests use an injected deterministic provider; normal app execution has no simulated fallback. Integration coverage includes durability, rollback, immutable versions, corrections, suggestions, experiments, workflow freshness, failure recovery, secret exclusion, and origin checks.

Architecture: plain browser JavaScript/CSS, Node HTTP server, `node:sqlite`. `lib/provider.mjs` is the provider adapter. The local JSON API uses `x-notebook-request: 1` on POST requests. `GET /api/export` exports the versioned data schema. The server can be embedded through `createNotebookServer` for tests.

## Current limits

Anthropic Messages-compatible providers only; sequential workflows, no branching/tools; no streaming or cancellation; rule-based grading with manual reference review; no account synchronization or backup import. Do not treat token counts as dollar-cost estimates. Version model IDs may inherit the workspace default; each run records the actual returned model.
