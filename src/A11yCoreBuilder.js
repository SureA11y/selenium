'use strict';

const { By } = require('selenium-webdriver');
const { runa11yCoreInPage } = require('@surea11y/core');
const {
  A11yCoreBuilderBase,
  createInPageScan,
  rethrowEngineError,
  queryOccurrenceElement,
  getScanGaps
} = require('@surea11y/binding-base');

// core's runa11yCoreInPage, wrapped so an engine error comes back through
// executeScript() with its `code` (see analyze()). Built once: the wrapper
// is self-contained, so Selenium serializes it as it would the original.
const inPageScan = createInPageScan(runa11yCoreInPage);

/**
 * Selenium WebDriver binding for surea11y -- scans a real, already-rendered
 * page.
 *
 * const results = await new A11yCoreBuilder({ driver })
 *   .include('#main')
 *   .exclude('.cookie-banner')
 *   .withTags(['wcag2a', 'wcag2aa'])
 *   .disableRules(['meta-refresh-no-exceptions'])
 *   .options({ contrast: { mode: 'auditorAssist' } })
 *   .analyze();
 *
 * `results` is @surea11y/core's own native result shape (checksResults /
 * rulesResults -- see ../core/docs/OUTPUT_SCHEMA.md), not the
 * violations/passes/incomplete/inapplicable shape used by other tools in
 * this space. Method names are modeled on common conventions in this space
 * for migration ease, but the richer native schema (severity, confidence,
 * occurrences, policy contract, WCAG SC mappings) is kept as-is rather than
 * reshaped to match.
 *
 * Extends `A11yCoreBuilderBase` (from `@surea11y/binding-base`), which owns
 * every method with no driver-specific work at all -- `include()`/
 * `exclude()`/`withTags()`/`disableTags()`/`withRules()`/`disableRules()`/
 * `options()`/`reportOnly()`/`elementRef()`/`frames()`/`withCustomRules()`'s
 * validation (including the default customRules stringification, correct
 * here since Selenium's `executeScript()` crosses a real serialization
 * boundary), and `_buildEngineArgs()`. This class adds exactly the parts
 * that are genuinely Selenium-specific: `analyze()`'s injection mechanics,
 * the stateful frame-traversal model below, and `_attachElementRefs()`. See
 * `../binding-base/README.md` for what's shared and why.
 *
 * `driver` is the object returned by `selenium-webdriver`'s `Builder`
 * pattern -- it must already be navigated to and settled at the URL to
 * scan; this class does not navigate for you.
 *
 * Opt in to scanning every frame on the page (including cross-origin
 * iframes) via .frames(true):
 *
 * const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();
 * // results.topFrame        -- same shape as the single-frame case above
 * // results.frames          -- array of the same native result shape, one per sub-frame
 *
 * include() scopes the top frame only; each sub-frame is scanned whole.
 *
 * Unlike script-injection-based accessibility engines (which need a
 * postMessage-based protocol, runPartial/finishRun, to reach cross-origin
 * iframes, since they're injected as a plain <script> and are fully subject
 * to the browser's same-origin policy), this doesn't need any @surea11y/core
 * engine support: Selenium switches WebDriver
 * context into every frame at the automation-protocol level, not as in-page
 * script, so a cross-origin frame's executeScript() already just works --
 * verified empirically against a real cross-origin iframe (https://example.org/),
 * see tests/builder.test.js.
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
 * next). Default off, so plain
 * .analyze() keeps returning the single native result object it always has.
 *
 * By default `analyze()` returns every rule's outcome, including
 * `pass`/`notApplicable` -- @surea11y/core's own deliberate "not a
 * violations-only list" design (see ../core/docs/OUTPUT_SCHEMA.md).
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
 * way Puppeteer/Playwright's `elementHandle.screenshot({ path })` does.)
 *
 * Register your own rule(s) for just this scan with
 * `.withCustomRules([...])` (@surea11y/core's `engineOptions.customRules`
 * escape hatch -- see ../core/docs/ENGINE_OPTIONS.md). Pass a real,
 * live `runInPage`/
 * `applicability` function -- unlike the raw `.options({ customRules })`
 * passthrough, this method converts them to the function-source string
 * @surea11y/core needs on this side of the executeScript() serialization
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
class A11yCoreBuilder extends A11yCoreBuilderBase {
  /**
   * @param {{ driver: import('selenium-webdriver').WebDriver, url?: string }} opts
   *   `driver` must already be navigated to and settled at the URL to scan --
   *   this class does not navigate for you.
   */
  constructor({ driver, url } = {}) {
    super({ url });
    if (!driver || typeof driver.executeScript !== 'function') {
      throw new Error('A11yCoreBuilder requires { driver } (a Selenium WebDriver, with an .executeScript() method).');
    }
    this._driver = driver;
  }

  /**
   * Runs the scan and returns @surea11y/core's native result object.
   * @returns {Promise<object>} see ../core/docs/OUTPUT_SCHEMA.md
   */
  async analyze() {
    const { contextSelector, engineOptions, runOnly } = this._buildEngineArgs();
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
    // See ../core/docs/INTEGRATION.md "Pattern 2" for the mirrored call.
    //
    // It runs through inPageScan, not runa11yCoreInPage itself: a
    // JavascriptError from executeScript() keeps an error's message but not
    // its `code`, which is what tells INVALID_RUN_ONLY (a typo in
    // withRules()/withTags()) or INVALID_CONTEXT_SELECTOR (include() given
    // a selector the browser can't parse) from a broken page.
    // rethrowEngineError() throws those again here as an EngineError with
    // `code` (and `selector`).
    //
    // `scanContext` is the contextSelector for this frame: include()'s
    // selectors in the top frame, null in a sub-frame (see scanSubFrames).
    const runInCurrentFrame = async (scanContext) => {
      const frameUrl = this._url || (await this._safeCurrentFrameUrl());
      const result = rethrowEngineError(
        await driver.executeScript(inPageScan, frameUrl, scanContext, engineOptions, runOnly)
      );
      this._warnScanGaps(result);
      return this._elementRef ? this._attachElementRefs(result) : result;
    };

    if (!this._scanFrames) {
      return this._applyReportOnly(await runInCurrentFrame(contextSelector));
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
    //
    // A sub-frame is scanned whole (contextSelector null), as core's own
    // runa11yCoreAcrossFrames does: include()'s selectors name elements of
    // the top-level page. Since @surea11y/core 1.10.0 a selector that
    // matches nothing scans nothing, so passing them on would leave every
    // frame without that element unscanned; before, it fell back to the
    // whole frame. exclude() still applies in every frame.
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
          frames.push(this._applyReportOnly(await runInCurrentFrame(null)));
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
      const topFrame = this._applyReportOnly(await runInCurrentFrame(contextSelector));
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

  /**
   * Prints what the scan left out (getScanGaps(): an include() scope that
   * matched nothing, a custom rule that did not run) with console.warn, once
   * per scanned frame. @surea11y/core warns about these too, but in the
   * browser's console, which a Selenium run does not show; a result whose
   * checksResults alone look clean would otherwise pass without a word.
   */
  _warnScanGaps(result) {
    let gaps;
    try {
      gaps = getScanGaps(result);
    } catch (e) {
      return; // not a scan result; the caller sees it as it is
    }
    const where = result.url ? ` (${result.url})` : '';
    for (const gap of gaps) {
      console.warn(`@surea11y/selenium${where}: ${gap.message}`);
    }
  }

  /**
   * Resolves each occurrence to a live WebElement, scoped to whatever frame
   * the driver is currently switched into (so it composes with
   * .frames(true) automatically -- a sub-frame's occurrences resolve
   * against that sub-frame's own document, since this runs while the driver
   * is still switched into that frame). Mutates and returns the same result
   * object -- it's a fresh object from this scan, not shared external
   * state.
   */
  async _attachElementRefs(result) {
    if (!Array.isArray(result.checksResults)) return result;
    for (const check of result.checksResults) {
      if (!Array.isArray(check.occurrences) || !check.occurrences.length) continue;
      for (const occurrence of check.occurrences) {
        occurrence.elementHandle = await this._resolveElement(occurrence);
      }
    }
    return result;
  }

  /**
   * Resolves one occurrence to a live WebElement (or null). Since
   * @surea11y/core 1.10.0 an element inside a shadow tree carries
   * `shadowHostSelectors`, and its `selector` holds only inside the last
   * host's shadow root: looked up in the document (as By.css() does), it
   * finds another element or none. binding-base's queryOccurrenceElement()
   * walks the hosts in the page instead; executeScript() hands its element
   * back as a WebElement, and null when anything on the way is missing or a
   * selector doesn't parse.
   *
   * A page-wide finding with no single target element (e.g. some
   * manual/cantTell rules) carries selector "" -- short-circuited to null
   * without a round trip. An error from executeScript() itself also gives
   * null rather than aborting the whole scan.
   */
  async _resolveElement(occurrence) {
    if (!occurrence || !occurrence.selector) return null;
    try {
      const element = await this._driver.executeScript(
        queryOccurrenceElement,
        occurrence.selector,
        occurrence.shadowHostSelectors || null
      );
      return element || null;
    } catch (_) {
      return null;
    }
  }
}

module.exports = { A11yCoreBuilder };
