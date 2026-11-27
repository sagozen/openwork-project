# Documentation

Runbooks, guides and decision records for the projects in this repository. Each standalone project under
`projects/` keeps its own docs inside its folder; this directory holds the docs for the Cloudflare apps and the
repository as a whole.

## For contributors

- [Contributing guide](../CONTRIBUTING.md): setup, checks and pull request rules
- [Project README template](project-readme-template.md): the shape every project README follows

## Cloudflare apps

| App | Guides |
|---|---|
| ImageFactory | [Connect guide](imagefactory/connect-guide.md) · [Deploy and operations](imagefactory/deploy-and-operations.md) · [OpenClaw worker](imagefactory/openclaw-worker.md) |
| MyArtifacts | [Connect guide](myartifacts/connect-guide.md) · [Deploy and operations](myartifacts/deploy-and-operations.md) |
| TranscriptAnything | [Configuration reference](transcript/README.md) · [Deploy and operations](transcript/deploy-and-operations.md) · [n8n workflow](transcript/n8n/transcribe-link.json) |
| OTA and other mini apps | [Deploy and operations](mini-apps/deploy-and-operations.md) |

## Decision records

Architecture decisions that shape the shared platform:

- [0001: Platform baseline decisions](decisions/0001-phase-1-11-baseline.md)
- [0002: OAuth and MCP as an opt-in platform module](decisions/0002-oauth-mcp-platform-module.md)
