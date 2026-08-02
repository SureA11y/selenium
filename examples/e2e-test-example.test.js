'use strict';

/**
 * Demonstrates the pattern that actually matters for E2E test suites: using
 * A11yCoreBuilder as an accessibility gate inside a real test, not just a
 * standalone script -- see basic-scan.js for that simpler case.
 *
 * Runner choice: plain `node:test` + `selenium-webdriver`,
 * not a Selenium-specific test framework. Selenium has no first-party test
 * runner the way `@playwright/test` is the obvious default for Playwright
 * (the JS bindings are a pure automation library, deliberately runner-agnostic
 * -- WebdriverIO/Mocha/Jest are all third-party choices you bring yourself),
 * and `node:test` is a zero-new-dependency choice that already matches this
 * project's own test suite (tests/builder.test.js uses it directly against a
 * real launched browser) -- so an E2E example built the same way is a more
 * honest "this is how a real suite would look" than reaching for a runner
 * this project doesn't otherwise use.
 *
 * Run: node --test examples/e2e-test-example.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { A11yCoreBuilder, formatFailures } = require('../src/index.js');

function buildDriver() {
  const options = new chrome.Options();
  options.addArguments('--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  return new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();
}

test('flags real accessibility issues (unlabeled button, missing alt)', async () => {
  const driver = await buildDriver();
  try {
    await driver.get('data:text/html,<html><body><img src="logo.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ driver })
      .reportOnly(['fail'])
      .analyze();

    const failedRuleIds = results.checksResults.map((r) => r.ruleId);
    assert.ok(failedRuleIds.includes('img-alt-present'));
    assert.ok(failedRuleIds.includes('button-name-present'));
  } finally {
    await driver.quit();
  }
});

test('a well-formed page has no accessibility violations', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(
      'data:text/html,<html lang="en"><head><title>Example</title></head>' +
      '<body><main><h1>Hello</h1><button>Click me</button></main></body></html>'
    );

    const results = await new A11yCoreBuilder({ driver })
      .reportOnly(['fail'])
      .analyze();

    // The real assertion shape you'd use as an accessibility gate in CI --
    // formatFailures() turns checksResults into a readable block (rule,
    // severity, selector, hint per occurrence) instead of a bare "not equal
    // to []" diff, so a failure is scannable straight from CI/terminal output.
    assert.strictEqual(results.checksResults.length, 0, formatFailures(results.checksResults));
  } finally {
    await driver.quit();
  }
});
