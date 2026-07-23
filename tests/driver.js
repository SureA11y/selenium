'use strict';

// Shared helper for the test suite: builds a real, headless Chrome
// WebDriver. Selenium 4's bundled "Selenium Manager" auto-downloads and
// manages the matching chromedriver on first `new Builder().build()`, so no
// separate Selenium server or manual chromedriver install is needed -- the
// same zero-extra-setup story puppeteer.launch()/chromium.launch() have.
// Not named *.test.js, so `node --test "tests/**/*.test.js"` doesn't treat
// it as a test file.

const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

async function buildDriver(browserName = Browser.CHROME) {
  if (browserName === Browser.CHROME) {
    const options = new chrome.Options();
    options.addArguments('--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
    return new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();
  }
  return new Builder().forBrowser(browserName).build();
}

// Read a live DOM property through a resolved WebElement -- the Selenium
// equivalent of Puppeteer's `elementHandle.evaluate((el) => el.prop)`. A
// WebElement can be passed straight into executeScript as an argument, where
// it materializes as the real DOM node in `arguments`.
function readProp(driver, webElement, prop) {
  return driver.executeScript(`return arguments[0][${JSON.stringify(prop)}];`, webElement);
}

// Give iframes (especially cross-origin ones with a real network fetch) a
// moment to load before enumerating them. Selenium's driver.get() resolves on
// the top document's load, not necessarily every sub-frame's.
function settle(ms = 1200) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { buildDriver, readProp, settle };
