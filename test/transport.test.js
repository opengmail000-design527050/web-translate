/* 请求层：永久错误不重发，暂时错误只重发一次，作废的批次会真的 abort。 */
const fs = require('fs'), vm = require('vm'), path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}` + (!cond && extra ? '  :: ' + extra : ''));
};

function load(fetch, realTimers) {
  const noop = () => {};
  const chrome = {
    runtime: { onMessage: { addListener: noop }, onInstalled: { addListener: noop }, openOptionsPage: noop },
    commands: { onCommand: { addListener: noop } },
    tabs: { query: async () => [], sendMessage: async () => {}, onRemoved: { addListener: noop } },
    permissions: { contains: async () => true }, i18n: { getUILanguage: () => 'zh-CN' },
    storage: { local: { get: async () => ({ settings: {} }), set: async () => {}, remove: async () => {} } }
  };
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^export /gm, '');
  const src = read('common.js') + '\n' + read('background.js').replace(/^import .*$/m, '') +
    '\nglobalThis.__transportTest = { postJson, openJob, closeJob, cancelJobs };';
  const ctx = { console, setTimeout: realTimers ? setTimeout : (f) => setTimeout(f, 0), clearTimeout, AbortController, chrome, fetch };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.__transportTest;
}

function response(status, text, retryAfter) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => k === 'Retry-After' ? (retryAfter || '') : '' },
    text: async () => text
  };
}

(async () => {
  {
    let calls = 0;
    const T = load(async () => { calls++; return response(401, '{"error":{"message":"bad key"}}'); });
    try { await T.postJson('https://api.example/v1', 'bad', {}, 1000, 1); } catch (_) {}
    ok('401 是配置错误，只发送一次', calls === 1, String(calls));
  }

  {
    let calls = 0;
    const T = load(async () => {
      calls++;
      return calls === 1 ? response(500, 'temporary') : response(200, '{"ok":true}');
    });
    const out = await T.postJson('https://api.example/v1', 'key', {}, 1000, 1);
    ok('500 暂时错误会重发一次后恢复', calls === 2 && out.ok === true, JSON.stringify({ calls, out }));
  }

  {
    let calls = 0;
    const T = load(async () => { calls++; return response(429, 'rate limited', '0.01'); });
    const err = await T.postJson('https://rate.example/v1', 'key', {}, 1000, 1)
      .then(() => null, (e) => e);
    ok('429 听 Retry-After、同一次请求最多重发一次并把等待时间带回前端',
       calls === 2 && err && err.code === 'rate' && err.retryAfter > 0,
       JSON.stringify({ calls, code: err && err.code, retryAfter: err && err.retryAfter }));
  }

  {
    let calls = 0;
    const T = load((url, opt) => {
      calls++;
      return new Promise((resolve, reject) => {
        opt.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        }, { once: true });
      });
    }, true);
    const job = T.openJob(7, 'doc-a', 1, 9);
    const req = T.postJson('https://api.example/v1', 'key', {}, 1000, 1, job)
      .then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 0));
    T.cancelJobs(7, { sessionId: 'doc-a', epoch: 2 });
    const err = await req;
    T.closeJob(job);
    ok('页面作废时在途 fetch 被 abort，且不会自动再发',
       calls === 1 && err && err.cancelled === true,
       JSON.stringify({ calls, error: err && err.message }));
  }

  /* 报错要先用一句中文说清该去改什么，服务商的原话留在括号里 */
  {
    const T = load(async () => response(401, '{"error":{"message":"Incorrect API key provided"}}'));
    const err = await T.postJson('https://api.example/v1', 'bad', {}, 1000, 1).then(() => null, (e) => e);
    ok('401 先说「Key 不对」，原话留着',
       err && err.message.startsWith('API Key 不对') && err.message.includes('Incorrect API key'), err && err.message);
  }

  {
    let calls = 0;
    const T = load(async () => { calls++; return response(429, '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}'); });
    const err = await T.postJson('https://quota.example/v1', 'key', {}, 1000, 1).then(() => null, (e) => e);
    ok('429 + insufficient_quota 是余额用完，不当限流排队重试',
       calls === 1 && err && err.code !== 'rate' && !err.retryAfter && err.message.includes('余额'),
       JSON.stringify({ calls, code: err && err.code, msg: err && err.message }));
  }

  {
    let calls = 0;
    const T = load(async () => { calls++; return response(402, '{"error":{"message":"Insufficient Balance"}}'); });
    const err = await T.postJson('https://api.deepseek.example/v1', 'key', {}, 1000, 1).then(() => null, (e) => e);
    ok('402（DeepSeek 的余额不足）只发一次、说余额', calls === 1 && err && err.message.includes('余额'),
       JSON.stringify({ calls, msg: err && err.message }));
  }

  {
    let calls = 0;
    const T = load(async () => { calls++; return response(429, '{"error":{"message":"Resource has been exhausted (e.g. check quota)."}}', '0.01'); });
    const err = await T.postJson('https://gemini.example/v1', 'key', {}, 1000, 1).then(() => null, (e) => e);
    ok('普通限流里出现 quota 这个词，仍然按限流处理',
       err && err.code === 'rate' && calls === 2, JSON.stringify({ calls, code: err && err.code }));
  }

  {
    const T = load(async () => { throw new TypeError('Failed to fetch'); });
    const err = await T.postJson('https://down.example/v1', 'key', {}, 1000, 1).then(() => null, (e) => e);
    ok('网络不通时说「连不上 API 地址」', err && err.message.startsWith('连不上 API 地址'), err && err.message);
  }

  {
    let calls = 0;
    const T = load(async () => { calls++; return response(200, '<!doctype html><title>Home</title>'); });
    const err = await T.postJson('https://site.example', 'key', {}, 1000, 1).then(() => null, (e) => e);
    ok('地址指到网页上（回来的是 HTML）：提示地址填错，不重发',
       calls === 1 && err && err.message.includes('不是 JSON'), JSON.stringify({ calls, msg: err && err.message }));
  }

  {
    const T = load(async () => response(200, '{}'));
    T.cancelJobs(8, { sessionId: 'old-doc', epoch: 4 });
    const stale = T.openJob(8, 'old-doc', 3, 1);
    const freshDocument = T.openJob(8, 'new-doc', 0, 1);
    ok('先到的取消消息会挡住同一文档的迟到旧批次', stale.cancelled === true);
    ok('新文档 epoch 从零开始也不会被上一页误伤', freshDocument.cancelled === false);
    T.closeJob(stale); T.closeJob(freshDocument);
  }

  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
