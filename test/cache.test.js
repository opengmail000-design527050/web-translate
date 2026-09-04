/* 多标签页缓存：正文和索引必须在 background 的同一条队列里增量合并。 */
const fs = require('fs'), vm = require('vm'), path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function load() {
  const store = { settings: {}, cacheIndex: {} };
  const noop = () => {};
  const chrome = {
    runtime: { onMessage: { addListener: noop }, onInstalled: { addListener: noop }, openOptionsPage: noop },
    commands: { onCommand: { addListener: noop } },
    tabs: { query: async () => [], sendMessage: async () => {}, onRemoved: { addListener: noop } },
    permissions: { contains: async () => true }, i18n: { getUILanguage: () => 'zh-CN' },
    storage: { local: {
      get: async (k) => {
        if (k == null) return clone(store);
        if (Array.isArray(k)) return Object.fromEntries(k.map((x) => [x, clone(store[x])]));
        return { [k]: clone(store[k]) };
      },
      set: async (o) => Object.assign(store, clone(o)),
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; }
    } }
  };
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^export /gm, '');
  const src = read('common.js') + '\n' + read('background.js').replace(/^import .*$/m, '') +
    '\nglobalThis.__cacheTest = { cacheIndexOp };';
  const ctx = { console, setTimeout: (f) => setTimeout(f, 0), clearTimeout, AbortController,
    chrome, fetch: async () => { throw new Error('不该联网'); } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { C: ctx.__cacheTest, store };
}

(async () => {
  const { C, store } = load();
  await Promise.all([
    C.cacheIndexOp({ op: 'write', key: 'c_same', items: { a: '甲' } }),
    C.cacheIndexOp({ op: 'write', key: 'c_same', items: { b: '乙' } })
  ]);
  ok('两个标签页写同一页面时缓存正文取并集',
     store.c_same && store.c_same.m.a === '甲' && store.c_same.m.b === '乙',
     JSON.stringify(store.c_same));
  ok('增量写正文时同步维护缓存索引', !!store.cacheIndex.c_same, JSON.stringify(store.cacheIndex));

  const writing = C.cacheIndexOp({ op: 'write', key: 'c_same', items: { c: '丙' } });
  const forgetting = C.cacheIndexOp({ op: 'forget', key: 'c_same' });
  await Promise.all([writing, forgetting]);
  ok('重翻本页排在写入之后时正文和索引都删干净',
     !store.c_same && !store.cacheIndex.c_same,
     JSON.stringify({ body: store.c_same, index: store.cacheIndex }));

  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
