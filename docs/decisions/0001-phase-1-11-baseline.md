# 0001 — Phase 1 and Phase 11 baseline decisions

- Status: **provisional** (defaults applied so implementation can proceed)
- Date: 2026-10-21
- Owner: product owner
- Supersedes: none (first decision record in this repository)
- Sources: `plans/261021-2240-full-product-ux-plan/plan.md` §"Reconciled decisions", 04 §2 and §8,
  05 §2, 06 §10

The plan lists blocking owner decisions D1–D38. This record applies the plan's documented defaults to
the ones needed by Phase 1 and Phase 11, so work is not blocked. Each row stays provisional until the
owner signs it. Changing a row is a code change, not just a documentation change, where the decision
touches tokens, contracts or components.

## Decisions applied

| ID | Decision | Applied value | Evidence in this repo | Owner sign-off |
|---|---|---|---|---|
| D1 | Authentication | **Better Auth on Workers + D1**, Google OAuth primary, email magic link secondary, Postmark or Resend behind an adapter | Not built in Phase 1/11; contract notes session auth only on session endpoints (`openapi.yaml`) | Pending |
| D2 | Payment provider | **Deferred by owner.** No Paddle, Stripe, Lemon Squeezy or PayOS code in Phase 1/11. Keep a provider-adapter boundary for Phase 5. | `docs/compatibility.md` deviation table; pricing UI reads configuration only | **Owner instruction, 2026-10-21** |
| D28 | Selling legal entity | **Unresolved** (needed before paid launch, Phase 5) | Recorded in `docs/phase-1-and-11-status.md` open questions | Pending |
| D3 | Credit packs | `$10 / 1,000`, `$20 / 2,800`, `$50 / 8,000` (05 recommendation) | `openapi.yaml` `CreditPack`; no checkout implementation | Pending |
| D4 | Fonts | Baseline: **Noto Sans Regular/Bold**. Intended UI set: Be Vietnam Pro, Source Serif 4, JetBrains Mono; ten-family template set verified in Phase 11 | `packages/tokens/tokens/td.tokens.json`, `docs/compatibility.md`, spike `meta.json` hashes | Pending (set), baseline accepted |
| D6 | Document/PDF fidelity | pdfme generator is a **baseline only**; production preview and export are Go + Typst | Spike README and `meta.json` note; `README` of the spike | Locked in plan |
| D7 | Preview economics | Free, **watermarked** server previews under a daily quota (20 guest / 100 free / 500 paid); explicit Preview button; never auto-spend the last 3 previews | Component `PreviewBudget` and prototype preview state | Pending |
| D10 | Editor breakpoint | Full designer only at **≥ 1024 CSS px**, any orientation; below that, form + preview | Tokens `breakpoint.lg: 1024px`; `DesignerFallback` notice component | Pending |
| D14 | API test mode | **V1**, `td_test_` keys, watermarked, 0 credits, 50/day | Error catalogue `quota_exceeded`; pricing/API copy only in this phase | Pending |
| D16 | Brand | **"Ledger & Seal"** (Option A) | `packages/tokens` primitives: paper/ink/teal/vermilion | Pending |
| D17 | Styling | **Plain CSS + custom properties**, no Tailwind or CSS-in-JS | `packages/ui/src/styles/*.css`; components consume semantic tokens only | Pending |
| D18 | Themes | Light and dark for all UI; **documents never invert**; OS default + manual System/Light/Dark | `tokens.css` light/dark blocks; theme switcher in the gallery | Pending |
| D19 | Component gallery | Custom Astro gallery at `/styleguide` (Storybook deferred) | `apps/styleguide` | Pending |
| D20 | Chart types | Bar, grouped/stacked bar, line, budget-vs-actual. **No pie/donut in V1.** | `packages/ui` chart components; tokens `chart.*` | Pending |
| D22 | App language routing | UI language by cookie on app routes; public pages EN at `/`, VI at `/vi/` | Gallery prototype uses a language toggle and preserves route | Pending |
| D29 | Usability recruitment | Round A protocol and report template exist; **sessions not run** in this increment | `apps/styleguide/usability/round-a.md` | Pending |
| D32 | Editor effort | Plan default accepted: **38.5–50 days** (no deferrals) | Not built in Phase 1/11; recorded here for Phase 3 planning | Pending |
| D37 | Editor defaults | Sentence-mode text in V1; explicit preview; publication requires a fresh render | Contracts profile supports `td.mode: sentence`; no editor yet | Pending |
| — | Admin console | Phase **12**, not Phase 4 (plan reconciled default) | Not built | Pending |
| — | Status page | Hosted at `status.templatedesign.best`, outside Cloudflare | Not built | Pending |

## Consequences

1. **No payment code until the owner reopens D2.** Pricing components render from a typed configuration
   object; they do not import a provider SDK.
2. **No font downloads in Phase 1.** Documents use Noto Sans, which is verified for Vietnamese. The
   token font stacks are the intended final stacks, with system fallbacks, so swapping in the real
   files later does not change component APIs.
3. **Dark mode is first-class.** Every component and every visual-regression snapshot runs in both
   themes. Document canvases stay light.
4. **The gallery is the contract.** A component that is not in `/styleguide` with all states is not
   done, and the Playwright matrix is the definition of "all states".
5. **Storybook can be added later** without changing component code because the gallery imports the
   real components, not copies.

## Open questions for the owner

1. D28: which country is the selling entity in? This blocks payment onboarding and Vietnamese
   e-invoicing, not Phase 1/11 code.
2. D4: approve the ten-font set and licences before Phase 11 ships the font package.
3. D29: who recruits Round A participants, and what is the incentive?
4. D7: is the guest preview quota 20/day, and should the last three previews be protected?
5. D18: is dark mode required on public marketing pages at launch, or app/editor chrome only?
6. D2: confirm that payments stay out of scope until Phase 5.
