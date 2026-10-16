import type { WebDriver, WebElement } from 'selenium-webdriver';
import type { PackLike, WcagLevelInput, WcagVersion, ScanGap, ScanNote, PlannedCheck, PlannedCriterion } from '@surea11y/binding-base';
import type {
  CheckResult as CoreCheckResult,
  CompositeResult,
  Confidence,
  LocaleResolution,
  Occurrence as CoreOccurrence,
  Outcome,
  RuleMeta,
  ScanResult,
  Severity
} from '@surea11y/core';

// The result shapes are @surea11y/core's own types (shipped since 1.9.0,
// see its docs/OUTPUT_SCHEMA.md), so they follow the engine release this
// package depends on. The one addition is the elementHandle field this
// binding puts on each occurrence when .elementRef(true) is used.

export type {
  CompositeResult,
  Confidence,
  ContextMatch,
  EngineInfo,
  LocaleResolution,
  Margin,
  NormativeMapping,
  Outcome,
  OutcomeNormalized,
  RenderingEnvironment,
  RuleType,
  Severity,
  VisibilityFilter
} from '@surea11y/core';

// Names earlier releases of this package declared themselves, kept as
// aliases of core's types.
export type LocaleResolutionReason = LocaleResolution['reason'];
export type Category = RuleMeta['category'];
export type CheckResultMeta = RuleMeta;
export type CompositeResultDetails = CompositeResult['data']['details'];

export interface Occurrence extends CoreOccurrence {
  /**
   * Only present when `.elementRef(true)` was used. `null` when this
   * occurrence has no single resolvable target element (e.g. `selector` was
   * `""`, or a shadow host on the way is gone) -- see
   * A11yCoreBuilder#elementRef. A Selenium `WebElement`, whose per-element
   * screenshot is `.takeScreenshot()` (returns a base64 PNG string), not
   * `.screenshot({ path })`.
   */
  elementHandle?: WebElement | null;
}

export interface CheckResult extends Omit<CoreCheckResult, 'occurrences'> {
  occurrences: Occurrence[];
}

/** surea11y's native top-level result shape -- see docs/OUTPUT_SCHEMA.md. */
export interface A11yCoreResult extends Omit<ScanResult, 'checksResults'> {
  checksResults: CheckResult[];
}

/** A sub-frame that couldn't be scanned (detached, navigated away, or sandboxed). */
export interface A11yCoreFrameError {
  url: string | null;
  error: string;
}

/** Returned by analyze() when .frames(true) is enabled, instead of a single A11yCoreResult. */
export interface A11yCoreMultiFrameResult {
  topFrame: A11yCoreResult;
  frames: Array<A11yCoreResult | A11yCoreFrameError>;
}

/**
 * A runtime-registered rule descriptor for `.withCustomRules()` -- the same
 * shape as an internal surea11y rule module's own export (see surea11y's
 * docs/ENGINE_OPTIONS.md). `runInPage`/`applicability` may be passed as
 * either a real function or a function-source string -- `.withCustomRules()`
 * converts a live function to its source string for you, since it must
 * cross an executeScript() serialization boundary that cannot carry a live
 * Function reference.
 */
export interface CustomRuleDescriptor {
  id: string;
  meta?: {
    title?: string;
    description?: string;
    tags?: string[];
    defaultSeverity?: Severity;
    defaultConfidence?: Confidence;
    [key: string]: unknown;
  };
  runInPage: ((ctx: unknown) => unknown) | string;
  applicability?: ((ctx: unknown) => boolean) | string;
  data?: Record<string, unknown>;
}

export class A11yCoreBuilder {
  /**
   * @param opts.driver A Selenium WebDriver, already navigated to and settled
   *   at the URL to scan -- this class does not navigate for you.
   */
  constructor(opts: { driver: WebDriver; url?: string });

  /**
   * Installs @surea11y/core's opt-in internals hook, so a scan can read
   * names, states and roles web components set through a private
   * ElementInternals. Call it before driver.get(). Uses WebDriver BiDi when
   * the session has it, else the DevTools protocol on Chrome and Edge, else
   * rejects. Resolves to the way it was installed.
   */
  static installInternalsHook(driver: WebDriver): Promise<'bidi' | 'cdp'>;

  /**
   * Scope the scan to one region. Call multiple times for a multi-region
   * union. A selector that matches nothing scans nothing (see the result's
   * `contextMatch`); one the browser can't parse makes analyze() reject with
   * an EngineError, code `INVALID_CONTEXT_SELECTOR`. With `.frames(true)`,
   * it scopes the top frame only.
   */
  include(selector: string): this;
  /**
   * Skip elements matching this selector anywhere in the scanned scope.
   * With `opts.rules`, scopes the exclusion to just the named rule ID(s)
   * instead of globally -- on top of, not instead of, any global exclusions
   * from other `.exclude(selector)` calls.
   */
  exclude(selector: string, opts?: { rules?: string | string[] }): this;
  /** Only run rules carrying at least one of these tags. */
  withTags(tags: string | string[]): this;
  /** Never run rules carrying any of these tags (applied after withTags). */
  disableTags(tags: string | string[]): this;
  /** Only run these specific rule IDs (accepts with or without the `a11ycore-` prefix). */
  withRules(ruleIds: string | string[]): this;
  /** Never run these specific rule IDs (applied after withRules). */
  disableRules(ruleIds: string | string[]): this;
  /**
   * Run the rules for a WCAG conformance target: `withWcag('2.2', 'AA')`
   * runs those of WCAG 2.2's A and AA criteria. withTags()/withRules() add
   * to them. A later call replaces the target.
   */
  withWcag(version: WcagVersion | 2.0 | 2.1 | 2.2, level?: WcagLevelInput): this;
  /** Also run the best-practice rules, those that name no WCAG criterion. */
  withBestPractices(enabled?: boolean): this;
  /**
   * How withRules() and withTags() combine when both are given: 'and' (the
   * default) runs the rules matching both, 'or' those matching either. A
   * later call replaces the mode.
   */
  includeMode(mode: 'and' | 'or'): this;
  /**
   * The WCAG level of the criteria the scan reports, without changing which
   * rules run: `.withRules('contrast-computable').wcagLevel('AA')` reports
   * 1.4.3 and not 1.4.6. Any case; null clears it. A later call replaces it.
   */
  wcagLevel(level: WcagLevelInput | null): this;
  /**
   * Where analyze() sends each scan gap instead of console.warn: called once
   * per gap, with the result of the frame it came from, and once per scan
   * for the internals-hook note (tell them apart by `kind`). `() => {}`
   * silences them, `null` goes back to console.warn. A later call replaces it.
   */
  logger(fn: ((entry: ScanGap | ScanNote, result: A11yCoreResult) => void) | null): this;
  /** Merge arbitrary engineOptions (locale, contrast.mode, policyContract, ...). */
  options(partialEngineOptions: Record<string, unknown>): this;
  /** Register one or more custom rules for just this scan. Call multiple times to accumulate. */
  withCustomRules(rules: CustomRuleDescriptor | CustomRuleDescriptor[]): this;
  /**
   * Packs from `@surea11y/core/pack` (core 1.11 or later): registered in each
   * frame before the scan, and named in `engineOptions.packs`.
   */
  withPacks(packs: PackLike | PackLike[]): this;
  /** Post-filter checksResults down to only the given outcomes. */
  reportOnly(outcomes: Outcome | Outcome[]): this;
  /** Opt in to also scanning every sub-frame on the page (including cross-origin iframes). */
  frames(enabled?: boolean): this;
  /** Opt in to resolving each fail/cantTell occurrence's selector to a live WebElement. */
  elementRef(enabled?: boolean): this;
  /** The rules this scan will run, worked out in Node with no page (@surea11y/core 1.12.0 and later). */
  plannedChecks(): PlannedCheck[];
  /** The criteria this scan will report in rulesResults, worked out in Node with no page. */
  plannedCriteria(): PlannedCriterion[];

  /**
   * Runs the scan. Returns { topFrame, frames } instead of a single result
   * when .frames(true) was used. Rejects with an EngineError (with `code`)
   * when the engine refuses its input: `INVALID_RUN_ONLY` (a rule/tag
   * selection naming nothing it knows), `INVALID_CONTEXT_SELECTOR` (an
   * include() selector the browser can't parse), `INVALID_ENGINE_OPTIONS`
   * (an option `strictOptions: true` rejects) or `PAGE_BUILTINS_BROKEN` (the
   * page's scripts broke a JavaScript built-in the engine relies on).
   */
  analyze(): Promise<A11yCoreResult | A11yCoreMultiFrameResult>;
}
