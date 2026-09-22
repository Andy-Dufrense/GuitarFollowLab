// 验证"开不了麦克风"的两种典型情况，分别给出正确的提示：
//   A. 手机走 http://192.168.x.x —— 非安全上下文。必须【立刻】说明原因，
//      而且【完全不能调用】getUserMedia（安卓上它既不弹框也不返回）。
//   B. https 正常、证书也装了，但浏览器把站点权限设成了"拒绝" ——
//      这时浏览器不会再弹授权框，必须告诉用户去手动改回来。
// 用法： node test-mic-fail.mjs

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('   !! ' + m); } };

class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this._html = ''; this.className = '';
    this.style = {}; this.dataset = {}; this.value = ''; this.open = false;
    this.textContent = ''; this.listeners = {}; this._q = new Map();
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  querySelector(s) { if (!this._q.has(s)) this._q.set(s, new El()); return this._q.get(s); }
  querySelectorAll() { return []; }
  scrollIntoView() {}
}

// 每个用例都用一个全新的 DOM 和一份全新的模块实例
async function runCase(tag, setup) {
  const reg = new Map();
  globalThis.document = {
    getElementById(id) { if (!reg.has(id)) reg.set(id, new El()); return reg.get(id); },
    createElement(t) { return new El(t); },
    querySelector() { return new El(); },
    querySelectorAll() { return []; },
  };
  globalThis.performance = { now: () => 0 };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = globalThis;
  globalThis.fetch = async () => ({
    json: async () => ({ lanIPs: ['192.168.0.81'], httpPort: 1209, httpsPort: 1210, httpsReady: true }),
  });

  const ctx = setup();
  globalThis.location = ctx.location;
  globalThis.isSecureContext = ctx.secure;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: {
      userAgent: ctx.ua,
      mediaDevices: {
        getUserMedia: ctx.getUserMedia,
        enumerateDevices: async () => ([{ kind: 'audioinput', label: '手机麦克风' }]),
      },
      permissions: { query: async () => ({ state: ctx.perm }) },
    },
  });
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 48000; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData() {} }; }
  };

  await import('../frontend/js/main.js?case=' + tag);
  const $ = (id) => reg.get(id);
  await $('btnStart').onclick();
  return {
    verdict: $('verdict').textContent,
    diagOpen: $('diagbox').open,
    diag: String($('diagbody').innerHTML).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
    button: $('btnStart').textContent,
  };
}

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

// ── A. 非安全上下文 ─────────────────────────────────────────────────────────
console.log('\n=== A. 手机走 http://192.168.0.81:1209（非安全上下文）===');
let gumCalled = 0;
{
  const r = await runCase('insecure', () => ({
    secure: false,
    location: { origin: 'http://192.168.0.81:1209', host: '192.168.0.81:1209', protocol: 'http:' },
    ua: UA_ANDROID,
    perm: 'prompt',
    getUserMedia: async () => { gumCalled++; return { getTracks: () => [{ stop() {} }] }; },
  }));
  console.log('  判定条：' + r.verdict);
  ok(gumCalled === 0, `不该调用 getUserMedia，实际调用 ${gumCalled} 次`);
  ok(/不给麦克风权限|不会弹授权框/.test(r.verdict), 'A：应说明这个地址拿不到麦克风');
  ok(!/会弹一个授权框/.test(r.verdict), 'A：不能让人以为会弹框');
  ok(r.diagOpen === true, 'A：说明面板应自动展开');
  ok(/chrome:\/\/flags/.test(r.diag), 'A：应给出安卓免证书的 flags 办法');
  ok(r.button === '开始', 'A：按钮应恢复成"开始"');
}

// ── B. https 正常但权限被拒 ─────────────────────────────────────────────────
console.log('\n=== B. https + 证书正常，但站点权限已被设成「拒绝」===');
{
  const r = await runCase('denied', () => ({
    secure: true,
    location: { origin: 'https://192.168.0.81:1210', host: '192.168.0.81:1210', protocol: 'https:' },
    ua: UA_ANDROID,
    perm: 'denied',
    getUserMedia: async () => { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; },
  }));
  console.log('  判定条：' + r.verdict);
  console.log('  面板：' + r.diag.slice(0, 160));
  ok(/拒绝/.test(r.verdict), 'B：应指出权限已被设成拒绝');
  ok(/不会再弹授权框/.test(r.verdict), 'B：应说明不会再弹框');
  ok(/应用管理/.test(r.verdict), 'B：应提到系统层的应用权限');
  ok(/地址栏/.test(r.verdict), 'B：应提到浏览器里的站点权限');
  ok(r.diagOpen === true, 'B：说明面板应自动展开');
  ok(/站点麦克风权限：已拒绝/.test(r.diag), 'B：面板应显示权限状态');
  ok(/应用管理/.test(r.diag) && /设置/.test(r.diag), 'B：面板应给出系统层的操作路径');
  ok(/start\.bat 1211/.test(r.diag), 'B：面板应给出换端口的办法');
  ok(/换个浏览器/.test(r.diag), 'B：面板应建议换个浏览器');
  ok(r.button === '开始', 'B：按钮应恢复');
}

// ── C. https 正常、权限还没问过，但系统层把麦克风关了 ──────────────────────
console.log('\n=== C. 权限状态还是「询问」，却被直接挡掉（系统层关了麦克风）===');
{
  const r = await runCase('blocked', () => ({
    secure: true,
    location: { origin: 'https://192.168.0.81:1210', host: '192.168.0.81:1210', protocol: 'https:' },
    ua: UA_ANDROID,
    perm: 'prompt',
    getUserMedia: async () => { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; },
  }));
  console.log('  判定条：' + r.verdict);
  ok(/系统层面/.test(r.verdict), 'C：应提示是系统层关了麦克风');
  ok(/设置/.test(r.verdict), 'C：应给出到哪设置里打开');
}

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
