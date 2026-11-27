# Security policy

Several projects here handle sign-in, payments, credits, file sharing and multi-tenant data, so security reports
are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:

1. Go to [Security → Report a vulnerability](https://github.com/sagozen/openwork-project/security/advisories/new).
2. Name the project (for example `apps/imagefactory`), describe the problem, and include steps to reproduce.
3. Say what an attacker could do: read another tenant's data, spend someone else's credits, bypass sign-in, and so on.

You can expect an acknowledgement within 3 working days and a first assessment within 7. Once a fix is released we
publish an advisory and credit you, unless you ask us not to.

## Scope

In scope: the code in this repository, including the shared platform in `packages/`.

Out of scope: the maintainer's live deployments on `*.zhst.app` and `labs.sagozen.digital` (do not test against
them), third-party services the projects call, and problems that need a compromised machine or leaked secrets.

## Supported versions

Only the latest commit on `main` receives security fixes.
