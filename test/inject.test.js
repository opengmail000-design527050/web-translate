/* 补注入：插件更新 / 重新加载之后，弹窗和快捷键会往已经开着的页面里再注入一份
 * content.js。页面上可能还留着旧的那份 —— 跟后台断了线，却还贴着译文、挂着观察者。
 *
 * 断言三件事：
 *   - 旧的还活着（同一个隔离环境里重复注入）：新的什么都不做，不能出现两份在抢页面
 *   - 旧的断了线（插件重载后它在另一个隔离环境里）：新的一来，旧的把自己贴的东西全收掉
 *   - 弹窗问进度时，分母是「已经轮到的段落」而不是整页
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const { El, h } = require('./dom.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};

/* paintToast 往 innerHTML 里写了两个 span 再 querySelector —— mini DOM 不解析 HTML，给个替身 */
El.prototype.querySelector = function () { return (this._msg = this._msg || { textContent: '' }); };

const SRC = fs.readFileSync(path.join(__dirname, '../content/content.js'), 'utf8');

/* 一个页面 = 一份 document，DOM 事件在各个隔离环境之间是共享的。 */
function makePage() {
  const on = {};
  const body = h('body', [h('p', { id: 'p1' }, 'The first paragraph is long enough to be translated by the extension.')]);
  const doc = {
    title: 'Page', readyState: 'complete', visibilityState: 'visible', contentType: 'text/html',
    body, documentElement: h('html'),
    createElement: (t) => new El(t),
    getElementById: (id) => {
      const walk = (el) => { for (const c of el.children) { if (c.id === id) return c; const r = walk(c); if (r) return r; } return null; };
      return walk(body);
    },
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelectorAll(sel)[0] || null,
    addEventListener: (t, f) => { (on[t] = on[t] || []).push(f); },
    dispatchEvent: (e) => { for (const f of (on[e.type] || []).slice()) f(e); return true; }
  };
  return { doc, on };
}

/* 一个隔离环境 = 一个 vm 上下文 + 一份自己的 chrome。shareWith 传进来就是「同一个环境里再注入一次」。 */
function inject(page, shareWith) {
  if (shareWith) {
    vm.runInContext(SRC, shareWith.ctx);
    return shareWith;
  }
  const noop = () => {};
  const T = {};
  const listeners = [];
  const chrome = {
    i18n: { getUILanguage: () => 'zh-CN' },
    storage: {
      // lazy: false —— 桩里的 IntersectionObserver 不会触发，整页一次性翻才看得到译文节点
      local: { get: async () => ({ settings: { apiKey: 'sk', targetLang: '简体中文', lazy: false } }), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: noop }
    },
    runtime: {
      id: 'ext-id',
      sendMessage: async (msg) => msg.type === 'translateBatch'
        ? { ok: true, map: Object.fromEntries(msg.payload.items.map((it) => [it.id, '译文'])) }
        : { ok: true },
      onMessage: { addListener: (f) => listeners.push(f) }
    }
  };
  let observers = 0;
  const win = {
    __BT_TEST__: T,
    location: { href: 'https://example.com/a', origin: 'https://example.com', pathname: '/a', search: '', hostname: 'example.com' },
    document: page.doc, chrome, console, setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: noop,
    CustomEvent: class { constructor(type) { this.type = type; } },
    getComputedStyle: (el) => ({ display: (el && el.display) || 'block', fontSize: '16px', color: 'rgb(20, 20, 20)' }),
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() { observers++; } disconnect() { observers--; } }
  };
  win.window = win;
  const ctx = vm.createContext(win);
  Object.assign(ctx, { location: win.location, document: page.doc, chrome, CustomEvent: win.CustomEvent,
    getComputedStyle: win.getComputedStyle, IntersectionObserver: win.IntersectionObserver,
    MutationObserver: win.MutationObserver });
  vm.runInContext(SRC, ctx);
  return { ctx, T, chrome, listeners, observers: () => observers };
}

/* 跟 chrome.runtime.onMessage 一样：监听函数返回 true 表示稍后才 sendResponse。 */
function ask(world, msg) {
  return new Promise((resolve) => {
    let pending = false;
    for (const f of world.listeners) if (f(msg, {}, resolve) === true) pending = true;
    if (!pending) setTimeout(() => resolve(undefined), 0);
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log('[1] 同一个环境里重复注入');
  {
    const page = makePage();
    const a = inject(page);
    await tick();
    inject(page, a);
    await tick();
    ok('还活着的旧实例在，新注入的一份直接退出（只注册了一个消息监听）', a.listeners.length === 1, String(a.listeners.length));
    ok('ping 有回应', (await ask(a, { type: 'ping' })).ok === true);
  }

  console.log('\n[2] 插件重载后：旧实例断线，新实例在另一个环境里接手');
  {
    const page = makePage();
    const old = inject(page);
    await tick();
    await ask(old, { type: 'setActive', value: true });
    await tick();
    const p1 = page.doc.getElementById('p1');
    const hadNode = p1.children.some((c) => c.dataset && c.dataset.bt);
    ok('旧实例翻译时贴上了译文节点', hadNode);
    ok('旧实例开着 MutationObserver', old.observers() === 1, String(old.observers()));

    old.chrome.runtime.id = undefined;           // 插件重载：旧的这份跟后台断了线
    const fresh = inject(page);
    await tick();
    ok('旧实例收到接手广播后停了下来', old.T.St.active === false);
    ok('旧实例撤掉了自己贴的译文节点', !p1.children.some((c) => c.dataset && c.dataset.bt));
    ok('旧实例断开了 MutationObserver', old.observers() === 0, String(old.observers()));
    ok('新实例能应答', (await ask(fresh, { type: 'ping' })).ok === true);
  }

  console.log('\n[3] 别的环境里还活着的实例，不会被接手广播误伤');
  {
    const page = makePage();
    const a = inject(page);
    await tick();
    await ask(a, { type: 'setActive', value: true });
    await tick();
    inject(page);
    await tick();
    ok('活着的那份照常工作', a.T.St.active === true);
  }

  console.log('\n[4] 进度的分母是已经轮到的段落');
  {
    const page = makePage();
    const a = inject(page);
    await tick();
    a.T.St.active = true;
    const mk = (status) => ({ status, el: h('p'), text: 'x', hash: Math.random().toString(36) });
    a.T.St.units = [mk('done'), mk('done'), mk('pending'), mk('new'), mk('new'), mk('new')];
    a.T.St.done = 2;
    const r = await ask(a, { type: 'getStatus' });
    ok('seen 只数离开 new 状态的段落', r.seen === 3, JSON.stringify({ seen: r.seen, total: r.total }));
    ok('total 仍然是整页段数', r.total === 6, String(r.total));
    ok('普通网页不算 PDF', r.pdf === false, String(r.pdf));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
