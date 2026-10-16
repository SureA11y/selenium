// Compiled, not run, by tests/types.test.js: what a TypeScript user of this
// package writes, checked against @surea11y/core's types.
import type { WebDriver, WebElement } from 'selenium-webdriver';
import type { ScanResult } from '@surea11y/core';
import { definePack } from '@surea11y/core/pack';
import {
  A11yCoreBuilder,
  EngineError,
  formatFailures,
  formatOccurrenceLocation,
  getScanGaps,
  getScanNotes
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
    const how: 'bidi' | 'cdp' = await A11yCoreBuilder.installInternalsHook(driver);
    out.push(how);
    const planned = new A11yCoreBuilder({ driver }).withWcag('2.2', 'aa').wcagLevel('aa');
    out.push(...planned.plannedChecks().map((c) => c.ruleId), ...planned.plannedCriteria().map((r) => r.id));

    const results = await new A11yCoreBuilder({ driver })
      .include('#main')
      .exclude('.ad', { rules: ['region'] })
      .withWcag('2.2', 'AA')
      .withBestPractices()
      .includeMode('or')
      .wcagLevel('AA')
      .logger((entry, frame) => { void `${frame.url}: ${entry.kind} ${entry.message}`; })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules('region')
      .options({ locale: 'fr' })
      .withCustomRules({ id: 'my-rule', runInPage: () => ({ outcome: 'pass', occurrences: [] }) })
      .withPacks(definePack({ name: '@acme/a11y-rules', version: '1.0.0', namespace: 'acme', core: '^1.11.1' }))
      .reportOnly(['fail', 'cantTell'])
      .elementRef(true)
      .screenshots({ dir: 'a11y-shots', outcomes: ['fail', 'cantTell'], padding: 8, highlight: true, max: 20 })
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

    for (const note of getScanNotes(result)) {
      if (note.kind === 'internals-hook') out.push(String(note.elementCount));
      else out.push(note.message);
    }

    for (const gap of getScanGaps(result)) {
      if (gap.kind === 'custom-rule-skipped') out.push(gap.rule.reason);
      else if (gap.kind === 'pack-skipped') out.push(String(gap.pack.name));
      else out.push(gap.selectors.join(', '));
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
    const shot = occurrence.screenshot;
    if (shot && 'path' in shot) out.push(shot.path, String(shot.box.width));
    else if (shot && 'buffer' in shot) out.push(shot.buffer.toString('base64'));
    else if (shot) out.push(shot.skipped, shot.error ?? '');
    out.push(formatOccurrenceLocation(occurrence), String(hosts), String(path));
    out.push(formatFailures(result), formatFailures(result.checksResults));
  } catch (e) {
    if (e instanceof EngineError && e.code === 'INVALID_CONTEXT_SELECTOR') out.push(String(e.selector));
    if (e instanceof EngineError && e.code === 'INVALID_ENGINE_OPTIONS') out.push(e.message);
  }
  return out;
}

export { scan };
