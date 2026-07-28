# surea11y-selenium

A Selenium WebDriver binding for [`surea11y`](../surea11y) — scans a real, already-rendered page for accessibility issues using surea11y's DOM-rules engine.

This is a **separate project/package** from `surea11y` itself and from its siblings [`surea11y-playwright`](../surea11y-playwright) and [`surea11y-puppeteer`](../surea11y-puppeteer), kept as its own sibling directory rather than a monorepo subfolder — see `ROADMAP.md` §1 for the reasoning (the same reasoning both sibling bindings already used).

## Install (local development)

`surea11y` isn't published to npm yet, so this package depends on it via a relative `file:` path (see `package.json`):

```json
"dependencies": { "surea11y": "file:../core" }
```

That means this project must stay a sibling of `surea11y` (or you update the path) for `npm install` to resolve it.

```bash
npm install
npm test
```

`selenium-webdriver` (a `devDependency` here) bundles **Selenium Manager**, which auto-downloads and manages the matching `chromedriver` the first time you call `new Builder().forBrowser('chrome').build()` — no separate Selenium server, no manual chromedriver install, and no browser-download step is needed for `npm test` to work (Chrome itself must be installed on the machine, which it is on any normal dev box). This is the same zero-extra-setup story `puppeteer.launch()`/`chromium.launch()` have, reached a slightly different way.

## Usage

```js
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { A11yCoreBuilder } = require('surea11y-selenium');

const options = new chrome.Options().addArguments('--headless=new');
const driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();
await driver.get('https://example.com/');

const results = await new A11yCoreBuilder({ driver })
  .include('#main')            // optional -- call multiple times for multi-region scans
  .exclude('.cookie-banner')    // optional
  .withTags(['wcag2a', 'wcag2aa'])
  .disableRules(['meta-refresh-no-exceptions'])
  .options({ contrast: { mode: 'auditorAssist' } })
  .analyze();

console.log(results.checksResults.filter(r => r.outcome === 'fail'));
await driver.quit();
```

The builder takes `{ driver }` (a Selenium `WebDriver`), where the Puppeteer/Playwright bindings take `{ page }` — that's the one construction difference. Everything downstream of that is identical.

`results` is surea11y's own native result shape — see [`../surea11y/docs/OUTPUT_SCHEMA.md`](../surea11y/docs/OUTPUT_SCHEMA.md) — not the `violations`/`passes`/`incomplete`/`inapplicable` shape used by other popular accessibility testing tools. The builder's *method names* are modeled on common conventions in this space for migration familiarity; the richer result schema is kept as-is.

Also see `examples/basic-scan.js` for a runnable script (`npm run example -- <url>`).

`withTags()`/`disableRules()` above have counterparts: `.withRules([...])` (only run these specific rule IDs) and `.disableTags([...])` (never run rules carrying any of these tags). All four compose the same way similar allow/deny-list options do in other accessibility testing tools, with one non-obvious rule worth knowing: a "disable" always wins over a "with" on the same ID/tag (e.g. `.withRules(['a']).disableRules(['a'])` drops `'a'` entirely), and combining `.withRules()` **and** `.withTags()` together requires a rule to satisfy *both* (surea11y's default `includeMode: 'and'` — see `../surea11y/docs/ENGINE_OPTIONS.md`), not either one.

`.exclude(selector)` above excludes globally. Pass a second argument to scope it to specific rule IDs instead: `.exclude('.mat-select', { rules: ['aria-required-children'] })` skips `.mat-select` for that rule only — every other rule still sees it. Global and rule-scoped `.exclude()` calls compose freely.

**Create one builder per scan.** `A11yCoreBuilder` is a mutable object with no reset between `.analyze()` calls — `include()`/`exclude()`/`withRules()`/`disableRules()`/`withTags()`/`disableTags()`/`options()`/`withCustomRules()` all push onto or merge into internal state that persists for the instance's lifetime. Calling one of them again before a second `.analyze()` call *accumulates* on top of the first scan's scope rather than replacing it (this is exactly what makes "call `.include()` several times for one scan," above, work — the same accumulation just also applies across separate scans if you reuse an instance). `.reportOnly()`/`.frames()`/`.elementRef()` are the exception: each call replaces the previous value instead of merging with it.

### Using it as an E2E accessibility gate

The pattern above works unchanged inside a real test:

```js
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { A11yCoreBuilder, formatFailures } = require('surea11y-selenium');

const options = new chrome.Options().addArguments('--headless=new');
const driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();
await driver.get('https://example.com/');

const results = await new A11yCoreBuilder({ driver }).reportOnly(['fail']).analyze();

assert.strictEqual(results.checksResults.length, 0, formatFailures(results.checksResults));
```

See `examples/e2e-test-example.test.js` for a fuller, runnable version (`npm run example:e2e`) — one test proving real violations get caught (unlabeled button, missing `alt`), one proving a well-formed page passes cleanly. It uses `node:test` directly rather than a dedicated test-runner package: Selenium's JS bindings are a pure automation library with no first-party test runner (the way `@playwright/test` is the default for Playwright), and `node:test` is a zero-new-dependency choice that already matches this project's own test suite (see `ROADMAP.md` §6 for the full reasoning, including the other runners considered).

### Readable console/CI output on failure

A bare length/equality assertion alone gets you a *working* gate, but the failure message is a raw, deeply-nested object diff — hundreds of lines for a handful of violations. `formatFailures(checksResults)` turns that into a short, scannable block (one entry per occurrence, numbered, with rule ID/severity/selector/hint) that you hand to your assertion library's own failure-message parameter, as above. A real failure then prints:

```
Error: 1) button-name-present (serious): This button has no accessible name.
   at html > body > button
   Provide visible button text or a programmatic accessible-name mechanism (for example aria-label) so assistive technologies can identify the button.
2) img-alt-present (serious): Missing alt attribute on <img>.
   at html > body > img
   Add an alt attribute (use alt="" only for decorative images).
```

Deliberately a plain function, not a custom `expect` matcher — no dependency on any particular assertion library, so it works the same with `node:assert`, Jest, Vitest, Mocha, or a hand-rolled `if`/`throw`. Defaults to `fail`/`cantTell` outcomes (the only two that ever carry occurrences); pass `{ outcomes: [...] }` to narrow further. A thrown rule (`occurrences: []`, `error` set — see `../surea11y/docs/OUTPUT_SCHEMA.md`) is still surfaced using its `error` message rather than silently dropped.

### Scanning every frame, including cross-origin iframes

```js
const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();

console.log(results.topFrame.checksResults.filter(r => r.outcome === 'fail'));   // the top-level page
for (const frame of results.frames) {
  console.log(frame.checksResults.filter(r => r.outcome === 'fail'));            // each sub-frame, same result shape
}
```

Unlike script-injection-based accessibility tools (which need a `postMessage`-based protocol to reach cross-origin iframes, since they're injected as a plain `<script>` fully subject to the browser's same-origin policy), this needs no `surea11y` engine support at all — Selenium switches the WebDriver context into each frame at the automation-protocol level, so a cross-origin `driver.executeScript()` inside that frame already just works. Verified against a real cross-origin page (`example.org` embedded in an unrelated origin) — see `ROADMAP.md` §2c and `tests/builder.test.js`. Default off, so plain `.analyze()` is unaffected unless you opt in.

**How this differs from the Puppeteer/Playwright bindings (worth knowing):** Selenium has no `page.frames()` array of independent `Frame` objects. A frame is reached only by a *stateful context switch* — `driver.switchTo().frame(webElement)` changes what `driver.executeScript()` runs against, and `driver.switchTo().defaultContent()`/`.parentFrame()` unwind it. `.frames(true)` therefore enumerates iframes with `driver.findElements(By.css('iframe, frame'))`, switches into each (recursing into nested iframes so every frame at any depth is reached), scans, and always returns the driver to the top-level document when `analyze()` finishes — even if a scan throws partway through, so a stuck context can never break whatever you do next. The returned `{ topFrame, frames }` shape is identical to the sibling bindings'; only the internal mechanics differ. See `ROADMAP.md` §2c for the full design and its two honest limitations (nested-frame *element handles*, and genuinely detached frames).

### Trimming the result to just violations

By default `analyze()` returns every rule's outcome, including `pass`/`notApplicable` — surea11y's own deliberate "not a violations-only list" design (see `../surea11y/docs/OUTPUT_SCHEMA.md`). Use `.reportOnly()` to post-filter down to only the outcomes you care about:

```js
const results = await new A11yCoreBuilder({ driver })
  .reportOnly(['fail', 'cantTell'])
  .analyze();

console.log(results.checksResults); // only fail/cantTell entries, pass/notApplicable dropped
```

Valid outcome values are `'pass'`, `'fail'`, `'cantTell'`, `'notApplicable'`. This is pure binding-layer filtering — surea11y itself still computes every rule; nothing about the scan itself changes. Combines with `.frames(true)`: the filter is applied to `results.topFrame` and each entry of `results.frames` independently.

### Getting a live element handle, not just a selector string

By default each occurrence carries a CSS selector + HTML snippet, not a live reference to the element. Opt in to a real Selenium `WebElement` with `.elementRef(true)`:

```js
const results = await new A11yCoreBuilder({ driver }).elementRef(true).analyze();

const [failing] = results.checksResults.filter(r => r.outcome === 'fail');
await failing.occurrences[0].elementHandle.click();
const pngBase64 = await failing.occurrences[0].elementHandle.takeScreenshot();
```

This resolves `occurrence.selector` to a `WebElement` (via `driver.findElements(By.css(...))`, the plural form, which returns `[]` rather than throwing when a selector matches nothing) instead of leaving you to re-resolve a possibly-stale selector string yourself. Default off — resolving a handle per occurrence is a real page query per occurrence, so it costs more than a plain `.analyze()`. The field is named `elementHandle` for drop-in parity with the sibling bindings, even though Selenium's type is `WebElement`.

**Per-element screenshots ARE supported, but the shape differs from Puppeteer/Playwright.** Selenium's `WebElement.takeScreenshot()` **returns a base64-encoded PNG string**, where Puppeteer/Playwright's `elementHandle.screenshot({ path })` writes a file directly. Write it yourself if you want a file: `fs.writeFileSync('flagged.png', await handle.takeScreenshot(), 'base64')`. `.click()` and the rest of the `WebElement` API work as normal.

**Two honest caveats, both verified against real runs:**

- **Empty-selector occurrences.** Not every occurrence has one target element — a page-wide finding (some `manual`/`cantTell` rules, e.g. `contrast-enhanced`) can carry `selector: ""`. Selenium's `By.css("")` throws `InvalidSelectorError` (unlike Puppeteer/Playwright's `.$("")`, which resolves to `null`), so this binding short-circuits an empty selector to `occurrence.elementHandle = null` before it ever reaches Selenium — same `null` outcome as the sibling bindings, reached defensively.
- **Sub-frame handles are context-bound.** With `.frames(true)`, a `WebElement` for an occurrence inside a sub-frame is only usable *while the driver is switched into that frame*. Because `analyze()` deliberately returns the driver to the top-level document when it finishes, using such a handle means switching back into its frame first (`driver.switchTo().frame(iframe)`); it throws `NoSuchElementError` from any other context. The handle is valid, not dead — it revives on re-entering its frame. This is a genuine Selenium property (element references are scoped to a browsing context), with no equivalent in Puppeteer/Playwright's context-free `ElementHandle`s. The **top frame's** handles (single-frame mode, or `results.topFrame`) have no such caveat, since the top *is* the default context. See `ROADMAP.md` §2d.

### Registering a custom rule at runtime

`surea11y` supports registering additional rules per-scan via `engineOptions.customRules`. Use `.withCustomRules()` to register one:

```js
const results = await new A11yCoreBuilder({ driver })
  .withCustomRules({
    id: 'my-org-custom-rule',
    meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
    // A real, live function is fine here -- .withCustomRules() converts it
    // to a function-source string for you (see below for why that matters).
    runInPage(ctx) {
      const el = ctx.document.querySelector('.my-widget');
      return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
    }
  })
  .analyze();
```

A custom rule descriptor is the same shape as one of surea11y's own internal rule modules (`{ id, meta, runInPage, applicability?, data? }`) — see `../surea11y/docs/ENGINE_OPTIONS.md` for the full contract. Results appear in `checksResults` exactly like a built-in rule's, including automatic `selector`/`html`/`structuralPath` fill-in. Registered per-scan only (nothing persists between calls or shows up in any catalog listing), and a custom rule whose `id` collides with a built-in one overrides it for that scan.

Pass an array to register several at once, or call `.withCustomRules()` again to add more — like `.withRules()`/`.withTags()`, it accumulates rather than replacing what was already registered:

```js
const results = await new A11yCoreBuilder({ driver })
  .withCustomRules([firstRule, secondRule])
  .withCustomRules(thirdRule) // adds a third, doesn't replace the first two
  .analyze();
```

**Why `.withCustomRules()` instead of the raw `.options({ customRules })` passthrough** (still supported, and composes with this method if you use both): `runInPage`/`applicability` must reach the page as a function-source *string*, not a live `Function` — a Selenium `driver.executeScript()` argument crosses a serialization boundary that can't carry a live function reference, only a string surea11y can reconstruct with `new Function` on the page side. Passing a raw live function via `.options()` directly would silently fail to serialize; `.withCustomRules()` calls `.toString()` on a live function for you (patching the ES6 method-shorthand `.toString()` quirk — see `ROADMAP.md` §2a), so you can write a normal function and not have to remember that constraint yourself. A string is still accepted as-is if you already have one.

Invalid input (a missing/empty `id`, or a `runInPage`/`applicability` that's neither a function nor a non-empty string) throws immediately from `.withCustomRules()` itself, rather than surfacing later as a silently-skipped rule deep inside the page — easier to catch during development. (Note: a *raw* `.options({ customRules })` call bypasses this check entirely and defers to surea11y's own engine-side behavior, which silently skips an invalid descriptor rather than throwing — see `../surea11y/docs/ENGINE_OPTIONS.md`.)

### Element addressing beyond a CSS selector

Every occurrence already carries `selector` and (with `.elementRef(true)`, above) a live `WebElement`. It also carries `structuralPath` — a sibling-index path from the document root down to the flagged element (e.g. `[1, 0, 2]`) — a more robust identity than a selector string alone, since it survives some DOM changes a selector wouldn't (an id/class rename, for instance). No opt-in needed; it's already on every `fail`/`cantTell` occurrence today. See `../surea11y/docs/OUTPUT_SCHEMA.md` for the full field description.

## TypeScript

`src/A11yCoreBuilder.d.ts` (re-exported from `src/index.d.ts`, wired up via `package.json`'s `types` field) ships hand-written types for the whole builder API plus surea11y's native result shapes (`A11yCoreResult`, `CheckResult`, `Occurrence`, `CompositeResult`, etc.), mirrored from `../surea11y/docs/OUTPUT_SCHEMA.md`. `analyze()` is typed `Promise<A11yCoreResult | A11yCoreMultiFrameResult>` — narrow on `'topFrame' in results` (or cast, if you already know which mode you called) to get the specific shape back, since a fluent builder can't statically track that `.frames(true)` was called earlier in the chain. `selenium-webdriver` is a `peerDependencies` entry (not just `devDependencies`) since the class's `driver` argument and `Occurrence#elementHandle` (a `WebElement`) both come from it — consumers need their own `selenium-webdriver` install for the types to resolve, same as they already do to construct a `WebDriver` in the first place. Verified with a real `tsc --strict` compile against a throwaway consumer script exercising every method and both `analyze()` return shapes.

## Relationship to `surea11y-playwright` and `surea11y-puppeteer`

This binding's builder API is deliberately identical to the [Playwright](../surea11y-playwright) and [Puppeteer](../surea11y-puppeteer) bindings' — same method names, same mutability contract, same result shapes — so switching between them (or running the same accessibility gate logic against all three) is a near drop-in swap: construct a Selenium `WebDriver` instead of a Puppeteer/Playwright `Page`, pass it as `{ driver }` instead of `{ page }`, and the builder chain is unchanged. As of `ROADMAP.md` §8, that's enforced by shared code, not just convention: `A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`../surea11y-binding-base`](../surea11y-binding-base), the same base class every sibling binding now depends on.

The real implementation differences are internal, and all Selenium-specific:
- **The injection call** uses `driver.executeScript(runa11yCoreInPage, url, contextSelector, engineOptions, runOnly)`. Selenium's `executeScript` is variadic and, handed a function, stringifies it and runs it as `return (fn).apply(null, arguments)` — so the four positional args pass straight through, like Puppeteer's variadic `page.evaluate()` and unlike Playwright's single-arg wrapper trick. The synchronous `executeScript` (not `executeAsyncScript`) is correct, since `runa11yCoreInPage` is synchronous and returns its result directly. See `ROADMAP.md` §2b.
- **Frame handling** is a stateful `switchTo()` context walk rather than iterating a `page.frames()` array. See §2c.
- **Element refs** are context-bound `WebElement`s with a base64-string per-element screenshot rather than a file-writing one. See §2d.

Also see [`../surea11y/docs/BINDING_AUTHORS_GUIDE.md`](../surea11y/docs/BINDING_AUTHORS_GUIDE.md) — `surea11y`'s own reference for building a binding like this one (it names Selenium explicitly), distinguishing what's already engine-level (a generic `.options()`/`runOnly` passthrough, WCAG-version tag filtering, `structuralPath`) from what every binding has to build itself (element refs, `reportOnly`-style verbosity filtering, the `executeScript()` serialization-boundary caveat `.withCustomRules()` exists to paper over).

## Status and what's next

See `ROADMAP.md` — it documents what's built, what's verified with real runs, and the two honest Selenium-specific limitations (context-bound sub-frame element handles; base64 vs. file per-element screenshots).
