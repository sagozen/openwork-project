# Contributing to OpenWork

Thanks for taking the time to help. OpenWork is a collection of production projects, so most useful contributions
are small and concrete: a bug fix, a clearer README step, a missing test, or a port of one project to a new host.

This guide covers how the repository is organised, how to set up the project you want to work on, and what a pull
request needs before it can be merged.

## Ways to contribute

- **Report a bug** with the [bug report form](https://github.com/sagozen/openwork-project/issues/new?template=bug_report.yml).
  Name the project and include the exact command and output.
- **Suggest an improvement** with the [feature request form](https://github.com/sagozen/openwork-project/issues/new?template=feature_request.yml).
- **Fix docs.** If a setup step did not work for you, the fix is a welcome first pull request.
- **Pick up an issue** labelled [`good first issue`](https://github.com/sagozen/openwork-project/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/sagozen/openwork-project/labels/help%20wanted). Comment first so two people do
  not work on the same thing.
- **Report a security problem privately.** Do not open a public issue; follow [SECURITY.md](SECURITY.md).

For a large change (a new feature, a new dependency, a schema change, or a change to `packages/`), open an issue
first and agree on the approach. It saves you from writing code that cannot be merged.

## How the repository is organised

There are two kinds of project, and they are set up differently.

| Folder | Kind | Toolchain | Run checks from |
|---|---|---|---|
| `apps/*` | Cloudflare Workers apps on one shared platform | Node 24.21+, npm workspaces, Turbo | the repository root |
| `packages/*` | The shared platform those apps import | Node 24.21+ | the repository root |
| `services/transcriber` | Go worker for `apps/transcript` | Go | the repository root (`npm run test:transcriber`) |
| `projects/*` | Standalone projects, each with its own toolchain | see the table below | inside the project folder |

A change under `apps/` or `packages/` can affect every app, because they share auth, the wallet, migrations and the
admin. A change under `projects/<name>` affects only that project.

## Set up

```bash
git clone https://github.com/sagozen/openwork-project.git
cd openwork-project
```

### Cloudflare apps (`apps/*`, `packages/*`)

```bash
nvm use                         # reads .nvmrc (Node 24.21)
npm install
npm run test:platform           # shared platform
npm run test:imagefactory       # or test:myartifacts, test:ota, test:transcript
npm run dev:imagefactory        # copy apps/imagefactory/.dev.vars.example to .dev.vars first
```

You do not need a Cloudflare account to run the tests or the local dev server.

### Standalone projects (`projects/*`)

Each project's README is the source of truth. The checks a pull request must pass are:

| Project | Install | Checks |
|---|---|---|
| `projects/chatqa` | `npm install` | `cd apps/chatqa/web && npm run check`, then `cd ../desktop && go test ./...` |
| `projects/open-lims` | `bun install` | `bun run lint && bun test && bun run build` |
| `projects/asia-maps-twins` | `uv sync` | `make lint && make test-unit` |
| `projects/astra-cms` | Java 25 and Docker | `make build && make test` |
| `projects/mytutorlms` | see its README | the commands under "Verification commands" in its README |

## Making a change

1. Fork the repository and create a branch from `main`, for example `fix/imagefactory-webhook-retry` or
   `docs/ota-quick-start`.
2. Keep the change to one project and one purpose. Two unrelated fixes are two pull requests.
3. Add or update a test that fails without your change, when the change is in code.
4. Run the checks for the project you touched (above). For `apps/*` and `packages/*` also run:

   ```bash
   npm run lint                  # Biome
   npm run check:<app>           # type check
   npm run check:migrations      # only if you touched migrations.src/
   ```

5. Update the project README when you change a command, a setting, a route or behaviour a user sees.
6. Open a pull request and fill in the template.

### Rules that keep the repository safe to build on

- **Never commit secrets.** Only `*.example` files are tracked. Wrangler files keep all-zero resource ids.
- **Migrations:** edit `migrations.src/` and run `npm run compose:migrations`. Never edit `migrations/` by hand.
- **Shared platform:** a change in `packages/platform` must keep every app's tests passing (`npm test`).
- **No fake data in product code.** Fixtures belong in tests; sample records must be clearly fictional.
- **Dependencies:** explain in the pull request why a new dependency is needed and what it replaces.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/). Put the project name in the scope.

```
fix(imagefactory): retry fal webhook verification once on clock skew
feat(ota): allow per-app retention override
docs(open-lims): explain VITE_API_URL
chore(platform): bump better-auth to 1.4
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`. Mark breaking changes with `!`
(`feat(platform)!: ...`) and describe the migration in the body.

## Review

A maintainer aims to give a first response within a week. Reviews look at four things: the change does what it
says, it is tested, it does not weaken security or tenant isolation, and the README still matches the behaviour.
Small follow-up commits are fine during review; the pull request is squash-merged.

## Adding a new project

A new project under `projects/` should solve a real problem and be something you run yourself. Before opening the
pull request, make sure it has:

- a README that follows [docs/project-readme-template.md](docs/project-readme-template.md);
- an MIT `LICENSE` file;
- no secrets, real customer data or another company's branding;
- a row in the project table of the root README.

For a new Cloudflare app on the shared platform, start from the scaffold: `npm run new-app -- my-app`.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
