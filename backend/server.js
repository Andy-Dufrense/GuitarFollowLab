// 极简静态服务器，只依赖 Node 内置模块，不需要 npm install。
//
//   http://localhost:1209       电脑上用（localhost 本身就是安全上下文）
//   https://192.168.x.x:1210    手机上用（局域网地址必须 https，否则浏览器不给麦克风）
//
// https 需要 certs\local.pfx，跑一次 make-cert.bat 就有了。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', 'frontend');
const CERT_DIR = path.join(HERE, 'certs');
const PFX = path.join(CERT_DIR, 'local.pfx');
const PFX_PASS = 'guitarlab';

const PORT = Number(process.env.PORT || 1209);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || PORT + 1);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.cer': 'application/x-x509-ca-cert',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  // 字体必须给对 MIME：浏览器对字体有严格检查，
  // 用 application/octet-stream 发 woff2 会被拒收，表现就是"谱面一片空白"。
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.sf2': 'application/octet-stream',
  '.sf3': 'application/octet-stream',
  '.gp3': 'application/octet-stream',
  '.gp4': 'application/octet-stream',
  '.gp5': 'application/octet-stream',
  '.gpx': 'application/octet-stream',
};

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// 只有文本类才值得压；音色库/字体/图片压了反而多花 CPU（它们本来就不吃 gzip）
// octet-stream 里装的是音色库（sf2/sf3）和 .gp3 谱面 —— 它们 gzip 也能省一半
// （实测 sonivox.sf2 1320KB → 684KB），首屏那一次很值。
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|octet-stream)|image\/svg)/;
// 长缓存：vendor 里的第三方大件（alphaTab / 字体 / 音色库）不随我们迭代变 ——
// 让浏览器一直留着（朋友/手机第二次打开就几乎瞬开）。
// 其余的 JS / HTML / JSON 仍旧 no-store：你自己改代码，刷新立刻见效（不会被缓存骗）。
const LONG_CACHE = 'public, max-age=31536000, immutable';
function cachePolicy(urlPath, ext) {
  if (urlPath.startsWith('/vendor/')) return LONG_CACHE;
  if (['.sf2', '.sf3', '.woff2', '.woff', '.otf', '.ttf'].includes(ext)) return LONG_CACHE;
  return 'no-store';
}
// 压过的内容按"文件 + mtime"缓存，别每个请求都重压一遍 1MB 的 alphaTab
const gzipCache = new Map();
function gzipFor(file, mtimeMs, buf) {
  const hit = gzipCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.buf;
  const bufGz = zlib.gzipSync(buf);
  gzipCache.set(file, { mtimeMs, buf: bufGz });
  return bufGz;
}
function send(res, code, type, body, opts = {}) {
  const headers = { 'Content-Type': type, 'Cache-Control': opts.cache || 'no-store' };
  let out = body;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const req = opts.req;
  const wantsGzip = !!(req && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')));
  if (wantsGzip && COMPRESSIBLE.test(type) && buf.length > 1024) {
    const gz = opts.file ? gzipFor(opts.file, opts.mtimeMs, buf) : zlib.gzipSync(buf);
    if (gz.length < buf.length) {
      out = gz;
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    }
  }
  if (Buffer.isBuffer(out)) headers['Content-Length'] = out.length;
  res.writeHead(code, headers);
  res.end(out);
}

const handler = (req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // 页面用这个接口判断"这台设备上该怎么访问"
  if (urlPath === '/cert-info') {
    send(res, 200, MIME['.json'], JSON.stringify({
      lanIPs: lanIPs(),
      httpPort: PORT,
      httpsPort: HTTPS_PORT,
      httpsReady: fs.existsSync(PFX),
    }));
    return;
  }

  // 给手机下载证书用的
  if (urlPath === '/local.cer') {
    const f = path.join(CERT_DIR, 'local.cer');
    if (!fs.existsSync(f)) {
      send(res, 404, 'text/plain; charset=utf-8', '还没有生成证书，先在电脑上跑一次 make-cert.bat');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME['.cer'],
      'Content-Disposition': 'attachment; filename="local.cer"',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(f));
    return;
  }

  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const rel = path.normalize(urlPath).replace(/^[/\\]+/, '');
  const file = path.join(ROOT, rel);

  if (!file.startsWith(ROOT)) { send(res, 403, 'text/plain; charset=utf-8', '403 越界路径'); return; }

  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, 'text/plain; charset=utf-8', '404 找不到 ' + urlPath); return; }
    const ext = path.extname(file).toLowerCase();
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch (e) { /* ignore */ }
    send(res, 200, MIME[ext] || 'application/octet-stream', data, {
      req, cache: cachePolicy(urlPath, ext), file, mtimeMs,
    });
  });
};

const httpServer = http.createServer(handler);
httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。先关掉占用的进程，或者换个端口：set PORT=1210 && node server.js`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

httpServer.listen(PORT, () => {
  const ips = lanIPs();
  const ready = fs.existsSync(PFX);
  console.log('');
  console.log('  吉他跟弹识别');
  console.log(`  电脑浏览器打开：  http://localhost:${PORT}`);
  if (ips.length) {
    console.log(`  手机浏览器打开：  ${ready ? `https://${ips[0]}:${HTTPS_PORT}` : `http://${ips[0]}:${PORT}`}`);
  }
  console.log('');
  if (!ready) {
    console.log('  [!] 还没生成证书。想用手机的话先跑一次 make-cert.bat。');
    console.log('      浏览器只在 https 或 localhost 下才给麦克风权限，');
    console.log('      局域网 IP 走 http 是拿不到麦克风的。');
    console.log('');
  }
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

if (fs.existsSync(PFX)) {
  try {
    const httpsServer = https.createServer(
      { pfx: fs.readFileSync(PFX), passphrase: PFX_PASS },
      handler,
    );
    httpsServer.on('error', (e) => console.error(`https 端口 ${HTTPS_PORT} 起不来：${e.message}`));
    httpsServer.listen(HTTPS_PORT, () => {
      console.log(`  https 已就绪，监听 ${HTTPS_PORT} 端口（手机用这个）`);
      console.log('');
    });
  } catch (e) {
    console.error('证书读取失败，https 没起来：' + e.message);
  }
}
