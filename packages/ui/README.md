# @templatedesign/ui

Plain-CSS + React component library for the TemplateDesign SaaS plan. It ships both the styles and the
components; consumers do not need Tailwind, CSS-in-JS or a UI framework.

```tsx
import "@templatedesign/ui/styles.css";
import { Button, Field, TextInput, LocaleProvider } from "@templatedesign/ui";

<LocaleProvider locale="vi">
  <Field label="Tên người nhận" required>
    {(props) => <TextInput {...props} />}
  </Field>
  <Button variant="primary">Tạo PDF</Button>
</LocaleProvider>;
```

## Rules

- Use semantic tokens (`var(--td-color-text)`), never raw hex.
- Every component has EN and VI copy in `src/copy.ts`; keys must match in both locales and in
  placeholders. `npm run check:i18n` enforces it.
- Every user-visible string goes through `t()`; no hard-coded English in a component.
- Status always carries a word and an icon, never colour alone.
- Keyboard and screen-reader paths are part of the component, not an add-on.
- Analytics go through `track()`; unknown events or properties are rejected at runtime and in CI.

## Structure

```
src/components/  actions, forms, data, feedback, layout, marketing, editor
src/styles/      base + one CSS file per component group
src/copy.ts      EN/VI dictionary and pseudo-locale generator
src/i18n.tsx     LocaleProvider/useLocale
src/icons.tsx    inline SVG icon set (no icon-font dependency)
```

## Checks

```sh
npm run check      # CSS token references + i18n + TypeScript
npm test
```

The gallery in `apps/styleguide` renders every component and all states; a component is not done
until it has a story, axe passes and the visual matrix does not overflow.
