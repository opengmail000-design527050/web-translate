/* 生命周期竞态：旧页面 / 旧配置的请求晚回来时，绝不能碰新一版的页面状态和缓存。 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const { El, h } = require('./dom.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function load() {
  const T = {}, R = {}, replies = [];
  const noop = () => {};
  const doc = {
    title: 'Old page', readyState: 'complete', visibilityState: 'visible',
    body: h('body'), documentElement: h('html'),
    createElement: (t) => new El(t), getElementById: () => null,
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
    querySelector: (sel) => doc.body.querySelectorAll(sel)[0] || null,
    addEventListener: noop
  };
  const settings = {
    enabled: true, autoSites: [], apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1',
    model: 'model-a', targetLang: '简体中文', reasoningStyle: 'effort_none',
    extraPrompt: '', useTitle: true
  };
  const chrome = {
    i18n: { getUILanguage: () => 'zh-CN' },
    storage: {
      local: {
        get: async (k) => ({ [k]: k === 'settings' ? settings : undefined }),
        set: async () => {}, remove: async () => {}
      },
      onChanged: { addListener: noop }
    },
    runtime: {
      onMessage: { addListener: noop },
      sendMessage: (msg) => {
        if (msg.type !== 'translateBatch') return Promise.resolve({ ok: true });
        const d = deferred(); replies.push({ msg, ...d }); return d.promise;
      }
    }
  };
  const win = {
    __BT_TEST__: T, __BT_RACE_TEST__: R, location: {
      href: 'https://example.com/old', origin: 'https://example.com', pathname: '/old',
      search: '', hostname: 'example.com'
    },
    document: doc, chrome, console, setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: noop,
    getComputedStyle: (el) => ({ display: (el && el.display) || 'block', fontSize: '16px', color: 'rgb(20, 20, 20)' }),
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} }
  };
  win.window = win;
  const ctx = vm.createContext(win);
  Object.assign(ctx, { location: win.location, document: doc, chrome,
    getComputedStyle: win.getComputedStyle, IntersectionObserver: win.IntersectionObserver,
    MutationObserver: win.MutationObserver });
  let src = fs.readFileSync(path.join(__dirname, '../content/content.js'), 'utf8');
  src = src.replace('  boot();\n})();',
    '  Object.assign(window.__BT_RACE_TEST__, { sendBatch, pageCacheKey, reconcileUnits: typeof reconcileUnits === "function" ? reconcileUnits : null });\n  boot();\n})();');
  vm.runInContext(src, ctx);
  return { T, R, replies, doc };
}

(async () => {
  const { T, R, replies, doc } = load();
  await new Promise((r) => setTimeout(r, 0));

  T.St.active = true;
  T.St.epoch = 1;
  T.St.cacheKey = 'c_new';
  T.St.cacheMap = {};
  T.St.text.clear();
  T.St.byHash.set('old-hash', []);

  const oldOk = R.sendBatch([{ id: 'old-hash', text: 'Old text' }], 1);
  T.St.epoch = 2; // 模拟切页 / 换配置
  replies.shift().resolve({ ok: true, map: { 'old-hash': '旧译文' } });
  await oldOk;
  ok('旧请求的成功结果不写进新一版内存', !T.St.text.has('old-hash'));
  ok('旧请求的成功结果不写进新一版缓存', !T.St.cacheMap['old-hash']);

  T.St.error = '';
  const oldFail = R.sendBatch([{ id: 'failed-hash', text: 'Old failed text' }], 2);
  T.St.epoch = 3;
  replies.shift().resolve({ ok: false, error: '旧页面的 401' });
  await oldFail;
  ok('旧请求的错误不覆盖新页面状态', T.St.error === '', T.St.error);

  T.St.S.model = 'same-name';
  T.St.S.baseUrl = 'https://one.example/v1';
  T.St.S.extraPrompt = '';
  const k1 = R.pageCacheKey();
  T.St.S.extraPrompt = 'Use formal terminology.';
  const k2 = R.pageCacheKey();
  ok('会改变译文的自定义提示词参与缓存归属', k1 !== k2, `${k1} === ${k2}`);

  T.St.active = true;
  T.St.epoch = 4;
  T.St.retrying = 0;
  T.St.byHash.set('rate-hash', []);
  const limited = R.sendBatch([{ id: 'rate-hash', text: 'Rate limited text', tries: 0 }], 4);
  replies.shift().resolve({ ok: false, error: 'HTTP 429', retryAfter: 5000 });
  await limited;
  ok('429 的段落保留等待状态并自动排队，不立刻标成永久失败',
     T.St.retrying === 1 && T.St.byHash.has('rate-hash'),
     JSON.stringify({ retrying: T.St.retrying, waiting: T.St.byHash.has('rate-hash') }));
  T.St.epoch++;
  T.St.retrying = 0;

  doc.body.appendChild(h('p', 'The original paragraph is long enough to translate.'));
  T.St.uiFilter = false;
  T.St.units = [];
  T.St.owned = new WeakMap();
  T.St.watch = new WeakMap();
  T.addUnits(T.collect(doc.body));
  const p = doc.body.firstElementChild;
  p.textContent = 'The reused paragraph node now contains entirely different text.';
  const supported = typeof R.reconcileUnits === 'function';
  if (supported) {
    R.reconcileUnits();
    T.addUnits(T.collect(doc.body));
  }
  ok('站点复用 DOM 节点改文案后会丢掉旧单元并重新登记',
     supported && T.St.units.length === 1 && T.St.units[0].text.includes('entirely different'),
     supported ? JSON.stringify(T.St.units.map((u) => u.text)) : '缺少 reconcileUnits');

  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
