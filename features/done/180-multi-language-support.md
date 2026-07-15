# Feature 180 — Multi-language support (French, German, Spanish, Chinese, Japanese, Italian)

## Context

Depends on: **60** (the i18n seam — everything this feature needs already exists). No new
dependency, no schema change, no new IPC.

Feature 60 built a complete localization machine and shipped exactly one catalog — English.
The renderer module `src/web/scripts/i18n.js` embeds the full English catalog as `EN`,
resolves strings synchronously through `t(key, params)`, and layers the active locale over
`EN` via `applyCatalog` after `init()` fetches it over the `i18n:load` IPC. The main process
(`src/app/i18n.js`) resolves the same catalogs for the chrome it renders itself — the
application menu, the tray, and native dialogs/notifications — and `main.js` re-localizes all
of that on `did-finish-load`, so a language change that reloads the window relocalizes both
sides in one pass. The Settings → Appearance → **Language** picker is already wired: it reads
`LOCALE_OPTIONS`, persists the `language` setting, and triggers a full renderer reload.

The module's own header comment states the contract plainly:

> Shipping additional locales is therefore purely additive: drop a
> `src/web/locales/<lang>.json` beside `en.json` and translate — no component changes, and any
> key a locale omits falls back to English, then to the key itself (so a gap is visible, never
> blank).

Today that promise is untested in practice: `LOCALE_OPTIONS` lists only `system` + `en`, only
`en.json` ships, and the main-side test literally asserts *"No fr.json ships yet, so 'fr'
resolves to English."* This feature makes good on the promise for six languages —
**French (`fr`), German (`de`), Spanish (`es`), Simplified Chinese (`zh`), Japanese (`ja`),
and Italian (`it`)** — translating every `EN` key, registering each in the picker, closing the
one real rendering gap (CJK glyph coverage), and adding a parity test so a translation can
never silently drift from `EN`.

## Goal

A user opens Settings → Appearance → **Language**, picks Français / Deutsch / Español / 中文 /
日本語 / Italiano (or keeps *System default*), and the **entire** UI renders in that language —
the Definition and Monitoring views, every editor and dialog, the host-key prompt, the native
application menu, the tray tooltip and menu, and shell notifications. Numbers and dates already
follow the active locale through the module's `Intl` wrappers. Any key a locale happens to miss
falls back to English, never to a blank or a raw key. Worked example from the request: switch
to 日本語 → the window reloads → the tunnel list, state badges, the "Arm All" tray item and the
native **File / Edit / View / Help** menus all read in Japanese, with real CJK glyphs (no tofu
boxes), and switching to *System default* on a French-locale machine lands on French with no
further interaction.

## Design decisions (settled — do not relitigate)

- **Additive only — the seam does not change.** This stage adds six JSON catalogs, six
  `LOCALE_OPTIONS` rows, one font-stack fallback, and tests. It does **not** touch the
  resolution / fallback / reload / IPC machinery, and it does **not** restructure keys. English
  stays the single source of truth: `EN` and `en.json` remain byte-identical and unchanged; a
  locale catalog only *layers over* the English fallback, never replaces it.

- **A translation is values-only; keys and `{placeholder}` tokens are invariant.** Each new
  catalog carries the **exact** `EN` key set, in the same order (for reviewable diffs), with
  every value translated. `{name}`-style tokens are copied through untranslated and unmoved
  positionally is fine but their *presence* is mandatory — `t()` interpolates by token name, so
  a dropped or renamed token silently breaks a string. The parity test (below) makes that a CI
  failure rather than a runtime surprise.

- **The product noun and protocol terms stay untranslated.** "Port Hippo" is a brand and is
  never localized. Protocol proper nouns (SSH, SOCKS, `known_hosts`, "fingerprint" where it
  names the SSH artefact) stay as-is; the prose around them is translated. Curly quotes/typography
  in `EN` (`“…”`, `’`, `—`) are matched to each language's convention where it differs (e.g.
  French `« … »`, German „…", CJK full-width punctuation) — the strings are UI copy, not code.

- **Simplified Chinese ships as `zh`.** Main-side resolution keys on the primary subtag only
  (`String(wants).split("-")[0]`), so `zh-Hans`, `zh-Hant`, and `zh-CN` all resolve to
  `zh.json`. We ship **Simplified** and label it as such. Traditional Chinese is deliberately
  out of scope: the current subtag-only resolver can't distinguish `zh-Hant`, so it would need a
  script-aware resolver — a clean future follow-on, not this stage. The picker label makes the
  variant explicit (`中文（简体）`) so the choice is unambiguous.

- **CJK glyph coverage via the OS, never a webfont.** The bundled Inter variable font has **no**
  CJK glyphs, so Chinese and Japanese would render as tofu against the current stack. Fix it the
  only house-legal way: extend the font-family stacks in `theme.css` (and the `fontFamily`
  options that pin a Latin face) with a **system** CJK fallback tail — e.g.
  `"PingFang SC", "Hiragino Sans", "Microsoft YaHei", "Yu Gothic", "Noto Sans CJK SC"` before
  the final `sans-serif`. The OS supplies the glyphs; Latin text is unaffected (Inter still wins
  for Latin). **No CDN font** (hard house rule: never load fonts from a CDN) and **no bundled
  multi-MB CJK font** (rejected on size). Layout is unchanged — only the glyph source for
  characters Inter lacks.

- **Endonym labels in the picker.** `LOCALE_OPTIONS` labels are each language's own name —
  `Français`, `Deutsch`, `Español`, `中文（简体）`, `日本語`, `Italiano` — matching how `English`
  is already a literal `label` (not a `t()` key). A speaker recognises their language regardless
  of the UI's current language. Order: the requested order (`fr, de, es, zh, ja, it`) after the
  existing `system` + `en` rows.

- **Parity is enforced, not trusted.** A new completeness test walks `locales/*.json` (except
  `en.json`) and asserts, per locale: (1) the key set **equals** `EN`'s — no missing, no extra;
  (2) each value's **shape** matches `EN`'s (a string stays a string; a plural group stays an
  object with the same plural-form keys); (3) the set of `{placeholder}` tokens in each value
  **equals** the set in the corresponding `EN` value. A machine-mangled, half-finished, or
  token-dropping translation therefore fails `make test`, exactly as the existing
  `EN ⇄ en.json` byte-identity test guards English. Runtime still falls back to English for any
  gap — the test just forbids *shipping* one.

- **"Untranslated" is a visible English value, never an absent key.** Because parity is hard on
  missing keys, a contributor who lacks a language pastes the **English** value in for that key
  rather than omitting it. That keeps the diff honest (the untranslated string is right there in
  review) instead of hiding behind silent runtime fallback, and it mirrors the house rules that
  already keep `en.json` regenerated after an `EN` edit and docs in step with features: **a
  future feature that adds an `EN` key must add the six translations (or explicit English
  placeholders) in the same change.** The parity test is what makes that non-optional.

- **No RTL, no `dir` work.** None of the six languages is right-to-left. `applyCatalog` already
  reflects the language on `<html lang>` for accessibility; nothing else is needed.

- **The long-form user guide stays English.** Feature 80's single-source Markdown guide
  (`src/web/docs/*.md`, rendered in-app and on the website) is a separate system, and translating
  long-form prose is a different, larger effort. This stage localizes the **application UI**
  only. A future "docs i18n" stage can localize the guide; it is explicitly not in scope here,
  called out to prevent scope creep.

## Implementation steps

1. **Author the six catalogs.** For each of `fr`, `de`, `es`, `zh`, `ja`, `it`, create
   `src/web/locales/<lang>.json` from `en.json`'s key set — same keys, same order — and translate
   every value. Preserve every `{placeholder}` token; keep `Port Hippo` and protocol proper nouns
   verbatim; use each language's quotation/punctuation convention. (Translation quality matters —
   these are short, user-facing UI strings; a machine first-draft is acceptable **only** if
   human-reviewed by a speaker. Untranslatable-yet keys carry the English value explicitly, never
   an omission — see the design note above.)

2. **Register them in the picker.** Extend `LOCALE_OPTIONS` in `src/web/scripts/i18n.js` with the
   six endonym rows after `system` + `en`. No other renderer change — `settings-popup.js` already
   maps `LOCALE_OPTIONS` into the `<select>`.

3. **CJK font fallback.** Append the system CJK fallback tail to the font-family custom
   properties in `src/web/styles/theme.css`, and to any hardcoded Latin-face options behind the
   `settings.appearance.fontFamily` picker, so ja/zh render real glyphs while Latin text still
   resolves to Inter. Confirm no token/colour is hardcoded (design-token rule).

4. **Update the main-side i18n test.** In `src/app/tests/i18n.test.js`, replace the *"No fr.json
   ships yet"* case: `loadCatalog({ requested: "fr", systemLocale: "en-US" })` now resolves
   `active === "fr"` and returns a known French value; add a one-line spot-check per new locale
   (`de`, `es`, `zh`, `ja`, `it` each resolve to their own `active`/`lang`). Keep the
   path-traversal and system-locale cases unchanged.

5. **Add the locale-parity test.** In `src/web/scripts/tests/i18n.test.js` (where `EN` is a plain
   ESM import), add a test that reads every `locales/*.json` except `en.json` and asserts key-set
   equality with `EN`, per-key shape parity, and per-value `{placeholder}`-token parity, with a
   failure message naming the offending locale + key. Fold into `make test` (it already runs).

6. **Format, don't regenerate.** `en.json`/`EN` are untouched (no regenerate step). New JSON is
   exempt from the license-header guard (non-comment file type). Run `make fmt` so Prettier
   normalises the six catalogs to house formatting.

7. **Docs in step.** Add a short *"Choosing a language"* note to the relevant user-guide page
   (the Settings/Appearance section) listing the shipped languages and the English-fallback
   behaviour — satisfying the "keep docs in step with features" house rule. The guide body itself
   stays English (see scope note).

## Acceptance criteria

- Settings → Appearance → **Language** lists *System default, English, Français, Deutsch,
  Español, 中文（简体）, 日本語, Italiano*. Selecting any one reloads the window and renders the
  **entire** UI in that language — views, editors, dialogs, the host-key prompt, the native
  menu, the tray tooltip/menu, and notifications.
- *System default* on a machine whose OS locale is one of the six lands on that language with no
  further interaction; on any other locale it lands on English.
- Chinese and Japanese render with real glyphs from a system CJK face — **no tofu boxes** — in
  the list, badges, menu, and tray tooltip.
- Any key a locale omits falls back to English at runtime (never blank, never the raw key), yet
  the parity test proves no shipped locale omits or adds a key and every `{placeholder}` survives
  translation.
- Numbers and dates format per the active locale (already via `Intl` — spot-check thousands
  separators and date order in, e.g., German and Japanese).
- "Port Hippo" is never translated. No secret is touched and no behaviour changes — only strings
  and a font fallback. `make fmt && make lint && make test` is green.

## Constraints

- **Additive only.** Do not change the i18n resolution, fallback, reload, or IPC machinery, and
  do not restructure or rename keys. A translation is values-only.
- Preserve every `{placeholder}` token and the string/plural-object **shape** of each `EN` entry;
  keys are invariant. Enforced by the parity test.
- **No CDN webfont and no bundled multi-MB CJK font** — CJK glyphs come from the OS via the
  font-stack fallback (house rule: never load fonts from a CDN).
- Product name "Port Hippo" and protocol proper nouns (SSH, SOCKS, `known_hosts`) stay
  untranslated.
- English remains the source of truth: `EN` / `en.json` stay byte-identical and unchanged; a
  locale layers over the English fallback and never replaces it. An untranslated key ships as an
  explicit English value, never an absent key.
- Scope is the **application UI** catalogs; the long-form Markdown user guide stays English (a
  possible future docs-i18n stage).

## Verify

```
make fmt && make lint && make test
make debug   # Settings → Appearance → Language → Français: the window reloads and every view,
             # editor, dialog, the native menu and the tray render in French. Switch to 日本語
             # and 中文（简体）and confirm real CJK glyphs (no tofu) in the tunnel list, state
             # badges, native menu and tray tooltip. Set the OS locale to one of the six and pick
             # "System default" → it lands on that language. Delete one key from de.json →
             # `make test` fails on parity; restore it. Break a {placeholder} in es.json →
             # `make test` fails; restore it. Confirm a deliberate gap falls back to English at
             # runtime, never blank.
```
