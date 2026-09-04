import { DEFAULTS, getSettings, setSettings,
         getProfiles, saveProfiles, pickProfile } from '../common.js';

const $ = (id) => document.getElementById(id);
let S = Object.assign({}, DEFAULTS);
let tabId = null;
let last = null;     // 最近一次从页面拿到的状态
let P = { active: '', list: [] };   // 存了哪几套接口配置

const HINTS = {
  none: '网页翻译一般「关闭」就够，最快最省。',
  low: '略微思考，长难句和论文里的术语更稳。',
  medium: '最贴切，但明显更慢更贵，留给真正难啃的论文。'
};

async function init() {
  S = await getSettings();
  try { P = await getProfiles(); } catch (_) {}
  paintSettings();
  bind();
  await connectTab();
  refreshStatus();
  refreshUsage();
  setInterval(refreshStatus, 1000);
}

function paintSettings() {
  $('master').checked = !!S.enabled;
  setSeg('reasoning', S.reasoning);
  setSeg('scope', S.scope);
  setSeg('layout', S.layout);
  $('reasonHint').textContent = HINTS[S.reasoning] || '';
  paintModel();
}

/* 推理三档是对着某一个模型选的 —— 同样的「关闭」，换个模型可能就关不掉。
   所以把当前模型写在「推理强度」右边，不用为了确认它跑一趟设置页。
   模型名同时是个按钮：点开就是已存的配置档，换一套接口不用再跑设置页。 */
function paintModel() {
  const el = $('modelTag');
  const model = String(S.model || '').trim();
  el.textContent = model || '未设置模型';
  el.classList.toggle('none', !model);

  const cur = P.list.find((x) => x.id === P.active);
  el.title = (cur && cur.name ? `配置「${cur.name}」　·　` : '') +
             (model ? '模型 ' + model : '还没填模型，去设置页填一个') +
             '　·　点击切换配置';
}

/* 每次打开都重画一遍：上一次点过之后当前档换了，标记得跟着挪。 */
function paintMenu() {
  const box = $('pfMenu');
  box.innerHTML = '';
  for (const p of P.list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pfItem' + (p.id === P.active ? ' on' : '');
    b.dataset.id = p.id;
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', p.id === P.active ? 'true' : 'false');
    const n = document.createElement('span');
    n.className = 'pfName';
    n.textContent = p.name;
    const m = document.createElement('span');
    m.className = 'pfModel';
    m.textContent = p.model || '未设置模型';
    b.append(n, m);
    box.appendChild(b);
  }
  // 只有一档时这一条就是唯一出口：告诉用户上哪儿再加一档
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'pfItem pfMore';
  more.setAttribute('role', 'menuitem');
  more.textContent = '管理配置…';
  box.appendChild(more);
}

function openMenu(on) {
  const box = $('pfMenu');
  const want = on === undefined ? box.classList.contains('hidden') : on;
  if (want) paintMenu();
  box.classList.toggle('hidden', !want);
  $('modelTag').classList.toggle('open', want);
  $('modelTag').setAttribute('aria-expanded', want ? 'true' : 'false');
}

/* P 是「存了哪几套」，settings 是「现在正在用哪一套」—— 和设置页一样，
   切换就是把某一档的接口字段灌回 settings，运行时只认 settings。 */
async function switchProfile(id) {
  const p = P.list.find((x) => x.id === id);
  if (!p || id === P.active) return;
  P = await saveProfiles({ active: id, list: P.list });
  // 换了模型/语言，页面得按新配置重来一遍
  await save(pickProfile(p), true);
  paintModel();
  toast(`已切换到「${p.name}」`);
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1600);
}

function setSeg(id, value) {
  [...$(id).querySelectorAll('button')].forEach((b) => {
    b.classList.toggle('on', b.dataset.v === value);
  });
}

async function save(patch, reload) {
  S = await setSettings(patch);
  if (tabId && reload) { try { await chrome.tabs.sendMessage(tabId, { type: 'settingsChanged' }); } catch (_) {} }
}

function bind() {
  $('master').addEventListener('change', async (e) => {
    await save({ enabled: e.target.checked });
    if (!e.target.checked && tabId) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'setActive', value: false }); } catch (_) {}
    }
    refreshStatus();
  });

  $('actBtn').addEventListener('click', async () => {
    if (!tabId) return;
    const on = !!(last && last.active);
    if (!S.enabled && !on) await save({ enabled: true });
    try { await chrome.tabs.sendMessage(tabId, { type: 'setActive', value: !on }); } catch (_) {}
    $('master').checked = !!S.enabled;
    setTimeout(refreshStatus, 120);
  });

  $('reasoning').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg('reasoning', b.dataset.v);
    $('reasonHint').textContent = HINTS[b.dataset.v] || '';
    // 推理档位只影响之后发出去的请求，已经翻好的不用重来
    save({ reasoning: b.dataset.v }, false);
  });

  $('scope').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.v === S.scope) return;
    setSeg('scope', b.dataset.v);
    // 换了范围就得重新找正文容器、重新切段
    save({ scope: b.dataset.v }, true);
  });

  $('layout').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.v === S.layout) return;
    setSeg('layout', b.dataset.v);
    // 显示方式改的是已经贴在页面上的译文，得让页面重画
    save({ layout: b.dataset.v }, true);
  });

  $('retryBtn').addEventListener('click', async () => {
    if (!tabId) return;
    try { await chrome.tabs.sendMessage(tabId, { type: 'retry' }); } catch (_) {}
    refreshStatus();
  });

  /* 错位的译文会按原文哈希写进缓存，刷新页面只会再命中同一份错的。
     给一个「把这一页的缓存扔了重翻」的出口。 */
  $('purgeBtn').addEventListener('click', async () => {
    if (!tabId) return;
    const b = $('purgeBtn');
    b.disabled = true;
    b.textContent = '正在重翻…';
    try { await chrome.tabs.sendMessage(tabId, { type: 'purge' }); } catch (_) {}
    b.disabled = false;
    b.textContent = '译文和原文对不上？重翻本页';
    refreshStatus();
  });

  $('modelTag').addEventListener('click', (e) => { e.stopPropagation(); openMenu(); });

  $('pfMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    openMenu(false);
    if (b.dataset.id) switchProfile(b.dataset.id);
    else chrome.runtime.openOptionsPage();
  });

  document.addEventListener('click', () => openMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openMenu(false); });

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

async function connectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:\/\//.test(tab.url)) return;
  tabId = tab.id;
}

async function refreshStatus() {
  if (!tabId) {
    $('statusText').textContent = '这个页面不能翻译';
    $('dot').removeAttribute('data-s');
    $('actBtn').disabled = true;
    return;
  }

  let r = null;
  try { r = await chrome.tabs.sendMessage(tabId, { type: 'getStatus' }); } catch (_) {}
  last = r;

  if (!r) {
    // 装好插件之前就打开的标签页里没有内容脚本，刷新一下才有
    $('statusText').textContent = '页面未就绪，刷新一下试试';
    $('dot').removeAttribute('data-s');
    $('actBtn').disabled = true;
    return;
  }

  $('actBtn').disabled = false;
  $('actBtn').textContent = r.active ? '退出翻译' : '翻译此页';
  $('actBtn').classList.toggle('on', !!r.active);

  const busy = !!r.busy;
  let text;
  if (!r.active) text = S.enabled ? '未翻译' : '插件已关闭';
  else if (busy) text = `正在翻译 ${r.done}/${r.total} 段`;
  else if (r.total) text = `已翻译 ${r.done} 段` + (r.failed ? `　·　${r.failed} 段失败` : '');
  else text = '这一页没有需要翻译的内容';
  if (r.active && r.target) text += `　·　${r.target}`;

  $('statusText').textContent = text;
  /* 正文识别落空时会自动退回整页 —— 不写出来的话，用户只会看到导航也被翻了，
     还以为是「只翻正文」没生效。 */
  $('scopeTag').textContent = r.fellBack ? '没认出正文，已按整页翻' : '';
  $('dot').dataset.s = r.error ? 'error' : (busy ? 'busy' : (r.active && r.done ? 'ready' : ''));
  $('pageTitle').textContent = r.title || '';
  $('barFill').style.width = r.total ? Math.round((r.done / r.total) * 100) + '%' : '0%';

  const hasErr = !!r.error;
  $('errText').textContent = r.error || '';
  $('errText').classList.toggle('hidden', !hasErr);
  $('retryBtn').classList.toggle('hidden', !(hasErr || r.failed));
  $('purgeBtn').classList.toggle('hidden', !(r.active && r.done > 0));
}

async function refreshUsage() {
  const got = await chrome.storage.local.get('stats');
  const s = got.stats;
  if (!s || !s.requests) { $('usage').textContent = '还没用过 token'; return; }
  const total = (s.prompt || 0) + (s.completion || 0);
  $('usage').textContent = `累计 ${fmt(total)} tokens · ${s.requests} 次请求`;
}

function fmt(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(2) + 'M';
}

init();
