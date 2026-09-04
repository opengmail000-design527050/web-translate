/* 逐段对齐 —— 这是唯一一种「出了错也看不出来」的故障。
 *
 * 模型把相邻两段并成一句话回来时，编号会整体平移：输入 4 段、回来 3 行，
 * 每个编号都在有效区间里，光看编号毫无破绽，可是从并的那一段起，每一段装的
 * 都是下一段的译文。这种错位还会按原文哈希写进缓存，刷新页面也回不来。
 * 所以这里断言的是：宁可整块作废重来，也绝不把错位的译文交出去。
 * 全程用桩，不联网。
 */
const fs = require('fs'), vm = require('vm'), path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，想要 ${JSON.stringify(want)}`);

/**
 * 把 background.js 跑起来。
 *   reply(items, body) -> 模型这次回什么（字符串），返回 null 表示 HTTP 500
 * 返回 { t, calls }：calls 是每次真正发出去的请求体
 */
function load(reply, settings) {
  /* common.js 和 background.js 拼成一份普通脚本跑。用真的 common.js 而不是桩，
     DEFAULTS 和目标语言的解析才跟线上是同一套。 */
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^export /gm, '');
  const src = read('common.js') + '\n' +
              read('background.js').replace(/^import .*$/m, '') +
              '\nglobalThis.__t = { translateBatch, testApi, __test };';

  const calls = [];
  const store = { settings: Object.assign({
    apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna',
    targetLang: '简体中文', reasoning: 'none', reasoningStyle: 'effort_none'
  }, settings || {}) };

  const noop = () => {};
  const ctx = {
    console, setTimeout: (f) => setTimeout(f, 0), clearTimeout, AbortController,
    chrome: {
      runtime: { onMessage: { addListener: noop } },
      commands: { onCommand: { addListener: noop } },
      tabs: { query: async () => [], sendMessage: async () => {} },
      permissions: { contains: async () => true },
      i18n: { getUILanguage: () => 'zh-CN' },
      storage: {
        local: {
          get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : store),
          set: async (o) => Object.assign(store, o),
          remove: async () => {}
        }
      }
    },
    fetch: async (url, opt) => {
      const body = JSON.parse(opt.body);
      calls.push(body);
      const items = body.messages[1].content.split('\n').filter((l) => /^\d+\|/.test(l));
      const text = reply(items, body, calls.length);
      if (text === null) return { ok: false, status: 500, text: async () => 'boom' };
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 50 } })
      };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { t: ctx.__t, calls, store };
}

const four = [
  { id: 'a', text: 'The dominant sequence transduction models are based on complex networks.' },
  { id: 'b', text: 'We propose a new simple network architecture, the Transformer.' },
  { id: 'c', text: 'Experiments on two machine translation tasks show these models to be superior.' },
  { id: 'd', text: 'Our model achieves 28.4 BLEU on the WMT 2014 English-to-German task.' }
];

/* ---------------- 一切正常 ---------------- */
(async () => {
  {
    const { t, calls } = load((items) => items.map((l, i) => `${i + 1}|译文${i + 1}`).join('\n'));
    const r = await t.translateBatch({ items: four, title: 'Attention Is All You Need' });
    ok('四段全翻回来', r.ok && Object.keys(r.map).length === 4, JSON.stringify(r));
    eq('按 id 回填，不是按顺序猜', r.map, { a: '译文1', b: '译文2', c: '译文3', d: '译文4' });
    ok('只发了一次请求', calls.length === 1, String(calls.length));
    ok('没有拆过块', r.split === 0);
  }

  /* ---------------- 模型把两段并成一句：必须拆块重来 ---------------- */
  {
    let merged = true;
    const { t, calls } = load((items) => {
      // 第一次（4 段）把 2、3 并掉，只回 3 行；拆小之后老实回
      if (items.length === 4 && merged) {
        merged = false;
        return '1|译文1\n2|译文2和3\n3|译文4';
      }
      return items.map((l, i) => `${i + 1}|小批译文${i + 1}`).join('\n');
    });
    const r = await t.translateBatch({ items: four });
    ok('并段被识破，拆了块', r.split > 0, JSON.stringify({ split: r.split }));
    ok('拆完发了不止一次请求', calls.length > 1, String(calls.length));
    ok('没有把「译文2和3」当成 b 的译文交出去',
       r.map.b !== '译文2和3', JSON.stringify(r.map));
    ok('最终四段都有译文', Object.keys(r.map).length === 4, JSON.stringify(r.map));
  }

  /* ---------------- 中间漏了一段：单独补翻，不必整批重来 ---------------- */
  {
    let first = true;
    const { t, calls } = load((items) => {
      if (first) { first = false; return '1|译文1\n2|译文2\n4|译文4'; }   // 缺 3，缺口在中间
      return items.map((l, i) => `${i + 1}|补的译文`).join('\n');
    });
    const r = await t.translateBatch({ items: four });
    ok('缺口在中间不算错位，没拆块', r.split === 0, JSON.stringify({ split: r.split }));
    ok('补翻了一段', r.repaired === 1, String(r.repaired));
    eq('补的那一段落到正确的 id 上', r.map.c, '补的译文');
    ok('一共两次请求（正常 + 补翻）', calls.length === 2, String(calls.length));
  }

  /* ---------------- 反复错位：宁可只显示原文 ---------------- */
  {
    // 永远少回最后一行，拆到底也一样
    const { t } = load((items) => items.slice(0, -1).map((l, i) => `${i + 1}|译文`).join('\n'));
    const r = await t.translateBatch({ items: four });
    ok('拆到头还错位，就整块放弃', !r.ok || Object.keys(r.map || {}).length < 4, JSON.stringify(r));
  }

  /* ---------------- 认不出编号就当没给 ---------------- */
  {
    const P = load(() => '').t.__test.parseLines;
    eq('正常编号', P('1|甲\n2|乙', [{ n: 1 }, { n: 2 }]), { 1: '甲', 2: '乙' });
    eq('中文竖线和冒号也认', P('1｜甲\n2：乙', [{ n: 1 }, { n: 2 }]), { 1: '甲', 2: '乙' });
    eq('没编号的行一律丢掉，绝不按顺序猜', P('甲\n乙', [{ n: 1 }, { n: 2 }]), {});
    eq('编号超出范围的丢掉', P('1|甲\n9|野的', [{ n: 1 }, { n: 2 }]), { 1: '甲' });
    eq('代码围栏不当成译文', P('```\n1|甲\n```', [{ n: 1 }]), { 1: '甲' });
  }

  /* ---------------- 缺口碰到两端才叫错位 ---------------- */
  {
    const E = load(() => '').t.__test.edgeGap;
    ok('缺第一行 = 错位', E([{ n: 1 }], 4));
    ok('缺最后一行 = 错位', E([{ n: 4 }], 4));
    ok('只缺中间 = 不是错位', !E([{ n: 2 }, { n: 3 }], 4));
    ok('一行都不缺 = 不是错位', !E([], 4));
  }

  /* ---------------- 段落里的换行必须抹平 ---------------- */
  {
    const { t, calls } = load((items) => items.map((l, i) => `${i + 1}|译文`).join('\n'));
    await t.translateBatch({ items: [{ id: 'x', text: 'first line\nsecond line\n\nthird' }] });
    const user = calls[0].messages[1].content;
    ok('多行的一段被压成一行发出去', user.split('\n').length === 1, JSON.stringify(user));
    ok('内容一个字没丢', user === '1|first line second line third', JSON.stringify(user));
  }

  /* ---------------- 推理参数的四种写法 ---------------- */
  {
    const A = load(() => '').t.__test.applyReasoning;
    const b1 = {}; A(b1, { reasoning: 'none', reasoningStyle: 'effort_none' });
    eq('effort_none：关闭也要发 none', b1, { reasoning_effort: 'none' });
    const b2 = {}; A(b2, { reasoning: 'none', reasoningStyle: 'effort' });
    eq('effort：关闭时干脆不发', b2, {});
    const b3 = {}; A(b3, { reasoning: 'medium', reasoningStyle: 'enable_thinking' });
    eq('enable_thinking：带上预算', b3, { enable_thinking: true, thinking_budget: 2048 });
    const b4 = {}; A(b4, { reasoning: 'medium', reasoningStyle: 'off' });
    eq('off：永远不发', b4, {});
  }

  /* ---------------- 地址拼接 ---------------- */
  {
    const J = load(() => '').t.__test.joinUrl;
    eq('补上 /chat/completions', J('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
    eq('末尾斜杠不管用几个', J('https://api.openai.com/v1///'), 'https://api.openai.com/v1/chat/completions');
    eq('已经是完整路径就不再补', J('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions');
    eq('结尾 # 表示原样用', J('https://x.com/custom/path#'), 'https://x.com/custom/path');
  }

  /* ---------------- 标题不能夹带记号 ---------------- */
  {
    const S = load(() => '').t.__test.safeTitle;
    ok('方括号和竖线被抹平', !/[\[\]|]/.test(S('[block] a|b\nc')), S('[block] a|b\nc'));
  }

  /* ---------------- 系统提示 ---------------- */
  {
    const B = load(() => '').t.__test.buildSystemPrompt;
    const p = B({ targetLang: '简体中文', useTitle: true }, 'Attention Is All You Need');
    ok('写明了目标语言', p.includes('简体中文'));
    ok('给出了编号对齐契约', p.includes('<n>|<translation>'));
    ok('禁止合并段落', /never merge/i.test(p));
    ok('带上了页面标题', p.includes('Attention Is All You Need'));
    const p2 = B({ targetLang: '简体中文', useTitle: false }, 'Attention Is All You Need');
    ok('关掉标题提示就真的不发', !p2.includes('Attention Is All You Need'));
  }

  /* ---------------- 缓存淘汰 ---------------- */
  {
    const K = load(() => '').t.__test.staleKeys;
    const day = 86400000;
    const idx = { old: Date.now() - 100 * day, mid: Date.now() - 2 * day, fresh: Date.now() };
    eq('过期的被淘汰', K(idx, { days: 30, max: 100 }), ['old']);
    const many = {};
    for (let i = 0; i < 5; i++) many['k' + i] = Date.now() - i * 1000;
    eq('超出条数上限时先淘汰最久没看的', K(many, { days: 365, max: 3 }), ['k3', 'k4']);
  }

  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
