// 共享的默认配置与工具函数（被 background / popup / options 以 ES module 引用）。
// content script 不能用 ES module，里面有一份等价的内联副本，改动时两边保持一致。

export const DEFAULTS = {
  // —— 基本开关 ——
  enabled: true,          // 总开关
  autoSites: [],          // 打开就自动翻译的域名

  // —— API ——
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-5.6-luna',
  // 'auto' = 跟随浏览器界面语言。也可以直接写语言名，例如「简体中文」「繁體中文」
  targetLang: 'auto',

  // —— 推理强度：none / low / medium ——
  reasoning: 'none',
  // 不同厂商的参数写法：
  //  effort_none     -> 三档都发 reasoning_effort（GPT-5 系列默认，"none" 才是真关闭）
  //  effort          -> low/medium 发 reasoning_effort，none 时不发该字段（最保守）
  //  enable_thinking -> 通义 / DeepSeek 风格，发 enable_thinking: true/false
  //  off             -> 永远不发推理参数
  reasoningStyle: 'effort_none',

  // —— 范围与显示 ——
  // main = 只翻正文（自动识别正文容器，排除导航/侧栏/按钮），page = 整页都翻
  scope: 'main',
  layout: 'both',         // both = 原文 + 译文，transOnly = 只显示译文
  markStyle: 'line',      // line = 左侧竖线, none = 无标记, dim = 淡化原文
  transFont: 'inherit',   // inherit = 跟随原文, serif, sans
  transScale: 1,          // 译文相对原文的字号比例

  // —— 省 token ——
  lazy: true,             // 只翻译进入视野的段落（关掉就是整页一次性翻）
  batchChars: 1600,       // 每批最多字符数
  batchUnits: 12,         // 每批最多段落数
  concurrency: 3,         // 并发请求数
  minChars: 4,            // 短于这个长度的块不翻（按钮、日期、序号）
  useTitle: true,         // 把页面标题作为领域提示带上（约 30 token / 批）
  useCache: true,         // 译文缓存到本地，重看不再花钱
  cacheDays: 30,
  cacheMax: 400,          // 最多缓存多少个页面

  // —— 高级 ——
  temperature: '',        // 留空 = 不发送
  maxTokens: '',          // 留空 = 不发送
  extraPrompt: ''         // 附加到系统提示的自定义要求
};

/* ------------------------------------------------------------------ *
 * 语言
 * ------------------------------------------------------------------ */
export const CODE_TO_NAME = {
  'zh': '简体中文', 'zh-CN': '简体中文', 'zh-SG': '简体中文', 'zh-Hans': '简体中文',
  'zh-TW': '繁體中文', 'zh-HK': '繁體中文', 'zh-Hant': '繁體中文',
  'en': 'English', 'ja': '日本語', 'ko': '한국어', 'fr': 'Français', 'de': 'Deutsch',
  'es': 'Español', 'ru': 'Русский', 'pt': 'Português', 'it': 'Italiano',
  'th': 'ไทย', 'vi': 'Tiếng Việt', 'ar': 'العربية', 'hi': 'हिन्दी'
};

export const NAME_TO_CODE = (() => {
  const m = {};
  for (const [code, name] of Object.entries(CODE_TO_NAME)) if (!m[name]) m[name] = code;
  Object.assign(m, { '中文': 'zh', '英文': 'en', '英语': 'en', '日文': 'ja', '日语': 'ja', '韩语': 'ko' });
  return m;
})();

export function uiLanguage() {
  try { return chrome.i18n.getUILanguage() || 'zh-CN'; } catch (_) { return 'zh-CN'; }
}

/** 把设置里的 targetLang 解析成给模型看的语言名。'auto' → 跟随浏览器。 */
export function resolveTargetName(settings) {
  const t = String((settings && settings.targetLang) || 'auto').trim();
  if (t && t.toLowerCase() !== 'auto') return t;
  const ui = uiLanguage();
  return CODE_TO_NAME[ui] || CODE_TO_NAME[ui.split('-')[0]] || ui;
}

/** 目标语言的代码；用户填了无法识别的自定义名称时返回 ''（表示放弃同语言判断）。 */
export function resolveTargetCode(settings) {
  const t = String((settings && settings.targetLang) || 'auto').trim();
  if (!t || t.toLowerCase() === 'auto') return uiLanguage();
  return NAME_TO_CODE[t] || '';
}

export async function getSettings() {
  const got = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULTS, got.settings || {});
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

/* ------------------------------------------------------------------ *
 * 接口配置档
 *
 * 一套服务商就是一档：地址、Key、模型、译文语言、推理参数写法。
 * 存在单独的 profiles 键里，settings 仍然是运行时的唯一真相 ——
 * background 和 content 照旧只读 settings，不需要知道配置档的存在。
 * ------------------------------------------------------------------ */

/** 属于配置档的字段。这几个之外的设置（外观、缓存、省 token）是全局的。 */
export const PROFILE_KEYS = ['baseUrl', 'apiKey', 'model', 'targetLang', 'reasoningStyle'];

export function newProfileId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function pickProfile(src) {
  const o = {};
  for (const k of PROFILE_KEYS) o[k] = src && src[k] !== undefined ? src[k] : DEFAULTS[k];
  return o;
}

/**
 * 读配置档。没有 profiles 键时，拿当前设置原地立一档「默认」，不动任何字段 ——
 * 升级之后打开设置页，看到的必须和升级前一模一样。
 */
export async function getProfiles() {
  const got = await chrome.storage.local.get('profiles');
  const p = got.profiles;
  if (p && Array.isArray(p.list) && p.list.length) {
    // active 指向一个已经被删掉的 id 时兜底回第一档
    const active = p.list.some((x) => x.id === p.active) ? p.active : p.list[0].id;
    return { active, list: p.list };
  }
  const s = await getSettings();
  const one = Object.assign({ id: newProfileId(), name: '默认' }, pickProfile(s));
  const fresh = { active: one.id, list: [one] };
  await chrome.storage.local.set({ profiles: fresh });
  return fresh;
}

export async function saveProfiles(p) {
  await chrome.storage.local.set({ profiles: p });
  return p;
}

/* ------------------------------------------------------------------ *
 * 自定义 API 地址的可选权限
 * manifest 只静态声明了 api.openai.com；填别的地址时按需申请。
 * ------------------------------------------------------------------ */

/** 从 API 地址取出权限模式，如 https://api.example.com/*。取不出来返回 ''。 */
export function originPattern(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\s+/g, '').replace(/#$/, '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.protocol + '//' + u.hostname + '/*';
  } catch (_) { return ''; }
}

/** 是否已经能访问这个地址（manifest 里静态声明过的也算已授权）。 */
export async function hasApiPermission(baseUrl) {
  const origins = originPattern(baseUrl);
  if (!origins) return true;              // 地址本身无效，交给请求阶段报错
  try { return await chrome.permissions.contains({ origins: [origins] }); }
  catch (_) { return true; }
}

/* autoSites 存的是主机名（含子域，精确匹配）。设置页负责增删，
 * content.js 启动时自己比一次 —— 没有第三个地方需要它，就不再抽函数了。 */
