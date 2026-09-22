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

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
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
    send(res, 200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', data);
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
