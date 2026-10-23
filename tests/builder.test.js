'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { By } = require('selenium-webdriver');
const { A11yCoreBuilder, EngineError, getScanGaps } = require('../src/index.js');
const { buildDriver, readProp, settle } = require('./driver.js');

// Shared across the customRules tests below -- reported outcome depends on
// whether ctx.document has a .my-widget element. runInPage must be a
// function-source STRING, not a live function -- engineOptions crosses an
// executeScript() serialization boundary that can't carry a live Function
// reference.
const MY_ORG_CUSTOM_RULE = {
  id: 'my-org-custom-rule',
  meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
  runInPage: (function (ctx) {
    const el = ctx.document.querySelector('.my-widget');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }).toString()
};

// Same rule, but as a real, LIVE function -- used to prove
// .withCustomRules() converts it to a source string itself, unlike the raw
// .options({ customRules }) passthrough above, which requires the caller to
// call .toString() themselves.
const MY_ORG_CUSTOM_RULE_LIVE = {
  id: 'my-org-custom-rule',
  meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
  runInPage(ctx) {
    const el = ctx.document.querySelector('.my-widget');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }
};

// A second, distinct rule ID -- used to prove withCustomRules() can register
// more than one rule at once (array form) and accumulates across calls.
const SECOND_CUSTOM_RULE = {
  id: 'my-org-second-custom-rule',
  meta: { title: 'My second custom rule', tags: ['custom'] },
  runInPage(ctx) {
    const el = ctx.document.querySelector('.my-other-widget');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }
};

// Exercises the optional `applicability` field -- also accepted as a live
// function and converted the same way as runInPage. When applicability
// returns false, surea11y reports 'notApplicable' WITHOUT ever invoking
// runInPage; runInPage here always reports 'pass' so the two outcomes are
// unambiguous proof of which path ran.
const CUSTOM_RULE_WITH_APPLICABILITY = {
  id: 'my-org-conditional-custom-rule',
  meta: { title: 'Conditional custom rule', tags: ['custom'] },
  applicability(ctx) {
    return !!ctx.document.querySelector('.applicability-gate');
  },
  runInPage() {
    return { outcome: 'pass', occurrences: [] };
  }
};

test('A11yCoreBuilder.analyze() scans a real page and returns surea11y\'s native result shape', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><img src="x.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver }).analyze();

    assert.ok(Array.isArray(results.checksResults));
    const fails = results.checksResults.filter((r) => r.outcome === 'fail');
    assert.ok(fails.some((r) => r.ruleId === 'button-name-present'));
    assert.ok(fails.some((r) => r.ruleId === 'img-alt-present'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: include() scopes the scan to one region', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<section id="a"><img src="x.png"></section>' +
      '<section id="b"><img src="y.png" alt=""></section>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ driver }).include('#b').analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'pass');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: include() called twice scans the union of both regions', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<section id="a"><img src="x.png"></section>' +
      '<section id="b"><img src="y.png"></section>' +
      '<section id="c"><img src="z.png" alt="decorative"></section>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ driver }).include('#a').include('#b').analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    assert.strictEqual(rule.occurrences.length, 2); // #a and #b's images, not #c's
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: scoping methods (include/exclude/withRules/etc.) accumulate across analyze() calls on the same instance -- create one builder per scan', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<section id="a"><img src="x.png"></section>' +
      '<section id="b"><img src="y.png"></section>' +
      '</body></html>'
    );

    // The builder is a mutable object with no reset between analyze() calls
    // -- include()/exclude()/withRules()/disableRules()/withTags()/
    // disableTags()/options() all push onto or merge into internal arrays/
    // objects that persist for the instance's lifetime. This is intentional
    // for "call include() multiple times within ONE scan" (see the test
    // above), but the same accumulation applies across separate analyze()
    // calls if you reuse an instance -- documented here so it's a known,
    // tested behavior rather than a silent surprise for anyone holding a
    // builder across multiple assertions. See README.md's own note.
    const builder = new A11yCoreBuilder({ driver });
    const first = await builder.include('#a').analyze();
    const second = await builder.include('#b').analyze(); // scope is now #a AND #b, not just #b

    const firstRule = first.checksResults.find((r) => r.ruleId === 'img-alt-present');
    const secondRule = second.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.deepStrictEqual(firstRule.occurrences.map((o) => o.selector), ['#a > img']);
    assert.deepStrictEqual(secondRule.occurrences.map((o) => o.selector), ['#a > img', '#b > img']);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: reportOnly()/frames()/elementRef() overwrite on repeated calls, unlike the accumulating scoping methods above', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><button></button></body></html>');

    const builder = new A11yCoreBuilder({ driver }).reportOnly(['fail']);
    await builder.analyze();
    // Calling reportOnly() again REPLACES the previous outcomes list rather
    // than merging with it -- unlike include()/withRules()/etc. above.
    const results = await builder.reportOnly(['pass']).analyze();

    assert.ok(results.checksResults.length > 0);
    assert.ok(results.checksResults.every((r) => r.outcome === 'pass'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: exclude() skips elements inside the excluded subtree', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<div id="excluded"><img src="x.png"></div>' +
      '<div id="included"><img src="y.png" alt=""></div>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ driver }).exclude('#excluded').analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'pass');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: include() and exclude() combined -- scoped to a region, minus a sub-part of it', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<section id="scope"><div id="excluded"><img src="x.png"></div><img src="y.png"></section>' +
      '<img src="z.png">' + // outside #scope entirely -- must not count either
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ driver }).include('#scope').exclude('#excluded').analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    assert.deepStrictEqual(rule.occurrences.map((o) => o.selector), ['#scope > img']);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: disableRules() removes a rule from the result entirely', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver })
      .disableRules(['button-name-present'])
      .analyze();

    const rule = results.checksResults.find((r) => r.ruleId === 'button-name-present');
    assert.strictEqual(rule, undefined);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withRules() only runs the given rule IDs', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><img src=x.png><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver })
      .withRules(['img-alt-present'])
      .analyze();

    assert.deepStrictEqual(results.checksResults.map((r) => r.ruleId), ['img-alt-present']);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withRules() and disableRules() combined on the same rule ID -- disableRules wins', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><img src=x.png><button></button></body></html>');

    // surea11y applies excludeRuleIds *after* includeRuleIds (see
    // ../surea11y/docs/ENGINE_OPTIONS.md) -- disableRules() should win over
    // withRules() when the same ID appears in both.
    const results = await new A11yCoreBuilder({ driver })
      .withRules(['img-alt-present', 'button-name-present'])
      .disableRules(['img-alt-present'])
      .analyze();

    assert.deepStrictEqual(results.checksResults.map((r) => r.ruleId), ['button-name-present']);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: disableTags() never runs rules carrying any of the given tags', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><button></button></body></html>');

    // button-name-present carries wcag412 -- disabling that tag should remove it.
    const results = await new A11yCoreBuilder({ driver }).disableTags(['wcag412']).analyze();
    assert.ok(!results.checksResults.some((r) => r.ruleId === 'button-name-present'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withTags() only runs rules carrying at least one of the given tags', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver }).withTags(['wcag412']).analyze();
    assert.ok(results.checksResults.length > 0);
    // button-name-present carries wcag412 -- should still be present.
    assert.ok(results.checksResults.some((r) => r.ruleId === 'button-name-present'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withTags() and disableTags() combined on the same tag -- disableTags wins, leaving nothing', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver }).withTags(['wcag412']).disableTags(['wcag412']).analyze();
    assert.deepStrictEqual(results.checksResults, []);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withRules() and withTags() combined require BOTH to match (surea11y\'s default "and" includeMode)', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><img src=x.png><button></button></body></html>');

    // surea11y's default includeMode is 'and' when both an ID include and a
    // tag include are given (see ../surea11y/docs/ENGINE_OPTIONS.md) -- this
    // binding doesn't expose includeMode, so combining withRules() and
    // withTags() is stricter than either alone, not an OR of the two. Worth
    // locking down since it's non-obvious: img-alt-present doesn't carry
    // wcag412, so this combination yields nothing even though img-alt-present
    // alone matches withRules() and button-name-present alone matches wcag412.
    const results = await new A11yCoreBuilder({ driver })
      .withRules(['img-alt-present'])
      .withTags(['wcag412'])
      .analyze();

    assert.deepStrictEqual(results.checksResults, []);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: options() merges into engineOptions and is actually applied', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver }).options({ locale: 'fr' }).analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'button-name-present');
    assert.ok(rule, 'button-name-present should be present in the result');
    // Each result echoes back the *resolved* engineOptions it actually ran
    // under (see surea11y's docs/OUTPUT_SCHEMA.md), rather than just
    // presence, confirms .options() really reached the engine instead of
    // being silently dropped.
    assert.strictEqual(rule.engineOptions.locale, 'fr');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: options({ customRules }) registers a runtime custom rule via surea11y\'s engineOptions passthrough', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    // No dedicated builder method for this yet -- .options() already
    // forwards arbitrary engineOptions, including surea11y's customRules
    // runtime-registration escape hatch (see ../surea11y/docs/ENGINE_OPTIONS.md).
    const results = await new A11yCoreBuilder({ driver })
      .options({ customRules: [MY_ORG_CUSTOM_RULE] })
      .analyze();

    const custom = results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule');
    assert.ok(custom, 'custom rule should appear in checksResults like a built-in rule');
    assert.strictEqual(custom.outcome, 'fail');
    // Confirms the custom rule's occurrence gets the same automatic
    // selector/structuralPath fill-in a built-in rule's does, not a raw
    // pass-through of whatever the custom runInPage returned.
    assert.strictEqual(custom.occurrences[0].selector, 'html > body > div');
    assert.deepStrictEqual(custom.occurrences[0].structuralPath, [1, 0]);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: options({ customRules }) combined with frames(true) -- the custom rule runs in every frame, not just the top one', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cdiv class=my-widget%3E%3C/div%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();

    const results = await new A11yCoreBuilder({ driver })
      .frames(true)
      .options({ customRules: [MY_ORG_CUSTOM_RULE] })
      .analyze();

    assert.strictEqual(results.topFrame.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.frames[0].checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: options({ customRules }) combined with reportOnly() -- the custom rule is filtered the same as a built-in one', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    const results = await new A11yCoreBuilder({ driver })
      .options({ customRules: [MY_ORG_CUSTOM_RULE] })
      .reportOnly(['fail'])
      .analyze();

    assert.ok(results.checksResults.some((r) => r.ruleId === 'my-org-custom-rule'));
    assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withCustomRules() registers a runtime custom rule, converting a live runInPage function to a source string automatically', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    // MY_ORG_CUSTOM_RULE_LIVE's runInPage is a real, live function -- unlike
    // the raw .options({ customRules }) passthrough above, which requires a
    // pre-stringified function, withCustomRules() must convert it itself.
    const results = await new A11yCoreBuilder({ driver })
      .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
      .analyze();

    const custom = results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule');
    assert.ok(custom, 'custom rule should appear in checksResults like a built-in rule');
    assert.strictEqual(custom.outcome, 'fail');
    assert.strictEqual(custom.occurrences[0].selector, 'html > body > div');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withCustomRules() accepts an array to register multiple rules in one call', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<div class="my-other-widget"></div>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ driver })
      .withCustomRules([MY_ORG_CUSTOM_RULE_LIVE, SECOND_CUSTOM_RULE])
      .analyze();

    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-second-custom-rule').outcome, 'fail');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withCustomRules() accumulates across repeated calls, like withRules()/withTags()', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<div class="my-other-widget"></div>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ driver })
      .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
      .withCustomRules(SECOND_CUSTOM_RULE) // adds a second rule, doesn't replace the first
      .analyze();

    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-second-custom-rule').outcome, 'fail');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withCustomRules() composes with a raw options({ customRules }) call rather than clobbering it', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<div class="my-other-widget"></div>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ driver })
      .options({ customRules: [MY_ORG_CUSTOM_RULE] })
      .withCustomRules(SECOND_CUSTOM_RULE)
      .analyze();

    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-second-custom-rule').outcome, 'fail');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withCustomRules() runs the rule in every frame when combined with frames(true)', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cdiv class=my-widget%3E%3C/div%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();

    const results = await new A11yCoreBuilder({ driver })
      .frames(true)
      .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
      .analyze();

    assert.strictEqual(results.topFrame.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.frames[0].checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withCustomRules() is filtered the same as a built-in rule when combined with reportOnly()', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    const results = await new A11yCoreBuilder({ driver })
      .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
      .reportOnly(['fail'])
      .analyze();

    assert.ok(results.checksResults.some((r) => r.ruleId === 'my-org-custom-rule'));
    assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withCustomRules() converts a live applicability function too, and respects its true/false result', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><div class="applicability-gate"></div></body></html>');
    const applicableResults = await new A11yCoreBuilder({ driver })
      .withCustomRules(CUSTOM_RULE_WITH_APPLICABILITY)
      .analyze();
    assert.strictEqual(
      applicableResults.checksResults.find((r) => r.ruleId === 'my-org-conditional-custom-rule').outcome,
      'pass'
    );

    await driver.get('data:text/html,<html><body></body></html>');
    const notApplicableResults = await new A11yCoreBuilder({ driver })
      .withCustomRules(CUSTOM_RULE_WITH_APPLICABILITY)
      .analyze();
    assert.strictEqual(
      notApplicableResults.checksResults.find((r) => r.ruleId === 'my-org-conditional-custom-rule').outcome,
      'notApplicable'
    );
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withCustomRules() still accepts an already-stringified runInPage, same as the raw options() passthrough', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    const results = await new A11yCoreBuilder({ driver })
      .withCustomRules(MY_ORG_CUSTOM_RULE) // runInPage is already a string here
      .analyze();

    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withCustomRules() throws synchronously on a missing/empty id, instead of failing silently deep in the page', () => {
  assert.throws(
    () => new A11yCoreBuilder({ driver: { executeScript: () => {} } }).withCustomRules({ runInPage: () => ({}) }),
    /requires a non-empty string `id`/
  );
  assert.throws(
    () => new A11yCoreBuilder({ driver: { executeScript: () => {} } }).withCustomRules({ id: '', runInPage: () => ({}) }),
    /requires a non-empty string `id`/
  );
});

test('A11yCoreBuilder: withCustomRules() throws synchronously when runInPage is missing or not a function/string', () => {
  assert.throws(
    () => new A11yCoreBuilder({ driver: { executeScript: () => {} } }).withCustomRules({ id: 'no-run-fn' }),
    /requires a `runInPage` function or function-source string/
  );
  assert.throws(
    () => new A11yCoreBuilder({ driver: { executeScript: () => {} } }).withCustomRules({ id: 'bad-run-fn', runInPage: 123 }),
    /requires a `runInPage` function or function-source string/
  );
  assert.throws(
    () => new A11yCoreBuilder({ driver: { executeScript: () => {} } }).withCustomRules({ id: 'empty-run-fn', runInPage: '' }),
    /requires a `runInPage` function or function-source string/
  );
});

test('A11yCoreBuilder: withCustomRules() throws synchronously when applicability is provided but not a function/string', () => {
  assert.throws(
    () => new A11yCoreBuilder({ driver: { executeScript: () => {} } }).withCustomRules({
      id: 'bad-applicability',
      runInPage: () => ({}),
      applicability: 123
    }),
    /`applicability` must be a function or function-source string/
  );
});

test('A11yCoreBuilder: withCustomRules() rejects the whole call (no partial registration) when one descriptor in an array is invalid', () => {
  const builder = new A11yCoreBuilder({ driver: { executeScript: () => {} } });
  assert.throws(
    () => builder.withCustomRules([MY_ORG_CUSTOM_RULE_LIVE, { id: '', runInPage: () => ({}) }]),
    /requires a non-empty string `id`/
  );
  // Confirms the valid entry earlier in the array wasn't partially pushed
  // onto internal state before the invalid one threw.
  assert.strictEqual(builder._customRules.length, 0);
});

test('A11yCoreBuilder: frames(true) with no sub-frames returns { topFrame, frames: [] }', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();

    assert.ok(Array.isArray(results.topFrame.checksResults));
    assert.ok(results.topFrame.checksResults.some((r) => r.ruleId === 'button-name-present' && r.outcome === 'fail'));
    assert.deepStrictEqual(results.frames, []);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: frames(true) scans a sub-frame and keeps its findings separate from the top frame', async () => {
  const driver = await buildDriver();
  try {
    // <iframe srcdoc> creates a real, distinct sub-frame with zero network
    // dependency and fully deterministic content -- good for verifying the
    // orchestration logic itself (topFrame vs. frames[], not double-counting).
    await driver.get(
      'data:text/html,<html><body>' +
      '<button>Top button, has a name</button>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();

    const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();

    // Top frame has no img-alt-present issue (no <img> there at all) and no
    // button-name-present failure (the button has real text).
    const topButtonRule = results.topFrame.checksResults.find((r) => r.ruleId === 'button-name-present');
    assert.strictEqual(topButtonRule.outcome, 'pass');

    assert.strictEqual(results.frames.length, 1);
    const frameImgRule = results.frames[0].checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(frameImgRule.outcome, 'fail');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: frames(true) recurses into nested iframes, flattening every depth into one frames array', async () => {
  const driver = await buildDriver();
  try {
    // An iframe whose srcdoc itself contains another iframe -- Selenium has
    // no page.frames()-style flat listing, so .frames(true) must recurse
    // through switchTo().frame()/parentFrame() to reach the grandchild. Both
    // the child (a button with no name) and grandchild (an img with no alt)
    // must appear in the flat frames array. Built with encodeURIComponent +
    // &quot;-escaping (rather than hand-written %-encoding) so the nested
    // srcdoc documents parse cleanly; the grandchild uses unquoted attributes
    // so its own quotes can't terminate the srcdoc value early.
    const grandchildDoc = '<img id=gc src=x.png>';
    const childDoc = `<button></button><iframe srcdoc="${grandchildDoc.replace(/"/g, '&quot;')}"></iframe>`;
    const topDoc = `<html><body><iframe srcdoc="${childDoc.replace(/"/g, '&quot;')}"></iframe></body></html>`;
    await driver.get('data:text/html,' + encodeURIComponent(topDoc));
    await settle();

    const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();

    assert.strictEqual(results.frames.length, 2, 'expected child + grandchild frames flattened into one array');
    const anyButtonFail = results.frames.some((f) =>
      (f.checksResults || []).some((r) => r.ruleId === 'button-name-present' && r.outcome === 'fail'));
    const anyImgFail = results.frames.some((f) =>
      (f.checksResults || []).some((r) => r.ruleId === 'img-alt-present' && r.outcome === 'fail'));
    assert.ok(anyButtonFail, 'child frame button-name-present should fail');
    assert.ok(anyImgFail, 'grandchild frame img-alt-present should fail');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: reportOnly() filters checksResults down to the given outcomes', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><img src="x.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver }).reportOnly(['fail']).analyze();

    assert.ok(results.checksResults.length > 0);
    assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
    assert.ok(results.checksResults.some((r) => r.ruleId === 'button-name-present'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: reportOnly() rejects an invalid outcome value', () => {
  const driver = { executeScript: async () => {} };
  assert.throws(
    () => new A11yCoreBuilder({ driver }).reportOnly(['nope']),
    /invalid outcome "nope"/
  );
});

test('A11yCoreBuilder: reportOnly() applies per-frame when combined with frames(true)', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<button>Top button, has a name</button>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();

    const results = await new A11yCoreBuilder({ driver }).frames(true).reportOnly(['fail']).analyze();

    assert.ok(results.topFrame.checksResults.every((r) => r.outcome === 'fail'));
    assert.ok(results.frames[0].checksResults.every((r) => r.outcome === 'fail'));
    assert.ok(results.frames[0].checksResults.some((r) => r.ruleId === 'img-alt-present'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: elementRef(true) attaches a live, usable WebElement to each fail/cantTell occurrence', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><img id="pic" src="x.png"></body></html>');

    const results = await new A11yCoreBuilder({ driver }).elementRef(true).analyze();

    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    const [occurrence] = rule.occurrences;
    assert.ok(occurrence.elementHandle, 'occurrence should carry a live WebElement');
    // Prove it's a real, usable handle into the page -- not just a
    // truthy placeholder -- by reading a live DOM property through it.
    const id = await readProp(driver, occurrence.elementHandle, 'id');
    assert.strictEqual(id, 'pic');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: reportOnly() and elementRef(true) combined -- surviving occurrences still carry a usable WebElement', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><img id="pic" src="x.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver }).reportOnly(['fail']).elementRef(true).analyze();

    assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    const id = await readProp(driver, rule.occurrences[0].elementHandle, 'id');
    assert.strictEqual(id, 'pic');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: elementRef(true) leaves elementHandle null for an occurrence with no resolvable selector, instead of throwing', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><button>x</button></body></html>');

    // contrast-enhanced can report a page-wide occurrence with
    // selector: "" (no single target element) -- confirms .elementRef(true)
    // doesn't crash calling findElements(By.css("")) on it (an invalid CSS
    // selector Selenium throws InvalidSelectorError for) and instead leaves
    // elementHandle null. Selenium's empty-string behavior DIFFERS from
    // Puppeteer/Playwright's .$("") (which resolves to null rather than
    // throwing) -- _resolveElement() short-circuits an empty selector to null
    // before it ever reaches Selenium. Verified with a real run.
    const results = await new A11yCoreBuilder({ driver }).elementRef(true).analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'contrast-enhanced');
    const occurrence = rule.occurrences.find((o) => o.selector === '');
    assert.ok(occurrence, 'expected an occurrence with an empty selector on this page');
    assert.strictEqual(occurrence.elementHandle, null);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: elementRef(true) resolves against each frame\'s own document when combined with frames(true)', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<button>Top button, has a name</button>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg id=inner src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();

    const results = await new A11yCoreBuilder({ driver }).frames(true).elementRef(true).analyze();

    const rule = results.frames[0].checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    const handle = rule.occurrences[0].elementHandle;
    assert.ok(handle, 'sub-frame occurrence should carry a live WebElement resolved against that frame');

    // Selenium WebElements are CONTEXT-BOUND (verified with a real run):
    // a handle resolved inside a sub-frame is only usable
    // while the driver is switched into that same frame, and throws
    // NoSuchElementError from any other context. Since analyze() deliberately
    // leaves the driver back at the top-level document, using a sub-frame
    // handle means switching back into its frame first. This is a real
    // difference from Puppeteer/Playwright's context-free ElementHandles --
    // the top frame's handles (single-frame mode, or results.topFrame) have
    // no such caveat since the top IS the default context. The handle is
    // valid, not dead: it revives on re-entering its frame.
    const iframe = await driver.findElement(By.css('iframe'));
    await driver.switchTo().frame(iframe);
    try {
      const id = await readProp(driver, handle, 'id');
      assert.strictEqual(id, 'inner');
    } finally {
      await driver.switchTo().defaultContent();
    }
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: frames(true) scans a genuinely cross-origin iframe (no surea11y engine support needed for this)', async () => {
  const driver = await buildDriver();
  try {
    // example.org is IANA-reserved specifically for use in documentation/
    // testing and is about as stable a real external dependency as exists --
    // this is the exact page used to empirically verify that cross-origin
    // frame scanning needs no engine work, the same claim the Playwright/
    // Puppeteer bindings already verified for themselves (Selenium switches
    // WebDriver context into the frame at the automation-protocol level, so
    // the same reasoning transfers -- confirmed here with a real run, not
    // assumed).
    await driver.get('data:text/html,<html><body><iframe src="https://example.org/"></iframe></body></html>');
    await settle(2000);

    const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();

    assert.strictEqual(results.frames.length, 1);
    assert.ok(!results.frames[0].error, `Cross-origin frame scan should not error: ${results.frames[0].error}`);
    assert.ok(Array.isArray(results.frames[0].checksResults));
    assert.ok(results.frames[0].checksResults.length > 0);
  } finally {
    await driver.quit();
  }
});

// Since @surea11y/core 1.10.0 the engine throws, with a `code`, for a rule or
// tag list that names nothing it knows and for a scope selector the browser
// can't parse. executeScript() alone would keep only the message.
test('A11yCoreBuilder: withRules() naming no known rule rejects with an EngineError, code INVALID_RUN_ONLY', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><button></button></body></html>');

    await assert.rejects(
      new A11yCoreBuilder({ driver }).withRules(['no-such-rule']).analyze(),
      (err) => {
        assert.ok(err instanceof EngineError, `expected an EngineError, got ${err && err.name}: ${err && err.message}`);
        assert.strictEqual(err.code, 'INVALID_RUN_ONLY');
        assert.match(err.message, /no-such-rule/);
        return true;
      }
    );
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: include() with a selector the browser cannot parse rejects with an EngineError, code INVALID_CONTEXT_SELECTOR', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><main></main></body></html>');

    await assert.rejects(
      new A11yCoreBuilder({ driver }).include('main[').analyze(),
      (err) => {
        assert.ok(err instanceof EngineError, `expected an EngineError, got ${err && err.name}: ${err && err.message}`);
        assert.strictEqual(err.code, 'INVALID_CONTEXT_SELECTOR');
        assert.strictEqual(err.selector, 'main[');
        return true;
      }
    );
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: an engine error in frames(true) mode rejects too, and leaves the driver in the top-level document', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cbutton%3E%3C/button%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();

    await assert.rejects(
      new A11yCoreBuilder({ driver }).frames(true).withTags(['wcag2.2aa']).analyze(),
      (err) => err instanceof EngineError && err.code === 'INVALID_RUN_ONLY'
    );
    // Still at the top: the iframe is findable from here.
    assert.strictEqual((await driver.findElements(By.css('iframe'))).length, 1);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withRules()/withTags()/disableRules()/disableTags() reject a missing or empty value at the call', () => {
  const builder = new A11yCoreBuilder({ driver: { executeScript: () => {} } });
  for (const method of ['withRules', 'withTags', 'disableRules', 'disableTags']) {
    for (const value of [undefined, '', [''], ['ok', undefined]]) {
      assert.throws(() => builder[method](value), (err) => err instanceof TypeError && err.code === 'INVALID_RUN_ONLY', `${method}(${JSON.stringify(value)})`);
    }
  }
});

test('A11yCoreBuilder: include() combined with frames(true) scopes the top frame only; each sub-frame is scanned whole', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<main id="main"><img src="a.png" alt=""></main><img src="outside.png">' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=b.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();

    const results = await new A11yCoreBuilder({ driver }).include('#main').frames(true).analyze();

    // Top frame: only #main, so the image outside it isn't reported.
    assert.deepStrictEqual(results.topFrame.contextMatch, { elementCount: 1, unmatchedSelectors: [] });
    assert.strictEqual(results.topFrame.checksResults.find((r) => r.ruleId === 'img-alt-present').outcome, 'pass');

    // Sub-frame: it has no #main. With the top frame's selector it would
    // scan nothing (core 1.10.0); it is scanned whole instead.
    assert.strictEqual(results.frames.length, 1);
    assert.strictEqual(results.frames[0].contextSelector, null);
    assert.strictEqual(results.frames[0].contextMatch, null);
    assert.strictEqual(results.frames[0].checksResults.find((r) => r.ruleId === 'img-alt-present').outcome, 'fail');
  } finally {
    await driver.quit();
  }
});

// A page with an image missing alt inside an open shadow root, and a
// light-DOM image (with alt) its in-shadow selector would also match from
// the document.
const SHADOW_PAGE =
  'data:text/html,' + encodeURIComponent(
    '<html><body><main><img src="light.png" alt="Light"></main><div id="host"></div>' +
    '<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = \'<main><img src="shadow.png"></main>\';</script>' +
    '</body></html>'
  );

test('A11yCoreBuilder: elementRef(true) resolves a shadow-DOM occurrence through its shadow hosts, not to a light-DOM look-alike', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(SHADOW_PAGE);

    const results = await new A11yCoreBuilder({ driver }).withRules(['img-alt-present']).elementRef(true).analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    assert.strictEqual(rule.occurrences.length, 1);
    const [occurrence] = rule.occurrences;
    assert.deepStrictEqual(occurrence.shadowHostSelectors, ['#host']);

    // The selector alone, looked up in the document, finds the light-DOM image.
    const fromDocument = await driver.findElements(By.css(occurrence.selector));
    assert.ok(fromDocument.length > 0);
    assert.match(await readProp(driver, fromDocument[0], 'src'), /light\.png$/);

    assert.ok(occurrence.elementHandle, 'expected a WebElement for the shadow-DOM image');
    assert.match(await readProp(driver, occurrence.elementHandle, 'src'), /shadow\.png$/);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: elementRef(true) leaves elementHandle null when a shadow host is gone', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(SHADOW_PAGE);

    const builder = new A11yCoreBuilder({ driver });
    const occurrence = { selector: 'main > img', shadowHostSelectors: ['#no-such-host'] };
    assert.strictEqual(await builder._resolveElement(occurrence), null);
    assert.strictEqual(await builder._resolveElement({ selector: 'main > img[', shadowHostSelectors: ['#host'] }), null);
  } finally {
    await driver.quit();
  }
});

// Collects console.warn calls made while `fn` runs.
async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('A11yCoreBuilder: analyze() prints each scan gap with console.warn, and nothing for a scan without gaps', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><main><img src="x.png"></main></body></html>');

    const clean = await captureWarnings(() => new A11yCoreBuilder({ driver }).include('main').analyze());
    assert.deepStrictEqual(clean, []);

    const warnings = await captureWarnings(() => new A11yCoreBuilder({ driver }).include('#no-such-region').analyze());
    assert.strictEqual(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /^@surea11y\/selenium \(data:text\/html,.*\): Nothing was scanned: the scan scope matched no element \("#no-such-region"\)\.$/);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: with frames(true), analyze() prints the scan gaps of each frame', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cp%3Einner%3C/p%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();

    const warnings = await captureWarnings(() =>
      new A11yCoreBuilder({ driver })
        .frames(true)
        .withCustomRules({ id: 'broken-rule', meta: { title: 'Broken' }, runInPage: 'not a function' })
        .analyze()
    );
    // The custom rule is skipped in the top frame and in the sub-frame.
    assert.strictEqual(warnings.length, 2, warnings.join('\n'));
    assert.ok(warnings.every((w) => w.includes('Custom rule "broken-rule" did not run')), warnings.join('\n'));
    assert.ok(warnings.some((w) => w.includes('(about:srcdoc)')), warnings.join('\n'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: logger() receives each scan gap with its frame\'s result, instead of console.warn', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cp%3Einner%3C/p%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();

    const seen = [];
    const warnings = await captureWarnings(() =>
      new A11yCoreBuilder({ driver })
        .include('#missing')
        .frames(true)
        .withCustomRules({ id: 'broken-rule', meta: { title: 'Broken' }, runInPage: 'not a function' })
        .logger((gap, frame) => seen.push([gap.kind, frame.url]))
        .analyze()
    );
    assert.deepStrictEqual(warnings, []);
    // The scope matched nothing in the top frame; the custom rule was
    // skipped there and in the sub-frame. Each gap comes with its frame.
    assert.deepStrictEqual(seen.map(([kind]) => kind).sort(), ['context-not-found', 'custom-rule-skipped', 'custom-rule-skipped']);
    assert.strictEqual(seen.filter(([, url]) => url === 'about:srcdoc').length, 1, JSON.stringify(seen));
  } finally {
    await driver.quit();
  }
});

// A pack (@surea11y/core/pack, plain object form): a rule, a 7:1 variant of
// contrast-minimum, and a checklist profile with one item.
const ACME_PACK = {
  name: '@acme/a11y-rules',
  version: '1.0.0',
  namespace: 'acme',
  core: '*',
  title: 'Acme policy',
  rules: [
    {
      id: 'acme-no-widget',
      meta: { title: 'No widget', tags: ['house-rules'] },
      runInPage(ctx) {
        const el = ctx.document.querySelector('.my-widget');
        return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'pass' };
      }
    }
  ],
  variants: [
    {
      id: 'acme-contrast-enhanced',
      from: 'contrast-minimum',
      config: { normalTextRatio: 7, largeTextRatio: 4.5 },
      meta: {
        title: 'Text contrast is at least 7:1',
        tags: ['house-rules'],
        i18n: { titleKey: 'acmeContrastEnhanced_title', descriptionKey: 'acmeContrastEnhanced_description' }
      }
    }
  ],
  dictionaries: {
    en: {
      acmeContrastEnhanced_title: 'Text contrast is at least 7:1',
      acmeContrastEnhanced_description: 'Checks text contrast at 7:1.'
    }
  },
  profiles: { 'acme-1': { tags: ['wcag2a', 'wcag2aa', 'house-rules'] } },
  rollups: [{ id: 'acme-text', title: 'Text', checksIds: ['contrast-minimum', 'acme-contrast-enhanced'] }]
};

test('A11yCoreBuilder: withPacks() runs a pack in the page, its profile and variant included', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html lang="en"><head><title>t</title></head><body><main>' +
      '<div class="my-widget">W</div><p style="color:%23767676;background:%23fff">Grey</p></main></body></html>'
    );
    await settle();
    const result = await new A11yCoreBuilder({ driver })
      .withPacks(ACME_PACK)
      .options({ profile: 'acme-1' })
      .analyze();
    assert.deepStrictEqual(result.engine.packs, ['@acme/a11y-rules@1.0.0']);
    assert.strictEqual(result.engine.profile, 'acme-1');
    const outcome = (id) => result.checksResults.find((r) => r.ruleId === id).outcome;
    assert.strictEqual(outcome('acme-no-widget'), 'fail');
    // #767676 on white is 4.54:1: core's rule passes, the 7:1 variant fails.
    assert.strictEqual(outcome('contrast-minimum'), 'pass');
    assert.strictEqual(outcome('acme-contrast-enhanced'), 'fail');
    assert.strictEqual(result.rulesResults.find((r) => r.ruleId === 'acme-text').outcome, 'fail');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withPacks() runs the pack in every frame when combined with frames(true)', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cdiv class=my-widget%3E%3C/div%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await settle();
    const results = await new A11yCoreBuilder({ driver }).frames(true).withPacks(ACME_PACK).analyze();
    for (const r of [results.topFrame, results.frames[0]]) {
      assert.deepStrictEqual(r.engine.packs, ['@acme/a11y-rules@1.0.0']);
      assert.strictEqual(r.checksResults.find((c) => c.ruleId === 'acme-no-widget').outcome, 'fail');
    }
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withPacks() runs the pack in a nested frame too', async () => {
  const driver = await buildDriver();
  try {
    const grandchildDoc = '<div class=my-widget></div>';
    const childDoc = `<p>child</p><iframe srcdoc="${grandchildDoc}"></iframe>`;
    const topDoc = `<html><body><iframe srcdoc="${childDoc.replace(/"/g, '&quot;')}"></iframe></body></html>`;
    await driver.get('data:text/html,' + encodeURIComponent(topDoc));
    await settle();
    const results = await new A11yCoreBuilder({ driver }).frames(true).withPacks(ACME_PACK).withRules('acme-no-widget').analyze();
    assert.strictEqual(results.frames.length, 2);
    const outcomes = [results.topFrame, ...results.frames].map((r) => r.checksResults.find((c) => c.ruleId === 'acme-no-widget').outcome);
    assert.deepStrictEqual(outcomes, ['pass', 'pass', 'fail']);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withPacks() can scan the same page twice', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html lang="en"><head><title>t</title></head><body><div class="my-widget">W</div></body></html>');
    for (let i = 0; i < 2; i++) {
      const result = await new A11yCoreBuilder({ driver }).withPacks(ACME_PACK).withRules('acme-no-widget').analyze();
      assert.deepStrictEqual(result.checksResults.map((r) => [r.ruleId, r.outcome]), [['acme-no-widget', 'fail']]);
    }
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: a pack the page does not run is a pack-skipped gap, and analyze() warns about it', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html lang="en"><head><title>t</title></head><body><img src="a.png"></body></html>');
    let result;
    const warnings = await captureWarnings(async () => {
      result = await new A11yCoreBuilder({ driver }).options({ packs: ['@acme/not-registered@1.0.0'] }).withRules('img-alt-present').analyze();
    });
    const gaps = getScanGaps(result);
    assert.deepStrictEqual(gaps.map((g) => [g.kind, g.pack.name]), [['pack-skipped', '@acme/not-registered@1.0.0']]);
    assert.ok(warnings.some((w) => w.includes('Pack "@acme/not-registered@1.0.0" did not run')), warnings.join('\n'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: withWcag() runs a WCAG target, and withBestPractices() adds the best practices', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html lang="en"><head><title>t</title></head><body><img src="a.png"></body></html>');
    const target = await new A11yCoreBuilder({ driver }).withWcag('2.2', 'AA').analyze();
    const ids = target.checksResults.map((r) => r.ruleId);
    assert.strictEqual(target.engine.wcagVersion, '2.2');
    assert.ok(ids.includes('img-alt-present'));
    assert.ok(!ids.includes('duplicate-id'), '4.1.1 is no part of a WCAG 2.2 target');
    assert.ok(!ids.includes('region'));
    const withBest = await new A11yCoreBuilder({ driver }).withWcag('2.2', 'AA').withBestPractices().analyze();
    assert.ok(withBest.checksResults.some((r) => r.ruleId === 'region'));
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: strictOptions rejects a misspelt option with an EngineError carrying INVALID_ENGINE_OPTIONS', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html lang="en"><head><title>t</title></head><body></body></html>');
    await assert.rejects(
      () => new A11yCoreBuilder({ driver }).options({ strictOptions: true, lcoale: 'fr' }).analyze(),
      (err) => err instanceof EngineError && err.code === 'INVALID_ENGINE_OPTIONS' && /lcoale/.test(err.message)
    );
  } finally {
    await driver.quit();
  }
});

test("A11yCoreBuilder: a frames(true) result goes to @surea11y/core's SARIF report with every frame's findings", async () => {
  const { renderSarifReport } = require('@surea11y/core/sarif');
  const driver = await buildDriver();
  try {
    const grandchildDoc = '<img src=grandchild.png>';
    const childDoc = `<img src="child.png"><iframe title="Inner" srcdoc="${grandchildDoc}"></iframe>`;
    const topDoc = '<html lang="en"><head><title>t</title></head><body><img src="top.png">' +
      `<iframe title="Ad" srcdoc="${childDoc.replace(/"/g, '&quot;')}"></iframe></body></html>`;
    await driver.get('data:text/html,' + encodeURIComponent(topDoc));
    await settle();
    const results = await new A11yCoreBuilder({ driver }).frames(true).withRules('img-alt-present').analyze();
    const run = JSON.parse(renderSarifReport(results)).runs[0];
    const failures = run.results.filter((r) => r.ruleId === 'img-alt-present' && r.level === 'error');
    assert.strictEqual(failures.length, 3, JSON.stringify(failures.map((r) => r.locations)));
    const notices = (run.invocations || []).flatMap((i) => i.toolExecutionNotifications || []);
    assert.deepStrictEqual(notices.map((n) => n.message.text), [], 'no frame reported as not scanned');
  } finally {
    await driver.quit();
  }
});

// --- @surea11y/core 1.12 -------------------------------------------------------------

// Web components that keep their ElementInternals in a private field, where
// no script but the internals hook can read them: one names itself and sets
// its state, one is a switch only through its internals, with no name, and
// one is the same switch named through its internals.
const COMPONENTS_SCRIPT = `<script>
customElements.define('x-check', class extends HTMLElement {
  #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.ariaLabel = 'Subscribe'; this.#i.ariaChecked = 'false'; }
});
customElements.define('x-toggle', class extends HTMLElement {
  #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.role = 'switch'; }
});
customElements.define('x-named-toggle', class extends HTMLElement {
  #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.role = 'switch'; this.#i.ariaLabel = 'Dark mode'; }
});
</script>`;

function componentPage(body) {
  return 'data:text/html,' + encodeURIComponent(
    `<!doctype html><html lang="en"><head><title>t</title>${COMPONENTS_SCRIPT}</head><body><main><h1>Hi</h1>${body}</main></body></html>`
  );
}

function srcdoc(html) {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function outcomeOf(result, ruleId) {
  const check = result.checksResults.find((r) => r.ruleId === ruleId);
  return check ? check.outcome : undefined;
}

test('A11yCoreBuilder: wcagLevel() reaches the engine: a contrast check at AA reports 1.4.3 and no 1.4.6', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1><p>Text</p></main></body></html>');
    const results = await new A11yCoreBuilder({ driver }).withRules('contrast-computable').wcagLevel('aa').analyze();
    assert.strictEqual(results.engine.wcagLevel, 'AA');
    assert.deepStrictEqual(results.rulesResults.map((r) => r.ruleId), ['wcag-1.4.3-contrast-minimum']);
    assert.deepStrictEqual(results.checksResults.map((r) => r.ruleId), ['contrast-computable']);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: a scan under forced colors emulated through the DevTools protocol records engine.environment.forcedColors', async () => {
  const driver = await buildDriver();
  try {
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    await driver.get('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>');
    const results = await new A11yCoreBuilder({ driver }).withRules('contrast-minimum').analyze();
    assert.strictEqual(results.engine.environment.forcedColors, 'active');

    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] });
    const plain = await new A11yCoreBuilder({ driver }).withRules('contrast-minimum').analyze();
    assert.strictEqual(plain.engine.environment.forcedColors, 'none');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder.installInternalsHook(): in a BiDi session, a component named through private internals is a question without it, and passes with it, in every frame', async () => {
  const inner = `<!doctype html><html lang="en"><head><title>f</title>${COMPONENTS_SCRIPT}</head><body><x-check role="checkbox"></x-check></body></html>`;
  const url = componentPage(`<x-check role="checkbox"></x-check><iframe title="Form" srcdoc="${srcdoc(inner)}"></iframe>`);

  const plain = await buildDriver(undefined, { bidi: true });
  try {
    await plain.get(url);
    const before = await new A11yCoreBuilder({ driver: plain }).logger(() => {}).analyze();
    assert.strictEqual(outcomeOf(before, 'binary-control-name-present'), 'cantTell');
    assert.strictEqual(before.engine.environment.internalsHook, undefined);
  } finally {
    await plain.quit();
  }

  const driver = await buildDriver(undefined, { bidi: true });
  try {
    assert.strictEqual(await A11yCoreBuilder.installInternalsHook(driver), 'bidi');
    await driver.get(url);
    await settle();
    const results = await new A11yCoreBuilder({ driver }).frames(true).analyze();
    for (const frame of [results.topFrame, ...results.frames]) {
      assert.strictEqual(frame.engine.environment.internalsHook, 'early', frame.url);
      assert.strictEqual(outcomeOf(frame, 'binary-control-name-present'), 'pass', frame.url);
    }
    assert.strictEqual(results.frames.length, 1);
    assert.strictEqual(outcomeOf(results.topFrame, 'aria-required-attr'), 'pass');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder.installInternalsHook(): without BiDi, Chrome gets it through the DevTools protocol, and a switch set only through internals is checked as one', async () => {
  const plain = await buildDriver();
  try {
    await plain.get(componentPage('<x-toggle></x-toggle>'));
    const before = await new A11yCoreBuilder({ driver: plain }).withRules('binary-control-name-present').analyze();
    assert.strictEqual(outcomeOf(before, 'binary-control-name-present'), 'notApplicable', 'without the hook the role is not seen');
  } finally {
    await plain.quit();
  }

  const driver = await buildDriver();
  try {
    assert.strictEqual(await A11yCoreBuilder.installInternalsHook(driver), 'cdp');
    await driver.get(componentPage('<x-toggle></x-toggle>'));
    const unnamed = await new A11yCoreBuilder({ driver }).withRules('binary-control-name-present').analyze();
    assert.strictEqual(unnamed.engine.environment.internalsHook, 'early');
    assert.strictEqual(outcomeOf(unnamed, 'binary-control-name-present'), 'fail');

    await driver.get(componentPage('<x-named-toggle></x-named-toggle>'));
    const named = await new A11yCoreBuilder({ driver }).withRules('binary-control-name-present').analyze();
    assert.strictEqual(outcomeOf(named, 'binary-control-name-present'), 'pass');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder.installInternalsHook(): called after driver.get(), the loaded page has no hook; the next navigation has it', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(componentPage('<x-check role="checkbox"></x-check>'));
    await A11yCoreBuilder.installInternalsHook(driver);
    const loaded = await new A11yCoreBuilder({ driver }).logger(() => {}).analyze();
    assert.strictEqual(loaded.engine.environment.internalsHook, undefined);

    await driver.navigate().refresh();
    const reloaded = await new A11yCoreBuilder({ driver }).analyze();
    assert.strictEqual(reloaded.engine.environment.internalsHook, 'early');
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder.installInternalsHook() rejects a session with no before-load script, saying how to enable BiDi', async () => {
  // A classic session on a browser with no DevTools protocol: no
  // webSocketUrl capability, no sendDevToolsCommand().
  const classic = { getCapabilities: async () => new Map([['browserName', 'safari']]) };
  await assert.rejects(() => A11yCoreBuilder.installInternalsHook(classic), /no way to run a script before the page loads.*enableBidi\(\)/);
  for (const bad of [undefined, null, {}, { executeScript() {} }]) {
    await assert.rejects(() => A11yCoreBuilder.installInternalsHook(bad), TypeError);
  }
});

test('A11yCoreBuilder: without the hook, analyze() says once per scan that it would let the engine read those components', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => { warnings.push(String(msg)); });
  const driver = await buildDriver();
  try {
    const inner = `<!doctype html><html lang="en"><head><title>f</title>${COMPONENTS_SCRIPT}</head><body><x-check role="checkbox"></x-check></body></html>`;
    await driver.get(componentPage(`<x-check role="checkbox"></x-check><iframe title="Form" srcdoc="${srcdoc(inner)}"></iframe>`));
    await settle();
    await new A11yCoreBuilder({ driver }).frames(true).analyze();
    const notes = warnings.filter((w) => /custom element was asked about/.test(w));
    assert.strictEqual(notes.length, 1, JSON.stringify(warnings));
    assert.match(notes[0], /^@surea11y\/selenium \(data:text\/html,.*installInternalsHook\(\)/);
  } finally {
    await driver.quit();
  }
});

test('A11yCoreBuilder: plannedChecks() and plannedCriteria() list what analyze() then reports', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1><img src="a.png"></main></body></html>');
    const builder = new A11yCoreBuilder({ driver }).withWcag('2.2', 'AA');
    const results = await builder.analyze();
    const ids = (list, key) => list.map((e) => e[key]).sort();
    assert.deepStrictEqual(ids(builder.plannedChecks(), 'ruleId'), ids(results.checksResults, 'ruleId'));
    assert.deepStrictEqual(ids(builder.plannedCriteria(), 'id'), ids(results.rulesResults, 'ruleId'));
  } finally {
    await driver.quit();
  }
});

// --- @surea11y/core 1.14 -------------------------------------------------------------

// The listener hook needs @surea11y/core 1.14.0, and its note
// @surea11y/binding-base 1.6.0; these tests are skipped with older ones.
const HAS_LISTENER_HOOK = typeof require('@surea11y/core').listenerHookScript === 'function';
const HAS_LISTENER_NOTE = require('@surea11y/binding-base').getScanNotes({
  checksResults: [{ outcome: 'cantTell', occurrences: [{ selector: 'div', data: { details: { reasonCode: 'CLICK_HANDLER_NO_KEY_HANDLER' } } }] }]
}).some((n) => n.kind === 'listener-hook');
const NEEDS_HOOK = !HAS_LISTENER_HOOK && 'needs @surea11y/core 1.14.0';
const NEEDS_NOTE = !(HAS_LISTENER_HOOK && HAS_LISTENER_NOTE) && 'needs @surea11y/core 1.14.0 and @surea11y/binding-base 1.6.0';

// A custom button given its click listener from script, with no key listener
// anywhere: Enter and Space do nothing. Without the listener hook the scan
// can't see the listener; with it, the button fails.
const SCRIPTED_BUTTON = 'data:text/html,' + encodeURIComponent(
  '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1>' +
  '<div id="save" role="button" tabindex="0">Save</div>' +
  "<script>document.getElementById('save').addEventListener('click', () => {});</script>" +
  '</main></body></html>'
);

function listenerFinding(result) {
  const check = result.checksResults.find((r) => r.ruleId === 'click-handler-keyboard-operable');
  return [check.outcome, check.occurrences.map((o) => o.data.details.reasonCode)];
}

test('A11yCoreBuilder.installListenerHook(): a button given its click listener from script is unseen without it, and fails with it, through BiDi or the DevTools protocol', { skip: NEEDS_HOOK }, async () => {
  const plain = await buildDriver();
  try {
    await plain.get(SCRIPTED_BUTTON);
    const before = await new A11yCoreBuilder({ driver: plain }).withRules('click-handler-keyboard-operable').analyze();
    assert.strictEqual(outcomeOf(before, 'click-handler-keyboard-operable'), 'notApplicable');
    assert.strictEqual(before.engine.environment.listenerHook, undefined);
  } finally {
    await plain.quit();
  }

  for (const [bidi, how] of [[true, 'bidi'], [false, 'cdp']]) {
    const driver = await buildDriver(undefined, { bidi });
    try {
      assert.strictEqual(await A11yCoreBuilder.installListenerHook(driver), how);
      assert.strictEqual(await A11yCoreBuilder.installInternalsHook(driver), how);
      await driver.get(SCRIPTED_BUTTON);
      const after = await new A11yCoreBuilder({ driver }).withRules('click-handler-keyboard-operable').analyze();
      assert.strictEqual(after.engine.environment.listenerHook, 'early', how);
      assert.strictEqual(after.engine.environment.internalsHook, 'early', how);
      assert.deepStrictEqual(listenerFinding(after), ['fail', ['CLICK_HANDLER_NO_KEY_LISTENER']], how);
    } finally {
      await driver.quit();
    }
  }
});

test('A11yCoreBuilder.installListenerHook() rejects a session with no before-load script, and anything but a WebDriver', async () => {
  const classic = { getCapabilities: async () => new Map([['browserName', 'safari']]) };
  // With a core too old to have the hook, that is what the call says first.
  await assert.rejects(
    () => A11yCoreBuilder.installListenerHook(classic),
    HAS_LISTENER_HOOK
      ? /installListenerHook\(\): this session has no way to run a script before the page loads.*enableBidi\(\)/
      : /needs @surea11y\/core 1\.14\.0 or later/
  );
  for (const bad of [undefined, null, {}, { executeScript() {} }]) {
    await assert.rejects(() => A11yCoreBuilder.installListenerHook(bad), TypeError);
  }
});

const HAS_LIVE_REGION_HOOK = typeof require('@surea11y/core').liveRegionHookScript === 'function';
const HAS_ANNOUNCEMENTS = typeof require('@surea11y/binding-base').createInPageAnnouncements === 'function';
const NEEDS_LIVE_REGIONS =
  !(HAS_LIVE_REGION_HOOK && HAS_ANNOUNCEMENTS) && 'needs @surea11y/core 1.14.0 and @surea11y/binding-base 1.6.0';
const LIVE_REGIONS = 'data:text/html,' + encodeURIComponent(
  '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1>' +
  '<div id="status" role="status"></div><div id="toasts"></div></main></body></html>'
);

test('A11yCoreBuilder.installLiveRegionHook(): getAnnouncements() reads what live regions were given, and a region added with its text is asked about, through BiDi or the DevTools protocol', { skip: NEEDS_LIVE_REGIONS }, async () => {
  const plain = await buildDriver();
  try {
    await plain.get(LIVE_REGIONS);
    assert.strictEqual(await A11yCoreBuilder.getAnnouncements(plain), null);
  } finally {
    await plain.quit();
  }

  for (const [bidi, how] of [[true, 'bidi'], [false, 'cdp']]) {
    const driver = await buildDriver(undefined, { bidi });
    try {
      assert.strictEqual(await A11yCoreBuilder.installLiveRegionHook(driver), how);
      await driver.get(LIVE_REGIONS);
      await driver.executeScript("document.getElementById('status').textContent = 'Saved';");
      await driver.executeScript("document.getElementById('toasts').innerHTML = '<div role=\"status\">Copied</div>';");
      const said = await A11yCoreBuilder.getAnnouncements(driver);
      assert.deepStrictEqual(said.map((a) => [a.text, a.politeness]), [['Saved', 'polite']], how);
      assert.strictEqual(typeof said[0].time, 'number', how);

      const results = await new A11yCoreBuilder({ driver }).withRules('live-region-announcements').analyze();
      assert.strictEqual(results.engine.environment.liveRegionHook, 'early', how);
      const check = results.checksResults.find((r) => r.ruleId === 'live-region-announcements');
      assert.deepStrictEqual(
        check.occurrences.map((o) => [o.data.details.reasonCode, o.data.details.text]),
        [['LIVE_REGION_INSERTED_WITH_CONTENT', 'Copied']],
        how
      );
    } finally {
      await driver.quit();
    }
  }
});

test('A11yCoreBuilder.installLiveRegionHook() and getAnnouncements() reject what they cannot use', async () => {
  for (const bad of [undefined, null, {}]) {
    await assert.rejects(() => A11yCoreBuilder.installLiveRegionHook(bad), TypeError);
    await assert.rejects(() => A11yCoreBuilder.getAnnouncements(bad), TypeError);
  }
});

test('A11yCoreBuilder: without the listener hook, analyze() says once per scan that it would let the engine judge those handlers', { skip: NEEDS_NOTE }, async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => { warnings.push(String(msg)); });
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,' + encodeURIComponent(
      '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1>' +
      '<div role="button" tabindex="0" onclick="void save()">Save</div></main></body></html>'
    ));
    await new A11yCoreBuilder({ driver }).withRules('click-handler-keyboard-operable').analyze();
    const notes = warnings.filter((w) => /element was asked about because the scan could not see/.test(w));
    assert.strictEqual(notes.length, 1, JSON.stringify(warnings));
    assert.match(notes[0], /installListenerHook\(\)/);
  } finally {
    await driver.quit();
  }
});
