# @surea11y/selenium

A Selenium WebDriver binding for [`@surea11y/core`](https://github.com/rumoroso/surea11y-core) — scans a real, already-rendered page for accessibility issues using surea11y's DOM-rules engine.

## Install

```bash
npm install @surea11y/selenium selenium-webdriver
```

`selenium-webdriver` (a `peerDependencies` entry) bundles **Selenium Manager**, which auto-downloads and manages the matching `chromedriver` the first time you call `new Builder().forBrowser('chrome').build()` — no separate Selenium server, no manual chromedriver install, and no browser-download step needed (Chrome itself must be installed on the machine). This is the same zero-extra-setup story `puppeteer.launch()`/`chromium.launch()` have, reached a slightly different way.

## Usage

```js
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { A11yCoreBuilder } = require('@surea11y/selenium');

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

`results` is `@surea11y/core`'s own native result shape — see its [`OUTPUT_SCHEMA.md`](https://github.com/rumoroso/surea11y-core/blob/main/docs/OUTPUT_SCHEMA.md) — not the `violations`/`passes`/`incomplete`/`inapplicable` shape used by other popular accessibility testing tools. The builder's *method names* are modeled on common conventions in this space for migration familiarity; the richer result schema is kept as-is.

Also see `examples/basic-scan.js` for a runnable script (`npm run example -- <url>`).

`withTags()`/`disableRules()` above have counterparts: `.withRules([...])` (only run these specific rule IDs) and `.disableTags([...])` (never run rules carrying any of these tags). All four compose the same way similar allow/deny-list options do in other accessibility testing tools, with one non-obvious rule worth knowing: a "disable" always wins over a "with" on the same ID/tag (e.g. `.withRules(['a']).disableRules(['a'])` drops `'a'` entirely), and combining `.withRules()` **and** `.withTags()` together requires a rule to satisfy *both* (`@surea11y/core`'s default `includeMode: 'and'`), not either one.

`.exclude(selector)` above excludes globally. Pass a second argument to scope it to specific rule IDs instead: `.exclude('.mat-select', { rules: ['aria-required-children'] })` skips `.mat-select` for that rule only — every other rule still sees it. Global and rule-scoped `.exclude()` calls compose freely.

**Create one builder per scan.** `A11yCoreBuilder` is a mutable object with no reset between `.analyze()` calls — `include()`/`exclude()`/`withRules()`/`disableRules()`/`withTags()`/`disableTags()`/`options()`/`withCustomRules()` all push onto or merge into internal state that persists for the instance's lifetime. Calling one of them again before a second `.analyze()` call *accumulates* on top of the first scan's scope rather than replacing it (this is exactly what makes "call `.include()` several times for one scan," above, work — the same accumulation just also applies across separate scans if you reuse an instance). `.reportOnly()`/`.frames()`/`.elementRef()` are the exception: each call replaces the previous value instead of merging with it.

### Using it as an E2E accessibility gate

The pattern above works unchanged inside a real test:

```js
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { A11yCoreBuilder, formatFailures } = require('@surea11y/selenium');

const options = new chrome.Options().addArguments('--headless=new');
const driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();
await driver.get('https://example.com/');

const results = await new A11yCoreBuilder({ driver }).reportOnly(['fail']).analyze();

assert.strictEqual(results.checksResults.length, 0, formatFailures(results.checksResults));
```

See `examples/e2e-test-example.test.js` for a fuller, runnable version (`npm run example:e2e`) — one test proving real violations get caught (unlabeled button, missing `alt`), one proving a well-formed page passes cleanly. It uses `node:test` directly rather than a dedicated test-runner package: Selenium's JS bindings are a pure automation library with no first-party test runner (the way `@playwright/test` is the default for Playwright), and `node:test` is a zero-new-dependency choice that already matches this project's own test suite.

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

Deliberately a plain function, not a custom `expect` matcher — no dependency on any particular assertion library, so it works the same with `node:assert`, Jest, Vitest, Mocha, or a hand-rolled `if`/`throw`. Defaults to `fail`/`cantTell` outcomes (the only two that ever carry occurrences); pass `{ outcomes: [...] }` to narrow further. A thrown rule (`occurrences: []`, `error` set) is still surfaced using its `error` message rather than silently dropped.

### Scanning every frame, including cross-origin iframes

```js
const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();

console.log(results.topFrame.checksResults.filter(r => r.outcome === 'fail'));   // the top-level page
for (const frame of results.frames) {
  console.log(frame.checksResults.filter(r => r.outcome === 'fail'));            // each sub-frame, same result shape
}
```

Unlike script-injection-based accessibility tools (which need a `postMessage`-based protocol to reach cross-origin iframes, since they're injected as a plain `<script>` fully subject to the browser's same-origin policy), this needs no extra engine support at all — Selenium switches the WebDriver context into each frame at the automation-protocol level, so a cross-origin `driver.executeScript()` inside that frame already just works. Verified against a real cross-origin page (`example.org` embedded in an unrelated origin) — see `tests/builder.test.js`. Default off, so plain `.analyze()` is unaffected unless you opt in.

**How this differs from the Puppeteer/Playwright bindings (worth knowing):** Selenium has no `page.frames()` array of independent `Frame` objects. A frame is reached only by a *stateful context switch* — `driver.switchTo().frame(webElement)` changes what `driver.executeScript()` runs against, and `driver.switchTo().defaultContent()`/`.parentFrame()` unwind it. `.frames(true)` therefore enumerates iframes with `driver.findElements(By.css('iframe, frame'))`, switches into each (recursing into nested iframes so every frame at any depth is reached), scans, and always returns the driver to the top-level document when `analyze()` finishes — even if a scan throws partway through, so a stuck context can never break whatever you do next. The returned `{ topFrame, frames }` shape is identical to the sibling bindings'; only the internal mechanics differ. Two honest limitations: a genuinely *detached* frame can't be re-entered, and a frame that navigates away mid-walk surfaces as an `{ url, error }` entry rather than a result, instead of aborting the whole multi-frame scan.

### Trimming the result to just violations

By default `analyze()` returns every rule's outcome, including `pass`/`notApplicable` — `@surea11y/core`'s own deliberate "not a violations-only list" design. Use `.reportOnly()` to post-filter down to only the outcomes you care about:

```js
const results = await new A11yCoreBuilder({ driver })
  .reportOnly(['fail', 'cantTell'])
  .analyze();

console.log(results.checksResults); // only fail/cantTell entries, pass/notApplicable dropped
```

Valid outcome values are `'pass'`, `'fail'`, `'cantTell'`, `'notApplicable'`. This is pure binding-layer filtering — the engine itself still computes every rule; nothing about the scan itself changes. Combines with `.frames(true)`: the filter is applied to `results.topFrame` and each entry of `results.frames` independently.

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
- **Sub-frame handles are context-bound.** With `.frames(true)`, a `WebElement` for an occurrence inside a sub-frame is only usable *while the driver is switched into that frame*. Because `analyze()` deliberately returns the driver to the top-level document when it finishes, using such a handle means switching back into its frame first (`driver.switchTo().frame(iframe)`); it throws `NoSuchElementError` from any other context. The handle is valid, not dead — it revives on re-entering its frame. This is a genuine Selenium property (element references are scoped to a browsing context), with no equivalent in Puppeteer/Playwright's context-free `ElementHandle`s. The **top frame's** handles (single-frame mode, or `results.topFrame`) have no such caveat, since the top *is* the default context.

### Registering a custom rule at runtime

`@surea11y/core` supports registering additional rules per-scan via `engineOptions.customRules`. Use `.withCustomRules()` to register one:

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

A custom rule descriptor is the same shape as one of `@surea11y/core`'s own internal rule modules (`{ id, meta, runInPage, applicability?, data? }`) — see its [`ENGINE_OPTIONS.md`](https://github.com/rumoroso/surea11y-core/blob/main/docs/ENGINE_OPTIONS.md) for the full contract. Results appear in `checksResults` exactly like a built-in rule's, including automatic `selector`/`html`/`structuralPath` fill-in. Registered per-scan only (nothing persists between calls or shows up in any catalog listing), and a custom rule whose `id` collides with a built-in one overrides it for that scan.

Pass an array to register several at once, or call `.withCustomRules()` again to add more — like `.withRules()`/`.withTags()`, it accumulates rather than replacing what was already registered:

```js
const results = await new A11yCoreBuilder({ driver })
  .withCustomRules([firstRule, secondRule])
  .withCustomRules(thirdRule) // adds a third, doesn't replace the first two
  .analyze();
```

**Why `.withCustomRules()` instead of the raw `.options({ customRules })` passthrough** (still supported, and composes with this method if you use both): `runInPage`/`applicability` must reach the page as a function-source *string*, not a live `Function` — a Selenium `driver.executeScript()` argument crosses a serialization boundary that can't carry a live function reference, only a string `@surea11y/core` can reconstruct with `new Function` on the page side. Passing a raw live function via `.options()` directly would silently fail to serialize; `.withCustomRules()` calls `.toString()` on a live function for you (patching the ES6 method-shorthand `.toString()` quirk, where `{ runInPage(ctx){...} }` stringifies without the `function` keyword and would otherwise silently fail to revive), so you can write a normal function and not have to remember that constraint yourself. A string is still accepted as-is if you already have one.

Invalid input (a missing/empty `id`, or a `runInPage`/`applicability` that's neither a function nor a non-empty string) throws immediately from `.withCustomRules()` itself, rather than surfacing later as a silently-skipped rule deep inside the page — easier to catch during development. (Note: a *raw* `.options({ customRules })` call bypasses this check entirely and defers to `@surea11y/core`'s own engine-side behavior, which silently skips an invalid descriptor rather than throwing.)

### Element addressing beyond a CSS selector

Every occurrence already carries `selector` and (with `.elementRef(true)`, above) a live `WebElement`. It also carries `structuralPath` — a sibling-index path from the document root down to the flagged element (e.g. `[1, 0, 2]`) — a more robust identity than a selector string alone, since it survives some DOM changes a selector wouldn't (an id/class rename, for instance). No opt-in needed; it's already on every `fail`/`cantTell` occurrence today. See [`OUTPUT_SCHEMA.md`](https://github.com/rumoroso/surea11y-core/blob/main/docs/OUTPUT_SCHEMA.md) for the full field description.

## TypeScript

`src/A11yCoreBuilder.d.ts` (re-exported from `src/index.d.ts`, wired up via `package.json`'s `types` field) ships hand-written types for the whole builder API plus `@surea11y/core`'s native result shapes (`A11yCoreResult`, `CheckResult`, `Occurrence`, `CompositeResult`, etc.). `analyze()` is typed `Promise<A11yCoreResult | A11yCoreMultiFrameResult>` — narrow on `'topFrame' in results` (or cast, if you already know which mode you called) to get the specific shape back, since a fluent builder can't statically track that `.frames(true)` was called earlier in the chain. `selenium-webdriver` is a `peerDependencies` entry (not just `devDependencies`) since the class's `driver` argument and `Occurrence#elementHandle` (a `WebElement`) both come from it — consumers need their own `selenium-webdriver` install for the types to resolve, same as they already do to construct a `WebDriver` in the first place. Verified with a real `tsc --strict` compile against a throwaway consumer script exercising every method and both `analyze()` return shapes.

## Relationship to `@surea11y/playwright` and `@surea11y/puppeteer`

This binding's builder API is deliberately identical to the [Playwright](https://github.com/rumoroso/surea11y-core-playwright) and [Puppeteer](https://github.com/rumoroso/surea11y-core-puppeteer) bindings' — same method names, same mutability contract, same result shapes — so switching between them (or running the same accessibility gate logic against all three) is a near drop-in swap: construct a Selenium `WebDriver` instead of a Puppeteer/Playwright `Page`, pass it as `{ driver }` instead of `{ page }`, and the builder chain is unchanged. That's enforced by shared code, not just convention: `A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`@surea11y/binding-base`](https://github.com/rumoroso/surea11y-core-binding-base), the same base class every sibling binding depends on.

The real implementation differences are internal, and all Selenium-specific:
- **The injection call** uses `driver.executeScript(runa11yCoreInPage, url, contextSelector, engineOptions, runOnly)`. Selenium's `executeScript` is variadic and, handed a function, stringifies it and runs it as `return (fn).apply(null, arguments)` — so the four positional args pass straight through, like Puppeteer's variadic `page.evaluate()` and unlike Playwright's single-arg wrapper trick. The synchronous `executeScript` (not `executeAsyncScript`) is correct, since `runa11yCoreInPage` is synchronous and returns its result directly.
- **Frame handling** is a stateful `switchTo()` context walk rather than iterating a `page.frames()` array — see "Scanning every frame" above.
- **Element refs** are context-bound `WebElement`s with a base64-string per-element screenshot rather than a file-writing one — see "Getting a live element handle" above.

## Building another framework binding?

See `@surea11y/core`'s [`BINDING_AUTHORS_GUIDE.md`](https://github.com/rumoroso/surea11y-core/blob/main/docs/BINDING_AUTHORS_GUIDE.md) — a reference for building a new binding (it names Selenium explicitly as a worked example), covering which parity features are engine-level (work through a generic `.options()`/`runOnly` passthrough with zero binding code, including WCAG-version tag filtering) vs. binding-layer (element refs, `reportOnly`-style verbosity filtering, the serialization-boundary caveat that `.withCustomRules()` exists to paper over).

`A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`@surea11y/binding-base`](https://github.com/rumoroso/surea11y-core-binding-base), a small shared package holding the scaffolding common to every framework binding. A new binding should depend on that package from the start.

## License

MIT — see [`LICENSE`](./LICENSE).

This package depends on [`@surea11y/core`](https://github.com/rumoroso/surea11y-core), which is MPL-2.0. MPL-2.0's copyleft is file-level and applies only to `@surea11y/core`'s own source files; consuming it as a normal package dependency doesn't affect this package's license.
