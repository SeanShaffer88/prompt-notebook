# Public Prompt Notebook

The hosted edition of [Prompt Notebook](https://github.com/SeanShaffer88/prompt-notebook).

- No-key sample mode is explicitly simulated and never calls a model.
- Live mode supports visitors' own Anthropic, OpenAI, and Gemini API keys. Keys are kept separately in tab memory, sent over HTTPS only on model operations, and never saved in the database or included in exports. Reloading or clearing connections removes all keys. The server forwards only the matching key to the fixed provider endpoint: `api.anthropic.com/v1/messages`, `api.openai.com/v1/responses`, or `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`. Redirects and custom endpoints are rejected. OpenAI requests set `store: false`.
- Settings chooses the default provider/model for new versions. Each saved version pins its provider; old versions remain Anthropic versions. To change a prompt's provider, choose it under Instructions and save a new version. Experiments and workflows can span providers when all required keys are connected; missing keys fail before starting the batch. Reference corrections use the provider of the original version.
- Saved prompts, versions, corrections, examples, experiments and workflows live in Cloudflare D1. Each browser receives a random HttpOnly/Secure/SameSite cookie; its hash selects an isolated workspace. There is no shared global notebook and no unauthenticated workspace-list API.
- Cookies preserve access for up to 180 days. Clearing the cookie loses access; export important work. This alpha has no cross-device recovery, sign-in, or backup import.
- Public limits: 1,000 workspaces, 120 operations per workspace/day, 3 examples per comparison, 128 KB requests, bounded per-workspace storage and model-operation duration. A lease serializes operations within each workspace.

## Development and deployment

Use the included Sites/Vinext runtime. The original starter README documents installation, local D1 migrations and builds. Run `node --test test/notebook.test.mjs` to verify the portable notebook service. Run `npm run build` before previewing with `npm start`. The deployment manifest binds D1 as `DB`; migrations are in `drizzle/`.

Production requires no operator model key or connection to the owner's computer. The standalone local application remains available in the parent repository.

## Validation

Service tests cover the sample correction/experiment/workflow loop, all three API request/response contracts, fixed destinations, blocked/empty responses, provider failure handling, key routing in mixed-provider workflows, legacy version compatibility, secret exclusion, and independent visitor state. HTTP checks against the built local Worker exercise separate cookie sessions, data persistence, stale workflow detection/retest, exports and cross-origin rejection. Successful paid-provider calls require visitor credentials; adapter tests use deterministic provider responses.
