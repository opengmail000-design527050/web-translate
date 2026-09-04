/* 够跑 content.js 的最小 DOM。
 *
 * 只实现切段真正用到的那几样：父子关系、textContent、firstElementChild 那一串、
 * classList / dataset / closest。别的一律不做 —— 做多了就是在测试自己写的 DOM，
 * 而不是在测 content.js。
 */

class TextNode {
  constructor(v) { this.nodeType = 3; this.nodeValue = v; this.parentNode = null; }
  get parentElement() { return this.parentNode; }
  get textContent() { return this.nodeValue; }
  /* sourceText 是靠 firstChild / nextSibling 一路走过去的，文本节点少了这个，
     一段话只要夹了个 <em>，后半截就凭空消失 —— 而真实 DOM 里它是有的。 */
  get nextSibling() {
    const p = this.parentNode; if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] || null;
  }
}

/* 浏览器默认样式表里这些标签是行内的。mini DOM 得照着来，否则测试里
   每个 <em> <a> 都成了块级，切段测的就不是真实浏览器里的行为了。 */
const DEFAULT_INLINE = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'DATA', 'DFN', 'EM', 'FONT', 'I',
  'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
  'TIME', 'U', 'WBR', 'LABEL', 'BIG', 'STRIKE', 'ACRONYM', 'NOBR', 'INS', 'DEL',
  'CODE', 'KBD', 'SAMP', 'VAR', 'TT', 'IMG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'
]);

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.id = '';
    this.isContentEditable = false;
    /* 显式指定的 display。真实浏览器里 <div style="display:inline"> 很常见
       （X 就是这么包正文里的链接的），切段必须看得见它。 */
    this.disp = null;
    const self = this;
    this.classList = {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); self.attrs.class = [...this._s].join(' '); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); self.attrs.class = [...this._s].join(' '); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on === undefined ? (this.contains(c) ? this.remove(c) : this.add(c)) : (on ? this.add(c) : this.remove(c)); }
    };
  }

  /* 真实 DOM 里 className 是字符串，切段判断网页外壳时读的就是它。 */
  get className() { return this.attrs.class || ''; }
  set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); this.attrs.class = String(v); }

  /** 计算样式里的 display：显式指定的优先，否则按默认样式表 */
  get display() { return this.disp || (DEFAULT_INLINE.has(this.tagName) ? 'inline' : 'block'); }

  get parentElement() { return this.parentNode; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }

  get nextSibling() {
    const p = this.parentNode; if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] || null;
  }
  get nextElementSibling() {
    const p = this.parentNode; if (!p) return null;
    const c = p.children;
    return c[c.indexOf(this) + 1] || null;
  }
  get previousElementSibling() {
    const p = this.parentNode; if (!p) return null;
    const c = p.children;
    return c[c.indexOf(this) - 1] || null;
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '') this.appendChild(new TextNode(String(v)));
  }

  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) {
    n.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    i < 0 ? this.childNodes.push(n) : this.childNodes.splice(i, 0, n);
    return n;
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }

  setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }

  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }

  /* 只认得 [data-bt] 这一种选择器 —— content.js 里也只用它。 */
  closest(sel) {
    if (sel !== '[data-bt]') throw new Error('mini DOM 只支持 [data-bt]：' + sel);
    for (let n = this; n; n = n.parentElement) if (n.dataset && n.dataset.bt) return n;
    return null;
  }

  /* 只支持 content.js 用到的那点语法：逗号分隔的「标签名」和「[属性="值"]」。
     再多就是在实现一个选择器引擎，而不是在测切段了。 */
  matches(sel) {
    return sel.split(',').map((x) => x.trim()).filter(Boolean).some((one) => {
      const m = one.match(/^\[([\w-]+)="([^"]*)"\]$/);
      if (m) return this.getAttribute(m[1]) === m[2];
      return this.tagName === one.toUpperCase();
    });
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) { if (c.matches(sel)) out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }
}

/** h('p', '文字') / h('div', [子, 子]) / h('div', { id: 'x' }, [子]) */
function h(tag, a, b) {
  const el = new El(tag);
  let props = null, kids = null;
  if (Array.isArray(a) || typeof a === 'string') kids = a;
  else if (a && typeof a === 'object') { props = a; kids = b; }
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'disp') el.disp = v;
    else if (k === 'id') el.id = v;
    else if (k === 'class') { el.classList.add(...String(v).split(/\s+/)); }
    else el.setAttribute(k, v);
  }
  if (typeof kids === 'string') el.appendChild(new TextNode(kids));
  else if (Array.isArray(kids)) for (const k of kids) el.appendChild(typeof k === 'string' ? new TextNode(k) : k);
  return el;
}

module.exports = { El, TextNode, h };
