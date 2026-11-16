// Headless test (selectors only: the page's CSP blocks Playwright's string evaluation): converts a clip on the page in Chromium, saves the downloads and takes a screenshot per theme.
//   node e2e.mjs <page url> <input video> <out dir> <noisy video for the 10 MB warning> [more videos to convert with the defaults]
// ONLY_VARIANTS=1 converts only the extra videos.
import { chromium, firefox } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const [url, input, out, noisy, ...variants] = process.argv.slice(2);
const origin = new URL(url).origin;
const report = { external: [], errors: [], runs: [] };
const logs = [];

async function open(browser, colorScheme, query = '') {
  const ctx = await browser.newContext({ colorScheme, viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) report.external.push(r.url()); });
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(m.text()); else if (process.env.LOGDIR) logs.push(m.text()); });
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await page.goto(url + query);
  return { ctx, page };
}

async function choose(page, f = input) {
  await page.setInputFiles('#file', f);
  await page.waitForSelector('#convert:not([disabled]), #status.error', { state: 'attached', timeout: 120000 });
  return page.textContent('#source');
}

// Waits for the preview of the current settings; returns its time and size estimate
async function previewDone(page) {
  await page.waitForSelector('#preview[data-state="done"], #preview[data-state="invalid"], #preview[data-state="error"], #preview[data-state="none"]',
    { state: 'attached', timeout: 1200000 });
  const est = await page.getAttribute('#estimate', 'data-bytes');
  return { estimate: est ? Number(est) : null, previewSeconds: Number(await page.getAttribute('#preview', 'data-seconds')) || null,
    stills: await page.locator('#stills img').count(), previewText: await page.textContent('#estimate'),
    stillSizes: await Promise.all((await page.locator('#stills img').all()).map((i) => i.getAttribute('data-size'))) };
}

async function convert(page, name, opts) {
  for (const [id, v] of Object.entries(opts)) {
    if (id === 'mode') await page.selectOption('#mode', v); else await page.fill('#' + id, String(v));
  }
  const pv = await previewDone(page);
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
  const size = fs.statSync(file).size;
  // The preview's estimate must be within 25% of the real size
  const ratio = pv.estimate ? pv.estimate / size : null;
  const estimateOk = ratio != null && Math.abs(ratio - 1) <= 0.25;
  if (!estimateOk) report.failed = true;
  report.runs.push({ name, opts, seconds: (Date.now() - t0) / 1000, file, size, ...pv, ratio: ratio && Number(ratio.toFixed(3)), estimateOk,
    info: await page.textContent('#info'), warning: await page.isVisible('#size-warning'), progress: samples.filter((s, i, a) => s && s !== a[i - 1]).slice(0, 12) });
}

const browser = await (process.env.BROWSER === 'firefox' ? firefox : chromium).launch({ headless: !process.env.HEADED });
report.browser = (process.env.BROWSER || 'chromium') + (process.env.HEADED ? ' headed' : ' headless') + ' ' + browser.version();
try {
  // Extra inputs (WebM kinds): defaults, each must convert
  if (variants.length) {
    const v = await open(browser, 'light');
    for (const f of variants) {
      logs.length = 0;
      // Names say what should happen: *av1* gets the AV1 message, *broken* fails, the rest convert
      const name = 'variant ' + path.basename(f);
      try {
        const source = await choose(v.page, f);
        if (/av1/.test(f) || /broken/.test(f)) {
          if (await v.page.isEnabled('#convert')) await v.page.click('#convert');
          if (await v.page.isVisible('#cancel')) await v.page.waitForSelector('#status.error', { state: 'attached', timeout: 600000 });
          const st = await v.page.textContent('#status');
          const ok = /av1/.test(f) ? /AV1/.test(st) : /failed|Could not/.test(st);
          report.runs.push({ name, source, expected: ok ? 'yes' : 'NO', status: st });
          if (!ok) report.failed = true;
          continue;
        }
        // First preview, then two setting changes (each an update on the decoded samples)
        const first = await previewDone(v.page);
        const t1 = Date.now();
        await v.page.fill('#width', '640');
        const narrow = await previewDone(v.page);
        const updateSeconds = (Date.now() - t1) / 1000;
        await v.page.fill('#width', '960');
        report.runs.push({ name, source, firstPreviewSeconds: first.previewSeconds, firstPreview: first.previewText,
          updateSeconds, update640: narrow.previewText, update640Stills: narrow.stillSizes });
        await convert(v.page, name, {});
        if (process.env.LOGDIR) fs.writeFileSync(path.join(process.env.LOGDIR, path.basename(f) + '.log'), logs.join('\n'));
      } catch (e) {
        report.runs.push({ name: 'variant ' + path.basename(f), failed: String(e.message || e).slice(0, 400) });
        if (process.env.LOGDIR) (await import('node:fs')).writeFileSync(path.join(process.env.LOGDIR, path.basename(f) + '.log'), logs.join('\n'));
        report.failed = true;
      }
    }
    await v.ctx.close();
    // A real failed run (AV1, let through by ?debug=av1), then a normal video in the same tab
    const av1 = variants.find((f) => /av1/.test(f)), ok = variants.find((f) => /sample-5s/.test(f));
    if (av1 && ok) {
      const r = await open(browser, 'light', '?debug=av1');
      await choose(r.page, av1);
      await r.page.click('#convert');
      await r.page.waitForSelector('#status.error', { state: 'attached', timeout: 600000 });
      report.runs.push({ name: 'recover: AV1 run fails', status: await r.page.textContent('#status') });
      try {
        await choose(r.page, ok);
        await convert(r.page, 'recover: then ' + path.basename(ok), {});
      } catch (e) {
        report.runs.push({ name: 'recover: then ' + path.basename(ok), failed: String(e.message || e).slice(0, 400) });
        report.failed = true;
      }
      await r.ctx.close();
    }
  }
  if (!process.env.ONLY_VARIANTS) {
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
  }
} finally {
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
if (report.failed || report.errors.length || report.external.length) process.exit(1);
