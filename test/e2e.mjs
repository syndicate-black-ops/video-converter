// Headless test (selectors only: the page's CSP blocks Playwright's string evaluation): converts a clip on the page in Chromium, saves the downloads and takes a screenshot per theme.
//   node e2e.mjs <page url> <input video> <out dir> <noisy video for the 10 MB warning>
import { chromium } from 'playwright';
import path from 'node:path';

const [url, input, out, noisy] = process.argv.slice(2);
const origin = new URL(url).origin;
const report = { external: [], errors: [], runs: [] };

async function open(browser, colorScheme) {
  const ctx = await browser.newContext({ colorScheme, viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) report.external.push(r.url()); });
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(m.text()); });
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await page.goto(url);
  return { ctx, page };
}

async function choose(page, f = input) {
  await page.setInputFiles('#file', f);
  await page.waitForSelector('#convert:not([disabled]), #status.error', { state: 'attached', timeout: 120000 });
  return page.textContent('#source');
}

async function convert(page, name, opts) {
  for (const [id, v] of Object.entries(opts)) {
    if (id === 'mode') await page.selectOption('#mode', v); else await page.fill('#' + id, String(v));
  }
  const t0 = Date.now();
  const samples = [];
  await page.click('#convert');
  const poll = setInterval(async () => { try { samples.push(await page.textContent('#progress-text')); } catch (e) { /* closed */ } }, 1000);
  await page.waitForSelector('#result:not([hidden]), #status.error', { state: 'attached', timeout: 600000 });
  clearInterval(poll);
  const status = await page.textContent('#status');
  if (await page.isHidden('#result')) throw new Error(name + ': ' + status);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
  const file = path.join(out, name.replace(/\W+/g, '_') + '--' + dl.suggestedFilename());
  await dl.saveAs(file);
  report.runs.push({ name, opts, seconds: (Date.now() - t0) / 1000, file, info: await page.textContent('#info'), warning: await page.isVisible('#size-warning'), progress: samples.filter((s, i, a) => s && s !== a[i - 1]).slice(0, 12) });
}

const browser = await chromium.launch();
try {
  // Light: default video conversion, validation messages, cancel, a second video with width and fps set
  const light = await open(browser, 'light');
  report.source = await choose(light.page);
  for (const [w, f] of [[4000, ''], [961, ''], [960, 500]]) {
    await light.page.fill('#width', String(w));
    await light.page.fill('#fps', String(f));
    await light.page.click('#convert');
    report.runs.push({ name: 'validate width ' + w + ' fps ' + f, status: await light.page.textContent('#status') });
  }
  await light.page.fill('#width', '960');
  await light.page.fill('#fps', '');
  await light.page.click('#convert');
  await light.page.waitForTimeout(3000);
  await light.page.click('#cancel');
  report.runs.push({ name: 'cancel', status: await light.page.textContent('#status'), convertVisible: await light.page.isVisible('#convert') });
  await convert(light.page, 'video defaults', {});
  await convert(light.page, 'video 640 wide 12 fps 600k q5', { width: 640, fps: 12, bitrate: 600, quality: 5 });
  await choose(light.page, noisy);
  await convert(light.page, 'noisy video 9000k over 10 MB', { width: 960, fps: '', bitrate: 9000, quality: 3 });
  await light.page.screenshot({ path: path.join(out, 'page-light.png'), fullPage: true });
  await light.page.setViewportSize({ width: 400, height: 900 });
  await light.page.screenshot({ path: path.join(out, 'page-narrow.png'), fullPage: true });
  await light.ctx.close();

  // Dark: sound only
  const dark = await open(browser, 'dark');
  await choose(dark.page);
  await convert(dark.page, 'sound only', { mode: 'audio' });
  await dark.page.screenshot({ path: path.join(out, 'page-dark.png'), fullPage: true });
  await dark.ctx.close();
} finally {
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
