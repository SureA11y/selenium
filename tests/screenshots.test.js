'use strict';

// .screenshots() in real, headless Chrome. Selenium reaches a frame by
// switching into it and takes only the whole viewport, so these check that
// each picture is cut from the right place, in every frame, and that the
// frame traversal still finds its way after the step switched around. Each
// picture is checked by its pixels: the element's own colour where the
// element is. The page and its cross-origin frames are served from two
// local ports, so nothing here depends on the network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { decodePng } = require('@surea11y/binding-base/src/png.js');
const { A11yCoreBuilder, formatFailures } = require('../src/index.js');
const { buildDriver, settle } = require('./driver.js');

// A transparent image, so each <img> shows its own background colour.
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const PAGE = (child) => `<!doctype html><html lang="en"><head><title>Shots</title><style>
  body { margin: 0; font: 16px sans-serif }
  header { position: sticky; top: 0; background: #036; color: #fff; padding: 20px; z-index: 5 }
  #scroller { height: 120px; overflow: auto; border: 1px solid }
</style></head><body>
<header>Header</header>
<main>
  <h1>Shots</h1>
  <img id="top" src="${GIF}" width="80" height="40" style="background:rgb(255,165,0)">
  <p style="height:1200px">spacer</p>
  <div id="scroller"><p style="height:400px">inner</p><img id="inner" src="${GIF}" width="50" height="30" style="background:rgb(0,128,0)"></div>
  <x-card></x-card>
  <div style="position:absolute;left:-9999px"><img id="away" src="${GIF}" width="10" height="10"></div>
  <iframe id="first" title="First" src="${child}" width="400" height="300" style="border:10px solid #ccc;padding:5px"></iframe>
  <iframe id="second" title="Second" src="${child}?second" width="300" height="200"></iframe>
  <p style="height:800px">after</p>
</main>
<script>
  customElements.define('x-card', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<img src="${GIF}" width="60" height="60" style="background:rgb(128,0,128)">'; }
  });
</script>
</body></html>`;

// The frame: an image near its bottom, so it needs scrolling into view on
// the page as well as in itself.
const CHILD = `<!doctype html><html lang="en"><head><title>Child</title></head><body style="margin:0">
<main><h1>Child</h1><p style="height:200px">child spacer</p>
<img id="framed" src="${GIF}" width="70" height="35" style="background:rgb(0,128,128)"></main>
</body></html>`;

// The colour each flagged image is, by where core says it is. An element
// at the top of a shadow root keeps its first step to the root's own
// children (`img:not(* > *)`, @surea11y/core 1.14.0).
const COLOURS = {
  '#top': [255, 165, 0],
  '#inner': [0, 128, 0],
  'html > body > main > x-card >>> img:not(* > *)': [128, 0, 128],
  '#framed': [0, 128, 128]
};

function serve(body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(body());
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The page on localhost, its frames on 127.0.0.1: two origins.
async function servePages() {
  const child = await serve(() => CHILD);
  const childUrl = `http://127.0.0.1:${child.address().port}/`;
  const page = await serve(() => PAGE(childUrl));
  return {
    url: `http://localhost:${page.address().port}/`,
    close: () => { child.close(); page.close(); }
  };
}

// Headless Chrome at a device pixel ratio of 2, so the crop scales CSS
// pixels to the screenshot's.
function buildHiDpiDriver() {
  const options = new chrome.Options();
  options.addArguments('--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--force-device-scale-factor=2', '--window-size=800,700');
  return new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();
}

function where(occurrence) {
  return (occurrence.shadowHostSelectors || []).concat(occurrence.selector).join(' >>> ');
}

function assertColour(shot, scale, want, label) {
  assert.ok(shot && shot.buffer, `${label}: ${JSON.stringify(shot)}`);
  const png = decodePng(shot.buffer);
  const x = Math.floor((shot.box.x + shot.box.width / 2) * scale);
  const y = Math.floor((shot.box.y + shot.box.height / 2) * scale);
  const got = Array.from(png.rows.subarray(y * png.stride + x * png.bpp, y * png.stride + x * png.bpp + 3));
  assert.ok(want.every((v, i) => Math.abs(v - got[i]) <= 3), `${label}: ${got} at the element, wanted ${want}`);
}

// What the page looks like from outside: scroll positions and the main
// content's markup (chromedriver marks each <iframe> it switched into with
// an attribute of its own, so the frames are left out).
async function pageState(driver) {
  await driver.switchTo().defaultContent();
  return driver.executeScript(() => [
    window.scrollX,
    window.scrollY,
    document.getElementById('scroller').scrollTop,
    document.body.innerHTML.replace(/<iframe[^>]*>/g, '<iframe>'),
    Object.getOwnPropertySymbols(window).map(String)
  ]);
}

test('screenshots(): pictures each flagged element in every frame, says why for the rest, and leaves the page and the frame traversal as they were', async () => {
  const pages = await servePages();
  const driver = await buildHiDpiDriver();
  try {
    await driver.get(pages.url);
    await settle();
    await driver.executeScript(() => { window.scrollTo(0, 37); document.getElementById('scroller').scrollTop = 11; });
    const before = await pageState(driver);

    const scan = (screenshots) => {
      const builder = new A11yCoreBuilder({ driver }).withRules('img-alt-present').frames(true);
      return (screenshots ? builder.screenshots({ padding: 8 }) : builder).analyze();
    };
    const plain = await scan(false);
    const results = await scan(true);

    // The same frames, in the same order, with the same findings.
    const shape = (r) => [r.topFrame, ...r.frames].map((f) => [f.url, f.error || null, (f.checksResults || []).map((c) => [c.ruleId, c.outcome, c.occurrences.map(where)])]);
    const withoutShots = JSON.parse(JSON.stringify(results, (k, v) => (k === 'screenshot' ? undefined : v)));
    assert.deepStrictEqual(shape(withoutShots), shape(plain));
    assert.strictEqual(results.frames.length, 2);

    const top = new Map(results.topFrame.checksResults[0].occurrences.map((o) => [where(o), o]));
    for (const name of ['#top', '#inner', 'html > body > main > x-card >>> img:not(* > *)']) {
      assert.ok(top.has(name), `${name} is not among ${[...top.keys()].join(', ')}`);
      assertColour(top.get(name).screenshot, 2, COLOURS[name], name);
    }
    assert.deepStrictEqual(top.get('#away').screenshot, { skipped: 'off-screen' });

    // The image in each cross-origin frame, placed on the top-level page.
    for (const [i, frame] of results.frames.entries()) {
      const framed = frame.checksResults[0].occurrences[0];
      assertColour(framed.screenshot, 2, COLOURS['#framed'], `#framed in frame ${i}`);
    }

    assert.deepStrictEqual(await pageState(driver), before);
  } finally {
    await driver.quit();
    pages.close();
  }
});

test('screenshots({ dir }): one file per element, named after it, which formatFailures() points to; reportOnly() and elementRef() still apply', async () => {
  const pages = await servePages();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surea11y-selenium-shots-'));
  const driver = await buildDriver();
  try {
    await driver.get(pages.url);
    const run = () => new A11yCoreBuilder({ driver })
      .withRules(['img-alt-present', 'image-alt-not-filename'])
      .screenshots({ dir })
      .reportOnly(['fail'])
      .elementRef(true)
      .analyze();
    const results = await run();

    const occurrence = results.checksResults[0].occurrences.find((o) => o.selector === '#top');
    assert.ok(occurrence.elementHandle, 'elementRef() still attaches its element');
    assert.strictEqual(await occurrence.elementHandle.getAttribute('id'), 'top');
    assert.match(occurrence.screenshot.path, /element-[0-9a-f]{8}\.png$/);
    assert.strictEqual(path.dirname(occurrence.screenshot.path), dir);
    assert.ok(decodePng(fs.readFileSync(occurrence.screenshot.path)));
    assert.ok(formatFailures(results).includes(`   screenshot: ${occurrence.screenshot.path}`));
    const files = fs.readdirSync(dir).sort();

    // The same elements get the same files on the next run.
    const again = await run();
    assert.strictEqual(again.checksResults[0].occurrences.find((o) => o.selector === '#top').screenshot.path, occurrence.screenshot.path);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), files);
  } finally {
    await driver.quit();
    pages.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshots(): max caps the pictures a scan takes, frames included', async () => {
  const pages = await servePages();
  const driver = await buildDriver();
  try {
    await driver.get(pages.url);
    await settle();
    const results = await new A11yCoreBuilder({ driver }).withRules('img-alt-present').screenshots({ max: 2 }).frames(true).analyze();
    const shots = [results.topFrame, ...results.frames]
      .flatMap((r) => r.checksResults[0].occurrences)
      .map((o) => o.screenshot);
    assert.strictEqual(shots.filter((s) => s.buffer).length, 2);
    assert.ok(shots.some((s) => s.skipped === 'max-reached'));
  } finally {
    await driver.quit();
    pages.close();
  }
});

test('screenshots(): a scan of a frame the driver was switched into says why it took no picture', async () => {
  const pages = await servePages();
  const driver = await buildDriver();
  try {
    await driver.get(pages.url);
    await settle();
    await driver.switchTo().frame(driver.findElement({ css: '#first' }));
    const results = await new A11yCoreBuilder({ driver }).withRules('img-alt-present').screenshots().analyze();
    const shot = results.checksResults[0].occurrences[0].screenshot;
    assert.strictEqual(shot.skipped, 'capture-failed');
    assert.match(shot.error, /frames\(true\)/);
  } finally {
    await driver.quit();
    pages.close();
  }
});

test('screenshots(): off unless asked; with selectors turned off, analyze() rejects before scanning', async () => {
  const driver = await buildDriver();
  try {
    await driver.get(`data:text/html,<html><body><img src="${GIF}"></body></html>`);
    const plain = await new A11yCoreBuilder({ driver }).withRules('img-alt-present').analyze();
    assert.ok(!('screenshot' in plain.checksResults[0].occurrences[0]));

    await assert.rejects(
      new A11yCoreBuilder({ driver }).options({ output: { includeSelector: false } }).screenshots().analyze(),
      (e) => e instanceof TypeError && e.code === 'INVALID_ENGINE_OPTIONS'
    );
    assert.throws(() => new A11yCoreBuilder({ driver }).screenshots({ padding: -1 }), (e) => e.code === 'INVALID_ENGINE_OPTIONS');
  } finally {
    await driver.quit();
  }
});
