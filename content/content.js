/* 网页分段翻译。
 *
 * 整条链路：切段 → 过滤 → 进入视野 → 去重 → 查缓存 → 组批 → 交给 background 翻 → 回填。
 *
 * 省 token 的四道闸门，按拦截率从高到低：
 *   1. 只翻进入视野的段落（长文章往往只读前三分之一）
 *   2. 同一段文字在页面里出现多次，只翻一次（导航、页脚、重复卡片）
 *   3. 本地缓存按「原文哈希」存，同一段换页面、换标签页都命中
 *   4. 明显不用翻的直接扔掉（已经是目标语言、纯数字日期、太短的按钮文字）
 *
 * content script 不能用 ES module，DEFAULTS 在这里有一份副本，
 * 改 common.js 时两边要保持一致。
 */
(() => {
  'use strict';
  if (window.__btLoaded) return;
  window.__btLoaded = true;

  const DEFAULTS = {
    enabled: true,
    autoSites: [],
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-luna',
    targetLang: 'auto',
    reasoningStyle: 'effort_none',
    scope: 'main',
    layout: 'both',
    markStyle: 'line',
    transFont: 'inherit',
    transScale: 1,
    lazy: true,
    batchChars: 1600,
    batchUnits: 12,
    concurrency: 3,
    minChars: 4,
    useCache: true,
    cacheDays: 30,
    cacheMax: 400,
    useTitle: true,
    temperature: '',
    maxTokens: '',
    extraPrompt: ''
  };

  const CODE_TO_NAME = {
    'zh': '简体中文', 'zh-CN': '简体中文', 'zh-SG': '简体中文', 'zh-Hans': '简体中文',
    'zh-TW': '繁體中文', 'zh-HK': '繁體中文', 'zh-Hant': '繁體中文',
    'en': 'English', 'ja': '日本語', 'ko': '한국어', 'fr': 'Français', 'de': 'Deutsch',
    'es': 'Español', 'ru': 'Русский', 'pt': 'Português', 'it': 'Italiano',
    'th': 'ไทย', 'vi': 'Tiếng Việt', 'ar': 'العربية', 'hi': 'हिन्दी'
  };
  const NAME_TO_CODE = (() => {
    const m = {};
    for (const [c, n] of Object.entries(CODE_TO_NAME)) if (!m[n]) m[n] = c;
    Object.assign(m, { '中文': 'zh', '英文': 'en', '英语': 'en', '日文': 'ja', '日语': 'ja', '韩语': 'ko' });
    return m;
  })();

  /* ---------------------------------------------------------------- *
   * 切段
   * ---------------------------------------------------------------- */

  /* 整棵子树都不看。代码块尤其要紧：把 pre / code 里的东西翻了，是最讨厌的一种破坏，
     而且它们的 token 还特别贵。 */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'LINK', 'META',
    'PRE', 'CODE', 'KBD', 'SAMP', 'VAR', 'TT',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'OPTGROUP',
    'CANVAS', 'SVG', 'MATH', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'TRACK',
    'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'MAP', 'AREA'
  ]);

  /* 铁定行内的标签：它们是段落的一部分，不该自己单独成段。 */
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'DATA', 'DFN', 'EM', 'FONT', 'I',
    'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
    'TIME', 'U', 'WBR', 'LABEL', 'BIG', 'STRIKE', 'ACRONYM', 'NOBR', 'INS', 'DEL'
  ]);

  /* 计算样式里的 display。查一次就记下来 —— 单页应用滚动时每隔几百毫秒就要重扫一遍，
     不缓存的话同一批元素会被反复问。实测 X 的长文整页一趟不到 10 毫秒。 */
  let dispCache = new WeakMap();
  function displayOf(el) {
    let d = dispCache.get(el);
    if (d === undefined) {
      try { d = getComputedStyle(el).display || ''; } catch (_) { d = ''; }
      dispCache.set(el, d);
    }
    return d;
  }

  /**
   * 行内还是块级 —— 由 display 说了算，标签名只在拿不到计算样式时兜底。
   *
   * 只看标签名是不够的，这是 X 上的真实故障：它把正文里的链接包在一个
   * <div style="display:inline"> 里 ——
   *     DIV[block]  ├ SPAN "In the last month, …"
   *                 ├ DIV[inline] " dynamic workflows"
   *                 └ SPAN "."
   * DIV 一律当块级的话，这一段会被切成「前半截 / 链接 / 句号」三段，各自送去翻译，
   * 读起来支离破碎，token 也白花。反过来 <span style="display:block"> 当标题用的
   * 站点也不少，那时候又必须切开 —— 两个方向都只有 display 答得对。
   *
   * display:contents 故意不算行内：它可能包着好几个真正的块，当成行内会把几段话
   * 糊成一段；当块级则会照常往下钻，结果是对的。
   */
  function isInline(el) {
    const d = displayOf(el);
    if (d) return d.startsWith('inline') || d.startsWith('ruby');
    return INLINE_TAGS.has(el.tagName);
  }

  /* ---------------------------------------------------------------- *
   * 网页外壳：导航、侧栏、按钮、Cookie 条……
   *
   * 这些东西翻出来既没人看，又实实在在地花钱：一页里它们的条数常常比正文还多。
   * 三种判据从可靠到不可靠排：语义标签 > ARIA 角色 > 类名关键词。
   * 类名那一层刻意收得很窄 —— 漏掉几个导航只是小浪费，
   * 而错杀正文（比如把 class 里带 header 的文章标题当成页眉）用户是会当成 bug 的。
   * ---------------------------------------------------------------- */
  const UI_TAGS = new Set(['NAV', 'ASIDE', 'DIALOG', 'MENU', 'BUTTON']);

  const UI_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'searchbox',
    'menu', 'menubar', 'menuitem', 'toolbar', 'tablist', 'tab', 'dialog', 'alertdialog',
    'button', 'checkbox', 'radiogroup', 'switch', 'slider', 'combobox', 'listbox',
    'progressbar', 'tooltip', 'status'
  ]);

  /* 故意不含 header / footer 这两个词：文章自己的 .article-header、.post-footer
     里装的是标题和作者，是正文的一部分。页眉页脚交给上面的角色判据和正文容器识别。 */
  const UI_WORDS = /(^|[-_ ])(nav|navbar|navigation|menu|sidebar|sidenav|masthead|topbar|breadcrumb|toolbar|site-header|page-header|global-header|site-footer|page-footer|widget|promo|advert|adsense|share|social|cookie|consent|newsletter|subscribe|paginat|pager|skip-link|sr-only|screen-reader|visually-hidden|comment|comments|related|recommend|trending|who-to-follow)([-_ ]|$)/i;

  let chromeCache = new WeakMap();

  /** 这个元素是网页外壳而不是正文吗。只在「只翻正文」模式下起作用。 */
  function isChrome(el) {
    let v = chromeCache.get(el);
    if (v !== undefined) return v;
    v = computeChrome(el);
    chromeCache.set(el, v);
    return v;
  }

  function computeChrome(el) {
    if (UI_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role && UI_ROLES.has(role.toLowerCase())) return true;
    /* className 在 SVG 元素上是个对象而不是字符串，统一转一下。
       X 那种混淆过的类名（css-146c3p1）这一层拦不住，靠正文容器识别去挡。 */
    const cls = typeof el.className === 'string' ? el.className : '';
    const id = el.id || '';
    if (cls && UI_WORDS.test(cls)) return true;
    if (id && UI_WORDS.test(id)) return true;
    return false;
  }

  function isSkipped(el) {
    if (!el || el.nodeType !== 1) return true;
    if (St.uiFilter && isChrome(el)) return true;          // 只翻正文时，网页外壳一律不看
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.dataset && el.dataset.bt) return true;          // 我们自己插的译文
    if (el.id === 'bt-toast') return true;
    if (el.isContentEditable) return true;                 // 编辑器里绝不动手
    const t = el.getAttribute && el.getAttribute('translate');
    if (t === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    return false;
  }

  /** 把一个节点底下的字原样接起来（不做归一化，留给 unitText 最后统一处理）。
   *  跳过我们插的译文，以及 pre / code 这类不该翻的子树。 */
  function rawText(n, acc) {
    if (n.nodeType === 3) { acc.s += n.nodeValue; return; }
    if (n.nodeType !== 1) return;
    if (n.tagName === 'BR') { acc.s += ' '; return; }
    if (isSkipped(n)) return;
    for (let c = n.firstChild; c; c = c.nextSibling) rawText(c, acc);
  }

  /** 一个单元的原文。u.nodes 为空表示「整个元素就是一段」。 */
  function unitText(u) {
    const acc = { s: '' };
    if (u.nodes) for (const n of u.nodes) rawText(n, acc);
    else for (let c = u.el.firstChild; c; c = c.nextSibling) rawText(c, acc);
    return acc.s.replace(/\s+/g, ' ').trim();
  }

  /** 便宜的「这底下有字吗」，用于判断要不要往下钻。 */
  const hasText = (el) => !!(el.textContent && el.textContent.trim());

  const MAX_UNITS = 4000;      // 再多就不是「读文章」了，别把页面拖垮
  const MAX_TEXT = 2500;       // 单段上限，超了自己占一批

  /**
   * 切段。返回 [{ el, nodes }]：
   *   nodes 为 null —— 整个元素就是一段（最常见，<p> 之类）
   *   nodes 为数组 —— 元素里的一截「行内连续段」，用于块级和行文混排的容器
   *
   * 关键在于往下钻的时候**只钻块级子元素**。行内元素（<a> <b> <span>…）是段落的
   * 一部分，绝不能自己成段 —— 早先的版本把所有元素子节点一股脑压栈，于是一段带
   * 三个链接的正文会被切成三个 <a> 加零星碎片，而链接之间的纯文本节点根本不是
   * 元素，压根就没进过栈，整段话读起来就是「从后半截被切开了」。
   *
   * 混排容器（<div>一句话<p>另一段</p></div>）里那截游离的行文也不能丢，
   * 所以它单独成一个 run 单元，译文插在这一截的后面 —— 不包 <span>、不动 DOM 结构，
   * React 那类框架重绘时不会跟我们打架。
   */
  function collect(root) {
    const found = [];
    const stack = [root];
    while (stack.length) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      if (isSkipped(el)) continue;
      if (St.owned.has(el)) continue;                // 整个元素已经是一段，里面没别的
      if (!hasText(el)) continue;
      if (displayOf(el) === 'none') continue;        // 藏起来的东西不翻，省钱也省得帮倒忙

      const blocks = [];
      const runs = [];
      let run = null;
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1) {
          /* 跳过的元素既不打断行文也不进原文：句子中间的 <code>、行内图标 <svg>、
             我们自己插的译文，都不该把一句话切成两半。 */
          if (isSkipped(n) || displayOf(n) === 'none') continue;
          if (!isInline(n) && hasText(n)) { blocks.push(n); run = null; continue; }
          if (!run) { run = []; runs.push(run); }
          run.push(n);
          continue;
        }
        if (n.nodeType !== 3) continue;
        if (!n.nodeValue.trim() && !run) continue;    // 块与块之间的排版空白
        if (!run) { run = []; runs.push(run); }
        run.push(n);
      }

      if (!blocks.length) { found.push({ el, nodes: null }); continue; }
      for (const r of runs) if (!St.owned.has(r[0])) found.push({ el, nodes: r });
      for (let i = blocks.length - 1; i >= 0; i--) stack.push(blocks[i]);
      if (found.length > MAX_UNITS) break;
    }
    return found;
  }

  /* ---------------------------------------------------------------- *
   * 正文在哪
   *
   * 从 <body> 往下钻，每层跟着「字最多的那个孩子」走，直到内容散在好几个孩子里为止 ——
   * 那一层就是正文容器。导航和侧栏总是正文的兄弟节点，字数比正文少，自然就被落下了。
   *
   * 语义标签（<main> <article>）只在它确实装着页面大部分文字时才认：X 的时间线上
   * 每条推文都是一个 <article>，认了就只翻其中一条。这时候交给逐层下钻，
   * 它会停在装着所有推文的那一列上。
   * ---------------------------------------------------------------- */

  /** 元素里有多少字，其中多少落在链接里。导航和侧栏几乎全是链接。 */
  function textStats(el) {
    const total = (el.textContent || '').trim().length;
    if (!total) return { total: 0, link: 0, density: 1 };
    let link = 0;
    try {
      for (const a of el.querySelectorAll('a')) link += (a.textContent || '').trim().length;
    } catch (_) {}
    return { total, link, density: link / total };
  }

  /* 一个孩子要装下父节点这么多比例的字，才算「正文就在它里面」。
     再低就说明内容是分散的，该停在父节点这一层。 */
  const DESCEND_RATIO = 0.7;
  const MIN_ROOT_TEXT = 300;      // 短页面不值得挑，整页翻就是了
  const LINKY = 0.6;              // 链接占比超过这个数的，是导航或侧栏，不是正文

  function findMainRoot() {
    const body = document.body;
    if (!body) return null;
    const whole = (body.textContent || '').trim().length;
    if (whole < MIN_ROOT_TEXT) return body;

    /* 1. 语义容器只当下钻的**起点**，不当答案。
       X 的 <main> 里同时装着正文列和右边的「你可能感兴趣」，直接认了等于没筛。
       而且它得装着页面大部分文字才算数 —— 时间线上每条推文都是一个 <article>，
       认了就只翻其中一条。 */
    let start = body, bestLen = 0;
    try {
      for (const el of document.querySelectorAll('main, [role="main"], article')) {
        if (isSkipped(el) || displayOf(el) === 'none') continue;
        const n = (el.textContent || '').trim().length;
        if (n > bestLen) { start = el; bestLen = n; }
      }
    } catch (_) {}
    if (bestLen < whole * 0.4) start = body;

    /* 2. 逐层下钻：某一层里有一个孩子独占了这一层大部分正文，就钻进去；
       内容散在好几个孩子里（一堆并列的段落、一列推文）就停在这一层。
       比的是「同层可翻内容的总量」而不是父节点的全部文字 —— 否则一个大导航栏
       就能把比例压到阈值以下，逼得我们停在最外层，等于没筛。 */
    let node = start;
    for (let depth = 0; depth < 40; depth++) {
      let pick = null, pickLen = 0, sum = 0;
      for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
        if (isSkipped(c) || displayOf(c) === 'none') continue;
        const st = textStats(c);
        if (st.density > LINKY) continue;          // 一堆链接，是导航或侧栏
        sum += st.total;
        if (st.total > pickLen) { pick = c; pickLen = st.total; }
      }
      if (!pick || pickLen < MIN_ROOT_TEXT) break;
      if (pickLen < sum * DESCEND_RATIO) break;
      node = pick;
    }
    return node;
  }

  /** 要扫描的根。可能不止一个：正文容器 + 落在它外面的标题。 */
  function resolveRoots() {
    if (St.S.scope === 'page') return [document.body];
    const root = findMainRoot() || document.body;
    const out = [root];
    /* 正文容器往往不含标题 —— 标题在它外面、和它平级（X 就是这样）。
       <h1> 基本就是页面标题，单独捞一条回来：论文和长文里它是最该翻的一行。 */
    try {
      const h1 = document.querySelector('h1');
      if (h1 && root !== document.body && !root.contains(h1) && !isSkipped(h1)) out.push(h1);
    } catch (_) {}
    return out;
  }

  /* ---------------------------------------------------------------- *
   * 过滤：哪些段不值得花钱
   * ---------------------------------------------------------------- */
  const HAS_LETTER = /\p{L}/u;
  const HAN = /[一-鿿㐀-䶿]/g;
  const KANA = /[぀-ヿ]/g;
  const HANGUL = /[가-힯]/g;
  const CJK_ANY = /[一-鿿㐀-䶿぀-ヿ가-힯]/;

  /** 已经是目标语言了就别翻。判错的代价不对称：漏翻一段用户自己能看出来，
   *  把中文再「翻」一遍成中文，是白花钱还把原文改坏。所以阈值取得保守。 */
  function looksLikeTarget(text) {
    const base = String(St.targetCode || '').toLowerCase().split('-')[0];
    if (!base) return false;
    const dense = text.replace(/\s/g, '');
    const len = dense.length;
    if (!len) return true;

    if (base === 'zh') {
      // 假名一多就是日文，还得翻
      if ((dense.match(KANA) || []).length / len > 0.05) return false;
      if ((dense.match(HANGUL) || []).length / len > 0.05) return false;
      return (dense.match(HAN) || []).length / len > 0.3;
    }
    if (base === 'ja') return (dense.match(KANA) || []).length / len > 0.1;
    if (base === 'ko') return (dense.match(HANGUL) || []).length / len > 0.2;
    if (base === 'en') return !CJK_ANY.test(text);
    return false;
  }

  function worthTranslating(text) {
    if (text.length < St.S.minChars) return false;
    if (!HAS_LETTER.test(text)) return false;              // 纯数字、日期、符号
    if (/^[\d\s.,:/·—–-]+$/.test(text)) return false;
    if (/^https?:\/\/\S+$/.test(text)) return false;
    if (looksLikeTarget(text)) return false;
    return true;
  }

  /* ---------------------------------------------------------------- *
   * 状态
   * ---------------------------------------------------------------- */
  const St = {
    S: Object.assign({}, DEFAULTS),
    targetCode: 'zh-CN',
    targetName: '简体中文',
    active: false,
    booted: false,
    uiFilter: true,           // 只翻正文时才挡网页外壳，见 isSkipped
    roots: null,              // 要扫描的根：正文容器（+ 落在它外面的标题）
    fellBack: false,          // 正文识别落空、已经退回整页

    /* 节点 -> 单元。整元素单元记在元素自己头上，run 单元记在它覆盖的每个子节点上 ——
       重扫时靠它认出「这块已经翻过了」。 */
    owned: new WeakMap(),
    watch: new WeakMap(),     // 元素 -> [单元]，同一个元素可能有两截 run
    units: [],                // 所有单元
    byHash: new Map(),        // 原文哈希 -> [单元]，同一段文字只翻一次
    text: new Map(),          // 原文哈希 -> 译文（本页内存缓存）

    queue: [],                // 待发的 { hash, text }
    inflight: 0,
    retrying: 0,              // 正按 Retry-After 等待的批次数
    sessionId: Date.now().toString(36) + Math.random().toString(36).slice(2),
    epoch: 0,                 // 页面 / 配置每作废一次就递增；旧请求回来时据此丢弃
    batchSeq: 0,
    done: 0,
    failed: 0,
    error: '',

    io: null,
    mo: null,
    href: location.href,

    cacheKey: '',
    cacheMap: null,
    cachePending: {},         // 上次落盘之后新买到的译文，只把增量送给 background
    cacheDirty: false,
    cacheTimer: null,
    toastTimer: null,
    scanTimer: null,
    activating: null
  };

  /* FNV-1a。哈希只用来当缓存键和去重键，撞了最坏是两段短文字共用一份译文，
     所以把长度接在后面，短文字之间几乎不可能再撞。 */
  function hashText(t) {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36) + t.length.toString(36);
  }

  function applyRuntimeSettings(raw) {
    St.S = Object.assign({}, DEFAULTS, raw || {});
    St.uiFilter = St.S.scope !== 'page';
    const t = String(St.S.targetLang || 'auto').trim();
    if (!t || t.toLowerCase() === 'auto') {
      let ui = 'zh-CN';
      try { ui = chrome.i18n.getUILanguage() || 'zh-CN'; } catch (_) {}
      St.targetCode = ui;
      St.targetName = CODE_TO_NAME[ui] || CODE_TO_NAME[ui.split('-')[0]] || ui;
    } else {
      St.targetCode = NAME_TO_CODE[t] || '';
      St.targetName = t;
    }
    return St.S;
  }

  async function loadSettings() {
    let got = {};
    try { got = await chrome.storage.local.get('settings'); } catch (_) {}
    return applyRuntimeSettings(got.settings);
  }

  /* ---------------------------------------------------------------- *
   * 缓存
   *
   * 一页一条记录：{ t: 时间, m: { 原文哈希: 译文 } }。
   * 键里带上模型和目标语言 —— 换了模型或换了语言，旧译文就不该再命中。
   * ---------------------------------------------------------------- */
  function cacheSignature() {
    const base = String(St.S.baseUrl || '').trim().replace(/\/+$/, '');
    const defaultBase = String(DEFAULTS.baseUrl).replace(/\/+$/, '');
    const extra = [];
    /* 0.1.0 的默认缓存键只含 URL、模型和目标语言。默认设置继续沿用老键，避免升级后
       把已经买过的译文全丢掉；只有真正改变译文内容的非默认设置才追加 v2 签名。 */
    if (base !== defaultBase) extra.push(['base', base]);
    if ((St.S.reasoningStyle || '') !== DEFAULTS.reasoningStyle) extra.push(['reasoningStyle', St.S.reasoningStyle || '']);
    if (String(St.S.temperature ?? '') !== String(DEFAULTS.temperature)) extra.push(['temperature', String(St.S.temperature ?? '')]);
    if (String(St.S.maxTokens ?? '') !== String(DEFAULTS.maxTokens)) extra.push(['maxTokens', String(St.S.maxTokens ?? '')]);
    if (St.S.useTitle === false) extra.push(['useTitle', false]);
    if (String(St.S.extraPrompt || '').trim()) extra.push(['extraPrompt', String(St.S.extraPrompt).trim()]);
    return extra.length ? '|v2|' + JSON.stringify(extra) : '';
  }

  function pageCacheKey() {
    const u = location.origin + location.pathname + location.search;
    return 'c_' + hashText(u + '|' + (St.S.model || '') + '|' + St.targetName + cacheSignature());
  }

  async function loadCache(epoch) {
    const key = pageCacheKey();
    let map = {};
    if (!St.S.useCache) {
      if (epoch !== St.epoch || !St.active) return false;
      St.cacheKey = key;
      St.cacheMap = map;
      St.cachePending = {};
      St.cacheDirty = false;
      return true;
    }
    try {
      const got = await chrome.storage.local.get(key);
      const rec = got[key];
      if (rec && rec.m) map = rec.m;
    } catch (_) {}
    if (epoch !== St.epoch || !St.active) return false;
    St.cacheKey = key;
    St.cacheMap = map;
    St.cachePending = {};
    St.cacheDirty = false;
    for (const [h, v] of Object.entries(map)) St.text.set(h, v);
    // 顺手让 background 更新索引并淘汰旧页面（只有它能改索引，见 background.js）
    fire({ type: 'cacheIndex', payload: { op: 'touch', key, prune: { days: St.S.cacheDays, max: St.S.cacheMax } } });
    return true;
  }

  function cachePut(hash, tr) {
    if (!St.S.useCache || !St.cacheMap) return;
    St.cacheMap[hash] = tr;
    St.cachePending[hash] = tr;
    St.cacheDirty = true;
    clearTimeout(St.cacheTimer);
    St.cacheTimer = setTimeout(flushCache, 2000);
  }

  async function flushCache() {
    if (!St.cacheDirty || !St.cacheKey) return;
    const key = St.cacheKey;
    const items = St.cachePending;
    St.cachePending = {};
    St.cacheDirty = false;
    if (!Object.keys(items).length) return;
    try {
      const res = await send({
        type: 'cacheWrite',
        payload: { op: 'write', key, items,
                   prune: { days: St.S.cacheDays, max: St.S.cacheMax } }
      });
      if (!res || !res.ok) throw new Error('缓存写入失败');
    } catch (_) {
      /* 如果期间没换页面 / 配置，就把没送出去的增量还回去，下次继续写。
         键已经变了则不能混进新缓存；旧页面的请求此时也已经被 epoch 作废。 */
      if (key === St.cacheKey) {
        Object.assign(St.cachePending, items);
        St.cacheDirty = true;
      }
    }
  }
  window.addEventListener('beforeunload', flushCache);
  window.addEventListener('pagehide', flushCache);
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushCache();
    });
  } catch (_) {}

  /* ---------------------------------------------------------------- *
   * 登记与渲染
   * ---------------------------------------------------------------- */
  function addUnits(descs) {
    const fresh = [];
    for (const d of descs) {
      if (St.units.length >= MAX_UNITS) break;
      if (St.owned.has(d.nodes ? d.nodes[0] : d.el)) continue;
      const text = unitText(d);
      if (!text || text.length > MAX_TEXT * 4) continue;
      if (!worthTranslating(text)) continue;

      const u = { el: d.el, nodes: d.nodes, text, hash: hashText(text), node: null, status: 'new' };
      if (d.nodes) for (const n of d.nodes) St.owned.set(n, u);
      else St.owned.set(d.el, u);

      const list = St.watch.get(d.el);
      list ? list.push(u) : St.watch.set(d.el, [u]);

      St.units.push(u);
      fresh.push(u);
    }
    return fresh;
  }

  /** 译文节点。原文是什么排版，译文就跟着什么排版，只加最少的装饰。 */
  function makeNode(u) {
    const node = document.createElement('font');
    node.setAttribute('data-bt', '1');
    node.className = 'bt-tr';
    if (St.S.markStyle === 'line') node.classList.add('bt-mark-line');
    if (St.S.transFont === 'serif') node.style.fontFamily = 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif';
    if (St.S.transFont === 'sans') node.style.fontFamily = 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif';

    const cs = getComputedStyle(u.el);
    const scale = Number(St.S.transScale) || 1;

    /* 「仅译文」和「淡化原文」都是往整个元素上加类，可 run 单元只占元素的一截，
       整个元素一起处理会连它的块级子元素也一并压掉。这种单元一律照双语显示。 */
    const whole = !u.nodes;

    if (whole && St.S.layout === 'transOnly') {
      /* 原文整体被压成 font-size: 0（这是唯一能连纯文本节点一起收掉的办法），
         所以译文必须自带一个绝对字号，不能再 inherit。 */
      const px = parseFloat(cs.fontSize) || 16;
      node.style.fontSize = (px * scale).toFixed(1) + 'px';
      u.el.classList.add('bt-only');
    } else if (scale !== 1) {
      node.style.fontSize = scale + 'em';
    }

    if (whole && St.S.markStyle === 'dim') {
      /* 原文交给 .bt-dim 染灰，译文在这里钉死成原来的颜色 ——
         不这么做的话译文会跟着一起灰掉（继承）。 */
      node.style.color = cs.color;
      u.el.classList.add('bt-dim');
    }

    if (u.nodes) {
      // 就插在这一截行文的后面，不动元素的其余部分
      const last = u.nodes[u.nodes.length - 1];
      dropStale(last.nextSibling);
      u.el.insertBefore(node, last.nextSibling);
    } else if (cs.display === 'inline' && u.el.parentNode) {
      /* display:inline 的元素塞不进块级子节点（会撑出奇怪的行盒），
         这种就挂到它后面当兄弟。 */
      node.classList.add('bt-sib');
      dropStale(u.el.nextSibling);
      u.el.parentNode.insertBefore(node, u.el.nextSibling);
    } else {
      /* 其余一律放进元素内部 —— 这样译文继承原文的字体、行高、对齐、缩进，
         是最不容易被页面样式冲垮的做法。 */
      for (let c = u.el.firstElementChild; c; ) {
        const next = c.nextElementSibling;
        dropStale(c);
        c = next;
      }
      u.el.appendChild(node);
    }
    return node;
  }

  /* React 重绘会把我们记在节点上的所有权标记连同节点一起换掉，重扫时就会给同一段
   * 再插一份译文 —— X 上表现为链接的译文出现两次，一次在原文前、一次在原文后。
   * 插之前先把这个位置上残留的旧译文收走，比事后去猜哪份是新的可靠得多。 */
  function dropStale(n) {
    if (n && n.nodeType === 1 && n.dataset && n.dataset.bt) n.remove();
  }

  function showLoading(u) {
    if (u.node || u.status === 'done') return;
    u.node = makeNode(u);
    u.node.classList.add('bt-loading');
    u.node.textContent = '';
  }

  function showText(u, tr) {
    if (!u.node) u.node = makeNode(u);
    u.node.classList.remove('bt-loading');
    u.node.textContent = tr;
    if (u.status !== 'done') { u.status = 'done'; St.done++; }
    u.el.classList.remove('bt-failed');
  }

  function showFail(u) {
    if (u.node) { u.node.remove(); u.node = null; }
    /* 这两个类是「原文让位给译文」用的，译文没来就得原样还回去 ——
       漏掉 bt-dim 的话，翻失败的那一段会永远灰在那儿，还没有译文顶上。 */
    u.el.classList.remove('bt-only', 'bt-dim');
    u.el.classList.add('bt-failed');
    if (u.status !== 'failed') { u.status = 'failed'; St.failed++; }
  }

  function clearUnit(u) {
    if (u.node) { u.node.remove(); u.node = null; }
    u.el.classList.remove('bt-only', 'bt-dim', 'bt-failed');
  }

  /** 单页应用经常复用同一个元素，只替换里面的文字；无限滚动还会不断移除旧节点。
   *  owned 只回答「以前登记过没有」，不能证明它现在还是原来那段。每次重扫先核对：
   *  断开文档的单元释放掉，原文变了的单元撤掉旧译文，让后面的 collect 重新登记。 */
  function reconcileUnits() {
    if (!St.units.length) return 0;
    const keep = [];
    let removed = 0;
    for (const u of St.units) {
      const connected = typeof u.el.isConnected === 'boolean' ? u.el.isConnected : !!u.el.parentNode;
      const changed = connected && unitText(u) !== u.text;
      if (connected && !changed) { keep.push(u); continue; }

      removed++;
      if (u.status === 'done') St.done = Math.max(0, St.done - 1);
      if (u.status === 'failed') St.failed = Math.max(0, St.failed - 1);
      if (St.io) { try { St.io.unobserve(u.el); } catch (_) {} }
      clearUnit(u);

      if (u.nodes) for (const n of u.nodes) St.owned.delete(n);
      else St.owned.delete(u.el);

      const watched = St.watch.get(u.el) || [];
      const leftWatch = watched.filter((x) => x !== u);
      if (leftWatch.length) St.watch.set(u.el, leftWatch);
      else St.watch.delete(u.el);

      const waiting = St.byHash.get(u.hash) || [];
      const left = waiting.filter((x) => x !== u);
      if (left.length) St.byHash.set(u.hash, left);
      else {
        St.byHash.delete(u.hash);
        St.queue = St.queue.filter((x) => x.hash !== u.hash);
      }
    }
    St.units = keep;
    return removed;
  }

  /* ---------------------------------------------------------------- *
   * 排队与发送
   * ---------------------------------------------------------------- */
  function queueUnit(u) {
    if (!St.active) return;
    if (u.status === 'done' || u.status === 'pending' || u.status === 'queued') return;

    const hit = St.text.get(u.hash);
    if (hit) { showText(u, hit); return; }                 // 缓存或同页重复段落

    if (u.status === 'failed') { St.failed--; u.el.classList.remove('bt-failed'); }

    const waiting = St.byHash.get(u.hash);
    if (waiting) {                                          // 同一段文字已经在路上了
      waiting.push(u);
      u.status = 'pending';
      showLoading(u);
      return;
    }
    St.byHash.set(u.hash, [u]);
    u.status = 'queued';
    showLoading(u);
    St.queue.push({ hash: u.hash, text: u.text, tries: 0 });
    pump();
  }

  /** 一批凑多少段。段落长度差得很远，所以字符数和条数各设一个上限，谁先到算谁。 */
  function takeBatch() {
    const items = [];
    let chars = 0;
    const maxUnits = Math.max(1, Number(St.S.batchUnits) || DEFAULTS.batchUnits);
    const maxChars = Math.max(1, Number(St.S.batchChars) || DEFAULTS.batchChars);
    while (St.queue.length && items.length < maxUnits) {
      const it = St.queue[0];
      if (items.length && chars + it.text.length > maxChars) break;
      St.queue.shift();
      items.push({ id: it.hash, text: it.text, tries: Number(it.tries) || 0 });
      chars += it.text.length;
    }
    return items;
  }

  function pump() {
    const concurrency = Math.max(1, Number(St.S.concurrency) || DEFAULTS.concurrency);
    while (St.active && St.inflight < concurrency && St.queue.length) {
      const items = takeBatch();
      if (!items.length) break;
      const epoch = St.epoch;
      St.inflight++;
      for (const it of items) {
        for (const u of (St.byHash.get(it.id) || [])) u.status = 'pending';
      }
      sendBatch(items, epoch).finally(() => {
        // deactivate 已经把新一版的计数归零；旧一版回来不能再减一次
        if (epoch !== St.epoch) return;
        St.inflight = Math.max(0, St.inflight - 1);
        paintToast();
        pump();
      });
    }
    paintToast();
  }

  const BATCH_DEADLINE = 120000;

  function withDeadline(p, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new Error('后台一直没有回应，这一批先放弃了（可以点重试）');
        e.timeout = true;
        reject(e);
      }, ms);
      Promise.resolve(p).then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  const AUTO_RETRY_MAX = 5;

  /** 429 不是要用户点按钮的永久错误。保留 byHash 里的等待者，冷却后把同一批放回队列。
   *  每个条目有独立次数，封顶后才标红，避免坏接口无限耗电 / 循环请求。 */
  function deferRateRetry(items, epoch, waitMs) {
    if (!(waitMs > 0)) return false;
    const retry = [], exhausted = [];
    for (const it of items) {
      if ((Number(it.tries) || 0) < AUTO_RETRY_MAX) retry.push({ hash: it.id, text: it.text, tries: (Number(it.tries) || 0) + 1 });
      else exhausted.push(it);
    }
    for (const it of exhausted) finishHash(it.id, null);
    if (!retry.length) return false;

    St.retrying++;
    const sec = Math.max(1, Math.round(waitMs / 1000));
    St.error = `接口限流，${sec} 秒后自动重试`;
    setTimeout(() => {
      if (epoch !== St.epoch || !St.active) return;
      St.retrying = Math.max(0, St.retrying - 1);
      for (const it of retry) {
        if (!St.byHash.has(it.hash)) continue;
        for (const u of (St.byHash.get(it.hash) || [])) u.status = 'queued';
        St.queue.push(it);
      }
      if (St.retrying === 0 && St.failed === 0) St.error = '';
      pump();
    }, Math.max(1000, waitMs));
    return true;
  }

  async function sendBatch(items, epoch = St.epoch) {
    const batchId = ++St.batchSeq;
    let res = null;
    try {
      res = await withDeadline(send({
        type: 'translateBatch',
        payload: { items, title: document.title, sessionId: St.sessionId, epoch, batchId }
      }), BATCH_DEADLINE);
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
      if (e && e.timeout && epoch === St.epoch) {
        fire({ type: 'cancel', payload: { sessionId: St.sessionId, epoch, batchId } });
      }
    }

    /* 等待期间换了页面、模型、语言或显示范围：结果已经不属于当前状态。
       尤其不能调用 finishHash，它会使用当前的 cacheKey，把旧译文写进新缓存。 */
    if (epoch !== St.epoch || !St.active) return;

    if (!res || !res.ok) {
      if (res && res.cancelled) return;
      if (deferRateRetry(items, epoch, Number(res && res.retryAfter) || 0)) return;
      St.error = (res && res.error) || '翻译请求失败';
      for (const it of items) finishHash(it.id, null);
      return;
    }
    const map = res.map || {};
    const missing = [];
    for (const it of items) {
      const tr = map[it.id] || null;
      if (tr) finishHash(it.id, tr);
      else missing.push(it);
    }
    if (missing.length && deferRateRetry(missing, epoch, Number(res.retryAfter) || 0)) return;
    for (const it of missing) finishHash(it.id, null);
    if (St.failed === 0 && St.retrying === 0) St.error = '';
  }

  /** 一段文字有结果了（或确定失败了），把等着它的所有单元一起处理掉。 */
  function finishHash(hash, tr) {
    const list = St.byHash.get(hash) || [];
    St.byHash.delete(hash);
    if (tr) {
      St.text.set(hash, tr);
      cachePut(hash, tr);
      for (const u of list) showText(u, tr);
    } else {
      for (const u of list) showFail(u);
    }
  }

  function send(msg) {
    try { return chrome.runtime.sendMessage(msg); }
    catch (e) { return Promise.reject(e); }
  }

  /** 发出去就不管了的消息。插件被重新加载时 sendMessage 会拒绝，
   *  不接住的话控制台里会刷一片红。 */
  function fire(msg) {
    send(msg).catch(() => {});
  }

  /* ---------------------------------------------------------------- *
   * 看得见才翻
   * ---------------------------------------------------------------- */
  function observeUnits(units) {
    if (!St.S.lazy) {
      // 整页一次性翻：也按文档顺序排，先翻上面的
      for (const u of units) queueUnit(u);
      return;
    }
    if (!St.io) {
      St.io = new IntersectionObserver((entries) => {
        /* 一屏里的段落是同时进来的，按纵坐标排一下，
           上面的先翻 —— 用户的视线就在那儿。 */
        const hit = entries.filter((e) => e.isIntersecting);
        hit.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        for (const e of hit) {
          St.io.unobserve(e.target);
          for (const u of (St.watch.get(e.target) || [])) queueUnit(u);
        }
      }, { rootMargin: '600px 0px 600px 0px' });
    }
    for (const u of units) St.io.observe(u.el);
  }

  /* ---------------------------------------------------------------- *
   * 页面变了就再扫一遍（X 这种一路往下加内容的站全靠它）
   * ---------------------------------------------------------------- */
  /** 这个节点是不是我们自己插进去的译文（或它里面的东西） */
  function isOurs(node) {
    if (!node) return false;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest('[data-bt]'));
  }

  function watchDom() {
    if (St.mo) return;
    St.mo = new MutationObserver((records) => {
      if (!St.active) return;
      for (const r of records) {
        /* 自己插的译文别当成新内容。这一条不是可选的优化：showText 往 <font> 里
           写文字，在观察者眼里就是「新增了一个文本节点」—— 不挡掉的话，每翻完一批
           都会引来一次整棵树的重扫。 */
        if (isOurs(r.target)) continue;
        if (r.type === 'characterData') { scheduleScan(); return; }
        for (const n of (r.addedNodes || [])) {
          if (n.nodeType === 1 && !isSkipped(n)) { scheduleScan(); return; }
          if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim() && !isOurs(n.parentNode)) {
            scheduleScan();
            return;
          }
        }
        for (const n of (r.removedNodes || [])) {
          if (!isOurs(n)) { scheduleScan(); return; }
        }
      }
    });
    St.mo.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  function scheduleScan() {
    clearTimeout(St.scanTimer);
    St.scanTimer = setTimeout(scan, 450);
  }

  function scan() {
    if (!St.active || !document.body) return;
    // 单页应用换了地址：旧译文和旧缓存都不再适用
    if (location.href !== St.href) { St.href = location.href; restart(); return; }

    reconcileUnits();

    /* 单页应用换页时会把整棵正文子树换掉，旧的 root 就此脱离文档 —— 得重新找一次，
       否则从此扫的是一棵没人看的树。 */
    if (!St.roots || !St.roots[0] || !St.roots[0].isConnected) St.roots = resolveRoots();

    let fresh = [];
    for (const r of St.roots) fresh = fresh.concat(addUnits(collect(r)));

    /* 正文识别落空了（挑中的容器里一段可翻的都没有）：退回整页。
       宁可多翻点导航，也不能让用户对着一片没动静的页面发呆。 */
    if (!St.units.length && St.roots[0] !== document.body && !St.fellBack) {
      St.fellBack = true;
      St.roots = [document.body];
      fresh = addUnits(collect(document.body));
    }

    if (fresh.length) observeUnits(fresh);
    paintToast();
  }

  /* ---------------------------------------------------------------- *
   * 开 / 关
   * ---------------------------------------------------------------- */
  async function activate(reloadSettings = true) {
    if (St.active) return;
    const epoch = St.epoch;
    if (St.activating && St.activating.epoch === epoch) return St.activating.promise;

    const promise = (async () => {
      if (reloadSettings) await loadSettings();
      if (epoch !== St.epoch || !St.S.enabled) return;
      St.active = true;
      St.error = '';
      if (!(await loadCache(epoch))) return;
      if (epoch !== St.epoch || !St.active) return;
      scan();
      watchDom();
      paintToast(true);
    })();
    const rec = { epoch, promise };
    St.activating = rec;
    try { await promise; }
    finally { if (St.activating === rec) St.activating = null; }
  }

  function bumpEpoch() {
    St.epoch++;
    fire({ type: 'cancel', payload: { sessionId: St.sessionId, epoch: St.epoch } });
    return St.epoch;
  }

  /** quiet：设置页一改动就会广播到每个标签页，那些从没开过翻译的页面不该因此
   *  在角落里闪一下「已收起译文」。 */
  function deactivate(quiet) {
    bumpEpoch();
    St.active = false;
    St.queue.length = 0;
    St.byHash.clear();
    St.inflight = 0;
    St.retrying = 0;
    if (St.io) { St.io.disconnect(); St.io = null; }
    if (St.mo) { St.mo.disconnect(); St.mo = null; }
    for (const u of St.units) clearUnit(u);
    St.units = [];
    St.owned = new WeakMap();
    St.watch = new WeakMap();
    dispCache = new WeakMap();         // 换了页面或改了设置，重新问一遍 display
    chromeCache = new WeakMap();
    St.roots = null;
    St.fellBack = false;
    St.done = 0;
    St.failed = 0;
    const saving = flushCache();
    if (!quiet) paintToast(true);
    return saving;
  }

  /** 设置变了、或者单页应用换了地址：全部推倒重来。 */
  async function restart() {
    const wasActive = St.active || !!St.activating;
    await deactivate(!wasActive);
    St.text.clear();
    if (wasActive) await activate();
  }

  async function purgeCurrentPage() {
    const wasActive = St.active || !!St.activating;
    const key = St.cacheKey;
    /* 先清掉待写增量，再 bump epoch / abort；这样等待删除期间旧请求也没有机会
       回来重新 cachePut。forget 与历史 cacheWrite 共用后台队列，保证删操作排在最后。 */
    St.cacheMap = {};
    St.cachePending = {};
    St.cacheDirty = false;
    St.text.clear();
    await deactivate(true);
    if (key) {
      try {
        const res = await send({ type: 'cacheIndex', payload: { op: 'forget', key } });
        if (!res || !res.ok) throw new Error('后台删除失败');
      } catch (_) {
        // 请求通道坏了时的兜底；此刻已经停掉在途翻译，不会再有正文写入与它竞争
        try { await chrome.storage.local.remove(key); } catch (_) {}
      }
    }
    if (wasActive) await activate();
  }

  /* storage.onChanged 是最终一致性的兜底：设置页广播失败、另一个窗口改配置、
     或 popup 只通知了当前标签页时，所有已经开启翻译的页面仍会跟上。
     reasoning / 缓存期限只影响后续请求或淘汰，不值得把已显示的译文推倒重来。 */
  const RESTART_KEYS = [
    'baseUrl', 'model', 'targetLang', 'reasoningStyle', 'scope', 'layout', 'markStyle',
    'transFont', 'transScale', 'lazy', 'batchChars', 'batchUnits', 'concurrency', 'minChars',
    'useTitle', 'useCache', 'temperature', 'maxTokens', 'extraPrompt'
  ];
  let settingsQueue = Promise.resolve();

  function settingsChanged(raw) {
    const task = settingsQueue.then(async () => {
      const next = Object.assign({}, DEFAULTS, raw || {});
      const old = St.S;
      const changed = Object.keys(next).some((k) => next[k] !== old[k]);
      if (!changed) return;

      const wasActive = St.active || !!St.activating;
      const needsRestart = RESTART_KEYS.some((k) => next[k] !== old[k]);
      const disabling = old.enabled !== false && next.enabled === false;

      /* flushCache 必须仍用旧配置 / 旧缓存键，所以先停，再把新设置灌进来。 */
      if (wasActive && (needsRestart || disabling)) await deactivate(true);
      applyRuntimeSettings(next);
      if (wasActive && needsRestart && next.enabled) await activate(false);
    });
    settingsQueue = task.catch(() => {});
    return task;
  }

  async function readChangedSettings() {
    let got = {};
    try { got = await chrome.storage.local.get('settings'); } catch (_) {}
    return settingsChanged(got.settings);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      settingsChanged(changes.settings.newValue).catch(() => {});
    });
  } catch (_) {}

  /* ---------------------------------------------------------------- *
   * 角落里的小提示（用快捷键的时候，这是唯一的反馈）
   * ---------------------------------------------------------------- */
  function toastEl() {
    let el = document.getElementById('bt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bt-toast';
      el.innerHTML = '<span class="bt-dot"></span><span class="bt-msg"></span>';
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  function paintToast(force) {
    if (!document.body) return;
    const el = toastEl();
    const busy = St.inflight > 0 || St.queue.length > 0 || St.retrying > 0;
    let msg;
    if (!St.active) msg = '已收起译文';
    else if (St.error) msg = '出错了：' + String(St.error).slice(0, 60);
    else if (busy) msg = `正在翻译 ${St.done}/${St.units.length} 段`;
    else if (St.units.length) msg = `已翻译 ${St.done} 段` + (St.failed ? ` · ${St.failed} 段失败` : '');
    else msg = '这一页没有需要翻译的内容';

    el.querySelector('.bt-msg').textContent = msg;
    el.classList.toggle('bt-busy', busy);
    el.classList.toggle('bt-quiet', !busy);

    if (busy || force) {
      el.classList.add('bt-show');
      clearTimeout(St.toastTimer);
      if (!busy) St.toastTimer = setTimeout(() => el.classList.remove('bt-show'), 2200);
    } else {
      clearTimeout(St.toastTimer);
      St.toastTimer = setTimeout(() => el.classList.remove('bt-show'), 1400);
    }
  }

  /* ---------------------------------------------------------------- *
   * 消息
   * ---------------------------------------------------------------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'getStatus') {
      sendResponse({
        ok: true,
        active: St.active,
        host: location.hostname,
        title: document.title,
        total: St.units.length,
        done: St.done,
        failed: St.failed,
        busy: St.inflight > 0 || St.queue.length > 0 || St.retrying > 0,
        error: St.error,
        target: St.targetName,
        scope: St.S.scope,
        fellBack: St.fellBack
      });
      return;
    }

    if (msg.type === 'toggle') {
      const p = St.active ? Promise.resolve(deactivate()) : activate();
      p.then(() => sendResponse({ ok: true, active: St.active }), () => sendResponse({ ok: false }));
      return true;
    }
    if (msg.type === 'setActive') {
      const p = msg.value ? activate() : Promise.resolve(deactivate());
      p.then(() => sendResponse({ ok: true, active: St.active }), () => sendResponse({ ok: false }));
      return true;
    }
    if (msg.type === 'settingsChanged') {
      readChangedSettings().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    }

    if (msg.type === 'retry') {
      St.error = '';
      for (const u of St.units) if (u.status === 'failed') queueUnit(u);
      pump();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'purge') {
      // 这一页的缓存全丢掉重翻（译文和原文对不上时的出口）
      purgeCurrentPage().then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false })
      );
      return true;
    }
  });

  /* ---------------------------------------------------------------- *
   * 启动：默认什么都不做，只有本站被设成自动翻译时才动手。
   * ---------------------------------------------------------------- */
  async function boot() {
    if (St.booted) return;
    St.booted = true;
    await loadSettings();
    if (!St.S.enabled) return;
    if ((St.S.autoSites || []).includes(location.hostname)) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => activate(false), { once: true });
      } else {
        activate(false);
      }
    }
  }

  /* 测试钩子。浏览器里 window.__BT_TEST__ 不存在，这几行什么都不做。 */
  if (typeof window !== 'undefined' && window.__BT_TEST__) {
    Object.assign(window.__BT_TEST__, {
      St, collect, unitText, worthTranslating, looksLikeTarget, isChrome, findMainRoot, resolveRoots,
      hashText, addUnits, takeBatch, queueUnit, loadSettings, reconcileUnits, pageCacheKey
    });
  }

  boot();
})();
