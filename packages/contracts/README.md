# @templatedesign/contracts

Shared API and document contracts for the SaaS plan. Runtime code imports the TypeScript entry point;
CI validates every schema, fixture and OpenAPI reference.

| File | Purpose |
|---|---|
| `schemas/template-profile.schema.json` | The controlled `certificate-cfo-v1` envelope and element allowlist |
| `schemas/certificate-input.schema.json` | Certificate form/API input |
| `schemas/cfo-input.schema.json` | CFO report input; integer minor units; cross-field rules documented in `x-td-rules` |
| `schemas/job.schema.json`, `job-create.schema.json`, `problem.schema.json` | API objects |
| `catalogue/errors.json` | Stable error codes, HTTP status, retryability, EN/VI strings |
| `catalogue/analytics-events.json` | Event allowlist and forbidden properties |
| `openapi/openapi.yaml` | Draft OpenAPI 3.1 contract |

## Commands

```sh
node scripts/validate.mjs     # schemas + fixtures + business rules + OpenAPI + catalogues
node scripts/check-events.mjs # scan UI code for unknown events/properties
npm run typecheck
```

## Changing a contract

1. Add the field or code to the schema and to the TypeScript types in `src/index.ts`.
2. Add or update a fixture in `fixtures/`; add a cross-field rule to `scripts/validate.mjs` if JSON
   Schema cannot express it.
3. Update `openapi/openapi.yaml` and the EN/VI copy in `packages/ui/src/copy.ts`.
4. Run `npm run check:foundation` from the repo root. Errors are additive only within `/api/v1`;
   breaking changes need `/api/v2`.
