'use strict';

const { By } = require('selenium-webdriver');
const { runa11yCoreInPage, internalsHookScript, listenerHookScript } = require('@surea11y/core');
const {
  A11yCoreBuilderBase,
  createInPageScan,
  rethrowEngineError,
  queryOccurrenceElement,
  cropViewportScreenshot,
  planScreenshots
} = require('@surea11y/binding-base');

// core's runa11yCoreInPage, wrapped so an engine error comes back through
// executeScript() with its `code` (see analyze()). Built once: the wrapper
// is self-contained, so Selenium serializes it as it would the original.
const inPageScan = createInPageScan(runa11yCoreInPage);

// The frame elements the frame traversal walks, and screenshots find again.
const FRAME_SELECTOR = 'iframe, frame';

// Runs `getSource()`'s script in every frame of the driver's pages, before
// their own scripts and after each navigation: through WebDriver BiDi's
// script.addPreloadScript when the session has BiDi (the webSocketUrl
// capability), else the DevTools protocol's
// Page.addScriptToEvaluateOnNewDocument on Chrome and Edge. Any other
// session is rejected, saying how to enable BiDi. `method` names the static
// method in its errors. Resolves to 'bidi' or 'cdp'.
async function installBeforeLoad(driver, method, getSource) {
  if (!driver || typeof driver.getCapabilities !== 'function') {
    throw new TypeError(`A11yCoreBuilder.${method}() requires a Selenium WebDriver.`);
  }
  const source = getSource();
  const capabilities = await driver.getCapabilities();
  const webSocketUrl = capabilities && typeof capabilities.get === 'function' ? capabilities.get('webSocketUrl') : undefined;
  if (typeof webSocketUrl === 'string' && webSocketUrl) {
    // selenium-webdriver's BiDi script module, loaded only on this path.
    const getScriptManager = require('selenium-webdriver/bidi/scriptManager');
    const scripts = await getScriptManager(undefined, driver);
    await scripts.addPreloadScript(`() => {\n${source}\n}`);
    return 'bidi';
  }
  if (typeof driver.sendDevToolsCommand === 'function') {
    await driver.sendDevToolsCommand('Page.addScriptToEvaluateOnNewDocument', { source });
    return 'cdp';
  }
  throw new Error(
    `A11yCoreBuilder.${method}(): this session has no way to run a script before the page loads. ` +
    'Enable WebDriver BiDi when building the driver (options.enableBidi(), the webSocketUrl: true capability), ' +
    'which Chrome, Edge and Firefox support, or use Chrome or Edge, whose DevTools protocol can.'
  );
}

/**
 * Selenium WebDriver binding for surea11y -- scans a real, already-rendered
 * page.
 *
 * const results = await new A11yCoreBuilder({ driver })
 *   .include('#main')
 *   .exclude('.cookie-banner')
 *   .withWcag('2.2', 'AA')
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
 * Or let the scan take a picture of each element it flags, with
 * `.screenshots()` (@surea11y/binding-base's, see its README): each
 * occurrence gets a `screenshot` field, the picture (a Buffer, or a file in
 * `dir`) or why there is none. The element is scrolled into view and marked
 * with a box drawn over the page, and the page is put back afterwards; in
 * every frame with `.frames(true)`, including cross-origin ones:
 *
 * const results = await new A11yCoreBuilder({ driver })
 *   .screenshots({ dir: 'a11y-shots', padding: 16 })
 *   .analyze();
 * // results.checksResults[i].occurrences[j].screenshot
 * //   -> { path: 'a11y-shots/element-3f9a1c07.png', box: { x, y, width, height } }
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
 * withTags()/disableTags()/options()/withCustomRules()/withPacks() all push
 * onto or merge into internal state that persists for the instance's
 * lifetime, so calling one of them again before a second analyze() call
 * accumulates on top of the first scan's scope rather than replacing it
 * (intentional for "call include() several times for one scan" -- see above
 * -- but a footgun if you hold one instance across multiple assertions).
 * reportOnly()/frames()/elementRef()/screenshots()/withWcag()/
 * withBestPractices() are the exception: each call replaces the previous
 * value rather than merging with it.
 */
class A11yCoreBuilder extends A11yCoreBuilderBase {
  /**
   * Installs @surea11y/core's opt-in internals hook, so a scan can read the
   * names, states and roles web components set through a private
   * ElementInternals. Call it before driver.get(). Classic WebDriver can't
   * run a script before a page's own, so it uses:
   *
   * - WebDriver BiDi's script.addPreloadScript, when the session has BiDi
   *   (options.enableBidi(), the `webSocketUrl` capability): Chrome, Edge
   *   and Firefox;
   * - otherwise, on Chrome and Edge, the DevTools protocol's
   *   Page.addScriptToEvaluateOnNewDocument (driver.sendDevToolsCommand()).
   *
   * Both run the script in every frame of the page, before its scripts, and
   * after each navigation. Any other session gets an error saying how to
   * enable BiDi. Resolves to the way it was installed, 'bidi' or 'cdp'.
   * @param {import('selenium-webdriver').WebDriver} driver
   * @returns {Promise<'bidi' | 'cdp'>}
   */
  static async installInternalsHook(driver) {
    return installBeforeLoad(driver, 'installInternalsHook', () => internalsHookScript());
  }

  /**
   * Installs @surea11y/core's opt-in listener hook (core 1.14.0 and later),
   * so the keyboard rules see the click, key, focus and mouse listeners a
   * page adds from script (addEventListener, or an onclick-style property),
   * not only inline handler attributes. Call it before driver.get(). It is
   * installed as installInternalsHook() is: through WebDriver BiDi when the
   * session has it, else the DevTools protocol on Chrome and Edge, else it
   * rejects saying how to enable BiDi. Resolves to the way it was installed,
   * 'bidi' or 'cdp'.
   * @param {import('selenium-webdriver').WebDriver} driver
   * @returns {Promise<'bidi' | 'cdp'>}
   */
  static async installListenerHook(driver) {
    return installBeforeLoad(driver, 'installListenerHook', () => {
      if (typeof listenerHookScript !== 'function') {
        throw new TypeError('A11yCoreBuilder.installListenerHook() needs @surea11y/core 1.14.0 or later, which has listenerHookScript().');
      }
      return listenerHookScript();
    });
  }

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
    // The script that registers withPacks()'s packs in a frame, which the
    // scan names in engineOptions.packs; null without packs. executeScript()
    // runs a string as a function body, so the script runs as written.
    const packScript = this._packScript();

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
    // `path` is where the frame is, the indices of the <iframe>s leading to
    // it from the top-level document ([] for that document), or null for
    // whatever frame the driver is in when analyze() is called without
    // frames(true): what screenshots need to reach it again.
    const runInCurrentFrame = async (scanContext, path) => {
      const frameUrl = this._url || (await this._safeCurrentFrameUrl());
      if (packScript) await driver.executeScript(packScript);
      // The text of the style sheets the frame can't read, fetched from Node
      // (binding-base 1.6.0 and core 1.14.0; nothing with older ones), in the frame
      // the driver is in.
      const frameEngineOptions =
        typeof this._styleSheetEngineOptions === 'function'
          ? await this._styleSheetEngineOptions(null, engineOptions)
          : engineOptions;
      const result = rethrowEngineError(
        await driver.executeScript(inPageScan, frameUrl, scanContext, frameEngineOptions, runOnly)
      );
      this._warnScanGaps(result, '@surea11y/selenium');
      // Right after the frame's scan, before reportOnly(): nothing unless
      // .screenshots() was called.
      if (this._screenshots) await this._screenshotFrame(result, path);
      return this._elementRef ? this._attachElementRefs(result) : result;
    };

    if (!this._scanFrames) {
      return this._applyReportOnly(await runInCurrentFrame(contextSelector, null));
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
    const scanSubFrames = async (path) => {
      let iframes;
      try {
        iframes = await driver.findElements(By.css(FRAME_SELECTOR));
      } catch (e) {
        // Couldn't even enumerate this document's frames -- nothing to add.
        return;
      }
      for (let i = 0; i < iframes.length; i++) {
        const iframe = iframes[i];
        let switched = false;
        try {
          await driver.switchTo().frame(iframe);
          switched = true;
          frames.push(this._applyReportOnly(await runInCurrentFrame(null, path.concat(i))));
          await scanSubFrames(path.concat(i));
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
      const topFrame = this._applyReportOnly(await runInCurrentFrame(contextSelector, []));
      await scanSubFrames([]);
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
   * binding-base's screenshots step for the frame just scanned, at `path`
   * (see analyze()). The step switches the driver from frame to frame to
   * place the element on the top-level page, so the driver is switched back
   * into the scanned frame afterwards: the frame traversal and
   * elementRef() go on from there.
   *
   * Without frames(true), the scan runs in whatever frame the driver is in.
   * From the top-level document, that is the page; from a frame the caller
   * switched into, there is no way to tell which <iframe> leads to it, so
   * its occurrences get `capture-failed`, saying so, rather than pictures
   * of the wrong place.
   */
  async _screenshotFrame(result, path) {
    if (path === null) {
      let top = true;
      try {
        top = await this._driver.executeScript('return window === window.top;');
      } catch (_) {
        // A frame that can't be asked can't be pictured either; the step
        // says so for each element.
      }
      if (!top) {
        const error = 'the scan ran in a frame the driver was switched into; screenshots need it to start from the top-level document (use frames(true) to scan frames)';
        const { elements, unlocated } = planScreenshots(result, { outcomes: this._screenshots.outcomes });
        for (const occurrence of unlocated) occurrence.screenshot = { skipped: 'no-element' };
        for (const element of elements) {
          const screenshot = { skipped: 'capture-failed', error };
          for (const occurrence of element.occurrences) occurrence.screenshot = screenshot;
        }
        return;
      }
      await this._captureScreenshots(result, null, []);
      return;
    }
    const framePath = path.map((index, i) => ({ frame: path.slice(0, i), iframe: { index, selector: FRAME_SELECTOR } }));
    try {
      await this._captureScreenshots(result, path, framePath);
    } finally {
      await this._switchToPath(path).catch(() => {});
    }
  }

  /**
   * For binding-base's screenshots step: runs `fn(...args)` in the frame at
   * `path` (null: the frame the driver is in). executeScript() waits for the
   * Promise the step returns, as W3C WebDriver's Execute Script does.
   */
  async _evaluateInFrame(path, fn, args) {
    if (path !== null) await this._switchToPath(path);
    return this._driver.executeScript(fn, ...args);
  }

  /**
   * For binding-base's screenshots step: a PNG of `box`, CSS pixels in the
   * top-level viewport. Selenium takes the whole viewport, whichever frame
   * the driver is in; binding-base cuts the box out of it.
   */
  async _captureBox(box, view) {
    return cropViewportScreenshot(await this._driver.takeScreenshot(), box, view);
  }

  /**
   * Switches the driver into the frame at `path`, from the top-level
   * document down, finding the <iframe>s again at each level, as the frame
   * traversal finds them.
   */
  async _switchToPath(path) {
    await this._driver.switchTo().defaultContent();
    for (const index of path) {
      const iframes = await this._driver.findElements(By.css(FRAME_SELECTOR));
      if (!iframes[index]) throw new Error(`no <iframe> ${index} where the frame was`);
      await this._driver.switchTo().frame(iframes[index]);
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
