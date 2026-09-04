/* 真 Chrome 冒烟：扩展能加载、能翻、DOM 原地换文案后能重翻、429 后能自己恢复。
 * 运行前安装开发依赖：npm install；然后 npm run e2e。全程使用假网页和假 API。 */
const { chromium } = require('playwright');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browserContext = null;

(async () => {
  const ctx = browserContext = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run']
  });
  const api = { calls: 0, rateLeft: 0 };

  await ctx.route('https://fixture.example/**', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8"><title>Fixture article</title>
      <main><article>
        <h1>Reliable translation systems</h1>
        <p id="p1">The first paragraph explains how a robust browser extension keeps asynchronous work attached to the page that created it.</p>
        <p>The second paragraph is deliberately long enough to make the content detector treat it as readable article text instead of a tiny interface label.</p>
        <p>The third paragraph discusses caching, rate limits, and dynamic pages in enough detail to keep this fixture above the short-page threshold.</p>
      </article></main>`
  }));

  await ctx.route('https://api.openai.com/**', async (route) => {
    api.calls++;
    if (api.rateLeft > 0) {
      api.rateLeft--;
      await route.fulfill({ status: 429, headers: { 'Retry-After': '0.1' },
        contentType: 'application/json', body: JSON.stringify({ error: { message: 'slow down' } }) });
      return;
    }
    const body = JSON.parse(route.request().postData() || '{}');
    const user = String(body.messages && body.messages[1] && body.messages[1].content || '');
    const content = user.split('\n').filter((x) => /^\d+\|/.test(x)).map((line) => {
      const n = line.slice(0, line.indexOf('|'));
      return `${n}|译:${line.slice(line.indexOf('|') + 1, line.indexOf('|') + 30)}`;
    }).join('\n');
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) });
  });

  const wake = await ctx.newPage();
  await wake.goto('https://fixture.example/wake');
  let id = '';
  for (let i = 0; i < 40 && !id; i++) {
    const sw = ctx.serviceWorkers()[0];
    if (sw) id = new URL(sw.url()).host;
    else await sleep(250);
  }
  ok('扩展 service worker 能启动', !!id);
  if (!id) throw new Error('扩展没有加载');

  const optionsUrl = `chrome-extension://${id}/options/options.html`;
  let opts = ctx.pages().find((p) => p.url().startsWith(optionsUrl));
  if (!opts) {
    opts = await ctx.newPage();
    await opts.goto(optionsUrl);
  } else {
    await opts.waitForLoadState('domcontentloaded').catch(() => {});
  }
  await opts.evaluate(() => chrome.storage.local.set({ settings: {
    enabled: true, autoSites: ['fixture.example'], apiKey: 'sk-e2e',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna', targetLang: '简体中文',
    reasoning: 'none', reasoningStyle: 'effort_none', scope: 'main', layout: 'both',
    lazy: false, useCache: false, batchChars: 1600, batchUnits: 12, concurrency: 3
  } }));
  await wake.close();

  const page = await ctx.newPage();
  await page.goto('https://fixture.example/article');
  const translated = await page.waitForFunction(() => {
    const n = document.querySelector('#p1 font.bt-tr[data-bt]');
    return n && n.textContent.startsWith('译:');
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  ok('真实内容脚本能切段、请求后台并插入译文', translated);

  await page.evaluate(() => {
    document.querySelector('#p1').textContent =
      'A reused DOM node now carries completely new source text and must receive a new translation.';
  });
  const updated = await page.waitForFunction(() => {
    const n = document.querySelector('#p1 font.bt-tr[data-bt]');
    return n && n.textContent.includes('A reused DOM node');
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  ok('同一个 DOM 节点换原文后旧译文会撤掉并重翻', updated);

  api.rateLeft = 2;
  const before = api.calls;
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'rate';
    p.textContent = 'This newly appended paragraph intentionally encounters a temporary API rate limit before succeeding.';
    document.querySelector('article').appendChild(p);
  });
  const recovered = await page.waitForFunction(() => {
    const n = document.querySelector('#rate font.bt-tr[data-bt]');
    return n && n.textContent.startsWith('译:');
  }, null, { timeout: 20000 }).then(() => true).catch(() => false);
  ok('连续两次 429 后无需点按钮也会自动恢复', recovered && api.calls >= before + 3,
     `新增请求 ${api.calls - before} 次`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e && e.stack || e);
  if (browserContext) await browserContext.close().catch(() => {});
  process.exit(1);
});
