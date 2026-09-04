/* 覆盖弹窗里的「点模型名切换配置档」：菜单画得对不对、切换有没有把那一档
 * 灌回 settings、有没有捎带改掉全局设置、页面有没有被通知重来。
 *
 * 和 profiles.test.js 同一套路子：把 common.js 和 popup.js 去掉 import/export
 * 之后拼进同一个沙箱跑。 */
const fs = require('fs'), vm = require('vm');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  :: ' + extra : '')); }
};

/* ---- 一个够用的 DOM 桩：按 id 自动造元素 ---- */
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', title: '', type: 'text',
    disabled: false, checked: false, className: '',
    dataset: {}, attrs: {}, _kids: [], _on: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _s: new Set(),
      add(...a) { a.forEach((x) => this._s.add(x)); },
      remove(...a) { a.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); }
    },
    appendChild(c) { this._kids.push(c); return c; },
    append(...c) { this._kids.push(...c); },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); },
    removeEventListener() {},
    querySelector() { return makeEl('_'); },
    querySelectorAll() { return []; },
    closest() { return el; },        // 菜单里点到的就是按钮本身
    focus() {}, select() {}
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set(v) { if (!v) this._kids.length = 0; }
  });
  return el;
}

const els = {};
const $ = (id) => (els[id] = els[id] || makeEl(id));

const docOn = {};
const doc = {
  getElementById: $,
  createElement: () => makeEl('_new'),
  querySelector: () => null,
  addEventListener(t, f) { (docOn[t] = docOn[t] || []).push(f); }
};

const storage = {};
const sent = [];              // 发给页面的消息
let optionsOpened = 0;

const chrome = {
  storage: {
    local: {
      async get(k) {
        if (k === null) return JSON.parse(JSON.stringify(storage));
        if (Array.isArray(k)) { const o = {}; k.forEach((x) => { if (x in storage) o[x] = JSON.parse(JSON.stringify(storage[x])); }); return o; }
        return (k in storage) ? { [k]: JSON.parse(JSON.stringify(storage[k])) } : {};
      },
      async set(o) { Object.assign(storage, JSON.parse(JSON.stringify(o))); },
      async remove(ks) { (Array.isArray(ks) ? ks : [ks]).forEach((k) => delete storage[k]); }
    },
    onChanged: { addListener() {} }
  },
  tabs: {
    async query() { return [{ id: 7, url: 'https://example.com/article' }]; },
    async sendMessage(tabId, msg) { sent.push(msg); return null; }
  },
  runtime: { openOptionsPage() { optionsOpened++; }, sendMessage: async () => ({ ok: false }) },
  i18n: { getUILanguage: () => 'zh-CN' }
};

/* 弹窗每秒刷一次状态，测试里不需要它真的跑起来 */
const timeout = (f, ms) => { const t = setTimeout(f, ms); if (t.unref) t.unref(); return t; };

const sandbox = { console, document: doc, chrome, setTimeout: timeout, clearTimeout,
                  setInterval: () => 0, clearInterval: () => {}, URL, Math, Date, JSON };
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);

const common = fs.readFileSync(__dirname + '/../common.js', 'utf8').replace(/^export /gm, '');
const popup = fs.readFileSync(__dirname + '/../popup/popup.js', 'utf8')
  .replace(/^import[\s\S]*?from '\.\.\/common\.js';/m, '')
  .replace(/^init\(\);$/m, '');       // 何时初始化由测试自己决定

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 先把老用户的设置摆好，再让弹窗初始化
storage.settings = {
  baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-old',
  model: 'deepseek-chat', targetLang: '简体中文', reasoningStyle: 'enable_thinking',
  scope: 'page', reasoning: 'low'
};

vm.runInContext(common + '\n' + popup + '\nglobalThis.__p = { init, getP: () => P, getS: () => S };',
                ctx, { filename: 'popup-bundle.js' });
const O = vm.runInContext('globalThis.__p', ctx);

/* 弹窗在真实 HTML 里是新开一个页面，重开一次就是重新绑一遍事件。
   这里手工把上一次绑的清掉，否则同一个按钮会被点两下。 */
function freshPopup() {
  for (const el of Object.values(els)) el._on = {};
  for (const k of Object.keys(docOn)) delete docOn[k];
  return O.init();
}

// 这两个元素在 HTML 里就写着 hidden
$('pfMenu').classList.add('hidden');
$('toast').classList.add('hidden');

const fire = (el, type, ev) => (el._on[type] || []).map((f) => f(ev || { stopPropagation() {}, preventDefault() {} }));
const clickTag = () => fire($('modelTag'), 'click');
const items = () => $('pfMenu')._kids;
const itemText = (b) => b._kids.map((k) => k.textContent).join(' · ') || b.textContent;

(async () => {
  /* ---------------------------------------------------------------- *
   * [1] 打开弹窗：拿现有设置原地立一档，模型名照常显示
   * ---------------------------------------------------------------- */
  console.log('[1] 初始化');
  await freshPopup();
  await sleep(10);
  check('立了正好一档', O.getP().list.length === 1, JSON.stringify(O.getP().list));
  check('模型名写在标签上', $('modelTag').textContent === 'deepseek-chat', $('modelTag').textContent);
  check('标签提示里带着配置名', $('modelTag').title.includes('默认') && $('modelTag').title.includes('点击切换配置'),
        $('modelTag').title);
  check('菜单一开始是收起的', $('pfMenu').classList.contains('hidden'));
  check('settings 一个字段都没被改动', storage.settings.scope === 'page' && storage.settings.apiKey === 'sk-old',
        JSON.stringify(storage.settings));

  /* ---------------------------------------------------------------- *
   * [2] 点模型名：菜单展开，条目 = 每档一条 + 「管理配置…」
   * ---------------------------------------------------------------- */
  console.log('\n[2] 展开菜单');
  // 直接往 storage 里塞第二档，模拟在设置页里加过一档
  const P0 = JSON.parse(JSON.stringify(storage.profiles));
  P0.list.push({ id: 'p2', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1',
                 apiKey: 'sk-kimi', model: 'kimi-k2', targetLang: 'auto', reasoningStyle: 'effort' });
  storage.profiles = P0;
  await freshPopup();                 // 重开弹窗
  await sleep(10);

  clickTag();
  check('菜单展开了', !$('pfMenu').classList.contains('hidden'));
  check('每档一条，外加「管理配置…」', items().length === 3, JSON.stringify(items().map(itemText)));
  check('条目里带着名字和模型', itemText(items()[1]) === 'Kimi · kimi-k2', itemText(items()[1]));
  check('当前档有标记', items()[0].className.includes('on') && !items()[1].className.includes('on'),
        items()[0].className + ' | ' + items()[1].className);
  check('最后一条是管理入口', items()[2].textContent === '管理配置…' && !items()[2].dataset.id,
        items()[2].textContent);

  /* ---------------------------------------------------------------- *
   * [3] 点另一档：灌回 settings，通知页面，菜单收起
   * ---------------------------------------------------------------- */
  console.log('\n[3] 切换到另一档');
  sent.length = 0;
  const kimiBtn = items()[1];
  await Promise.all(fire($('pfMenu'), 'click', { target: kimiBtn, stopPropagation() {} }));
  await sleep(10);

  check('active 指向了新的那档', storage.profiles.active === 'p2', storage.profiles.active);
  check('模型换过去了', storage.settings.model === 'kimi-k2', storage.settings.model);
  check('Key 换过去了', storage.settings.apiKey === 'sk-kimi', storage.settings.apiKey);
  check('地址换过去了', storage.settings.baseUrl === 'https://api.moonshot.cn/v1', storage.settings.baseUrl);
  check('推理参数写法换过去了', storage.settings.reasoningStyle === 'effort', storage.settings.reasoningStyle);
  check('全局设置没被顺手改掉', storage.settings.scope === 'page' && storage.settings.reasoning === 'low',
        JSON.stringify(storage.settings));
  check('标签跟着变了', $('modelTag').textContent === 'kimi-k2', $('modelTag').textContent);
  check('提示里的配置名也跟着变', $('modelTag').title.includes('Kimi'), $('modelTag').title);
  check('菜单收起了', $('pfMenu').classList.contains('hidden'));
  check('给页面发了 settingsChanged', sent.some((m) => m.type === 'settingsChanged'), JSON.stringify(sent));
  check('切完给了一句确认', !$('toast').classList.contains('hidden') && $('toast').textContent.includes('Kimi'),
        $('toast').textContent);

  /* ---------------------------------------------------------------- *
   * [4] 点当前这一档：什么都不该发生
   * ---------------------------------------------------------------- */
  console.log('\n[4] 点当前档是空操作');
  clickTag();
  const cur = items().find((b) => b.className.includes('on'));
  check('标记跟着切到了新的当前档', cur && cur.dataset.id === 'p2', cur && cur.dataset.id);
  sent.length = 0;
  const before = JSON.stringify(storage);
  await Promise.all(fire($('pfMenu'), 'click', { target: cur, stopPropagation() {} }));
  await sleep(10);
  check('存储一个字节都没动', JSON.stringify(storage) === before);
  check('没给页面发多余的消息', sent.length === 0, JSON.stringify(sent));
  check('菜单还是收起了', $('pfMenu').classList.contains('hidden'));

  /* ---------------------------------------------------------------- *
   * [5] 「管理配置…」只负责打开设置页
   * ---------------------------------------------------------------- */
  console.log('\n[5] 管理配置');
  clickTag();
  const more = items()[items().length - 1];
  sent.length = 0;
  const before5 = JSON.stringify(storage);
  await Promise.all(fire($('pfMenu'), 'click', { target: more, stopPropagation() {} }));
  await sleep(10);
  check('打开了设置页', optionsOpened === 1, String(optionsOpened));
  check('没改任何设置', JSON.stringify(storage) === before5);

  /* ---------------------------------------------------------------- *
   * [6] 菜单是每次打开时才画的：设置页刚改过也能看见
   * ---------------------------------------------------------------- */
  console.log('\n[6] 每次打开都重画');
  clickTag();                          // 展开
  const n6 = items().length;
  clickTag();                          // 收起
  check('再点一下收起', $('pfMenu').classList.contains('hidden'));
  O.getP().list.push({ id: 'p3', name: '本地', baseUrl: 'http://127.0.0.1:1234/v1',
                       apiKey: '', model: '', targetLang: 'auto', reasoningStyle: 'off' });
  clickTag();
  check('新加的一档出现在菜单里', items().length === n6 + 1, JSON.stringify(items().map(itemText)));
  check('没填模型的那档写「未设置模型」',
        items()[2]._kids[1].textContent === '未设置模型', itemText(items()[2]));
  check('菜单没有越点越长', items().filter((b) => b.dataset.id).length === 3,
        JSON.stringify(items().map(itemText)));

  /* ---------------------------------------------------------------- *
   * [7] 点别处 / 按 Esc 收起
   * ---------------------------------------------------------------- */
  console.log('\n[7] 收起');
  (docOn.click || []).forEach((f) => f({ target: $('statusCard') }));
  check('点空白处收起', $('pfMenu').classList.contains('hidden'));
  clickTag();
  (docOn.keydown || []).forEach((f) => f({ key: 'Escape' }));
  check('Esc 收起', $('pfMenu').classList.contains('hidden'));
  clickTag();
  (docOn.keydown || []).forEach((f) => f({ key: 'a' }));
  check('别的键不受影响', !$('pfMenu').classList.contains('hidden'));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
