// Compiled, not run, by tests/types.test.js: what a TypeScript user of this
// package writes, checked against @surea11y/core's types.
import type { WebDriver, WebElement } from 'selenium-webdriver';
import type { ScanResult } from '@surea11y/core';
import {
  A11yCoreBuilder,
  EngineError,
  formatFailures,
  formatOccurrenceLocation,
  getScanGaps
} from '../../src/index';
import type {
  A11yCoreFrameError,
  A11yCoreMultiFrameResult,
  A11yCoreResult,
  CheckResult,
  CheckResultMeta,
  Occurrence,
  Severity
} from '../../src/index';

declare const driver: WebDriver;

async function scan(): Promise<string[]> {
  const out: string[] = [];
  try {
    const results = await new A11yCoreBuilder({ driver })
      .include('#main')
      .exclude('.ad', { rules: ['region'] })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules('region')
      .options({ locale: 'fr' })
      .withCustomRules({ id: 'my-rule', runInPage: () => ({ outcome: 'pass', occurrences: [] }) })
      .reportOnly(['fail', 'cantTell'])
      .elementRef(true)
      .analyze();

    if ('topFrame' in results) {
      const tree: A11yCoreMultiFrameResult = results;
      out.push(formatFailures(tree.topFrame));
      for (const frame of tree.frames) {
        if ('error' in frame) {
          const failed: A11yCoreFrameError = frame;
          out.push(failed.error);
        } else {
          out.push(formatFailures(frame, { outcomes: ['fail'] }));
        }
      }
      return out;
    }

    const result: A11yCoreResult = results;
    // A result of this binding is one of core's.
    const core: ScanResult = result;
    const version: string = core.engine.version;
    const layout: boolean = result.engine.environment.layout;
    const scope: number | undefined = result.contextMatch?.elementCount;
    const skipped: Array<string | null> = result.skippedCustomRules.map((r) => r.id);
    out.push(version, String(layout), String(scope), ...skipped.map(String));

    for (const gap of getScanGaps(result)) {
      out.push(gap.kind === 'custom-rule-skipped' ? gap.rule.reason : gap.selectors.join(', '));
    }

    const check: CheckResult = result.checksResults[0];
    const severity: Severity = check.severity;
    const meta: CheckResultMeta = check.meta;
    const headroom: number | undefined = check.margin?.headroom;
    out.push(severity, meta.ruleId, String(headroom));

    const occurrence: Occurrence = check.occurrences[0];
    const hosts: string[] | undefined = occurrence.shadowHostSelectors;
    const path: number[] | null = occurrence.structuralPath;
    const handle: WebElement | null | undefined = occurrence.elementHandle;
    if (handle) out.push(await handle.takeScreenshot());
    out.push(formatOccurrenceLocation(occurrence), String(hosts), String(path));
    out.push(formatFailures(result), formatFailures(result.checksResults));
  } catch (e) {
    if (e instanceof EngineError && e.code === 'INVALID_CONTEXT_SELECTOR') out.push(String(e.selector));
  }
  return out;
}

export { scan };
