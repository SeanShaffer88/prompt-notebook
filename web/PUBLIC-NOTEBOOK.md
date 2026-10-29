# Public Prompt Notebook

The hosted edition of [Prompt Notebook](https://github.com/SeanShaffer88/prompt-notebook).

- No-key sample mode is explicitly simulated and never calls a model.
- Live mode uses a visitor's own Anthropic API key. Keys stay in tab memory, are sent over HTTPS only on model operations, and are never saved in the database or included in exports. Reloading clears the key. The server uses only `https://api.anthropic.com/v1/messages`.
- Saved prompts, versions, corrections, examples, experiments and workflows live in Cloudflare D1. Each browser receives a random HttpOnly/Secure/SameSite cookie; its hash selects an isolated workspace. There is no shared global notebook and no unauthenticated workspace-list API.
- Cookies preserve access for up to 180 days. Clearing the cookie loses access; export important work. This alpha has no cross-device recovery, sign-in, or backup import.
- Public limits: 1,000 workspaces, 120 operations per workspace/day, 3 examples per comparison, 128 KB requests, bounded per-workspace storage and model-operation duration. A lease serializes operations within each workspace.

## Development and deployment

Use the included Sites/Vinext runtime. The original starter README documents installation, local D1 migrations and builds. Run `node --test test/notebook.test.mjs` to verify the portable notebook service. Run `npm run build` before previewing with `npm start`. The deployment manifest binds D1 as `DB`; migrations are in `drizzle/`.

Production requires no operator model key or connection to the owner's computer. The standalone local application remains available in the parent repository.

## Validation

Service tests cover the sample correction/experiment/workflow loop, fixed-destination live request behavior, provider failure handling, secret exclusion, and independent visitor state. HTTP checks against the built local Worker exercise separate cookie sessions, data persistence, stale workflow detection/retest, exports and cross-origin rejection.
