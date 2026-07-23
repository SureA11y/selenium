'use strict';

/**
 * Minimal runnable example: scans a real page with a real (headless)
 * browser and prints every rule outcome that failed.
 *
 * Selenium 4's bundled "Selenium Manager" auto-downloads the matching
 * chromedriver on first launch -- no separate server or manual driver
 * install needed.
 *
 * Run: npm run example -- https://example.com/
 *      (defaults to https://example.com/ if no URL is given)
 */

const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { A11yCoreBuilder } = require('../src/index.js');

async function main() {
  const url = process.argv[2] || 'https://example.com/';

  const options = new chrome.Options();
  options.addArguments('--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  const driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();
  try {
    await driver.get(url);

    const results = await new A11yCoreBuilder({ driver }).analyze();

    const fails = results.checksResults.filter((r) => r.outcome === 'fail');
    console.log(`Scanned ${url}`);
    console.log(`${results.checksResults.length} rules evaluated, ${fails.length} failed.\n`);

    for (const f of fails) {
      console.log(`${f.ruleId} (${f.severity}): ${f.occurrences.length} occurrence(s)`);
      for (const occ of f.occurrences.slice(0, 3)) {
        console.log(`  - ${occ.selector}`);
      }
    }
  } finally {
    await driver.quit();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
