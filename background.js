import { DEFAULTS, getSettings, resolveTargetName, hasApiPermission } from './common.js';

/* ------------------------------------------------------------------ *
 * 消息入口
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const tabId = (sender && sender.tab && sender.tab.id) || 0;

  if (msg.type === 'translateBatch') {
    translateBatch(msg.payload, tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: errText(e) }));
    return true;
  }

  if (msg.type === 'cancel') {
    sendResponse({ ok: true, aborted: cancelJobs(tabId, msg.payload || {}) });
    return true;
  }

  if (msg.type === 'testApi') {
    testApi(msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: errText(e) }));
    return true;
  }

  if (msg.type === 'cacheIndex' || msg.type === 'cacheWrite') {
    cacheIndexOp(msg.payload)
      .then((n) => sendResponse({ ok: true, removed: n }))
      .catch((e) => sendResponse({ ok: false, error: errText(e) }));
    return true;
  }
});

/* 第一次安装就打开设置页。这个插件必须先填 Key 才能工作，入口应该主动出现；
   更新版本时不打扰。测试桩和少数 Chromium 分支没有 onInstalled，所以留兜底。 */
try {
  chrome.runtime.onInstalled.addListener((d) => {
    if (d && d.reason === 'install') chrome.runtime.openOptionsPage();
  });
} catch (_) {}

/* 快捷键：Alt+A */
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }); } catch (_) {}
  }
});

/* ------------------------------------------------------------------ *
 * 翻译
 * ------------------------------------------------------------------ */
function errText(e) {
  return String((e && e.message) || e || 'unknown error');
}

// 非默认 API 地址需要用户在设置页单独授权（manifest 里只静态声明了 api.openai.com）
const PERM_HINT = '还没有访问这个 API 地址的权限：打开设置页，在「API 地址」下面点「授权访问」。';

function joinUrl(base) {
  let b = String(base || '').trim().replace(/\s+/g, '');
  if (!b) throw new Error('未设置 API 地址');
  // 末尾带 # 表示「就用这个地址，别自动补路径」
  if (b.endsWith('#')) return b.slice(0, -1);
  b = b.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

/** 标题是从页面上取来的文本，可能带换行、方括号、竖线 —— 这几样正好是提示词里
 *  用来分块和分隔编号的记号。原样插进去，一个精心起名的标题就能伪造出一个块头
 *  骗过模型，所以先把它们抹平再截断。 */
function safeTitle(title) {
  return String(title || '').replace(/[\[\]|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/* 系统提示按「次」付费，一批十几段时它只占输入的一成，但仍然逐条推敲过 ——
 * 每一行都在挡一种具体的失败：
 *   第 2 行  唯一的对齐契约（编号、条数、顺序），没有它就没法校验错位
 *   第 3 行  网页的段落彼此独立，模型很爱把两个短段并成一句回来 —— 一并就整批错位
 *   第 5 行  论文和技术文里最刺眼的错误：把 transformer、GPU、变量名也给翻了
 *   第 6 行  译文要直接贴回原网页，多一句「以下是译文」就是脏数据 */
function buildSystemPrompt(s, title) {
  const lang = resolveTargetName(s);
  const lines = [
    `You are a professional translator. Translate web page text into ${lang}.`,
    `Input: lines of "<n>|<text>". Output exactly one "<n>|<translation>" per input line — same numbers, same order, same count, nothing else. No markdown fences, no notes, never an empty or missing line.`,
    `Each numbered line is an independent block of the page. Keep every block's meaning inside its own line: never merge two blocks, never split one, never carry content between them. A heading stays a heading, a fragment stays a fragment.`,
    `Write natural, fluent ${lang} that reads as if written by a native expert — faithful to the meaning, never word-for-word.`,
    `Leave unchanged: code identifiers, file paths, URLs, math, citation markers like [12], product and proper nouns, and established English acronyms (AI, GPU, LLM, API, RLHF, SOTA). Translate a technical term the way the field's ${lang} literature does; when it has no settled translation, keep the English.`,
    `Output only the translated lines. Never add explanations, never repeat the source text.`
  ];
  /* 页面标题。同一个 agent / trait / model，在 AI 论文里和在电商页面上根本不是
     一回事，而光看一批十几段常常判断不出领域。框架文字压到 20 token 左右，
     它待在系统提示里，不跟待翻的行挨着，不会被误当成输入。 */
  const t = s.useTitle === false ? '' : safeTitle(title);
  if (t) lines.push(`Page title, for domain terminology only — never translate or output it: "${t}"`);
  if (s.extraPrompt && s.extraPrompt.trim()) lines.push(s.extraPrompt.trim());
  return lines.join('\n');
}

function applyReasoning(body, s) {
  const level = s.reasoning || 'none';
  switch (s.reasoningStyle) {
    case 'off':
      break;
    case 'effort_none':
      body.reasoning_effort = level;
      break;
    case 'enable_thinking':
      body.enable_thinking = level !== 'none';
      if (level === 'low') body.thinking_budget = 512;
      if (level === 'medium') body.thinking_budget = 2048;
      break;
    case 'effort':
    default:
      if (level !== 'none') body.reasoning_effort = level;
      break;
  }
}

/* 一批最多拆多少层。每层对半砍，3 层足以把 12 段的批砍到 1~2 段。 */
const MAX_SPLIT = 3;

/* ------------------------------------------------------------------ *
 * 在途请求登记簿
 *
 * 内容脚本换页 / 换配置会递增 epoch。只在前端丢结果还不够：旧 fetch 仍会计费，
 * 后面还可能继续 strict、repair、拆块。这里按 (tab, epoch, batch) 真正 abort。
 * cancelFloor 还挡住「取消消息先到、translateBatch 尚在读设置」这一条竞态。
 * ------------------------------------------------------------------ */
const inflight = new Map();
const cancelFloor = new Map();
let fallbackJobSeq = 0;

function sessionKey(tabId, sessionId) {
  return `${Number(tabId) || 0}|${String(sessionId || '')}`;
}

function jobKey(tabId, sessionId, epoch, batchId) {
  return `${sessionKey(tabId, sessionId)}|${Number(epoch) || 0}|${Number(batchId) || 0}`;
}

function openJob(tabId, sessionId, epoch, batchId) {
  const t = Number(tabId) || 0;
  const session = String(sessionId || '');
  const e = Number(epoch) || 0;
  let b = Number(batchId) || 0;
  if (!b) b = ++fallbackJobSeq;
  const sk = sessionKey(t, session);
  const job = { key: jobKey(t, session, e, b), tabId: t, sessionId: session, epoch: e, batchId: b,
    cancelled: e < (cancelFloor.get(sk) || 0), ctrls: new Set() };
  inflight.set(job.key, job);
  return job;
}

function closeJob(job) {
  if (job) inflight.delete(job.key);
}

function abortJob(job) {
  job.cancelled = true;
  let n = 0;
  for (const ctrl of job.ctrls) { try { ctrl.abort(); n++; } catch (_) {} }
  job.ctrls.clear();
  return n;
}

function cancelJobs(tabId, payload) {
  const t = Number(tabId) || 0;
  const session = String((payload && payload.sessionId) || '');
  const sk = sessionKey(t, session);
  const epoch = Number((payload && payload.epoch) || 0);
  const one = payload && payload.batchId !== undefined && payload.batchId !== null
    ? Number(payload.batchId) : null;
  if (one === null) cancelFloor.set(sk, Math.max(cancelFloor.get(sk) || 0, epoch));
  let n = 0;
  for (const job of inflight.values()) {
    if (job.tabId !== t || job.sessionId !== session) continue;
    const hit = one === null
      ? job.epoch < epoch
      : job.epoch === epoch && job.batchId === one;
    if (hit) n += abortJob(job);
  }
  return n;
}

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const job of inflight.values()) if (job.tabId === tabId) abortJob(job);
    const prefix = `${Number(tabId) || 0}|`;
    for (const key of cancelFloor.keys()) if (key.startsWith(prefix)) cancelFloor.delete(key);
  });
} catch (_) {}

const stopped = (ctx) => !!(ctx.job && ctx.job.cancelled);

function cancelError() {
  const e = new Error('已取消');
  e.cancelled = true;
  e.noRetry = true;
  return e;
}

/** payload: { items: [{id, text}], title } */
async function translateBatch(payload, tabId) {
  const p = payload || {};
  const job = openJob(tabId, p.sessionId, p.epoch, p.batchId);
  try {
    const s = await getSettings();
    if (job.cancelled) return { ok: false, cancelled: true, error: '已取消' };
    if (!s.apiKey) return { ok: false, error: '还没填 API Key（点插件图标 → 设置）' };
    if (!(await hasApiPermission(s.baseUrl))) return { ok: false, error: PERM_HINT };

    const items = p.items || [];
    if (!items.length) return { ok: true, map: {}, usage: null };

    const ctx = {
      s,
      job,
      title: p.title || '',
      totals: { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cached_reports: 0 },
      error: '',
      retryAfter: 0,
      repaired: 0,
      split: 0        // 因为错位而对半重来的次数
    };

    const r = await translateChunk(ctx, items, 0);
    const usage = ctx.totals.prompt_tokens || ctx.totals.completion_tokens ? ctx.totals : null;

    /* 对齐的账，跟 usage 分开记 —— 有些服务商压根不回报 usage，偏偏那时候更需要知道
     * 对齐有没有出问题。但网络错误、401 这类跟对齐无关的失败绝不能算进来，判据是：
     * 好歹翻出了东西，或者真的因为错位拆过块。 */
    const countable = r.out.size > 0 || ctx.split > 0;
    const align = countable ? {
      batches: 1,
      split: ctx.split,
      repaired: ctx.repaired,
      dropped: r.missing.length,
      dirty: ctx.split > 0 || r.missing.length > 0 ? 1 : 0
    } : null;

    if (usage || align) await addUsage(usage, align);
    if (job.cancelled) return { ok: false, cancelled: true, error: '已取消', usage };

    if (!r.out.size) return {
      ok: false,
      error: ctx.error || '模型没有返回可用的译文',
      usage,
      split: ctx.split,
      retryAfter: ctx.retryAfter || 0
    };

    const map = {};
    for (const [id, t] of r.out) map[String(id)] = t;

    return {
      ok: true,
      map,
      usage,
      dropped: r.missing.map((m) => m.id),
      repaired: ctx.repaired,
      split: ctx.split,
      retryAfter: ctx.retryAfter || 0
    };
  } finally {
    closeJob(job);
  }
}

/* 缺号碰到了首行或末行 —— 编号整体平移的指纹，这一块的对齐全都不可信。
 *
 * 最常见的是合并：输入 12 段，模型把第 3、4 段并成一句，于是只输出 11 行、
 * 编号 1..11。每个编号都落在有效区间里，光看编号毫无破绽，可是从第 3 段起
 * 每一段装的都是下一段的译文 —— 一路错到批尾，缺的是第 12 段。
 *
 * 把这种当成「漏了几段」去补翻，前面错位的一大截会原封不动留下来，还会按原文
 * 哈希写进缓存 —— 刷新页面重新命中缓存，错位就永远回不来了。所以缺口只要碰到
 * 任何一端，就整块作废重来。只有夹在中间的窟窿，才说明前后编号都对得上。 */
function edgeGap(missing, total) {
  if (!missing.length) return false;
  return missing[0].n === 1 || missing[missing.length - 1].n === total;
}

/**
 * 翻一块。items = [{id, text}]，返回 { out: Map(id -> 译文), missing: [item] }。
 * 每层内部重新编号 1..N（数字短更省 token，也比全局序号更不容易错位）。
 */
async function translateChunk(ctx, items, depth) {
  if (stopped(ctx)) return { out: new Map(), missing: items };
  const numbered = items.map((it, i) => ({ n: i + 1, id: it.id, text: it.text }));

  const collect = (m) => {
    const out = new Map();
    for (const it of numbered) {
      const t = String((m && m[it.n]) || '').trim();
      if (t) out.set(it.id, t);
    }
    return out;
  };

  let r = await askModel(ctx.s, numbered, '', ctx.title, ctx.job);
  bumpUsage(ctx.totals, r.usage);
  noteRetryAfter(ctx, r);
  if (stopped(ctx)) return { out: new Map(), missing: items };
  let out = r.error ? new Map() : collect(r.map);

  /* 一行都没认出来，而且这次请求本身是成功的 —— 那就是模型没按 "<n>|译文" 回。
   * 编号一丢就没有任何办法校验对齐，绝不能拿「行数正好相等」当依据照单全收，
   * 只能重问一次、把格式要求说死。
   * 必须挡住 r.error：401、网络中断、超时跟格式毫无关系，重问只会把等待和计费翻倍。 */
  if (!r.error && !out.size && !stopped(ctx)) {
    const again = await askModel(ctx.s, numbered, 'strict', ctx.title, ctx.job);
    bumpUsage(ctx.totals, again.usage);
    noteRetryAfter(ctx, again);
    if (!again.error) { r = again; out = collect(again.map); }
  }

  if (!out.size) {
    if (!ctx.error) ctx.error = r.error || '模型没有按行给出译文';
    return { out: new Map(), missing: items };
  }

  const missing = numbered.filter((it) => !out.has(it.id));
  if (!missing.length) return { out, missing: [] };

  if (edgeGap(missing, numbered.length)) {
    // 拆成两半重来。块越小，模型越不会去合并相邻段；就算再错，作废的也只有一半。
    if (numbered.length > 1 && depth < MAX_SPLIT) {
      ctx.split++;
      const mid = Math.ceil(items.length / 2);
      const a = await translateChunk(ctx, items.slice(0, mid), depth + 1);
      const b = await translateChunk(ctx, items.slice(mid), depth + 1);
      const out2 = new Map(a.out);
      for (const [k, v] of b.out) out2.set(k, v);
      return { out: out2, missing: a.missing.concat(b.missing) };
    }
    /* 拆到头还在错位：这一块整个不要。宁可这几段只显示原文，也不能把「错一位」的
       译文贴上去 —— 那比没有更误导，还会毒化缓存。 */
    if (!ctx.error) ctx.error = '有几段模型反复错位，已跳过（只显示原文）';
    ctx.split++;
    return { out: new Map(), missing: items };
  }

  /* 缺号散在中间：模型明确留空了某几段，前后编号仍然对得上，单独补翻是安全的。 */
  const fixItems = missing.map((m, i) => ({ n: i + 1, id: m.id, text: m.text }));
    if (stopped(ctx)) return { out: new Map(), missing: items };
    const fix = await askModel(ctx.s, fixItems, 'repair', ctx.title, ctx.job);
    bumpUsage(ctx.totals, fix.usage);
    noteRetryAfter(ctx, fix);
  if (!fix.error) {
    // 补翻也可能合并。只有整整齐齐补全了才敢用，缺一段就整份不要
    const all = fixItems.every((it) => String(fix.map[it.n] || '').trim());
    if (all) {
      for (const it of fixItems) {
        out.set(it.id, String(fix.map[it.n]).trim());
        ctx.repaired++;
      }
      return { out, missing: [] };
    }
  }
  return { out, missing: missing.map((m) => ({ id: m.id, text: m.text })) };
}

function bumpUsage(totals, u) {
  if (!u) return;
  totals.prompt_tokens += Number(u.prompt_tokens || u.input_tokens || 0);
  totals.completion_tokens += Number(u.completion_tokens || u.output_tokens || 0);
  /* 前缀缓存命中单独记，而且要分清「服务商压根没回报」和「回报了 0」：前者说明
   * 这个接口不告诉你，后者才说明真的没命中。 */
  const c = cachedTokens(u);
  if (c !== null) {
    totals.cached_tokens += c;
    totals.cached_reports += 1;
  }
}

function noteRetryAfter(ctx, r) {
  const ms = Number((r && r.retryAfter) || 0);
  if (ms > 0) ctx.retryAfter = Math.max(Number(ctx.retryAfter) || 0, ms);
}

/** 这次请求里有多少输入 token 命中了前缀缓存。各家放的位置不一样，取不到返回 null。 */
function cachedTokens(u) {
  if (!u) return null;
  const d = u.prompt_tokens_details || u.input_tokens_details || {};
  const n = d.cached_tokens !== undefined ? d.cached_tokens
          : u.cache_read_input_tokens !== undefined ? u.cache_read_input_tokens
          : u.prompt_cache_hit_tokens;
  return typeof n === 'number' ? n : null;
}

/* 用户消息里的脚手架，全部用英文 —— 跟系统提示同一种语言。
 * repair 和 strict 发出去的时机，正是模型上一轮已经出过错的时候，是整条链路上最
 * 需要指令被不折不扣执行的一句话，措辞刻意跟系统提示对齐，用同一套记法。 */
const repairHead = (n) =>
  `[Your previous reply omitted these ${n} lines. Translate every one — exactly one "<n>|<translation>" per input line. Do not merge lines. No other text.]`;
const strictHead = (n) =>
  `[Your previous reply did not follow the format. Output exactly ${n} lines, each starting with its input number and a pipe, like "1|translation". Never merge lines. Output nothing else.]`;

/**
 * 发一次请求，返回 { map: {n: 译文}, usage, error }。mode：
 *   ''       正常翻
 *   'repair' 补翻上次漏掉的那几段
 *   'strict' 上次连编号都没带回来，把格式要求说死了重问
 */
async function askModel(s, items, mode, title, job) {
  const userParts = [];
  if (mode === 'repair') userParts.push(repairHead(items.length));
  if (mode === 'strict') userParts.push(strictHead(items.length));
  /* 段落里的换行必须抹平：编号靠行首识别，正文里留一个换行，那一段的后半截就成了
     一行没有编号的孤儿，parseLines 会直接把它丢掉。 */
  userParts.push(items.map((it) => `${it.n}|${oneLine(it.text)}`).join('\n'));

  const body = {
    model: s.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(s, title) },
      { role: 'user', content: userParts.join('\n') }
    ],
    stream: false
  };
  applyReasoning(body, s);
  if (s.temperature !== '' && s.temperature !== null && !isNaN(Number(s.temperature))) {
    body.temperature = Number(s.temperature);
  }
  if (s.maxTokens !== '' && s.maxTokens !== null && !isNaN(Number(s.maxTokens))) {
    body.max_tokens = Number(s.maxTokens);
  }

  let data;
  try {
    data = await postJson(joinUrl(s.baseUrl), s.apiKey, body, 90000, 1, job);
  } catch (e) {
    return {
      map: {}, usage: null, error: errText(e),
      code: (e && e.code) || 'network',
      retryAfter: (e && e.retryAfter) || 0
    };
  }

  const content =
    (data && data.choices && data.choices[0] && data.choices[0].message &&
      (data.choices[0].message.content || '')) || '';
  if (!content.trim()) {
    return { map: {}, usage: data && data.usage, error: '模型返回空内容（可能是推理档位太高、max_tokens 太小或模型不支持）' };
  }

  return { map: parseLines(content, items), usage: data.usage || null, error: null, retryAfter: 0 };
}

export function oneLine(t) {
  return String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
}

/** 把 "<n>|译文" 解析成 { n: 译文 }。认不出编号的行一律丢掉，绝不猜它属于哪一段。 */
function parseLines(content, items) {
  const map = {};
  const cleaned = content.replace(/\r/g, '').split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !/^```/.test(x));

  const valid = new Set(items.map((it) => String(it.n)));
  for (const line of cleaned) {
    const m = line.match(/^(\d+)\s*[|｜:：]\s*(.*)$/);
    if (!m || !valid.has(m[1])) continue;   // 没编号、或编号超出这一块的范围
    const t = m[2].trim();
    if (t) map[m[1]] = t;
  }
  /* 这里刻意没有「行数正好对得上就按顺序填」的兜底：那等于把唯一能校验对齐的信息
     （编号）扔掉去猜，而行数太容易凑巧对上（并了一段、末尾又客气一句）。
     认不出编号就当没给，缺哪几段交给上层严格补翻或拆块重来。 */
  return map;
}

/* 并发 3 时，三个批次不能在 429 后各睡 1.2 秒再一起撞墙。按接口 origin 共用
   冷却时间：优先听 Retry-After，没有就 2/4/8… 秒退避，单次最多 30 秒。 */
const RATE_CAP = 30000;
const RATE_BASE = 2000;
const cooldowns = new Map();

function rateKey(url) {
  try { return new URL(url).origin; } catch (_) { return String(url || ''); }
}

function rateWait(url) {
  const c = cooldowns.get(rateKey(url));
  return c ? Math.max(0, c.until - Date.now()) : 0;
}

function rateHit(url, requested) {
  const k = rateKey(url);
  const c = cooldowns.get(k) || { until: 0, step: 0 };
  const ladder = Math.min(RATE_CAP, RATE_BASE * Math.pow(2, c.step));
  const wait = Math.min(RATE_CAP, requested > 0 ? requested : ladder);
  c.step = Math.min(4, c.step + 1);
  c.until = Date.now() + wait;
  cooldowns.set(k, c);
  return wait;
}

function rateClear(url) {
  const k = rateKey(url);
  const c = cooldowns.get(k);
  if (c && c.until <= Date.now()) cooldowns.delete(k);
}

function retryAfterMs(res) {
  let v = '';
  try { v = (res && res.headers && res.headers.get && res.headers.get('Retry-After')) || ''; } catch (_) {}
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(RATE_CAP, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.min(RATE_CAP, Math.max(0, t - Date.now())) : 0;
}

async function postJson(url, key, body, timeoutMs, retries, job) {
  let lastErr = null;
  let rateTries = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (job && job.cancelled) throw cancelError();
    const queued = rateWait(url);
    if (queued > 0) {
      await sleep(queued);
      if (job && job.cancelled) throw cancelError();
    }
    const ctrl = new AbortController();
    if (job) job.ctrls.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const done = () => { clearTimeout(timer); if (job) job.ctrls.delete(ctrl); };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      done();

      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 300);
        try {
          const j = JSON.parse(text);
          detail = (j.error && (j.error.message || j.error.code)) || detail;
        } catch (_) {}
        const err = new Error(`HTTP ${res.status}: ${detail}`);
        /* 暂时性的才重发：408 超时、425 太早、429 限流，以及所有 5xx。
         * 其余（400 请求不合法、401 key 不对、404 模型名不对……）都是配置错了，
         * 重发一模一样的请求只会得到一模一样的拒绝。 */
        if (res.status === 429) {
          const wait = rateHit(url, retryAfterMs(res));
          if (rateTries++ < 1 && attempt < retries) { lastErr = err; continue; }
          err.code = 'rate';
          err.retryAfter = Math.max(wait, rateWait(url));
          err.noRetry = true;
          throw err;
        }
        const transient = res.status === 408 || res.status === 425 || res.status >= 500;
        if (transient) {
          lastErr = err;
          if (attempt < retries) { await sleep(1200 * (attempt + 1)); continue; }
          throw err;
        }
        err.noRetry = true;
        throw err;
      }
      rateClear(url);
      return JSON.parse(text);
    } catch (e) {
      done();
      if (job && job.cancelled) throw cancelError();
      lastErr = e;
      if (e && e.noRetry) throw e;
      if (e && e.name === 'AbortError') { if (attempt < retries) continue; throw new Error('请求超时'); }
      if (attempt >= retries) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr || new Error('请求失败');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 缓存索引
 *
 * { 缓存键: 最后使用时间 }。淘汰旧缓存时只读这一份，不必把所有译文正文读进内存。
 * 维护它是「读出来 → 改 → 写回去」，而写入方不止一个：每个标签页都在写，设置页
 * 清空缓存时也在写。两边各写回自己那份，后写的把先写的整个盖掉 —— 被盖掉的键
 * 对应的译文正文从此没人清理，存储只增不减。所以索引只在这里改，并串成一条队列。
 * ------------------------------------------------------------------ */
let cacheQueue = Promise.resolve();

/** payload: { op: 'touch' | 'forget' | 'clear' | 'write', key, items?, prune?: { days, max } } */
function cacheIndexOp(payload) {
  const task = cacheQueue.then(() => runCacheOp(payload || {}));
  // 一次失败不能把整条队列卡死，也不能把这次的返回值漏给下一次
  cacheQueue = task.then(() => {}, () => {});
  return task;
}

async function runCacheOp(p) {
  if (p.op === 'clear') {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('c_'));
    if (keys.length) await chrome.storage.local.remove(keys);
    await chrome.storage.local.set({ cacheIndex: {} });
    return keys.length;
  }

  const key = p.key || '';
  if (!key) return 0;

  /* 内容脚本只送这次新增的译文，正文也在这条队列里读-改-写。
     同一页面开两个标签时，后完成的不会拿自己的旧副本盖掉先完成的。 */
  if (p.op === 'write') await mergeCacheBody(key, p.items);

  const got = await chrome.storage.local.get('cacheIndex');
  const idx = got.cacheIndex || {};
  if (p.op === 'forget') {
    delete idx[key];
    // 删除和写入在同一队列：点「重翻本页」后，不会被一笔迟到的落盘重新写回来
    await chrome.storage.local.remove(key);
  } else idx[key] = Date.now();

  const drop = p.prune ? staleKeys(idx, p.prune) : [];
  for (const k of drop) delete idx[k];
  if (drop.length) await chrome.storage.local.remove(drop);
  await chrome.storage.local.set({ cacheIndex: idx });
  return drop.length;
}

async function mergeCacheBody(key, items) {
  if (!items || typeof items !== 'object' || !Object.keys(items).length) return;
  const got = await chrome.storage.local.get(key);
  const cur = got[key] && got[key].m ? got[key] : { m: {} };
  Object.assign(cur.m, items);
  cur.t = Date.now();
  await chrome.storage.local.set({ [key]: cur });
}

/** 过期的，加上超出条数上限的。刚 touch 过的那条时间最新、排在最前，不会淘汰掉自己。 */
function staleKeys(idx, opt) {
  const days = Number(opt.days) || 30;
  const max = Number(opt.max) || 400;
  const cutoff = Date.now() - days * 86400000;
  const expired = [], live = [];
  for (const k of Object.keys(idx)) ((idx[k] || 0) < cutoff ? expired : live).push(k);
  live.sort((a, b) => (idx[b] || 0) - (idx[a] || 0));
  return expired.concat(live.slice(max));
}

/* ------------------------------------------------------------------ *
 * 用量统计
 *
 * 统计是「读出来 → 加 → 写回去」，并发的批次同时完成会互相覆盖，串成一条队列。
 * align 那几个计数回答的是一个具体问题：改了提示词之后，逐段对齐是变好还是变差。
 * 翻得好不好没法自动判，但错位有客观指纹 —— 拆过块、留了空、最后放弃了几段。
 * ------------------------------------------------------------------ */
let usageQueue = Promise.resolve();
const ALIGN_KEYS = ['batches', 'split', 'repaired', 'dropped', 'dirty'];

function addUsage(usage, align) {
  usageQueue = usageQueue.then(async () => {
    const got = await chrome.storage.local.get('stats');
    const st = got.stats || { requests: 0, prompt: 0, completion: 0, since: Date.now() };
    if (usage) {
      st.requests = (st.requests || 0) + 1;
      st.prompt = (st.prompt || 0) + Number(usage.prompt_tokens || usage.input_tokens || 0);
      st.completion = (st.completion || 0) + Number(usage.completion_tokens || usage.output_tokens || 0);
      st.cached = (st.cached || 0) + Number(usage.cached_tokens || 0);
      st.cachedReports = (st.cachedReports || 0) + Number(usage.cached_reports || 0);
    }
    if (align) for (const k of ALIGN_KEYS) st[k] = (st[k] || 0) + Number(align[k] || 0);
    await chrome.storage.local.set({ stats: st });
  }).catch(() => {});
  return usageQueue;
}

/* ------------------------------------------------------------------ *
 * 设置页的连通性测试
 * ------------------------------------------------------------------ */
async function testApi(override) {
  const s = Object.assign({}, DEFAULTS, await getSettings(), override || {});
  if (!s.apiKey) return { ok: false, error: '缺少 API Key' };
  if (!(await hasApiPermission(s.baseUrl))) return { ok: false, error: PERM_HINT };

  const body = {
    model: s.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(s, 'Attention Is All You Need') },
      { role: 'user', content: '1|The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.\n2|We propose a new simple network architecture, the Transformer.' }
    ],
    stream: false
  };
  applyReasoning(body, s);

  const t0 = Date.now();
  const data = await postJson(joinUrl(s.baseUrl), s.apiKey, body, 60000, 0);
  const content =
    (data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content) || '';
  return {
    ok: true,
    ms: Date.now() - t0,
    sample: content.trim().slice(0, 300),
    usage: data.usage || null,
    model: s.model,
    /* 推理这块光看设置判断不了：「推理参数写法」只决定发哪个字段名，到底关没关得由
       模型说了算。把「我发了什么」和「它烧了多少推理 token」一起报出来 ——
       设成关闭却还在烧，就是选错写法了。 */
    reasoning: {
      level: s.reasoning || 'none',
      style: s.reasoningStyle || 'effort',
      sent: reasoningFields(body),
      used: reasoningTokens(data.usage)
    },
    cached: cachedTokens(data.usage)
  };
}

function reasoningFields(body) {
  const out = {};
  for (const k of ['reasoning_effort', 'enable_thinking', 'thinking_budget']) {
    if (k in body) out[k] = body[k];
  }
  return out;
}

/** 模型实际花掉的推理 token。取不到返回 null（不是 0）。 */
function reasoningTokens(u) {
  if (!u) return null;
  const d = u.completion_tokens_details || u.output_tokens_details || {};
  const n = d.reasoning_tokens !== undefined ? d.reasoning_tokens : u.reasoning_tokens;
  return typeof n === 'number' ? n : null;
}

/* 给测试用的导出，浏览器里走不到 */
export const __test = { edgeGap, parseLines, buildSystemPrompt, applyReasoning, joinUrl, staleKeys, safeTitle, oneLine };
