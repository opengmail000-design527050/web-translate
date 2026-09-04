import { DEFAULTS, getSettings, setSettings, resolveTargetName, uiLanguage,
         originPattern, hasApiPermission,
         PROFILE_KEYS, getProfiles, saveProfiles, newProfileId, pickProfile } from '../common.js';

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang',
                     'reasoningStyle', 'scope', 'layout', 'markStyle', 'transFont'];

const RANGE_FIELDS = {
  cacheDays: (v) => (Number(v) >= 365 ? '1 年' : v + ' 天'),
  cacheMax: (v) => v + ' 个',
  transScale: (v) => Number(v).toFixed(2)
};

const CHECK_FIELDS = ['lazy'];

/* 这两项已经从设置页撤掉了：缓存关掉等于重看一次付一次钱，领域提示每批只多约
   30 token 却直接决定论文里的术语翻得对不对 —— 实际没人会去关。
   但撤掉控件之后，以前手动关过的人就再也打不开了，所以打开设置页时补一次。 */
const FORCED_ON = ['useCache', 'useTitle'];

const MARK_NOTES = {
  line: '译文左边一道极淡的竖线，扫一眼就能分清中英。',
  none: '什么都不加，最安静，密排的正文里可能不好找边界。',
  dim: '原文压成中灰，译文保持原色 —— 以读译文为主时用这个。'
};

/* 常用的两家。只填地址、模型和推理写法，不动 Key ——
   换下一代模型时改「模型」那一栏就行，这里只是省得记地址。 */
const PRESETS = {
  pre1: { model: 'gpt-5.6-luna', baseUrl: 'https://api.openai.com/v1', reasoningStyle: 'effort_none' },
  pre2: { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1', reasoningStyle: 'enable_thinking' }
};

/* 译文预览用的字体，跟 content.js 里 makeNode 的写法保持一致 */
const FONT_STACKS = {
  inherit: 'Georgia, "Noto Serif SC", serif',
  serif: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif',
  sans: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
};

const SAMPLE_TR = '我们提出了一种新的简单网络架构 —— Transformer，它完全基于注意力机制，彻底摒弃了循环与卷积。';

let S = Object.assign({}, DEFAULTS);
let P = { active: '', list: [] };

async function init() {
  S = await getSettings();
  P = await getProfiles();

  const stuck = FORCED_ON.filter((k) => !S[k]);
  if (stuck.length) S = await setSettings(Object.fromEntries(stuck.map((k) => [k, true])));

  paintAll();
  bind();
  refreshStats();
}

/** 把 S / P 整个刷到界面上。初始化和「恢复默认」都走这里。 */
function paintAll() {
  TEXT_FIELDS.forEach((k) => { $(k).value = S[k] ?? ''; });
  Object.keys(RANGE_FIELDS).forEach((k) => {
    $(k).value = S[k];
    $(k + 'V').textContent = RANGE_FIELDS[k]($(k).value);
  });
  CHECK_FIELDS.forEach((k) => { $(k).checked = !!S[k]; });
  hideKey();

  paintProfiles();
  paintPreview();
  paintSites();
  paintPerm();
}

/* ------------------------------------------------------------------ *
 * 危险动作：点第一下只是「上膛」，3 秒内再点一下才真执行。
 * 比弹 confirm 框轻，也不会误触。
 * ------------------------------------------------------------------ */
const armTimers = new WeakMap();

function disarm(btn, label) {
  clearTimeout(armTimers.get(btn));
  armTimers.delete(btn);
  btn.classList.remove('arming');
  btn.textContent = label;
}

/** 返回 true 表示这一下是「确认」，可以执行了 */
function armOnce(btn, label, confirmLabel) {
  if (btn.classList.contains('arming')) { disarm(btn, label); return true; }
  btn.classList.add('arming');
  btn.textContent = confirmLabel;
  armTimers.set(btn, setTimeout(() => disarm(btn, label), 3000));
  return false;
}

/* ------------------------------------------------------------------ *
 * 接口配置档
 *
 * P 是「存了哪几套」，settings 是「现在正在用哪一套」。两边都要写：
 * 运行时（background / content）只认 settings，切换才是把某一档灌回 settings；
 * 而在这张卡片里改字段又要顺手存回当前这一档，否则切走再切回来就丢了。
 * ------------------------------------------------------------------ */
function activeProfile() {
  return P.list.find((x) => x.id === P.active) || P.list[0];
}

/** 同名会让下拉框认不出谁是谁，自动加序号 */
function uniqueName(base) {
  const used = new Set(P.list.map((x) => x.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(base + ' ' + i)) return base + ' ' + i;
}

function paintProfiles() {
  const sel = $('profileSel');
  sel.innerHTML = '';
  for (const p of P.list) {
    const o = document.createElement('option');
    o.value = p.id;
    // 顺手把模型名带出来，几套配置一眼能分清
    o.textContent = p.name + (p.model ? ' · ' + p.model : '');
    sel.appendChild(o);
  }
  sel.value = P.active;
  // 最后一档不给删，否则就没有任何配置可用了
  $('pfDel').disabled = P.list.length <= 1;
  disarm($('pfDel'), '删除');
}

function hideKey() {
  $('apiKey').type = 'password';
  $('toggleKey').textContent = '显示';
}

/** 把当前设置里的接口字段刷回表单（切换配置之后用） */
function paintApiFields() {
  for (const k of PROFILE_KEYS) $(k).value = S[k] ?? '';
  hideKey();     // Key 换了一套，重新遮起来
}

async function switchProfile(id) {
  if (id === P.active) return;
  const p = P.list.find((x) => x.id === id);
  if (!p) return;
  P = await saveProfiles({ active: id, list: P.list });
  await commit(pickProfile(p), `已切换到「${p.name}」`);
  paintApiFields();
  paintProfiles();
}

/** from 为空 = 建一份干净的；传当前档 = 复制一份 */
async function addProfile(from) {
  const base = from
    ? Object.assign({ id: newProfileId(), name: uniqueName(from.name + ' 副本') }, pickProfile(from))
    : Object.assign({ id: newProfileId(), name: uniqueName('新配置') }, pickProfile(DEFAULTS), { apiKey: '' });
  P = await saveProfiles({ active: base.id, list: P.list.concat([base]) });
  await commit(pickProfile(base), `已新建「${base.name}」`);
  paintApiFields();
  paintProfiles();
  startRename();
}

/* 删除是不可逆的（Key 就没了），所以走上膛-确认那一套 */
async function deleteProfile() {
  if (P.list.length <= 1) return;
  if (!armOnce($('pfDel'), '删除', '确认删除？')) return;

  const gone = activeProfile();
  const list = P.list.filter((x) => x.id !== gone.id);
  P = await saveProfiles({ active: list[0].id, list });
  await commit(pickProfile(list[0]), `已删除「${gone.name}」`);
  paintApiFields();
  paintProfiles();
}

/* 重命名就是把下拉框换成输入框，回车或失焦生效。 */
function startRename() {
  const sel = $('profileSel'), inp = $('profileName');
  inp.value = activeProfile().name;
  sel.classList.add('hidden');
  inp.classList.remove('hidden');
  $('pfRename').textContent = '完成';
  inp.focus();
  inp.select();
}

async function endRename(save) {
  const sel = $('profileSel'), inp = $('profileName');
  if (inp.classList.contains('hidden')) return;
  if (save) {
    const name = inp.value.trim();
    const cur = activeProfile();
    if (name && name !== cur.name) {
      cur.name = uniqueName(name);
      P = await saveProfiles(P);
      toast('已重命名');
    }
  }
  inp.classList.add('hidden');
  sel.classList.remove('hidden');
  $('pfRename').textContent = '重命名';
  paintProfiles();
}

/* ------------------------------------------------------------------ *
 * 预览
 * ------------------------------------------------------------------ */
function paintPreview() {
  const pv = $('preview');
  pv.className = 'preview';
  if (S.markStyle === 'line') pv.classList.add('pv-line');
  if (S.markStyle === 'dim') pv.classList.add('pv-dim');
  if (S.layout === 'transOnly') pv.classList.add('pv-only');

  let tr = pv.querySelector('.pv-trans');
  if (!tr) {
    tr = document.createElement('span');
    tr.className = 'pv-trans';
    pv.appendChild(tr);
  }
  tr.textContent = SAMPLE_TR;
  tr.style.fontFamily = FONT_STACKS[S.transFont] || FONT_STACKS.inherit;
  tr.style.fontSize = (Number(S.transScale) || 1) + 'em';

  $('markNote').textContent = MARK_NOTES[S.markStyle] || '';

  const t = String(S.targetLang || 'auto').trim();
  $('langNote').textContent = (!t || t.toLowerCase() === 'auto')
    ? `auto：跟随浏览器（${uiLanguage()}），当前译成「${resolveTargetName(S)}」。`
    : `固定译成「${t}」，改回 auto 则跟随浏览器。`;
}

/* ------------------------------------------------------------------ *
 * 自动翻译的网站
 * ------------------------------------------------------------------ */
function paintSites() {
  const box = $('siteList');
  box.innerHTML = '';
  for (const h of S.autoSites || []) {
    const el = document.createElement('span');
    el.className = 'site';
    el.textContent = h;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '×';
    b.title = '移除';
    b.addEventListener('click', () => removeSite(h));
    el.appendChild(b);
    box.appendChild(el);
  }
}

/** 用户可能整条网址粘进来，取出主机名就好 */
function normalizeHost(raw) {
  let t = String(raw || '').trim().toLowerCase();
  if (!t) return '';
  if (!/^https?:\/\//.test(t)) t = 'https://' + t;
  try { return new URL(t).hostname; } catch (_) { return ''; }
}

async function addSite() {
  const host = normalizeHost($('siteInput').value);
  if (!host) { toast('这不像一个网址'); return; }
  const list = (S.autoSites || []).filter((h) => h !== host).concat([host]);
  $('siteInput').value = '';
  await commit({ autoSites: list }, `${host} 打开就翻`);
  paintSites();
}

async function removeSite(host) {
  await commit({ autoSites: (S.autoSites || []).filter((h) => h !== host) }, `已移除 ${host}`);
  paintSites();
}

/* ------------------------------------------------------------------ *
 * 自定义 API 地址的权限
 * manifest 只静态声明了 api.openai.com，填别的地址时在这里按需申请。
 * ------------------------------------------------------------------ */
async function paintPerm() {
  const note = $('permNote');
  const origin = originPattern(S.baseUrl);
  const ok = !origin || (await hasApiPermission(S.baseUrl));
  note.classList.toggle('hidden', ok);
  if (!ok) $('permText').textContent = `还没有访问 ${origin.slice(0, -2)} 的权限，翻译会失败。`;
}

/** 返回是否拿到了权限。必须由用户点击触发，Chrome 才允许弹这个授权框。 */
async function requestApiPermission() {
  const origins = originPattern(S.baseUrl);
  if (!origins) return true;
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [origins] }); } catch (_) {}
  await paintPerm();
  if (granted) toast('已授权');
  return granted;
}

/* ------------------------------------------------------------------ *
 * 绑定
 * ------------------------------------------------------------------ */
function bind() {
  TEXT_FIELDS.forEach((k) => {
    $(k).addEventListener('change', () => commit({ [k]: $(k).value.trim() }));
  });

  Object.keys(RANGE_FIELDS).forEach((k) => {
    $(k).addEventListener('input', () => {
      $(k + 'V').textContent = RANGE_FIELDS[k]($(k).value);
      S[k] = Number($(k).value);
      paintPreview();
    });
    $(k).addEventListener('change', () => commit({ [k]: Number($(k).value) }));
  });

  CHECK_FIELDS.forEach((k) => {
    $(k).addEventListener('change', () => commit({ [k]: $(k).checked }));
  });

  Object.keys(PRESETS).forEach((id) => {
    $(id).addEventListener('click', async () => {
      await commit(PRESETS[id], `已填入 ${PRESETS[id].model} 的地址与写法`);
      paintApiFields();
    });
  });

  $('toggleKey').addEventListener('click', () => {
    const el = $('apiKey');
    if (el.type === 'text') hideKey();
    else { el.type = 'text'; $('toggleKey').textContent = '隐藏'; }
  });

  $('profileSel').addEventListener('change', () => switchProfile($('profileSel').value));
  $('pfNew').addEventListener('click', () => addProfile(null));
  $('pfCopy').addEventListener('click', () => addProfile(activeProfile()));
  $('pfDel').addEventListener('click', deleteProfile);
  /* 输入框失焦会先跑 endRename 把它藏起来；之后按钮的 click 才到，看到的是
     「已经藏起来了」，于是又开一次重命名。按住时不让焦点移走就没这回事。 */
  $('pfRename').addEventListener('mousedown', (e) => {
    if (!$('profileName').classList.contains('hidden')) e.preventDefault();
  });
  $('pfRename').addEventListener('click', () => {
    $('profileName').classList.contains('hidden') ? startRename() : endRename(true);
  });
  $('profileName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') endRename(true);
    if (e.key === 'Escape') endRename(false);
  });
  $('profileName').addEventListener('blur', () => endRename(true));

  $('siteAdd').addEventListener('click', addSite);
  $('siteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSite(); });

  $('testBtn').addEventListener('click', runTest);
  $('permBtn').addEventListener('click', requestApiPermission);
  $('clearCache').addEventListener('click', clearCache);
  $('resetStats').addEventListener('click', resetStats);
  $('resetAll').addEventListener('click', resetAll);
  // 勾不勾决定确认时的措辞，改了就把已上膛的按钮放下
  $('keepApi').addEventListener('change', () => disarm($('resetAll'), '恢复默认设置'));
}

async function commit(patch, msg) {
  S = await setSettings(patch);

  /* 改的是接口字段就顺手存回当前配置档。切换/新建/删除也会走到这里，
     那时候写进去的正是刚灌进 settings 的同一份值，是幂等的。 */
  const cur = activeProfile();
  if (cur && PROFILE_KEYS.some((k) => k in patch)) {
    for (const k of PROFILE_KEYS) if (k in patch) cur[k] = S[k];
    await saveProfiles(P);
    paintProfiles();      // 下拉框里带着模型名，改了模型要跟着变
  }

  paintPreview();
  if ('baseUrl' in patch) paintPerm();
  toast(msg || '已保存');
  broadcast();
}

/* ------------------------------------------------------------------ *
 * 恢复默认
 *
 * 勾着「保留模型与接口」时，PROFILE_KEYS 那几项原样留下、配置档一个不动；
 * 其余全部回到 DEFAULTS。这里是整份覆盖写，不走 setSettings 的合并 ——
 * 否则以前存过的字段会残留下来。翻译缓存和用量统计另有按钮，这里不碰。
 * ------------------------------------------------------------------ */
async function resetAll() {
  const keep = $('keepApi').checked;
  if (!armOnce($('resetAll'), '恢复默认设置', keep ? '确认恢复？' : '确认恢复（含接口）？')) return;

  const next = Object.assign({}, DEFAULTS);
  if (keep) Object.assign(next, pickProfile(S));
  await chrome.storage.local.set({ settings: next });
  S = next;

  if (!keep) {
    // 接口也一并出厂：只留一档空的「默认」
    const one = Object.assign({ id: newProfileId(), name: '默认' }, pickProfile(DEFAULTS));
    P = await saveProfiles({ active: one.id, list: [one] });
  }

  $('testCard').classList.add('hidden');
  paintAll();
  toast(keep ? '已恢复默认（模型与接口保留）' : '已全部恢复默认');
  broadcast();
}

/* 拖滑块时 change 会连着来，攒一下再广播 —— 每广播一次，所有开着译文的
   标签页都要重画一遍。 */
let bcTimer = null;
function broadcast() {
  clearTimeout(bcTimer);
  bcTimer = setTimeout(async () => {
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (_) { return; }
    for (const t of tabs) {
      if (!t.id) continue;
      try { await chrome.tabs.sendMessage(t.id, { type: 'settingsChanged' }); } catch (_) {}
    }
  }, 400);
}

const REASON_LEVEL = { none: '关闭', low: '低', medium: '中' };

/* ------------------------------------------------------------------ *
 * 测试连接的结果卡
 *
 * 抬头是模型名和状态，下面几格全是这次请求的硬数字。
 * 「发出的参数」和「实际推理」要并排看 —— 只看设置判断不出推理关没关，
 * 写法选错时服务商会安安静静退回它自己的默认档，只有账单上看得出来。
 * ------------------------------------------------------------------ */
function cardHead(name, state, label) {
  return `<div class="mcard-head"><span class="mcard-name">${esc(name || '—')}</span>` +
         `<span class="pill ${state}">${esc(label)}</span></div>`;
}

function chip(k, v, cls) {
  return `<div class="chip${cls ? ' ' + cls : ''}"><span class="ck">${esc(k)}</span>` +
         `<span class="cv">${v}</span></div>`;
}

function paintTestCard(html) {
  const box = $('testCard');
  box.innerHTML = html;
  box.classList.remove('hidden');
}

function okCard(res) {
  const r = res.reasoning || {};
  const u = res.usage || {};
  const used = r.used;          // null = 服务商没回报，不能当成 0
  const cch = res.cached;
  const pt = Number(u.prompt_tokens || u.input_tokens || 0);
  const ct = Number(u.completion_tokens || u.output_tokens || 0);

  const sent = r.sent && Object.keys(r.sent).length
    ? Object.entries(r.sent).map(([k, v]) => `${esc(k)}=${esc(JSON.stringify(v))}`).join(' ')
    : '不发送';

  const chips = [
    chip('推理档位', REASON_LEVEL[r.level] || r.level || '—'),
    chip('发出的参数', `<code>${sent}</code>`, 'wide'),
    chip('实际推理', used == null ? '未回报' : used + ' token',
         r.level === 'none' && used > 0 ? 'bad' : ''),
    chip('前缀缓存', cch == null ? '未回报' : cch + ' token'),
    chip('本次用量', (pt || ct) ? `${pt} 进 / ${ct} 出` : '未回报')
  ];

  let html = cardHead(res.model || S.model, 'ok', `已连通 · ${res.ms} ms`) +
             `<div class="mcard-chips">${chips.join('')}</div>`;

  // 试译回来的是带编号的对齐格式（1|…），卡片里只要译文
  const lines = String(res.sample || '').split('\n')
    .map((x) => x.trim().replace(/^\d+\s*\|\s*/, '')).filter(Boolean);
  if (lines.length) {
    html += `<div class="mcard-sample">${lines.map((x) => `<div>${esc(x)}</div>`).join('')}</div>`;
  }

  /* 最值得报的一种：设成「关闭」了，模型还在烧推理 token。 */
  if (r.level === 'none' && used > 0) {
    html += warnLine(`设成「关闭」却烧了 ${used} 个推理 token。换第一种写法再测，服务商拒收就说明这个模型关不掉推理。`);
  }
  if (r.level !== 'none' && used === 0) {
    html += warnLine(`档位是「${REASON_LEVEL[r.level] || r.level}」却一个推理 token 都没花，可能这个模型不支持推理，或者不认这种写法。`);
  }
  return html;
}

function warnLine(text) {
  return `<div class="mcard-warn">${esc(text)}</div>`;
}

function esc(x) {
  return String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function runTest() {
  const btn = $('testBtn');

  // 测试按钮本身就是一次用户手势，顺手把缺的地址权限要了
  if (!(await hasApiPermission(S.baseUrl)) && !(await requestApiPermission())) {
    paintTestCard(cardHead(S.model, 'bad', '未授权') +
      '<div class="mcard-err">没有访问该 API 地址的权限，已取消。</div>');
    return;
  }

  paintTestCard(cardHead(S.model, 'wait', '请求中'));
  btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'testApi', payload: {} });
  btn.disabled = false;

  if (!res || !res.ok) {
    paintTestCard(cardHead(S.model, 'bad', '失败') +
      `<div class="mcard-err">${esc((res && res.error) || '无响应')}</div>`);
    return;
  }
  paintTestCard(okCard(res));
  refreshStats();
}

async function refreshStats() {
  const got = await chrome.storage.local.get(['stats', 'cacheIndex']);
  const s = got.stats;
  const idx = got.cacheIndex || {};
  const keys = Object.keys(idx);

  const parts = [];
  if (s && s.requests) {
    parts.push(`累计 ${s.requests} 次请求`);
    parts.push(`输入 ${fmt(s.prompt)} / 输出 ${fmt(s.completion)} tokens`);
  } else {
    parts.push('还没有用量记录');
  }

  /* 对齐的账。改了提示词或批次大小之后，就靠这一行判断模型的逐段对齐是变好还是
     变差 —— 译文好不好没法自动判，错位有客观指纹。 */
  if (s && s.batches) {
    const pct = Math.round((s.dirty || 0) / s.batches * 100);
    const bits = [`翻了 ${s.batches} 批`];
    bits.push(s.dirty ? `错位 ${s.dirty} 批（${pct}%）` : '没出过错位');
    if (s.split) bits.push(`拆块 ${s.split} 次`);
    if (s.repaired) bits.push(`补翻 ${s.repaired} 段`);
    if (s.dropped) bits.push(`放弃 ${s.dropped} 段`);
    parts.push(bits.join('，'));
  }

  /* 前缀缓存命中率。OpenAI 兼容接口通常要前缀 ≥1024 token 才自动缓存，
     而这里一批输入常在 1000 上下，到底进没进得去，看这行数字才知道。 */
  if (s && s.requests) {
    if (!s.cachedReports) {
      parts.push('前缀缓存：服务商没回报');
    } else {
      const pct = s.prompt ? Math.round((s.cached || 0) / s.prompt * 100) : 0;
      parts.push(`前缀缓存命中 ${fmt(s.cached || 0)}（占输入 ${pct}%）`);
    }
  }

  let bytes = 0;
  try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (_) {}
  parts.push(`已缓存 ${keys.length} 个页面${bytes ? '（' + fmtBytes(bytes) + '）' : ''}`);

  if (keys.length) {
    const oldest = Math.min(...keys.map((k) => idx[k] || Date.now()));
    const days = Math.floor((Date.now() - oldest) / 86400000);
    parts.push(`最早一条 ${days} 天前用过`);
  }

  $('statLine').textContent = parts.join(' · ');
}

/* 清空也走 background：索引的读-改-写全都排在那一条队列上。自己在这儿删，
   正开着译文的标签页可能刚好把它读到一半的旧索引整个写回来，抵消掉这次清空。 */
async function clearCache() {
  let res = null;
  try { res = await chrome.runtime.sendMessage({ type: 'cacheIndex', payload: { op: 'clear' } }); } catch (_) {}
  toast(res && res.ok ? `已清空 ${res.removed} 个页面的缓存` : '清空失败，请重试');
  refreshStats();
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function resetStats() {
  await chrome.storage.local.remove('stats');
  toast('用量已归零');
  refreshStats();
}

function fmt(n) {
  n = Number(n || 0);
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

init();
