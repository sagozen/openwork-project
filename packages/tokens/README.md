# @templatedesign/tokens

One DTCG source (`tokens/td.tokens.json`) produces every visual constant:

| Output | Consumer |
|---|---|
| `dist/css/tokens.css` | Web components (light, dark, reduced motion) |
| `dist/ts/tokens.ts` | Typed constants and `cssVar()` helper |
| `dist/typst/tokens.typ` | Go + Typst document style (pinned per render release) |
| `dist/json/tokens.json` | Tools, contrast checker, design review |

Components consume **semantic** tokens only. Primitives exist for the palette and are never used
directly.

```sh
npm run build    # regenerate all outputs
npm run check    # build + enforce the declared contrast pairs
npm test         # determinism, aliases, output coverage, contrast
```

The contrast contract lives in the `contrast` block of the token file and is enforced at 4.5:1 for
text and 3:1 for UI boundaries/focus. Adding a token without a contrast entry is fine; adding a
colour pair that users must read is not.

Changing a value here changes the web UI immediately and the PDF only after a deliberate render-core
release, because `tokens.typ` is pinned.

## Restaurant themes

`themes/registry.json` lists the restaurant themes. A theme is a palette (the 14 colour roles in
`roles`), a font pair (`display`, `ui`) and an identity (name, description, cuisine tags, font names,
a picker swatch). It never carries spacing, radius or layout; those stay global.

- A record with a `tokens` file (for example `themes/thanh-vi.tokens.json`) is authored. The build
  emits it as one `[data-theme="<id>"]` block of `--td-theme-*` properties, so switching theme is one
  attribute on the document element. A light theme also keeps the platform's light palette when the
  device prefers dark.
- A record without `tokens` is identity-only: it reaches `themeRegistry` in `dist/ts/tokens.ts` with
  `available: false` and no palette, and never reaches the stylesheet.
- The `contrast` pairs in the registry are the ones the restaurant kit renders. `npm run check` holds
  every authored theme to all of them; a theme cannot opt out. Fix a failing token, not the gate.
