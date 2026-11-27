# Project README template

Every project in OpenWork uses the same README shape, so a visitor can compare projects quickly and a contributor
always knows where to look. Copy the block below into `projects/<name>/README.md` or `apps/<name>/README.md` and
replace each placeholder. Drop a section only when it truly does not apply.

The order matters: a visitor decides in the first ten lines whether the project is useful to them, so the problem
and the "use it as a base for" line come before any setup.

```markdown
# Project name

> Part of [OpenWork](../../README.md).

One or two sentences: the problem it solves and for whom. Bold the key nouns.

**Use it as a base for:** what someone could build by copying this, and which patterns the code shows
(for example tenant isolation, a job queue with leased workers, an MCP server).

<!-- Optional: one screenshot, GIF or architecture diagram. A picture raises interest more than any paragraph. -->

## What it does

- Three to six bullets describing real, shipped capabilities.

## Stack

Languages, frameworks, storage and hosting, in one line.

## Run it

Requirements (runtime versions, Docker, accounts), then copy-paste commands from a fresh clone:

    install
    dev server
    tests

## Layout

A short tree of the folders a contributor will touch.

## Status

What works today, what is not built yet, and which checks were run.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md). The checks for this project are `<commands>`.

## License

[MIT](LICENSE)
```

## Writing rules

- Lead with the outcome for the reader, then the details.
- Every command must work from a fresh clone. If it needs a secret, name the `*.example` file to copy.
- Describe only what exists in the code. Planned work goes under "Status" and is labelled as planned.
- Keep project-specific runbooks in `docs/<project>/` and link to them instead of copying them.
- Write in English. Product UI strings may stay in the language of the product's users; say so in the README.
