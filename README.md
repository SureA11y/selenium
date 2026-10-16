# @surea11y/selenium

A Selenium WebDriver binding for [`@surea11y/core`](https://github.com/SureA11y/core) — scans a real, already-rendered page for accessibility issues using surea11y's DOM-rules engine.

## Install

```bash
npm install @surea11y/selenium selenium-webdriver
```

`@surea11y/core` 1.12.0 or later comes with it as a peer dependency, as `selenium-webdriver` does: npm 7 and later, and pnpm 8 and later, install it for you, so the line above is all you need. With Yarn 1 or npm 6, which don't install peers, add `@surea11y/core` to that line.

Being a peer means your project and this binding share one copy of core. That matters as soon as your project uses core directly, to write a SARIF log or an HTML report (`@surea11y/core/sarif`, `/report`), read the rule catalogue, or keep a baseline: those read results with the same core that produced them, so a report never labels a finding with another release's rules. It holds when you bring your own core too: a linked checkout (`file:../core`), a monorepo, a fork, or a pinned release. Before 1.4.0, core was a regular dependency, and a project whose core differed from the binding's got a second copy without a word; such a project needed `"overrides": { "@surea11y/core": "$@surea11y/core" }` in its `package.json`, which it can now drop.

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
  .withWcag('2.2', 'AA')         // the rules for WCAG 2.2's A and AA criteria
  .disableRules(['meta-refresh-no-exceptions'])
  .options({ contrast: { mode: 'auditorAssist' } })
  .analyze();

console.log(results.checksResults.filter(r => r.outcome === 'fail'));
await driver.quit();
```

The builder takes `{ driver }` (a Selenium `WebDriver`), where the Puppeteer/Playwright bindings take `{ page }` — that's the one construction difference. Everything downstream of that is identical.

From 1.4.0 this package requires `@surea11y/core` 1.12.0 or later (installed with this package as a peer; see [Install](#install), and [What changes with `@surea11y/core` 1.12](#what-changes-with-surea11ycore-112)). `results.engine.version` names the core release that produced a result, such as `"1.12.0"`; quote it in a bug report.

`results` is `@surea11y/core`'s own native result shape — see its [`OUTPUT_SCHEMA.md`](https://github.com/SureA11y/core/blob/main/docs/OUTPUT_SCHEMA.md) — not the `violations`/`passes`/`incomplete`/`inapplicable` shape used by other popular accessibility testing tools. The builder's *method names* are modeled on common conventions in this space for migration familiarity; the richer result schema is kept as-is.

Also see `examples/basic-scan.js` for a runnable script (`npm run example -- <url>`).

`.withWcag(version, level)` selects by conformance target: `.withWcag('2.2', 'AA')` runs the rules for WCAG 2.2's Level A and AA criteria, by the level each criterion has in that version (4.1.1 Parsing, which 2.2 removed, is part of a `'2.1'` target and not of a `'2.2'` one). `.withBestPractices()` adds the rules that name no WCAG criterion, such as `region` and `heading-order`; on its own it runs only those. `.withRules()` and `.withTags()` add to a target's rules, and the disable methods apply after. The level is read in any case (`'aa'` is `'AA'`). A version other than `'2.0'`, `'2.1'` or `'2.2'`, or a level other than A, AA or AAA, throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. Both need `@surea11y/core` 1.11 or later.

`.withTags()` and `.disableRules()` have counterparts: `.withRules([...])` (only run these specific rule IDs) and `.disableTags([...])` (never run rules carrying any of these tags). All four compose the same way similar allow/deny-list options do in other accessibility testing tools, with one non-obvious rule worth knowing: a "disable" always wins over a "with" on the same ID/tag (e.g. `.withRules(['a']).disableRules(['a'])` drops `'a'` entirely), and combining `.withRules()` **and** `.withTags()` together requires a rule to satisfy *both* (`@surea11y/core`'s default `includeMode: 'and'`), not either one, unless you ask for that with `.includeMode('or')` (below).

`.includeMode(mode)` decides how `.withRules()` and `.withTags()` combine when both are given: `'and'`, the default, runs only the rules that match both, and `'or'` runs those that match either. That's what lets a scan say "this area, plus these checks". A team that owns a design system's form components, say, can run every rule about forms and the contrast check too, in one scan:

```js
const results = await new A11yCoreBuilder({ driver })
  .withTags('forms')
  .withRules('contrast-computable')
  .includeMode('or')             // every forms rule, plus the contrast check
  .analyze();
```

Without `.includeMode('or')`, the same lines run no rule at all, since `contrast-computable` isn't tagged `forms`, and a scan of no rules looks clean. The same goes for a WCAG level tag beside a best practice: `.withTags('wcag2a').withRules('region')` runs nothing, and with `'or'` runs the `wcag2a` rules plus `region`. On its own, with no other selection, it changes nothing. A value other than `'and'` or `'or'` throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. A `.withWcag()` target doesn't need it: its rules are always added to what tags and rules select.

`.wcagLevel(level)` sets the WCAG level of the criteria a scan reports, without changing which rules run: criteria above it are left out of `results.rulesResults`, while every selected rule still runs and reports in `results.checksResults`. It's what lets a scan that names a few checks say it is meant as WCAG AA. A team that gates each pull request on colour contrast alone, say, runs one check, which covers both 1.4.3 (AA) and 1.4.6 (AAA):

```js
const results = await new A11yCoreBuilder({ driver })
  .withRules('contrast-computable')
  .wcagLevel('AA')               // report 1.4.3, not the AAA 1.4.6
  .analyze();
```

Without `.wcagLevel('AA')`, that scan reports 1.4.6 as well, so a site that meets AA can show a failing AAA criterion it never aimed for. With it, the scan reports 1.4.3 alone, and `results.engine.wcagLevel` says `'AA'`. A `.withWcag()` target already implies its level; `.wcagLevel()` is for selections that don't, and wins when both are given, as it does over a level given through `.options()`. `'A'`, `'AA'` or `'AAA'` in any case is accepted. Anything else throws a `TypeError` with `code: 'INVALID_ENGINE_OPTIONS'` at the call, and `null` clears it. Needs `@surea11y/core` 1.12.0 or later.

`.plannedChecks()` and `.plannedCriteria()` say what a scan *will* check before you run it: the rules it runs (entries with `ruleId`) and the criteria it reports in `rulesResults` (entries with `id`), worked out in Node from the same selection and options, with no browser. Use them to record what a run covered next to its result, or to catch a selection that runs nothing, which would otherwise look like a clean scan:

```js
const builder = new A11yCoreBuilder({ driver }).withTags('forms').withRules('contrast-computable');
if (builder.plannedChecks().length === 0) {
  throw new Error('This selection runs no rule. Did you mean .includeMode("or")?');
}
const results = await builder.analyze();
```

`.exclude(selector)` above excludes globally. Pass a second argument to scope it to specific rule IDs instead: `.exclude('.mat-select', { rules: ['aria-required-children'] })` skips `.mat-select` for that rule only — every other rule still sees it. Global and rule-scoped `.exclude()` calls compose freely.

**A scope that matches nothing scans nothing.** Since `@surea11y/core` 1.10.0, an `.include()` selector that matches no element is not scanned: when none of them matches, every rule reports `notApplicable`, which on its own reads like a clean page. The result's `contextMatch` (`{ elementCount, unmatchedSelectors }`, or `null` without `.include()`) says how the scope resolved, and `getScanGaps(results)` lists what the scan left out: a scope that matched nothing (`context-not-found`), part of a scope that matched nothing (`context-partly-not-found`), each custom rule that did not run (`custom-rule-skipped`, from the result's `skippedCustomRules`; one you excluded yourself with `.disableRules()` is not a gap), and each pack that did not run (`pack-skipped`, from the result's `skippedPacks`; see [Scanning with packs](#scanning-with-packs-standards-checklists-and-your-own-rules)). `formatFailures(results)`, below, includes them. `analyze()` also prints each gap with `console.warn` (per frame with `.frames(true)`), such as `@surea11y/selenium (https://example.com/): Nothing was scanned: the scan scope matched no element ("#main").`, since core's own warning goes to the browser's console, which a Selenium run doesn't show.

That warning is the right default for a test run. A project that already handles gaps itself can take them over with `.logger(fn)`: `fn(gap, result)` is called once per gap, with the gap as `getScanGaps()` gives it and the result of the frame it came from, instead of `console.warn`. A scanning service that shows gaps to its users, say, can send them once to its own structured log, rather than also printing a loose line on the server's console for every scan:

```js
const results = await new A11yCoreBuilder({ driver })
  .include('#checkout')
  .logger((gap, frame) => log.warn({ url: frame.url, kind: gap.kind }, gap.message))
  .analyze();
```

A batch job that writes `getScanGaps(results)` into its own report can pass `.logger(() => {})` to keep its output to the report, and `.logger(null)` brings `console.warn` back. Anything other than a function or `null` throws a `TypeError` at the call, and a later call replaces the logger. Either way, `getScanGaps(results)` still lists every gap.

`getScanNotes(results)` says how the page was scanned, which a gap doesn't cover, and nothing was left out: `'forced-colors'` when the page was shown in [forced colors](#forced-colors), and `'internals-hook'` when the scan asked about web components it could have read with the [internals hook](#web-components-the-internals-hook). `analyze()` also prints the internals note, once per scan, and a `.logger()` receives it (check `kind` to tell a note from a gap).

**Create one builder per scan.** `A11yCoreBuilder` is a mutable object with no reset between `.analyze()` calls — `include()`/`exclude()`/`withRules()`/`disableRules()`/`withTags()`/`disableTags()`/`options()`/`withCustomRules()`/`withPacks()` all push onto or merge into internal state that persists for the instance's lifetime. Calling one of them again before a second `.analyze()` call *accumulates* on top of the first scan's scope rather than replacing it (this is exactly what makes "call `.include()` several times for one scan," above, work — the same accumulation just also applies across separate scans if you reuse an instance). `.reportOnly()`/`.frames()`/`.elementRef()`/`.withWcag()`/`.withBestPractices()`/`.includeMode()`/`.wcagLevel()`/`.logger()` are the exception: each call replaces the previous value instead of merging with it.

### Using it as an E2E accessibility gate

The pattern above works unchanged inside a real test:

```js
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { A11yCoreBuilder, formatFailures, getScanGaps } = require('@surea11y/selenium');

const options = new chrome.Options().addArguments('--headless=new');
const driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();
await driver.get('https://example.com/');

const results = await new A11yCoreBuilder({ driver }).reportOnly(['fail']).analyze();

assert.ok(
  results.checksResults.length === 0 && getScanGaps(results).length === 0,
  formatFailures(results)
);
```

Checking `getScanGaps()` as well keeps a scan that left something out (an `.include()` scope that matched nothing, a custom rule or a pack that did not run) from passing with zero findings.

See `examples/e2e-test-example.test.js` for a fuller, runnable version (`npm run example:e2e`) — one test proving real violations get caught (unlabeled button, missing `alt`), one proving a well-formed page passes cleanly, and one gating a page on a pack's checklist. It uses `node:test` directly rather than a dedicated test-runner package: Selenium's JS bindings are a pure automation library with no first-party test runner (the way `@playwright/test` is the default for Playwright), and `node:test` is a zero-new-dependency choice that already matches this project's own test suite.

### Readable console/CI output on failure

A bare length/equality assertion alone gets you a *working* gate, but the failure message is a raw, deeply-nested object diff — hundreds of lines for a handful of violations. `formatFailures(results)` turns that into a short, scannable block (one entry per occurrence, numbered, with rule ID/severity/location/hint) that you hand to your assertion library's own failure-message parameter, as above. Given a whole result, it then adds what the scan left out (see `getScanGaps()` above) and the core release that produced the result. A real failure then prints:

```
AssertionError [ERR_ASSERTION]: 1) button-name-present (serious): This button has no accessible name.
   at html > body > main > button
   Give the button visible text, or name it with aria-label, so screen reader users know what it does.
2) img-alt-present (serious): This <img> has no alt attribute.
   at html > body > main > img
   Add an alt attribute that says what the image shows, or alt="" if the image is purely decorative.

Scanned with @surea11y/core 1.12.0.
```

and a scan whose `.include()` scope matched nothing prints, instead of "No accessibility violations found.":

```
Nothing was scanned: the scan scope matched no element ("#main-content").

Scanned with @surea11y/core 1.12.0.
```

Before the version line, it also prints the result's notes (`getScanNotes()`, above), such as `The page was shown in forced colors (high contrast); contrast findings may differ with forced colors off.`

An occurrence inside a shadow tree is located through its shadow hosts, as `my-app >>> img` (`formatOccurrenceLocation(occurrence)` gives the same string). `formatFailures(results.checksResults)` still works and prints only the findings. A `.frames(true)` result is not one scan result: format `results.topFrame` and each entry of `results.frames` that has `checksResults` on its own; given the `{ topFrame, frames }` object itself, `formatFailures()` throws a `TypeError` rather than report it as clean. `@surea11y/core`'s reporters take that object whole (see [Scanning every frame](#scanning-every-frame-including-cross-origin-iframes)).

Deliberately a plain function, not a custom `expect` matcher — no dependency on any particular assertion library, so it works the same with `node:assert`, Jest, Vitest, Mocha, or a hand-rolled `if`/`throw`. Defaults to `fail`/`cantTell` outcomes (the only two that ever carry occurrences); pass `{ outcomes: [...] }` to narrow further. A thrown rule (`occurrences: []`, `error` set) is still surfaced using its `error` message rather than silently dropped.

### Scanning every frame, including cross-origin iframes

```js
const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();

console.log(results.topFrame.checksResults.filter(r => r.outcome === 'fail'));   // the top-level page
for (const frame of results.frames) {
  console.log(frame.checksResults.filter(r => r.outcome === 'fail'));            // each sub-frame, same result shape
}
```

`results.frames` is a flat list of every sub-frame, however deeply nested. A frame that couldn't be scanned is an entry `{ url, error }` instead of a result, so check for `error` before reading `checksResults`.

`@surea11y/core`'s reporters take this result as it is (core 1.11.1 and later): `renderSarifReport(results)`, `renderJunitReport(results)`, `renderHtmlReport(results)` and the baseline functions report every frame's findings, and a frame that couldn't be scanned as not scanned, so it never reads as a pass.

```js
const fs = require('node:fs');
const { renderSarifReport } = require('@surea11y/core/sarif');

const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();
fs.writeFileSync('a11y.sarif', renderSarifReport(results));
```

`.include()` scopes the top frame only; each sub-frame is scanned whole, as `@surea11y/core`'s own `runa11yCoreAcrossFrames` does. The selectors name elements of the top-level page, and since core 1.10.0 a selector that matches nothing in a frame would scan nothing there. `.exclude()` applies in every frame. An invalid rule/tag selection or scope selector rejects from the top frame, before any sub-frame is scanned (see "Errors" below).

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

A result trimmed this way is no longer the whole scan to `@surea11y/core`'s reporters: JUnit counts one test per rule it finds, and EARL makes one assertion per rule. To keep a result small and still hand it to them, ask the engine for a compact one instead, with `.options({ output: { detail: 'findings' } })`: a rule that passed or did not apply keeps only its outcome, and every reporter reads it as the full result. An empty page's result goes from about 238 KB to 82 KB.

### Getting a live element handle, not just a selector string

By default each occurrence carries a CSS selector + HTML snippet, not a live reference to the element. Opt in to a real Selenium `WebElement` with `.elementRef(true)`:

```js
const results = await new A11yCoreBuilder({ driver }).elementRef(true).analyze();

const [failing] = results.checksResults.filter(r => r.outcome === 'fail');
await failing.occurrences[0].elementHandle.click();
const pngBase64 = await failing.occurrences[0].elementHandle.takeScreenshot();
```

This resolves each occurrence to a `WebElement` in the page instead of leaving you to re-resolve a possibly-stale selector string yourself. An occurrence inside a shadow tree carries `shadowHostSelectors` (since `@surea11y/core` 1.10.0), and its `selector` holds only inside the last host's shadow root, so looking it up in the document finds another element or none; the handle is found through the hosts instead (`queryOccurrenceElement` from `@surea11y/binding-base`). It is `null` when a host or the element is missing. Default off — resolving a handle per occurrence is a real page query per occurrence, so it costs more than a plain `.analyze()`. The field is named `elementHandle` for drop-in parity with the sibling bindings, even though Selenium's type is `WebElement`.

**Per-element screenshots ARE supported, but the shape differs from Puppeteer/Playwright.** Selenium's `WebElement.takeScreenshot()` **returns a base64-encoded PNG string**, where Puppeteer/Playwright's `elementHandle.screenshot({ path })` writes a file directly. Write it yourself if you want a file: `fs.writeFileSync('flagged.png', await handle.takeScreenshot(), 'base64')`. `.click()` and the rest of the `WebElement` API work as normal.

**Two honest caveats, both verified against real runs:**

- **Empty-selector occurrences.** Not every occurrence has one target element — a page-wide finding (some `manual`/`cantTell` rules, e.g. `contrast-enhanced`) can carry `selector: ""`. This binding short-circuits an empty selector to `occurrence.elementHandle = null` without a round trip to the browser — same `null` outcome as the sibling bindings. (Selenium's `By.css("")` would throw `InvalidSelectorError`, so don't pass such a selector to `driver.findElements()` yourself.)
- **Sub-frame handles are context-bound.** With `.frames(true)`, a `WebElement` for an occurrence inside a sub-frame is only usable *while the driver is switched into that frame*. Because `analyze()` deliberately returns the driver to the top-level document when it finishes, using such a handle means switching back into its frame first (`driver.switchTo().frame(iframe)`); it throws `NoSuchElementError` from any other context. The handle is valid, not dead — it revives on re-entering its frame. This is a genuine Selenium property (element references are scoped to a browsing context), with no equivalent in Puppeteer/Playwright's context-free `ElementHandle`s. The **top frame's** handles (single-frame mode, or `results.topFrame`) have no such caveat, since the top *is* the default context.

### Web components: the internals hook

Many web components keep their `ElementInternals` in a private field and name themselves, set their states or give themselves a role through it:

```js
class SubscribeCheckbox extends HTMLElement {
  #internals = this.attachInternals();
  constructor() {
    super();
    this.#internals.ariaLabel = 'Subscribe';
    this.#internals.ariaChecked = 'false';
  }
}
```

The browser exposes that name, but no page script can read it back, so by default the scan asks about such a component (`cantTell`) instead of judging it. A component that's a `switch` only through `this.#internals.role` isn't even asked about: the scan doesn't see its role, so it isn't checked at all.

`A11yCoreBuilder.installInternalsHook(driver)` installs `@surea11y/core`'s opt-in hook, which records each component's internals for the scan to read. It has to run before the page's own scripts, which classic WebDriver can't do, so it uses:

- **WebDriver BiDi** (`script.addPreloadScript`) when the session has it: Chrome, Edge and Firefox, with BiDi enabled when the driver is built;
- otherwise, on **Chrome and Edge**, the DevTools protocol (`Page.addScriptToEvaluateOnNewDocument`).

Either way it runs in every frame and after each navigation. Call it **before** `driver.get()`:

```js
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { A11yCoreBuilder } = require('@surea11y/selenium');

const options = new chrome.Options().enableBidi(); // the webSocketUrl: true capability
const driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();

await A11yCoreBuilder.installInternalsHook(driver); // 'bidi' (or 'cdp' without BiDi on Chrome)
await driver.get('https://example.com/');

const results = await new A11yCoreBuilder({ driver }).analyze();
results.engine.environment.internalsHook; // 'early': the hook ran before the page's scripts
```

With it, the checkbox above passes, an unnamed component that attaches internals fails like any unnamed control, and the switch is checked as a switch, so it fails without a name. It resolves to `'bidi'` or `'cdp'`, the way it was installed.

- **A classic session on another browser** (Safari, or Firefox without BiDi) has no way to run a script before the page loads: the call rejects, saying how to enable BiDi. There, such components stay questions, and roles set through internals aren't checked.
- **Before the page loads.** On a page that's already loaded, the call has no effect until the next navigation (a refresh will do), and the result has no `internalsHook`.
- **For test and audit runs.** The hook wraps `HTMLElement.prototype.attachInternals` (components get the same internals back), adds a stack frame to errors thrown through it, and keeps its record under a global symbol, where any script on the page can read every component's internals. That's why it's opt-in.
- **Without it**, `analyze()` says so once per scan when it asked about such components (`1 custom element was asked about because the scan could not read...`), and `getScanNotes()` gives that note as `kind: 'internals-hook'`.

### Forced colors

A page shown in forced colors (Windows high contrast) draws in the user's colors, not its own. `results.engine.environment.forcedColors` says which it was: `'active'` or `'none'`. To check a page under forced colors on purpose in Chrome or Edge, emulate it through the DevTools protocol before scanning:

```js
await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
  features: [{ name: 'forced-colors', value: 'active' }]
});
await driver.get('https://example.com/');
const results = await new A11yCoreBuilder({ driver }).analyze();
results.engine.environment.forcedColors; // 'active'
```

Selenium offers no way to emulate it in Firefox or Safari. The contrast rules still measure the page's own colors under forced colors, since WCAG judges contrast in those, so results match a scan with forced colors off; a contrast finding the engine couldn't measure that way carries `details.forcedColors: true`. When forced colors were active, `formatFailures()` adds a line saying so, since it's easy to miss on a CI agent with high contrast turned on.

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

A custom rule descriptor is the same shape as one of `@surea11y/core`'s own internal rule modules (`{ id, meta, runInPage, applicability?, data? }`) — see its [`ENGINE_OPTIONS.md`](https://github.com/SureA11y/core/blob/main/docs/ENGINE_OPTIONS.md) for the full contract. Results appear in `checksResults` exactly like a built-in rule's, including automatic `selector`/`html`/`structuralPath` fill-in. Registered per-scan only (nothing persists between calls or shows up in any catalog listing), and a custom rule whose `id` collides with a built-in one overrides it for that scan.

Pass an array to register several at once, or call `.withCustomRules()` again to add more — like `.withRules()`/`.withTags()`, it accumulates rather than replacing what was already registered:

```js
const results = await new A11yCoreBuilder({ driver })
  .withCustomRules([firstRule, secondRule])
  .withCustomRules(thirdRule) // adds a third, doesn't replace the first two
  .analyze();
```

**Why `.withCustomRules()` instead of the raw `.options({ customRules })` passthrough** (still supported, and composes with this method if you use both): `runInPage`/`applicability` must reach the page as a function-source *string*, not a live `Function` — a Selenium `driver.executeScript()` argument crosses a serialization boundary that can't carry a live function reference, only a string `@surea11y/core` can reconstruct with `new Function` on the page side. Passing a raw live function via `.options()` directly would silently fail to serialize; `.withCustomRules()` calls `.toString()` on a live function for you (patching the ES6 method-shorthand `.toString()` quirk, where `{ runInPage(ctx){...} }` stringifies without the `function` keyword and would otherwise silently fail to revive), so you can write a normal function and not have to remember that constraint yourself. A string is still accepted as-is if you already have one.

A custom rule you turn off for one scan (`.withCustomRules(rules).disableRules('org-banner-text')`) is listed in `skippedCustomRules` with `excluded: true` and isn't a scan gap, so it isn't warned about (core 1.12.0 and later).

Invalid input (a missing/empty `id`, or a `runInPage`/`applicability` that's neither a function nor a non-empty string) throws immediately from `.withCustomRules()` itself, rather than surfacing later as a skipped rule deep inside the page — easier to catch during development. (Note: a *raw* `.options({ customRules })` call bypasses this check entirely and defers to `@surea11y/core`'s own engine-side behavior, which skips an invalid descriptor rather than throwing. Since core 1.10.0 the result lists each skipped rule and why in `skippedCustomRules`, and `getScanGaps()`/`formatFailures(results)` report it.)

### Errors

Since `@surea11y/core` 1.10.0 the engine refuses input it can't use instead of scanning something else, and `analyze()` rejects with an `EngineError` (exported by this package) carrying a `code`:

- `INVALID_RUN_ONLY`: `.withRules()`/`.withTags()` named no rule or tag the engine knows (a typo such as `.withTags(['wcag2.2aa'])`). It used to run no rule, or every rule, and pass. An unknown value next to known ones is ignored with a warning in the browser console.
- `INVALID_CONTEXT_SELECTOR`: an `.include()` selector the browser can't parse; `err.selector` is that selector.
- `INVALID_ENGINE_OPTIONS`: with `.options({ strictOptions: true })`, an option the engine doesn't read or a value it can't use. The message names each, with the closest known option (`lcoale`: did you mean `locale`?). Without `strictOptions`, a likely typo is only warned about in the browser console.
- `PAGE_BUILTINS_BROKEN`: the page's own scripts broke a JavaScript built-in the engine relies on (`Array.prototype.filter`, `Map`, `JSON.stringify`, ...), so no result it gave could be trusted. The message names each one.

```js
const { A11yCoreBuilder, EngineError } = require('@surea11y/selenium');

try {
  await new A11yCoreBuilder({ driver }).withRules(['img-alt']).analyze();
} catch (err) {
  if (err instanceof EngineError && err.code === 'INVALID_RUN_ONLY') {
    // fix the rule id
  }
  throw err;
}
```

`.withRules()`, `.withTags()`, `.disableRules()` and `.disableTags()` throw a `TypeError` with the same `code` at the call when given a value that isn't a non-empty string (such as `undefined` from a missing config value).

### Checking against EN 301 549

EN 301 549, the standard the European Accessibility Act refers to, restates WCAG's Level A and AA criteria in its chapter 9. `.options({ profile })` runs the rules for its version, and each finding carries its EN 301 549 clause beside its WCAG criterion, in `meta.normativeMappings` (WCAG 1.1.1 is clause 9.1.1.1):

```js
// EN 301 549 V4.1.1 (WCAG 2.2 A and AA); 'en301549-v3.2.1' for V3.2.1 (WCAG 2.1 A and AA)
const results = await new A11yCoreBuilder({ driver })
  .options({ profile: 'en301549-v4.1.1' })
  .analyze();

results.engine.profile; // 'en301549-v4.1.1'
```

`.withWcag()`, `.withRules()` and `.withTags()` select rules instead of a profile, so leave them out when scanning with one. As with any target, a scan with no failures means no rule found a violation, not that the page conforms: most criteria need a person to check them. A profile name core doesn't know is not an error: the scan runs without it, core warns in the page's console, and `results.engine.profile` is left out.

### Scanning with packs: standards, checklists and your own rules

A pack brings rules, variants of core's rules, a standard or a checklist, and their profiles and messages, from a package of its own: a national standard such as RGAA, or your organisation's accessibility policy. `@surea11y/core` runs a pack as it runs its own rules and standards, so its results, rollups and report entries look like core's. Packs need `@surea11y/core` 1.11.1 or later.

`.withPacks()` registers packs in the page, and in every frame with `.frames(true)`, before the scan (it runs the packs' script with `driver.executeScript()` in each frame it switches into); a pack's profile is chosen with `.options({ profile })`:

```js
const acmePolicy = require('@acme/a11y-policy'); // a pack

const results = await new A11yCoreBuilder({ driver })
  .withPacks(acmePolicy)
  .options({ profile: 'acme-web-2026' })
  .analyze();

results.engine.packs;   // ['@acme/a11y-policy@1.0.0']
results.engine.profile; // 'acme-web-2026'

// A checklist's items, each one result, beside core's WCAG rollups:
results.rulesResults.filter((r) => r.meta && r.meta.standard === 'Acme web policy');
```

A pack's own rules appear in `checksResults` like core's, with ids that start with its namespace (`acme-no-autoplay`). Without its profile, a pack's rules run only when selected, with `.withRules()` or by a tag. `@surea11y/core`'s HTML, SARIF and JUnit reports show a standard's or a checklist's items in a section of their own. Pass an array, or call `.withPacks()` again, to scan with several packs.

**Writing a pack.** A pack is an object made with `definePack` from `@surea11y/core/pack`. [`examples/acme-policy-pack.js`](./examples/acme-policy-pack.js) is a small one: a house rule, a checklist profile (WCAG 2.2 A and AA, `region`, and the house rule) and two checklist items. `npm run example:pack` scans a page with it, and [`examples/e2e-test-example.test.js`](./examples/e2e-test-example.test.js) uses it as a test gate. For a pack of your own, `npx surea11y-pack new <folder>` (from `@surea11y/core`) writes a package that works as generated, with its tests, docs and lint; core's [`PACKS.md`](https://github.com/SureA11y/core/blob/main/docs/PACKS.md) is the guide.

**When a pack doesn't run.** `.withPacks()` builds the page's script with the `@surea11y/core` this binding loads, and checks each pack as it does: `.analyze()` throws before scanning for a pack that core can't run, such as one whose `core` range leaves out the installed core, or whose profile names a rule that doesn't exist. A pack the page then doesn't run (one named with a raw `.options({ packs })` and never registered, or a page running another core version, when two copies of core are installed) is listed in `results.skippedPacks` with the reason. `getScanGaps()` reports that as `'pack-skipped'`, and `.analyze()` warns about it, so a test gate that asserts on `getScanGaps(results)` fails rather than passing with the pack's checks never run. Install the pack beside the binding, so npm resolves one core for both.

### Element addressing beyond a CSS selector

Every occurrence already carries `selector` and (with `.elementRef(true)`, above) a live `WebElement`. It also carries `structuralPath` — a sibling-index path from the document root down to the flagged element (e.g. `[1, 0, 2]`) — a more robust identity than a selector string alone, since it survives some DOM changes a selector wouldn't (an id/class rename, for instance). No opt-in needed; it's already on every `fail`/`cantTell` occurrence today. See [`OUTPUT_SCHEMA.md`](https://github.com/SureA11y/core/blob/main/docs/OUTPUT_SCHEMA.md) for the full field description.

## TypeScript

`src/A11yCoreBuilder.d.ts` (re-exported from `src/index.d.ts`, wired up via `package.json`'s `types` field) ships hand-written types for the whole builder API. The result shapes (`A11yCoreResult`, `CheckResult`, `Occurrence`, `CompositeResult`, etc.) are built on `@surea11y/core`'s own types, so they carry every field core declares (`engine.version`, `contextMatch`, `skippedCustomRules`, `margin`, `shadowHostSelectors`, ...); this package adds only `Occurrence#elementHandle`. `EngineError`, `getScanGaps()`, `getScanNotes()`, `formatOccurrenceLocation()` and `formatFailures()` are typed as `@surea11y/binding-base` declares them, and so are `withWcag()` and `wcagLevel()` (`WcagVersion`, `WcagLevelInput`), `plannedChecks()`/`plannedCriteria()` (`PlannedCheck`, `PlannedCriterion`), the static `installInternalsHook()`, and `withPacks()`, which takes a pack made with `definePack` (`PackLike`). Code that handles every `ScanGap` kind it knows and treats the rest in an `else` branch needs a branch for `'pack-skipped'`, which carries `pack` rather than `selectors`. `analyze()` is typed `Promise<A11yCoreResult | A11yCoreMultiFrameResult>` — narrow on `'topFrame' in results` (or cast, if you already know which mode you called) to get the specific shape back, since a fluent builder can't statically track that `.frames(true)` was called earlier in the chain. `selenium-webdriver` is a `peerDependencies` entry (not just `devDependencies`) since the class's `driver` argument and `Occurrence#elementHandle` (a `WebElement`) both come from it — consumers need their own `selenium-webdriver` install for the types to resolve, same as they already do to construct a `WebDriver` in the first place. `npm test` compiles a consumer script exercising every method and both `analyze()` return shapes with `tsc --strict` (`tests/types/usage.ts`).

## What changes with `@surea11y/core` 1.12

This release needs `@surea11y/core` 1.12.0. What a scan through this binding shows differently (core's [`CHANGELOG.md`](https://github.com/SureA11y/core/blob/main/CHANGELOG.md) has the full list):

- **An empty heading now fails an unscoped scan.** `empty-heading` used to ask about a heading with no accessible name; it now fails it. It's a best practice, so it runs in a scan that selects nothing and with `.withBestPractices()`, not under `.withWcag()`, tags or a profile. A gate on a page with `<h2></h2>` that asserted no failures now fails: fix the heading, or scan a WCAG target.
- **Scans that pick rules report their criteria.** `.withRules('img-alt-present')`, a non-WCAG tag or `.withBestPractices()` now fill `rulesResults` with the WCAG criteria those rules belong to, where it was empty. A criterion whose other rules weren't selected is `cantTell` (`reasonCode` `composite.rollup.cantTell.notSelectedChild`), and each check's `rollupIds` names the criteria it was added for. `.wcagLevel()` keeps those criteria to a level.
- **Four rules count towards more criteria**, as W3C's ACT rules map them: `input-image-alt-present` adds 4.1.2, `aria-roles-valid` 1.3.1, `link-name-present` 2.4.9 (AAA), and `meta-refresh-timing-absent` 2.2.4 and 3.2.5 (AAA). The findings don't change; the 1.3.1 and 4.1.2 rollups can now fail where they passed.
- **Unnamed custom elements are questions.** A defined custom element with no visible name may name itself through `ElementInternals`, so it's `cantTell` (`name_internals`) where it used to fail. [`installInternalsHook()`](#web-components-the-internals-hook) lets the engine decide, where the session allows it.
- **`engine.wcagLevel`** records the level a scan was gated by, and [`.wcagLevel()`](#usage) sets it.
- **`engine.environment.forcedColors`** records whether the page was in [forced colors](#forced-colors).
- **A custom rule you exclude** isn't a scan gap any more, so `.disableRules()` of one prints no warning.
- **Rule IDs in another case select their rule**: `.withRules('IMG-ALT-PRESENT')` used to throw `INVALID_RUN_ONLY` or be ignored.
- **`runOnly.optInTags` on its own throws** `INVALID_RUN_ONLY`; it was accepted and did nothing. Opt-in rules are unlocked with `.options({ optInRules })`.
- **A finding in a shadow tree is located through its hosts**, as `#card >>> img`, in core's HTML report, SARIF, JUnit and baselines, as `formatFailures()` already did.
- **An inline `policyContract`** with an unknown value in `allowedOutcomes` or `allowedConfidence` drops that value with a warning, where it turned every check into `cantTell`.

## What changes with `@surea11y/core` 1.11

The binding passes rule IDs, tags and options through to the engine, so these show in results without a change here (see core's [`CHANGELOG.md`](https://github.com/SureA11y/core/blob/main/CHANGELOG.md) for the full list):

- **Messages are reworded** in all five languages to say plainly what is wrong and what to do (`This <img> has no alt attribute.`). Message keys, rule IDs, reason codes and baselines are unchanged; a test that matches message text needs the new wording.
- **Contrast and target size measure what is on screen.** In a browser, the contrast rules check only text a reader can see, measure it against what is painted under it, and measure form field values and placeholders. `target-size-minimum` measures the area a pointer can hit, and exempts only links in a sentence. Expect new findings, and some old ones gone.
- **`aria-hidden-focus` maps to 4.1.2 only**, no longer to 2.4.7 Focus Visible, so `.withTags('wcag2aa')` alone no longer selects it.
- **A custom rule counts toward its WCAG criterion.** A `.withCustomRules()` rule with `meta.wcagSc` (or a WCAG `normativeMappings` entry) fails that criterion's rollup when it fails, and custom rules run after core's.
- **On/off options read as meant**: `.options({ perfStats: 'false' })` is off, where it was on. `.options({ strictOptions: true })` rejects any option the engine doesn't read (see [Errors](#errors)).

## Relationship to `@surea11y/playwright` and `@surea11y/puppeteer`

This binding's builder API is deliberately identical to the [Playwright](https://github.com/SureA11y/playwright) and [Puppeteer](https://github.com/SureA11y/puppeteer) bindings' — same method names, same mutability contract, same result shapes — so switching between them (or running the same accessibility gate logic against all three) is a near drop-in swap: construct a Selenium `WebDriver` instead of a Puppeteer/Playwright `Page`, pass it as `{ driver }` instead of `{ page }`, and the builder chain is unchanged. That's enforced by shared code, not just convention: `A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`@surea11y/binding-base`](https://github.com/SureA11y/binding-base), the same base class every sibling binding depends on.

The real implementation differences are internal, and all Selenium-specific:
- **The injection call** uses `driver.executeScript(inPageScan, url, contextSelector, engineOptions, runOnly)`, where `inPageScan` is `runa11yCoreInPage` wrapped by `@surea11y/binding-base`'s `createInPageScan()` so an engine error's `code` survives the trip back (see "Errors"). Selenium's `executeScript` is variadic and, handed a function, stringifies it and runs it as `return (fn).apply(null, arguments)` — so the four positional args pass straight through, like Puppeteer's variadic `page.evaluate()` and unlike Playwright's single-arg wrapper trick. The synchronous `executeScript` (not `executeAsyncScript`) is correct, since `runa11yCoreInPage` is synchronous and returns its result directly. With `.withPacks()`, the packs' script runs the same way, in each frame, just before the scan.
- **Frame handling** is a stateful `switchTo()` context walk rather than iterating a `page.frames()` array — see "Scanning every frame" above.
- **Element refs** are context-bound `WebElement`s with a base64-string per-element screenshot rather than a file-writing one — see "Getting a live element handle" above.

## Building another framework binding?

See `@surea11y/core`'s [`BINDING_AUTHORS_GUIDE.md`](https://github.com/SureA11y/core/blob/main/docs/BINDING_AUTHORS_GUIDE.md) — a reference for building a new binding (it names Selenium explicitly as a worked example), covering which parity features are engine-level (work through a generic `.options()`/`runOnly` passthrough with zero binding code, including WCAG-version tag filtering) vs. binding-layer (element refs, `reportOnly`-style verbosity filtering, the serialization-boundary caveat that `.withCustomRules()` exists to paper over).

`A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`@surea11y/binding-base`](https://github.com/SureA11y/binding-base), a small shared package holding the scaffolding common to every framework binding. A new binding should depend on that package from the start.

## Maintainer

Maintained by [Jorge Rumoroso](https://github.com/rumoroso).

## License

MIT — see [`LICENSE`](./LICENSE).

This package depends on [`@surea11y/core`](https://github.com/SureA11y/core), which is MPL-2.0. MPL-2.0's copyleft is file-level and applies only to `@surea11y/core`'s own source files; consuming it as a normal package dependency doesn't affect this package's license.
