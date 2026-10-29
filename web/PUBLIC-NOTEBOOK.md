# Public Prompt Notebook

The hosted edition of [Prompt Notebook](https://github.com/SeanShaffer88/prompt-notebook).

- No-key sample mode is explicitly simulated and never calls a model.
- Live mode supports 13 connections: Anthropic, OpenAI, Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together AI, Fireworks AI, Cerebras, SambaNova, and NVIDIA NIM. Keys are separate in tab memory, sent over HTTPS only on model operations, and never saved or exported. Reloading or clearing connections removes them. Each adapter has a fixed official API destination and rejects redirects and arbitrary endpoints. OpenAI and xAI Responses requests set `store: false`.
- Browse models from Instructions or Settings. A keyless public OpenRouter catalog provides hundreds of searchable text-capable models and refreshes every 10 minutes; a dated snapshot is used if the catalog is unavailable. Batch-only and non-text entries are filtered out. Direct connections include starter IDs; other supported model IDs can be entered manually. Catalog presence does not guarantee access, latency, credits or model-specific compatibility. This notebook handles text-in/text-out, not image/audio generation, embeddings, or model-specific tool workflows. Slow reasoning models may exceed its interactive timeout.
- A model labeled **via OpenRouter** requires an OpenRouter key, regardless of who made the model. OpenRouter forwards requests to its model hosting providers under its own routing and data policies. Direct-provider keys are never forwarded to OpenRouter or other connections.
- **Compare models** sends one saved prompt version and the same input values to 2–4 distinct provider/model combinations concurrently. All required keys and target IDs are checked before any model call. Results retain their order and are saved side by side with model/provider identity, usage, latency, exact rendered prompt and version/input snapshots. A failed model is shown separately without discarding successful answers. Source prompt versions remain unchanged. No-key sample comparisons are simulated canned answers; connect keys to compare actual model behavior.
- Settings chooses the default provider/model for new versions. Each saved version pins its provider; old versions remain Anthropic versions. To change a prompt's provider, choose it under Instructions and save a new version. Experiments and workflows can span providers when all required keys are connected; missing keys fail before starting the batch. Reference corrections use the provider of the original version.
- Saved prompts, versions, corrections, examples, experiments and workflows live in Cloudflare D1. Each browser receives a random HttpOnly/Secure/SameSite cookie; its hash selects an isolated workspace. There is no shared global notebook and no unauthenticated workspace-list API.
- Cookies preserve access for up to 180 days. Clearing the cookie loses access; export important work. This alpha has no cross-device recovery, sign-in, or backup import.
- Public limits: 1,000 workspaces, 120 operations per workspace/day, 3 examples per comparison, 128 KB requests, bounded per-workspace storage and model-operation duration. A lease serializes operations within each workspace.

## Development and deployment

Use the included Sites/Vinext runtime. The original starter README documents installation, local D1 migrations and builds. Run `node --test test/notebook.test.mjs` to verify the portable notebook service. Run `npm run build` before previewing with `npm start`. The deployment manifest binds D1 as `DB`; migrations are in `drizzle/`.

Production requires no operator model key or connection to the owner's computer. The standalone local application remains available in the parent repository.

## Validation

Service tests cover the sample correction/experiment/workflow loop, all three API request/response contracts, fixed destinations, blocked/empty responses, provider failure handling, key routing in mixed-provider workflows, legacy version compatibility, secret exclusion, and independent visitor state. HTTP checks against the built local Worker exercise separate cookie sessions, data persistence, stale workflow detection/retest, exports and cross-origin rejection. Successful paid-provider calls require visitor credentials; adapter tests use deterministic provider responses.

### Review model comparisons
Rate each completed response from 1–5, pick one winner, and save that winner into the notebook. Ratings and winner choices persist. Saved best responses retain the exact output, prompt/input snapshot, model, sample label, and rating at save time. Changing a winner leaves earlier saved responses intact; repeated saves of the same response are deduplicated. Prompt exports include reviews and saved responses. Failed responses cannot be rated or selected.

### Improve prompts from reviewed comparisons
After rating a response and choosing a winner, use Suggest improved prompt with optional feedback. The suggestion records the winner, all ratings and outputs as a snapshot, uses the original version's model, and preserves template variables. Review and edit it, then Save candidate & set up test. The original version and source example are preselected in Experiments; both versions run on the candidate's pinned provider/model/token limit. The source example is labeled as used for improvement. Add fresh examples to assess generalization. Reference answers support human review and are not automatic quality scores. Candidates do not become active automatically. Sample suggestions and runs remain explicitly simulated.

### Activate experiment winners and roll back
Completed experiments allow a human to pick either tested version as winner, then activate it separately. Activation records the actual previously active version and offers one-click rollback while that activation remains current. All versions, runs and results are retained. History also offers Make version active for any saved version. Stale active-version changes and incomplete test runs are rejected. Sample outputs cannot establish quality; review real responses before promoting. Activations affect future workflow runs and existing workflow staleness indicators.

### Slice 1: workflow quality checks
Test each affected workflow before promotion using the current active version and proposed experiment winner, without activating either. All step versions and model defaults are pinned. Step contracts support text rules, JSON validity and required top-level fields. Per-step user-supplied token prices enable estimated cost budgets; latency budgets use summed model-call latency. Missing prices remain unknown. Changed outputs require human review; previously passing rules or budgets that fail are regressions. Sample results cannot establish quality. Checks become stale after relevant version, model default, winner or contract changes. Experiment summaries show rule results and missing workflow coverage.
