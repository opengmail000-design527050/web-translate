/* 切段与过滤 —— 整个插件里最容易悄悄出错的一段。
 *
 * 切错了不会报任何错：要么把一整块 <article> 当成一段（译文糊成一坨），
 * 要么把每个 <span> 都切开（token 白花好几倍），两种都只有肉眼能发现。
 * 所以这里的断言全是「切出几段、分别是什么」。
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const { El, h } = require('./dom.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，想要 ${JSON.stringify(want)}`);

/** 把 content.js 跑起来，返回它的测试钩子 */
function load(settings) {
  const noop = () => {};
  const T = {};
  const doc = {
    title: 'Attention Is All You Need',
    readyState: 'complete',
    body: h('body'),
    documentElement: h('html'),
    createElement: (t) => new El(t),
    getElementById: () => null,
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
    querySelector: (sel) => doc.body.querySelectorAll(sel)[0] || null,
    addEventListener: noop
  };
  const win = {
    __BT_TEST__: T,
    location: { href: 'https://arxiv.org/abs/1706.03762', origin: 'https://arxiv.org', pathname: '/abs/1706.03762', search: '', hostname: 'arxiv.org' },
    document: doc,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: noop,
    getComputedStyle: (el) => ({ display: (el && el.display) || 'block', fontSize: '16px', color: 'rgb(20, 20, 20)' }),
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: {
      i18n: { getUILanguage: () => 'zh-CN' },
      storage: { local: { get: async () => ({ settings: settings || {} }), set: async () => {}, remove: async () => {} } },
      runtime: { sendMessage: async () => ({ ok: true, map: {} }), onMessage: { addListener: noop } }
    }
  };
  win.window = win;
  const ctx = vm.createContext(win);
  ctx.location = win.location;
  ctx.document = doc;
  ctx.chrome = win.chrome;
  ctx.getComputedStyle = win.getComputedStyle;
  ctx.IntersectionObserver = win.IntersectionObserver;
  ctx.MutationObserver = win.MutationObserver;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/content.js'), 'utf8'), ctx);
  return { T, doc };
}

const { T, doc } = load();
T.St.S.minChars = 4;
T.St.targetCode = 'zh-CN';

const texts = (root) => T.collect(root).map((d) => T.unitText(d));

/* ---------------- 最基本的一层 ---------------- */
{
  const root = h('div', [
    h('p', 'The dominant sequence transduction models are based on complex networks.'),
    h('p', 'We propose a new simple network architecture.')
  ]);
  eq('两个 <p> 切成两段', texts(root), [
    'The dominant sequence transduction models are based on complex networks.',
    'We propose a new simple network architecture.'
  ]);
}

/* ---------------- 行内元素不该拆开 ---------------- */
{
  const root = h('div', [
    h('p', ['We propose the ', h('em', 'Transformer'), ', based solely on ', h('a', { href: '#' }, 'attention'), '.'])
  ]);
  eq('行内元素并回同一段', texts(root),
     ['We propose the Transformer, based solely on attention.']);
}

/* ---------------- 嵌套的块要往下钻 ---------------- */
{
  const root = h('article', [
    h('div', [
      h('h2', 'Model Architecture'),
      h('div', [h('p', 'Most competitive models have an encoder-decoder structure.')])
    ])
  ]);
  eq('钻到最深的那一层块', texts(root),
     ['Model Architecture', 'Most competitive models have an encoder-decoder structure.']);
}

/* ---------------- 代码不能翻 ---------------- */
{
  const root = h('div', [
    h('p', 'Install it first:'),
    h('pre', 'pip install torch'),
    h('p', ['Then call ', h('code', 'model.forward()'), ' in your loop.'])
  ]);
  eq('<pre> 整块跳过，行内 <code> 也不进原文', texts(root),
     ['Install it first:', 'Then call in your loop.']);
}

/* ---------------- 用户明确说了别翻 ---------------- */
{
  const root = h('div', [
    h('p', { translate: 'no' }, 'Do not translate this line at all.'),
    h('p', { class: 'notranslate' }, 'This one is marked notranslate too.'),
    h('p', { 'aria-hidden': 'true' }, 'Hidden from the accessibility tree.'),
    h('p', 'This one is fine to translate.')
  ]);
  eq('translate=no / notranslate / aria-hidden 全部跳过', texts(root),
     ['This one is fine to translate.']);
}

/* ---------------- 正文里的链接绝不能把段落切开 ----------------
   这是 0.1.0 的真实故障：往下钻时把所有元素子节点都压了栈，行内的 <a> <b>
   于是各自成了一段，而链接之间的纯文本节点根本不是元素，压根没进过栈 ——
   一段带三个链接的正文因此从后半截被切得七零八落。 */
{
  const root = h('div', [
    h('p', [
      'Researchers at ', h('a', { href: '/g' }, 'Google'),
      ' proposed the architecture in ', h('a', { href: '/p' }, 'Attention Is All You Need'),
      ', which replaced ', h('b', 'recurrence'), ' with self-attention entirely.'
    ])
  ]);
  eq('三个链接的一段正文仍是完整一段', texts(root),
     ['Researchers at Google proposed the architecture in Attention Is All You Need, ' +
      'which replaced recurrence with self-attention entirely.']);
  ok('没有任何行内元素自己成段', T.collect(root).length === 1, String(T.collect(root).length));
}

/* ---------------- 块级和行文混排：游离的那截不能丢 ---------------- */
{
  const root = h('div', [
    h('div', [
      'This article needs more citations. Please help ',
      h('a', { href: '/e' }, 'improve it'),
      ' by adding references.',
      h('p', 'A separate paragraph that is its own block.')
    ])
  ]);
  eq('游离行文单独成段，块级子元素照旧下钻', texts(root), [
    'This article needs more citations. Please help improve it by adding references.',
    'A separate paragraph that is its own block.'
  ]);
  const ds = T.collect(root);
  ok('游离的那截是 run 单元（带 nodes）', Array.isArray(ds[0].nodes), JSON.stringify(!!ds[0].nodes));
  ok('整段的 <p> 是整元素单元', ds[1].nodes === null, JSON.stringify(ds[1].nodes));
}

/* ---------------- X 的推文那种结构 ---------------- */
{
  const tweet = h('div', { 'data-testid': 'tweetText', dir: 'auto' }, [
    h('span', 'The thing nobody tells you about scaling laws '),
    h('span', 'is that they are empirical, not fundamental.')
  ]);
  const root = h('article', [h('div', [h('div', 'Elon'), tweet])]);
  eq('推文正文是一段，用户名单独一段', texts(root),
     ['Elon', 'The thing nobody tells you about scaling laws is that they are empirical, not fundamental.']);
}

/* ---------------- display:inline 的 <div> 不能把段落切开 ----------------
   X 的真实结构：正文里的链接包在一个 <div style="display:inline"> 里。
   只看标签名的话 DIV 一律算块级，这一段会被切成「前半截 / 链接 / 句号」三段，
   每段单独送去翻译 —— 读起来支离破碎，token 也白花。 */
{
  const root = h('div', [
    h('div', [
      h('span', 'In the last month, developers migrated 10 code packages using Claude Fable 5, Claude Opus 4.8, and'),
      h('div', { disp: 'inline' }, [h('a', { href: '/w' }, ' dynamic workflows')]),
      h('span', '.')
    ])
  ]);
  eq('display:inline 的 div 并回同一段', texts(root),
     ['In the last month, developers migrated 10 code packages using Claude Fable 5, ' +
      'Claude Opus 4.8, and dynamic workflows.']);
  ok('整段只有一个单元', T.collect(root).length === 1, String(T.collect(root).length));
}

/* ---------------- display:block 的 <span> 反过来也要切开 ---------------- */
{
  const root = h('div', [
    h('span', { disp: 'block' }, 'A heading rendered with a span.'),
    h('span', { disp: 'block' }, 'And a body paragraph, also a span.')
  ]);
  eq('display:block 的 span 各自成段', texts(root),
     ['A heading rendered with a span.', 'And a body paragraph, also a span.']);
}

/* ---------------- 藏起来的东西不花钱 ---------------- */
{
  const root = h('div', [
    h('div', { disp: 'none' }, 'Hidden template text that nobody will ever read.'),
    h('p', 'A visible paragraph worth translating.')
  ]);
  eq('display:none 整块跳过', texts(root), ['A visible paragraph worth translating.']);
}

/* ---------------- 已经登记过的元素不重复切 ---------------- */
{
  const root = h('div', [h('p', 'A paragraph that will be registered first.')]);
  const first = T.addUnits(T.collect(root));
  const second = T.addUnits(T.collect(root));
  ok('第一遍登记 1 段', first.length === 1, String(first.length));
  ok('第二遍一段都不再登记', second.length === 0, String(second.length));
}

/* ---------------- 只翻正文：网页外壳挡在门外 ---------------- */
{
  T.St.uiFilter = true;
  const c = T.isChrome;
  ok('<nav> 是外壳', c(h('nav')));
  ok('<aside> 是外壳', c(h('aside')));
  ok('<button> 是外壳', c(h('button')));
  ok('role=navigation 是外壳', c(h('div', { role: 'navigation' })));
  ok('role=banner 是外壳', c(h('div', { role: 'banner' })));
  ok('role=contentinfo 是外壳', c(h('div', { role: 'contentinfo' })));
  ok('class 带 sidebar 是外壳', c(h('div', { class: 'left sidebar wide' })));
  ok('id 带 breadcrumb 是外壳', c(h('div', { id: 'breadcrumb' })));
  ok('评论区是外壳', c(h('div', { class: 'comment-list' })));

  // 反向：这些必须留下，错杀正文比漏翻导航严重得多
  ok('<article> 不是外壳', !c(h('article')));
  ok('<p> 不是外壳', !c(h('p')));
  ok('文章自己的 header 不是外壳', !c(h('div', { class: 'article-header' })));
  ok('文章自己的 footer 不是外壳', !c(h('div', { class: 'post-footer' })));
  ok('class 里含 menu 字样但不成词的不误杀', !c(h('div', { class: 'documentation' })));
}

/* ---------------- 只翻正文：整棵外壳子树都不进原文 ---------------- */
{
  T.St.uiFilter = true;
  const root = h('div', [
    h('nav', [h('a', { href: '/' }, 'Home'), h('a', { href: '/about' }, 'About us page')]),
    h('p', 'The actual article paragraph that we came here to read.'),
    h('aside', [h('p', 'Related stories you might also enjoy reading.')]),
    h('div', { class: 'site-footer' }, [h('p', 'Copyright and a pile of legal text.')])
  ]);
  eq('导航 / 侧栏 / 页脚全部不翻', texts(root),
     ['The actual article paragraph that we came here to read.']);

  T.St.uiFilter = false;
  const all = texts(root);
  ok('切到「整页都翻」就都回来了', all.length === 4, String(all.length));
  T.St.uiFilter = true;
}

/* ---------------- 正文容器识别 ---------------- */
{
  T.St.uiFilter = true;
  const body = h('body', [
    h('nav', [h('a', { href: '/' }, 'Home'), h('a', { href: '/x' }, 'Products'), h('a', { href: '/y' }, 'Pricing')]),
    h('div', { class: 'wrap' }, [
      h('div', { class: 'col' }, [
        h('p', 'The dominant sequence transduction models are based on complex recurrent networks that take a long time to train properly.'),
        h('p', 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms and nothing else at all.'),
        h('p', 'Experiments on two machine translation tasks show these models to be superior in quality while being more parallelisable.')
      ])
    ]),
    h('aside', [h('p', 'A short sidebar.')])
  ]);
  doc.body = body;
  const root = T.findMainRoot();
  ok('钻到了装着三段正文的那一层', root === body.children[1].children[0],
     root.tagName + '.' + (root.attrs.class || ''));
  eq('从正文容器切出来的就是那三段', T.collect(root).map((d) => T.unitText(d)).length, 3);
}

/* ---------------- 内容散在好几个孩子里就停住，别钻过头 ---------------- */
{
  const body = h('body', [
    h('div', { class: 'feed' }, [
      h('div', [h('p', 'First post, long enough to clear the minimum length below which narrowing the root is not worth the trouble at all.')]),
      h('div', [h('p', 'Second post, long enough to clear the minimum length below which narrowing the root is not worth the trouble at all.')]),
      h('div', [h('p', 'Third post, long enough to clear the minimum length below which narrowing the root is not worth the trouble at all.')])
    ])
  ]);
  doc.body = body;
  const root = T.findMainRoot();
  ok('停在装着三条内容的那一层，不会只挑一条',
     root === body.children[0], root.tagName + '.' + (root.attrs.class || ''));
  eq('三条都切出来了', T.collect(root).map((d) => T.unitText(d)).length, 3);
}

/* ---------------- 标题在正文容器外面时也要捞回来 ----------------
   X 就是这样：文章标题和正文容器是平级的，只扫正文容器会把标题漏掉，
   而论文和长文里标题恰恰是最该翻的一行。 */
{
  T.St.uiFilter = true;
  T.St.S.scope = 'main';
  const col = h('div', { class: 'col' }, [
    h('p', 'The dominant sequence transduction models are based on complex recurrent networks that take a long time to train properly.'),
    h('p', 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms and nothing else at all.'),
    h('p', 'Experiments on two machine translation tasks show these models to be superior in quality while being more parallelisable.')
  ]);
  const body = h('body', [
    h('nav', [h('a', { href: '/' }, 'Home'), h('a', { href: '/x' }, 'Products')]),
    h('h1', 'Attention Is All You Need'),
    h('div', { class: 'wrap' }, [col])
  ]);
  doc.body = body;
  const roots = T.resolveRoots();
  ok('正文容器 + 标题，两个根', roots.length === 2, String(roots.length));
  const got = roots.flatMap((r) => T.collect(r).map((d) => T.unitText(d)));
  ok('标题回来了', got.includes('Attention Is All You Need'), JSON.stringify(got.slice(0, 2)));
  ok('正文三段也都在', got.length === 4, String(got.length));

  T.St.S.scope = 'page';
  ok('整页模式只有一个根，就是 body', T.resolveRoots().length === 1);
  T.St.S.scope = 'main';
}

/* ---------------- 哪些不值得花钱 ---------------- */
{
  const w = T.worthTranslating;
  ok('太短的按钮文字不翻', !w('OK'));
  ok('纯数字日期不翻', !w('2024-05-01'));
  ok('纯符号不翻', !w('· — ·'));
  ok('单独一条网址不翻', !w('https://arxiv.org/abs/1706.03762'));
  ok('正常英文句子要翻', w('Attention is all you need.'));
  ok('中文不再翻一遍', !w('注意力就是你所需要的一切，这一段已经是中文了。'));
  ok('中英混排但以英文为主，要翻', w('The Transformer 架构 is based on attention mechanisms entirely.'));
  ok('日文即使有汉字也要翻', w('私はこの論文を読んでいます、とても面白いです。'));
}

/* ---------------- 组批 ---------------- */
{
  T.St.S.batchUnits = 3;
  T.St.S.batchChars = 40;
  T.St.queue.length = 0;
  T.St.queue.push({ hash: 'a', text: 'x'.repeat(20) });
  T.St.queue.push({ hash: 'b', text: 'y'.repeat(20) });
  T.St.queue.push({ hash: 'c', text: 'z'.repeat(20) });
  const b1 = T.takeBatch();
  eq('字符数到顶就收批', b1.map((x) => x.id), ['a', 'b']);

  T.St.S.batchChars = 4000;
  T.St.queue.length = 0;
  for (const k of ['a', 'b', 'c', 'd']) T.St.queue.push({ hash: k, text: 'short' });
  eq('条数到顶就收批', T.takeBatch().map((x) => x.id), ['a', 'b', 'c']);

  T.St.queue.length = 0;
  T.St.S.batchChars = 10;
  T.St.queue.push({ hash: 'big', text: 'q'.repeat(9000) });
  eq('超长的一段自己占一批，不会被卡住', T.takeBatch().map((x) => x.id), ['big']);

  T.St.queue.length = 0;
  T.St.S.batchUnits = 0;
  T.St.S.batchChars = 0;
  T.St.queue.push({ hash: 'safe', text: 'still moves' });
  eq('损坏的零值设置不会让队列永久卡住', T.takeBatch().map((x) => x.id), ['safe']);
}

/* ---------------- 去重 ---------------- */
{
  const a = T.hashText('Attention is all you need.');
  const b = T.hashText('Attention is all you need.');
  const c = T.hashText('Attention is all you needed.');
  ok('同样的文字得到同一个哈希', a === b);
  ok('差一个字母就换哈希', a !== c);
}

console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
