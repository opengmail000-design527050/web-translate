/* 真 Chrome：插件重新加载之后，已经开着的页面还能接着用。
 *
 * 重载后旧的内容脚本还留在页面里，却跟后台断了线；弹窗 / 快捷键会补注入一份新的
 * （common.js 的 ensureContent）。这里断言新的一份真的能接手：页面能应答，
 * 旧实例贴的译文被收走，每段最后只剩新实例贴的一份 —— 不会出现两份译文叠在一起。
 *
 * 补注入在真实使用中靠弹窗 / 快捷键带来的 activeTab 授权；测试里没有用户手势，
 * 所以把扩展复制一份，给假网页的域名加上 host 权限再加载。全程假网页、假 API。 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const src = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-reinject-'));
  for (const f of ['manifest.json', 'background.js', 'common.js']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  for (const d of ['content', 'popup', 'options', 'icons']) fs.cpSync(path.join(src, d), path.join(dir, d), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions = (m.host_permissions || []).concat(['https://fixture.example/*']);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

async function worker(ctx) {
  for (let i = 0; i < 60; i++) {
    const sw = ctx.serviceWorkers()[0];
    if (sw) return sw;
    await sleep(250);
  }
  return null;
}

let browser = null;      // 实际是 persistent context，收尾时关它
(async () => {
  const dir = copyExtension();
  /* 先照常用命令行装上；之后对同一个目录调一次 CDP 的 Extensions.loadUnpacked，
     就是「重新加载」—— 跟在 chrome://extensions 里点刷新是同一回事。
     chrome.runtime.reload() 在测试版 Chromium 里会把扩展直接卸掉，模拟不了。 */
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--no-first-run',
           '--enable-unsafe-extension-debugging']
  });
  browser = ctx;
  const cdp = await ctx.browser().newBrowserCDPSession();

  await ctx.route('https://fixture.example/**', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8"><title>Fixture article</title>
      <main><article>
        <h1>Reliable translation systems</h1>
        <p>The first paragraph explains how a robust browser extension keeps asynchronous work attached to the page that created it.</p>
        <p>The second paragraph is deliberately long enough to make the content detector treat it as readable article text instead of a tiny interface label.</p>
        <p>The third paragraph discusses caching, rate limits, and dynamic pages in enough detail to keep this fixture above the short-page threshold.</p>
      </article></main>`
  }));
  await ctx.route('https://api.openai.com/**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const user = String(body.messages && body.messages[1] && body.messages[1].content || '');
    const content = user.split('\n').filter((x) => /^\d+\|/.test(x))
      .map((line) => line.slice(0, line.indexOf('|')) + '|译:' + line.slice(line.indexOf('|') + 1, line.indexOf('|') + 20)).join('\n');
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) });
  });

  const first = await worker(ctx);
  ok('service worker 能启动', !!first);
  if (!first) throw new Error('扩展没有加载');
  await first.evaluate(() => chrome.storage.local.set({ settings: {
    enabled: true, autoSites: ['fixture.example'], apiKey: 'sk-e2e',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna', targetLang: '简体中文',
    reasoning: 'none', reasoningStyle: 'effort_none', scope: 'main', layout: 'both',
    lazy: false, useCache: false
  } }));

  const page = await ctx.newPage();
  await page.goto('https://fixture.example/article');
  const count = () => page.evaluate(() => [...document.querySelectorAll('article p')]
    .map((p) => p.querySelectorAll('font.bt-tr[data-bt]').length));
  const translated = await page.waitForFunction(() => document.querySelectorAll('article p font.bt-tr[data-bt]').length === 3,
    null, { timeout: 15000 }).then(() => true).catch(() => false);
  ok('重载前：自动翻译的网站正常翻好', translated, JSON.stringify(await count()));

  // 插件重新加载：旧的内容脚本还在页面里，但已经跟后台断了线
  const reloaded = ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  await cdp.send('Extensions.loadUnpacked', { path: dir });
  const sw = await reloaded;
  ok('重载后起了新的 service worker', !!sw && sw !== first);

  const probe = () => sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://fixture.example/*' });
    try { const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' }); return !!(r && r.ok); }
    catch (_) { return false; }
  });
  ok('重载后旧脚本不再应答（这正是以前要用户刷新的原因）', (await probe()) === false);

  // 跟 ensureContent 同样的两步：补 CSS、补脚本
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://fixture.example/*' });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/style.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
  });
  ok('补注入后页面能应答', (await probe()) === true);

  const settled = await page.waitForFunction(() => {
    const ps = [...document.querySelectorAll('article p')];
    return ps.every((p) => p.querySelectorAll('font.bt-tr[data-bt]').length === 1);
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  ok('新实例接手：每段只剩一份译文，没有两份叠在一起', settled, JSON.stringify(await count()));

  const toasts = await page.evaluate(() => document.querySelectorAll('#bt-toast').length);
  ok('角落提示只有一个', toasts <= 1, String(toasts));

  /* 旧实例真正会捣乱的是之后：页面又长出新内容（无限滚动）时，断线的它照样会去翻，
     发不出请求就把那一段标成失败，还往共用的角落提示里写「出错了」。 */
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'more';
    p.textContent = 'A paragraph appended after the reload, the way infinite scrolling keeps adding new content to a page.';
    document.querySelector('article').appendChild(p);
  });
  const more = await page.waitForFunction(() => {
    const n = document.querySelectorAll('#more font.bt-tr[data-bt]');
    return n.length === 1 && n[0].textContent.startsWith('译:');
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  await sleep(1500);                // 给旧实例足够的时间出来捣乱
  const after = await page.evaluate(() => ({
    failed: document.querySelectorAll('.bt-failed').length,
    toast: (document.querySelector('#bt-toast .bt-msg') || {}).textContent || ''
  }));
  ok('重载后新长出来的段落正常翻好', more);
  ok('断线的旧实例没有把段落标成失败', after.failed === 0, JSON.stringify(after));
  ok('角落提示里没有旧实例写的错误', !after.toast.includes('出错'), after.toast);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e && e.stack || e);
  if (browser) await browser.close().catch(() => {});
  process.exit(1);
});
