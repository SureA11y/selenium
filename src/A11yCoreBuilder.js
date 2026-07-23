'use strict';

const { By } = require('selenium-webdriver');
const { runa11yCoreInPage } = require('a11y-core');

// See a11y-core's docs/OUTPUT_SCHEMA.md -- the only valid `outcome` values a
// checksResults entry can carry.
const VALID_OUTCOMES = ['pass', 'fail', 'cantTell', 'notApplicable'];

// a11y-core revives a customRules runInPage/applicability STRING back into a
// function via `new Function('return (' + value + ')')()` (see its
// src/core/dom-runner.js) -- the exact same mechanism used here, in Node,
// purely to verify a candidate string will actually reconstruct before it
// ever crosses the executeScript() boundary.
function canReconstructAsFunction(src) {
  try {
    // eslint-disable-next-line no-new-func
    return typeof new Function('return (' + src + ')')() === 'function';
  } catch (e) {
    return false;
  }
}

// Converts a live function to a source string a11y-core can revive on the
// page side. Function.prototype.toString() on an ES6 method-shorthand
// property (e.g. `{ runInPage(ctx) { ... } }`, the idiomatic way to write
// one of these descriptors, including `async`/generator variants) omits the
// `function` keyword entirely -- so the *exact same* revival mechanism
// a11y-core uses can't parse it back as a standalone expression. Verified
// with `canReconstructAsFunction` above (real check, not a regex guess at
// the syntax) and patched by re-adding `function ` when needed.
function toReconstructableSource(fn) {
  const direct = fn.toString();
  if (canReconstructAsFunction(direct)) return direct;
  const patched = direct.replace(/^(async\s+)?(\*\s*)?/, '$1function ');
  if (canReconstructAsFunction(patched)) return patched;
  // Some other shape neither form can reconstruct (e.g. a computed method
  // name) -- hand back the plain toString() anyway; a11y-core's own revival
  // will skip it the same way it always has for an unreconstructable
  // descriptor, rather than this method inventing a different failure mode.
  return direct;
}

/**
 * Selenium WebDriver binding for a11y-core -- scans a real, already-rendered
 * page.
 *
 * const results = await new A11yCoreBuilder({ driver })
 *   .include('#main')
 *   .exclude('.cookie-banner')
 *   .withTags(['wcag2a', 'wcag2aa'])
 *   .disableRules(['a11ycore-meta-refresh-no-exceptions'])
 *   .options({ contrast: { mode: 'auditorAssist' } })
 *   .analyze();
 *
 * `results` is a11y-core's own native result shape (checksResults /
 * rulesResults -- see a11y-core's docs/OUTPUT_SCHEMA.md), not axe-core's
 * violations/passes/incomplete/inapplicable shape. Method names are modeled
 * on axe-core's AxeBuilder for migration ease, but the richer native schema
 * (severity, confidence, occurrences, policy contract, WCAG SC mappings) is
 * kept as-is rather than reshaped to match axe.
 *
 * Opt in to scanning every frame on the page (including cross-origin
 * iframes) via .frames(true):
 *
 * const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();
 * // results.topFrame        -- same shape as the single-frame case above
 * // results.frames          -- array of the same native result shape, one per sub-frame
 *
 * Unlike axe-core (which needs a postMessage-based protocol, runPartial/
 * finishRun, to reach cross-origin iframes, since it's injected as a plain
 * <script> and is fully subject to the browser's same-origin policy), this
 * doesn't need any a11y-core engine support: Selenium switches WebDriver
 * context into every frame at the automation-protocol level, not as in-page
 * script, so a cross-origin frame's executeScript() already just works --
 * verified empirically against a real cross-origin iframe (https://example.org/),
 * see ../ROADMAP.md and tests/builder.test.js.
 *
 * The mechanics differ from the Puppeteer/Playwright bindings, though:
 * Selenium has no `page.frames()` array of independent Frame objects. A
 * frame is reached by a *stateful context switch* --
 * `driver.switchTo().frame(webElement)` changes what `driver.executeScript()`
 * runs against, and `driver.switchTo().defaultContent()` / `.parentFrame()`
 * unwind it. `.frames(true)` therefore enumerates iframes with
 * `driver.findElements(By.css('iframe, frame'))`, switches into each (and
 * recurses into nested iframes), scans, then unwinds the context, always
 * returning to the top-level document at the end even if a scan throws
 * partway (a stuck context would otherwise break whatever the caller does
 * next). See ../ROADMAP.md §2c for the full design. Default off, so plain
 * .analyze() keeps returning the single native result object it always has.
 *
 * By default `analyze()` returns every rule's outcome, including
 * `pass`/`notApplicable` -- a11y-core's own deliberate "not a
 * violations-only list" design (see a11y-core's docs/OUTPUT_SCHEMA.md).
 * Opt in to a lighter payload with `.reportOnly(['fail', 'cantTell'])`,
 * which post-filters `checksResults` by `outcome` (applied per-frame when
 * combined with `.frames(true)`, since `checksResults` lives at
 * `results.topFrame` / each `results.frames[i]` in that shape, not at the
 * top level):
 *
 * const results = await new A11yCoreBuilder({ driver })
 *   .reportOnly(['fail', 'cantTell'])
 *   .analyze();
 *
 * Opt in to a live Selenium `WebElement` per occurrence (instead of just a
 * CSS selector string) with `.elementRef(true)`, so you can act on the
 * flagged element directly rather than re-resolving its selector yourself:
 *
 * const results = await new A11yCoreBuilder({ driver }).elementRef(true).analyze();
 * const [firstFail] = results.checksResults.filter(r => r.outcome === 'fail');
 * await firstFail.occurrences[0].elementHandle.click();
 * const pngBase64 = await firstFail.occurrences[0].elementHandle.takeScreenshot();
 *
 * (Note: Selenium's per-element screenshot is `WebElement.takeScreenshot()`,
 * which RETURNS a base64-encoded PNG string rather than writing a file the
 * way Puppeteer/Playwright's `elementHandle.screenshot({ path })` does --
 * see ../ROADMAP.md §2d.)
 *
 * Register your own rule(s) for just this scan with
 * `.withCustomRules([...])` (a11y-core's `engineOptions.customRules`
 * escape hatch, axe's `configure({ rules })` equivalent -- see
 * a11y-core's docs/ENGINE_OPTIONS.md). Pass a real, live `runInPage`/
 * `applicability` function -- unlike the raw `.options({ customRules })`
 * passthrough, this method converts them to the function-source string
 * a11y-core needs on this side of the executeScript() serialization
 * boundary for you, so you don't have to remember to call .toString()
 * yourself:
 *
 * const results = await new A11yCoreBuilder({ driver })
 *   .withCustomRules({
 *     id: 'my-org-custom-rule',
 *     meta: { title: 'My custom rule', tags: ['custom'] },
 *     runInPage(ctx) {
 *       const el = ctx.document.querySelector('.my-widget');
 *       return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
 *     }
 *   })
 *   .analyze();
 *
 * Create one builder per scan. This is a mutable object with no reset
 * between analyze() calls: include()/exclude()/withRules()/disableRules()/
 * withTags()/disableTags()/options()/withCustomRules() all push onto or
 * merge into internal state that persists for the instance's lifetime, so
 * calling one of them again before a second analyze() call accumulates on
 * top of the first scan's scope rather than replacing it (intentional for
 * "call include() several times for one scan" -- see above -- but a footgun
 * if you hold one instance across multiple assertions).
 * reportOnly()/frames()/elementRef() are the exception: each call replaces
 * the previous value rather than merging with it.
 */
class A11yCoreBuilder {
  /**
   * @param {{ driver: import('selenium-webdriver').WebDriver, url?: string }} opts
   *   `driver` must already be navigated to and settled at the URL to scan --
   *   this class does not navigate for you.
   */
  constructor({ driver, url } = {}) {
    if (!driver || typeof driver.executeScript !== 'function') {
      throw new Error('A11yCoreBuilder requires { driver } (a Selenium WebDriver, with an .executeScript() method).');
    }
    this._driver = driver;
    this._url = url || null;
    this._scanFrames = false;
    this._includeSelectors = [];
    this._excludeSelectors = [];
    this._includeRuleIds = [];
    this._excludeRuleIds = [];
    this._tags = [];
    this._excludeTags = [];
    this._engineOptions = {};
    this._reportOutcomes = null;
    this._elementRef = false;
    this._customRules = [];
  }

  /**
   * Scope the scan to one region. Call multiple times to scan several,
   * possibly disjoint regions in one run (a11y-core's contextSelector
   * accepts an array of selectors for exactly this -- see a11y-core's
   * docs/ENGINE_OPTIONS.md).
   */
  include(selector) {
    if (selector) this._includeSelectors.push(selector);
    return this;
  }

  /** Skip elements matching this selector anywhere in the scanned scope. */
  exclude(selector) {
    if (selector) this._excludeSelectors.push(selector);
    return this;
  }

  /** Only run rules carrying at least one of these tags. */
  withTags(tags) {
    this._tags = this._tags.concat(Array.isArray(tags) ? tags : [tags]);
    return this;
  }

  /** Never run rules carrying any of these tags (applied after withTags). */
  disableTags(tags) {
    this._excludeTags = this._excludeTags.concat(Array.isArray(tags) ? tags : [tags]);
    return this;
  }

  /** Only run these specific rule IDs (accepts with or without the a11ycore- prefix). */
  withRules(ruleIds) {
    this._includeRuleIds = this._includeRuleIds.concat(Array.isArray(ruleIds) ? ruleIds : [ruleIds]);
    return this;
  }

  /** Never run these specific rule IDs (applied after withRules). */
  disableRules(ruleIds) {
    this._excludeRuleIds = this._excludeRuleIds.concat(Array.isArray(ruleIds) ? ruleIds : [ruleIds]);
    return this;
  }

  /** Merge arbitrary engineOptions (locale, contrast.mode, policyContract, ...) -- see a11y-core's docs/ENGINE_OPTIONS.md. */
  options(partialEngineOptions) {
    this._engineOptions = { ...this._engineOptions, ...(partialEngineOptions || {}) };
    return this;
  }

  /**
   * Register one or more custom rules for just this scan (a11y-core's
   * engineOptions.customRules escape hatch -- see a11y-core's
   * docs/ENGINE_OPTIONS.md -- axe's configure({ rules }) equivalent). A
   * descriptor is { id, meta?, runInPage, applicability?, data? }, the same
   * shape as an internal a11y-core rule module's own export. Call multiple
   * times to register several rules across one scan (accumulates, same as
   * withRules()/withTags(), rather than replacing -- see this class's own
   * header comment on mutability).
   *
   * Unlike the raw `.options({ customRules })` passthrough, `runInPage`/
   * `applicability` may be passed as real, live functions here -- this
   * method converts each to a function-source string itself, since a
   * Selenium executeScript() argument crosses a serialization boundary that
   * cannot carry a live Function reference (a11y-core reconstructs the string
   * back into a function via `new Function` on the page side). A string is
   * still accepted as-is for callers who already have one. Plain
   * Function.prototype.toString() isn't quite enough on its own: an ES6
   * method-shorthand property (`{ runInPage(ctx) { ... } }` -- the idiomatic
   * way to write one of these, and what every example in this file's own
   * docs/tests uses) stringifies *without* the `function` keyword, which
   * a11y-core's own `new Function('return (' + value + ')')()` revival
   * can't parse back as a standalone expression. This method verifies
   * reconstructability the same way a11y-core will and patches that specific
   * case automatically, so you don't need to know about it.
   *
   * A descriptor whose `id` collides with a built-in rule overrides it for
   * that scan only (a11y-core's own semantics, matching axe's configure()
   * override behavior) -- nothing here persists past this one analyze() call
   * or mutates a11y-core's static rule catalog.
   */
  withCustomRules(rules) {
    const list = Array.isArray(rules) ? rules : [rules];

    // Validate the whole batch before normalizing/pushing any of it, so one
    // invalid descriptor later in the array can't leave an earlier valid one
    // partially registered -- same all-or-nothing spirit as reportOnly()'s
    // own validate-then-assign shape below.
    for (const rule of list) {
      if (!rule || typeof rule.id !== 'string' || !rule.id) {
        throw new Error('A11yCoreBuilder.withCustomRules(): each custom rule descriptor requires a non-empty string `id`.');
      }
      if (typeof rule.runInPage !== 'function' && (typeof rule.runInPage !== 'string' || !rule.runInPage)) {
        throw new Error(`A11yCoreBuilder.withCustomRules(): custom rule "${rule.id}" requires a \`runInPage\` function or function-source string.`);
      }
      if (rule.applicability !== undefined && typeof rule.applicability !== 'function' && (typeof rule.applicability !== 'string' || !rule.applicability)) {
        throw new Error(`A11yCoreBuilder.withCustomRules(): custom rule "${rule.id}"'s \`applicability\` must be a function or function-source string when provided.`);
      }
    }

    for (const rule of list) {
      const normalized = {
        ...rule,
        runInPage: typeof rule.runInPage === 'function' ? toReconstructableSource(rule.runInPage) : rule.runInPage
      };
      if (typeof rule.applicability === 'function') normalized.applicability = toReconstructableSource(rule.applicability);
      this._customRules.push(normalized);
    }
    return this;
  }

  /**
   * Post-filter `checksResults` down to only the given outcomes (e.g.
   * .reportOnly(['fail', 'cantTell']) to drop pass/notApplicable noise).
   * Binding-layer only -- a11y-core itself always computes every rule's
   * outcome; this just trims what analyze() hands back. Applied per-frame
   * when combined with .frames(true).
   */
  reportOnly(outcomes) {
    const list = Array.isArray(outcomes) ? outcomes : [outcomes];
    for (const outcome of list) {
      if (!VALID_OUTCOMES.includes(outcome)) {
        throw new Error(`A11yCoreBuilder.reportOnly(): invalid outcome "${outcome}" -- must be one of ${VALID_OUTCOMES.join(', ')}.`);
      }
    }
    this._reportOutcomes = list;
    return this;
  }

  /**
   * Opt in to resolving each fail/cantTell occurrence's `selector` to a live
   * Selenium `WebElement` (attached as `occurrence.elementHandle`), so
   * callers can `.click()`/`.takeScreenshot()` the flagged element directly
   * instead of re-resolving `occurrence.selector` themselves (fragile if the
   * DOM shifted between the scan and when you act on it). Default off --
   * resolving a handle per occurrence costs a real page query, so this stays
   * opt-in. Uses `driver.findElements(By.css(...))` (the plural form, which
   * returns `[]` rather than throwing a NoSuchElementError when a selector
   * matches nothing). Combines with `.frames(true)`: each frame's
   * occurrences are resolved while the driver is switched into that frame,
   * so they resolve against that frame's own document, not the top page's.
   */
  elementRef(enabled = true) {
    this._elementRef = !!enabled;
    return this;
  }

  // Note: not every occurrence resolves to one element -- a page-wide
  // finding (e.g. some manual/cantTell rules) can carry `selector: ""`, in
  // which case `occurrence.elementHandle` is `null` rather than a handle.
  // Selenium's By.css("") throws InvalidSelectorError (verified against a
  // real run, unlike Puppeteer/Playwright's .$("") which resolves to null),
  // so _resolveElement() short-circuits an empty selector to null before it
  // ever reaches findElements().

  /**
   * Opt in to also scanning every sub-frame on the page (including
   * cross-origin iframes -- see this file's own header comment for why
   * that needs no a11y-core engine support). Default off; when off,
   * analyze() returns the same single native result object it always has.
   * When on, analyze() instead returns { topFrame, frames }.
   */
  frames(enabled = true) {
    this._scanFrames = !!enabled;
    return this;
  }

  /**
   * Runs the scan and returns a11y-core's native result object.
   * @returns {Promise<object>} see a11y-core's docs/OUTPUT_SCHEMA.md
   */
  async analyze() {
    const contextSelector = this._includeSelectors.length
      ? (this._includeSelectors.length === 1 ? this._includeSelectors[0] : this._includeSelectors)
      : null;

    const engineOptions = { ...this._engineOptions };
    if (this._customRules.length) {
      // Concatenated with, not replaced by, any customRules already present
      // via a raw .options({ customRules }) call, so the two ways of
      // registering a custom rule compose rather than one silently
      // clobbering the other.
      const existing = Array.isArray(this._engineOptions.customRules) ? this._engineOptions.customRules : [];
      engineOptions.customRules = existing.concat(this._customRules);
    }
    if (this._excludeSelectors.length) {
      engineOptions.excludeSelectors = this._excludeSelectors;
    }

    const hasRunOnly = this._includeRuleIds.length || this._excludeRuleIds.length || this._tags.length || this._excludeTags.length;
    const runOnly = hasRunOnly
      ? {
        includeRuleIds: this._includeRuleIds.length ? this._includeRuleIds : undefined,
        excludeRuleIds: this._excludeRuleIds.length ? this._excludeRuleIds : undefined,
        tags: this._tags.length ? this._tags : undefined,
        excludeTags: this._excludeTags.length ? this._excludeTags : undefined
      }
      : null;

    const driver = this._driver;

    // The core injection call. Selenium's driver.executeScript(script,
    // ...args) is variadic and, when handed a function, stringifies it and
    // invokes it as `return (fn).apply(null, arguments)` (confirmed against
    // a real selenium-webdriver 4.x install's lib/webdriver.js) -- so
    // runa11yCoreInPage's own 4 positional args pass straight through with
    // no single-arg wrapper/eval() trick (unlike the Playwright binding).
    // executeScript (the SYNCHRONOUS form) is correct here, NOT
    // executeAsyncScript: runa11yCoreInPage is synchronous and returns its
    // result object directly (it doesn't take an async callback), and
    // executeScript captures a synchronous return value while
    // executeAsyncScript would hang waiting for a callback that never fires.
    // See a11y-core's docs/INTEGRATION.md "Pattern 2" for the mirrored call.
    const runInCurrentFrame = async () => {
      const frameUrl = this._url || (await this._safeCurrentFrameUrl());
      const result = await driver.executeScript(runa11yCoreInPage, frameUrl, contextSelector, engineOptions, runOnly);
      return this._elementRef ? this._attachElementRefs(result) : result;
    };

    if (!this._scanFrames) {
      return this._applyReportOnly(await runInCurrentFrame());
    }

    // Frames mode. Unlike Puppeteer/Playwright's page.frames() array of
    // independent Frame objects, Selenium reaches a frame only by switching
    // the driver's context into it (a stateful operation). Start from a known
    // context (the top-level document), scan it, then walk the iframe tree.
    await driver.switchTo().defaultContent();

    const frames = [];

    // Recursively enumerate + scan sub-frames from whatever context is
    // current when called. Invariant: this helper assumes the driver is
    // switched into the parent frame on entry and leaves it switched back
    // into that same parent frame on return -- each iteration switches down
    // exactly one level (into a child iframe) and unwinds exactly one level
    // (parentFrame) in a finally, so a scan that throws mid-frame can't leave
    // the context stranded and break every subsequent frame. Recursing while
    // switched into a child collects nested iframes too, giving a flat list
    // of every frame at any depth -- matching what Puppeteer/Playwright's
    // page.frames() returns in one call.
    const scanSubFrames = async () => {
      let iframes;
      try {
        iframes = await driver.findElements(By.css('iframe, frame'));
      } catch (e) {
        // Couldn't even enumerate this document's frames -- nothing to add.
        return;
      }
      for (const iframe of iframes) {
        let switched = false;
        try {
          await driver.switchTo().frame(iframe);
          switched = true;
          frames.push(this._applyReportOnly(await runInCurrentFrame()));
          await scanSubFrames();
        } catch (e) {
          // A frame can detach/navigate away mid-scan, or be a sandboxed
          // frame the browser blocks scripting in -- don't let one bad frame
          // abort the whole multi-frame scan; report it and keep going.
          frames.push({
            url: switched ? (await this._safeCurrentFrameUrl()) : null,
            error: (e && e.message) || String(e)
          });
        } finally {
          if (switched) {
            // Unwind exactly one level back to the parent this iteration
            // started from. If parentFrame() itself fails, hard-reset to the
            // top rather than leaving the context stuck somewhere unknown.
            try {
              await driver.switchTo().parentFrame();
            } catch (_) {
              await driver.switchTo().defaultContent();
            }
          }
        }
      }
    };

    try {
      const topFrame = this._applyReportOnly(await runInCurrentFrame());
      await scanSubFrames();
      return { topFrame, frames };
    } finally {
      // Always leave the driver back at the top-level document, even if a
      // scan threw partway through, so the caller isn't handed a driver
      // stranded inside some sub-frame.
      try {
        await driver.switchTo().defaultContent();
      } catch (_) {
        // Best-effort -- nothing more we can do to recover the context here.
      }
    }
  }

  /**
   * Reads the current frame/document's own URL via executeScript, for
   * error-reporting and the engine's pageUrl argument. Selenium has no
   * per-frame `.url()` accessor (driver.getCurrentUrl() always returns the
   * top-level URL regardless of switched context), so the current frame's
   * own URL has to come from inside the page. Best-effort -- returns null if
   * the frame can't be scripted (e.g. mid-detach).
   */
  async _safeCurrentFrameUrl() {
    try {
      return await this._driver.executeScript('return window.location.href;');
    } catch (_) {
      return null;
    }
  }

  /** Filters a single native result object's checksResults per .reportOnly(), if set. */
  _applyReportOnly(result) {
    if (!this._reportOutcomes || !Array.isArray(result.checksResults)) return result;
    return {
      ...result,
      checksResults: result.checksResults.filter((r) => this._reportOutcomes.includes(r.outcome))
    };
  }

  /**
   * Resolves occurrence.selector to a live WebElement for every fail/cantTell
   * occurrence, scoped to whatever frame the driver is currently switched
   * into (so it composes with .frames(true) automatically -- a sub-frame's
   * occurrences resolve against that sub-frame's own document, since this
   * runs while the driver is still switched into that frame). Mutates and
   * returns the same result object -- it's a fresh object from this scan, not
   * shared external state.
   */
  async _attachElementRefs(result) {
    if (!Array.isArray(result.checksResults)) return result;
    for (const check of result.checksResults) {
      if (!Array.isArray(check.occurrences) || !check.occurrences.length) continue;
      for (const occurrence of check.occurrences) {
        occurrence.elementHandle = await this._resolveElement(occurrence.selector);
      }
    }
    return result;
  }

  /**
   * Resolves one selector to a live WebElement (or null). Most occurrences
   * carry a concrete element selector, but a page-wide finding with no single
   * target element (e.g. some manual/cantTell rules) can carry "" -- Selenium's
   * By.css("") throws InvalidSelectorError (verified with a real run), so
   * short-circuit an empty selector to null. Uses findElements (plural),
   * which returns [] rather than throwing NoSuchElementError when a
   * valid-but-absent selector matches nothing, and wrap it in try/catch so an
   * adversarial/invalid selector string resolves to null instead of aborting
   * the whole scan.
   */
  async _resolveElement(selector) {
    if (!selector) return null;
    try {
      const found = await this._driver.findElements(By.css(selector));
      return found.length ? found[0] : null;
    } catch (_) {
      return null;
    }
  }
}

module.exports = { A11yCoreBuilder };
