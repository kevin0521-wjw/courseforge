/**
 * 内网穿透：把本地服务暴露成一个公网 HTTPS 地址，供手机真机测试。
 *
 * 为什么要这个 —— 本地开发有三个测不了的场景：
 *   1) PWA 安装（「添加到主屏幕」）在 http://localhost 上根本触发不了，必须有 HTTPS；
 *   2) 手机浏览器访问不到电脑的 127.0.0.1，同一个 WiFi 下用局域网 IP 也只是 http；
 *   3) 每次改动都重新部署线上太慢，穿透能做到「改完手机刷新即见」。
 *
 * 用本机已装的 cpolar（免费版给 https 子域名，正好够真机联调用）。
 *
 * 用法：
 *   npm run tunnel                 # 自动起本地服务 + 建隧道（一条命令搞定）
 *   npm run tunnel -- --no-server  # 本地服务已在跑，只建隧道
 *   PORT=8080 npm run tunnel       # 换端口（默认 5173，与 npm run start:web 一致）
 *
 * Ctrl+C 退出，隧道随之关闭。
 * 注意：免费版分到的域名**不固定** —— 实测同一账号连续两次分别是
 * 4d26f25b.r19.cpolar.top 和 39f45af8.r16.vip.cpolar.cn（节点和域名都会变），
 * 所以每次启动都要看输出的地址，别存书签。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(ROOT, 'tools', 'serve.mjs');
const PORT = Number(process.env.PORT) || 5173;
const LOCAL = `http://127.0.0.1:${PORT}`;
const NO_SERVER = process.argv.includes('--no-server');

const CPOLAR_CANDIDATES = [
  process.env.CPOLAR_PATH,
  'C:\\Program Files\\cpolar\\cpolar.exe',
  'C:\\Program Files (x86)\\cpolar\\cpolar.exe'
].filter(Boolean);
const CPOLAR = CPOLAR_CANDIDATES.find((p) => fs.existsSync(p));

if (!CPOLAR) {
  console.error('找不到 cpolar，试过：\n  ' + CPOLAR_CANDIDATES.join('\n  '));
  console.error('\n安装：https://www.cpolar.com/ ，装完执行 cpolar authtoken <你的token> 登录');
  console.error('（也可用 CPOLAR_PATH 环境变量指定路径）');
  process.exit(1);
}

let serverProc = null;
let tunnelProc = null;
let closing = false;

/** 探测本地服务是否已就绪（探到任何 HTTP 响应都算活着，404 也算）。 */
async function probe(timeoutMs = 1500) {
  try {
    await fetch(LOCAL + '/', { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(400);
  }
  return false;
}

/** 从 cpolar 输出里挖出公网地址。
 *
 * 踩过的坑：cpolar 不是 ngrok，**不输出** `Forwarding xx -> yy` 那一行，
 * 而且它的日志默认写文件（`-log` 默认 "none"），stdout 上一个字都没有 ——
 * 所以必须显式传 `-log=stdout`，否则只能看到"静默无输出"。
 * 真正宣告地址的是这一行（INFO 级）：
 *   level=info msg="[:tunnel server module] Tunnel established at https://xxx.r19.cpolar.top"
 */
function extractPublicUrls(text) {
  const urls = new Set();

  // 主判据：隧道建立宣告
  for (const m of text.matchAll(/Tunnel established at\s+(https?:\/\/[^\s"\\]+)/g)) {
    urls.add(m[1]);
  }

  // 兜底一：DEBUG 级别下 NewTunnel / RespStartTunnel 的 JSON（引号是转义的）
  for (const m of text.matchAll(/\\?"PublicUrl\\?":\s*\\?"(https?:\/\/[^\s"\\]+)/g)) {
    urls.add(m[1]);
  }

  // 兜底二：任何 cpolar 域名。注意是「多级子域」（如 4d26f25b.r19.cpolar.top），
  // 只匹配一段子域的正则会漏掉。
  if (urls.size === 0) {
    for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]+\.cpolar\.(?:cn|top|io)\b/gi)) {
      urls.add(m[0]);
    }
  }

  // https 排前面：测 PWA 必须用它
  return [...urls].sort((a, b) => (b.startsWith('https') ? 1 : 0) - (a.startsWith('https') ? 1 : 0));
}

/** Windows 上必须杀进程树，否则 cpolar / serve 会留孤儿进程。 */
function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-proc.pid, 'SIGKILL');
    }
  } catch { /* 已经退了 */ }
}

function cleanup() {
  if (closing) return;
  closing = true;
  killTree(tunnelProc);
  killTree(serverProc);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭隧道…');
    cleanup();
    process.exit(0);
  });
}
process.on('exit', cleanup);

// ==================== 主流程 ====================

console.log('CourseForge 内网穿透（cpolar ' + path.basename(CPOLAR) + '）');
console.log('目标端口：' + PORT);

// 1) 本地服务
if (await probe()) {
  console.log('✓ 本地服务已在运行：' + LOCAL);
} else if (NO_SERVER) {
  console.error('✗ 本地服务没在跑（' + LOCAL + '），但你指定了 --no-server。');
  console.error('  先执行：npm run start:web');
  process.exit(1);
} else {
  console.log('… 本地服务未启动，自动拉起 tools/serve.mjs');
  serverProc = spawn(process.execPath, [SERVE], { stdio: 'ignore', detached: process.platform !== 'win32' });
  if (!(await waitForServer())) {
    console.error('✗ 本地服务启动失败（等了 20 秒）。单独跑 npm run start:web 看报错。');
    cleanup();
    process.exit(1);
  }
  console.log('✓ 本地服务已就绪：' + LOCAL);
}

// 2) 建隧道
console.log('… 正在建立隧道（首次可能需要几秒）');
let tunnelLog = '';
const urls = await new Promise((resolve, reject) => {
  tunnelProc = spawn(CPOLAR, [
    'http', String(PORT),
    '-log=stdout',     // 默认是 none —— 不给这个参数，cpolar 在 stdout 上一个字都不输出
    '-log-level=INFO'  // DEBUG 会每秒刷心跳；INFO 只留「隧道建立」这类关键行
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // cpolar 的 INFO 日志本身有十几行噪音（读配置、握手、DNS…），这里静默累积、
  // 只在出错时回看，不直接透传 —— 否则「公网地址」会被淹没在日志里。
  const onData = (chunk) => {
    tunnelLog += chunk.toString('utf8');
    const found = extractPublicUrls(tunnelLog);
    if (found.length) resolve(found);
  };
  tunnelProc.stdout.on('data', onData);
  tunnelProc.stderr.on('data', onData);
  tunnelProc.on('error', (e) => reject(new Error('无法启动 cpolar：' + e.message)));
  tunnelProc.on('exit', (code) => {
    if (code !== null && code !== 0) reject(new Error('cpolar 退出，退出码 ' + code));
  });
  setTimeout(() => reject(new Error('等公网地址超时（30 秒）')), 30000);
}).catch((e) => {
  console.error('✗ ' + e.message);
  if (tunnelLog.trim()) {
    console.error('\n--- cpolar 输出末尾（排错用）---');
    console.error(tunnelLog.trim().split(/\r?\n/).slice(-8).join('\n'));
  }
  cleanup();
  process.exit(1);
});

console.log('');
console.log('✅ 隧道已建立');
for (const u of urls) console.log('   公网地址   ' + u + (/^https:/.test(u) ? '' : '   （用 https 那个才能测 PWA）'));
console.log('   本地地址   ' + LOCAL);
console.log('');
console.log('  手机直接打开上面的 https 地址即可 —— 不用连同一个 WiFi。');
console.log('  测 PWA：浏览器菜单 →「添加到主屏幕」。');
console.log('  Ctrl+C 停止。');
console.log('');
