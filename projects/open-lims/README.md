# Open LIMS

> Part of [OpenWork](../../README.md).

The web front end of a **laboratory information management system** (LIMS): sample intake, field sampling, lab
work, technical review, result approval, report delivery and system administration, with access controlled by
role and branch. Built for a Vietnamese testing laboratory, so screens, routes and labels are in Vietnamese.

**Use it as a base for:** a large, role-based internal tool. It shows how to structure many workflow screens
(worklists, scan-to-open forms, bulk assignment, approval queues), keep money and date formatting correct for a
locale, and gate every route by permission.

## Stack

React 19, TanStack Start (SSR) and TanStack Router, Fluent UI, Clerk for sign-in, Bun for tests.

## Workflow screens

| Route | Purpose |
|---|---|
| `/tiep-nhan` | Reception: reconcile a dossier, record the decision per sample |
| `/lay-mau` | Field sampling |
| `/cong-viec` | Lab work table, one compact row per sample, claim and bulk assign |
| `/nhap-ket-qua` | Result entry; scan a sample code and press Enter to open its parameters |
| `/kiem-tra-ky-thuat`, `/phe-duyet` | Technical review and approval |
| `/tra-ket-qua` | Report delivery |
| `/ban-giao` | Handover between stations |
| `/admin/*` | Branches, users, roles, catalogs, parameters, audit log |
| `/ho-tro/*` | Support: FAQ, documents, requests |

## Behaviour worth copying

- VND amounts use commas for thousands and a dot for decimals. Inputs keep the typed text and cursor while
  focused, group digits on blur, preserve fractional digits and a pasted `₫`, and refuse to submit invalid text.
- The reception queue counts dossiers, not samples; decisions and labels belong to the selected sample.
- "Received" at the front desk is not "in testing": the lab status starts only when the lab accepts a handover.
- Times are shown in Vietnam time (`HH:mm · dd/MM/yyyy`); missing values show `—`.

## Run it

```bash
bun install
bun run dev        # Vite dev server
bun test           # tests in tests/ (RBAC, currency, scan, handover, upload limits ...)
bun run build
```

The app expects a REST backend. By default it calls `http://localhost:8080/api/v1`; set `VITE_API_URL` to point
elsewhere. The backend is not part of this repository, and the sample records under `src/lib/admin/` are
fictional. Sign-in uses Clerk: set your own publishable key in `src/lib/auth/clerk-domains.ts` before deploying.

## Contributing

Issues and pull requests are welcome. Read the [contributing guide](../../CONTRIBUTING.md) first; the checks
for this project are `bun run lint && bun test && bun run build`.

## License

[MIT](LICENSE)
