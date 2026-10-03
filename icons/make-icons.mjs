/* 生成图标 PNG：node icons/make-icons.mjs（需要先 npm install）
 *
 * 图形是一本打开的书：左页灰（原文）、右页 rose（译文），左右对照；纸上的行是镂空的，
 * 透出工具栏的底色。没有底板，直接落在工具栏上。
 * 配色取自 Rosé Pine（降了饱和度），一共只有这两色，纯色扁平，不用渐变和投影。
 * 跟 yt-sub-translate 的淡紫气泡是一家，并排放在工具栏里一眼分得开。
 *
 * 源文件是两份 SVG：
 *   icon.svg     32 / 48 / 128 共用，也直接给弹窗和设置页的抬头用（矢量，Retina 不糊）。
 *                坐标都取偶数，缩到 32px 时横线正好落在整像素上。
 *   icon-16.svg  工具栏那一格。16px 下按比例缩小的线条会落在半个像素上，糊成一片，
 *                所以单独按像素网格画了一份；书页的弧度用整像素的台阶表示。
 * 用浏览器来栅格化：e2e 本来就靠 Playwright。先试它自带的 Chromium，
 * 没装（npx playwright install chromium）就退到本机的 Chrome。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const svg = (f) => 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64');

async function launch() {
  try { return await chromium.launch({ headless: true }); }
  catch (_) { return chromium.launch({ channel: 'chrome', headless: true }); }
}

const browser = await launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  const src = svg(size === 16 ? 'icon-16.svg' : 'icon.svg');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block}</style>` +
                        `<img src="${src}" width="${size}" height="${size}">`);
  await page.waitForFunction(() => document.images[0].complete);
  const out = path.join(dir, `icon${size}.png`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', path.relative(process.cwd(), out));
}
await browser.close();
