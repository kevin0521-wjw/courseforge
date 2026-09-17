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
 * ⚠️ 这个地址是**临时的**，别当稳定入口用（这是免费版的硬限制，不是 bug）：
 *   1) 隧道是「进程级」的 —— 脚本一退出隧道即销毁，地址立刻 404；
 *   2) 域名每次都变 —— 实测同一账号连续三次分别是
 *      4d26f25b.r19.cpolar.top / 39f45af8.r16.vip.cpolar.cn / 1041e15f.r19.cpolar.top
 *      （节点 r19 / r16 与域名都在变），存书签必然失效；
 *   3) 想固定域名得付费 —— 试过 `cpolar http 5173 -subdomain=courseforge`，服务端直接拒绝：
 *      「授权失败，用户当前Plan不允许使用该功能，请升级Plan」。
 *
 * → 要「长期稳定、可以发给别人」的地址，请用已部署的线上站点；
 *   本脚本的定位是「本地改完、手机立刻看到」，改一次看一次。
 *
 * 用法：
 *   npm run tunnel                 # 自动起本地服务 + 建隧道（一条命令搞定）
 *   npm run tunnel -- --no-server  # 本地服务已在跑，只建隧道
 *   PORT=8080 npm run tunnel       # 换端口（默认 5173，与 npm run start:web 一致）
 *
 * Ctrl+C 退出，隧道随之关闭。
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

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 把公网地址塞进剪贴板 —— 不然手机上还得手打一长串随机域名。 */
function copyToClipboard(text) {
  const cmd = process.platform === 'win32' ? 'clip'
    : process.platform === 'darwin' ? 'pbcopy'
      : 'xclip';
  const args = cmd === 'xclip' ? ['-selection', 'clipboard'] : [];
  try {
    return spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;
  } catch {
    return false;
  }
}

/**
 * 隧道存活巡检。
 * 为什么要它：地址失效有两种情况 ——
 *   ① 脚本退出了（用户自己清楚）；② **脚本还在跑，但隧道被服务端回收 / 换网后连不通了**，
 *      这时用户完全无感，只会觉得"地址又莫名其妙失效了"，然后来找我。
 * 用一个小文件探活（不探 index.html：那个 17KB，长期跑白耗免费版流量）；
 * 连续 2 次失败才告警，避开网络抖动误报；恢复时也报一声。
 */
function startHealthCheck(url) {
  const PROBE = url + '/manifest.webmanifest';
  let fails = 0;
  let warned = false;
  const tick = async () => {
    let ok = false;
    try {
      ok = (await fetch(PROBE, { signal: AbortSignal.timeout(12000) })).ok;
    } catch { ok = false; }

    if (ok) {
      if (warned) {
        console.log('[' + now() + '] ✓ 隧道已恢复可达');
        warned = false;
      }
      fails = 0;
      return;
    }
    fails += 1;
    if (fails >= 2 && !warned) {
      warned = true;
      // 顺手探一下本地服务再下结论 —— 实测踩过：这里原本写死「本地服务仍在跑」，
      // 但真实场景里后端自己也可能是挂的那个，文案就会指错修复方向，用户白折腾。
      const localAlive = await probe();
      console.log('');
      console.log('[' + now() + '] ⚠️ 公网地址连续 ' + fails + ' 次不可达：' + url);
      console.log(localAlive
        ? '    本地服务正常（' + LOCAL + '），断的是隧道侧 —— 多半被回收或网络出口变了。'
        : '    本地服务也没响应（' + LOCAL + '）—— 是后端挂了，不只是隧道。');
      console.log('    处理：Ctrl+C 停掉，重跑 npm run tunnel 会重新拉起服务并分配新地址。');
      console.log('');
    }
  };
  setInterval(tick, 120000);
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

const httpsUrl = urls.find((u) => /^https:/.test(u));

console.log('');
console.log('✅ 隧道已建立');
for (const u of urls) console.log('   公网地址   ' + u + (/^https:/.test(u) ? '' : '   （用 https 那个才能测 PWA）'));
console.log('   本地地址   ' + LOCAL);
if (httpsUrl) {
  console.log('   ' + (copyToClipboard(httpsUrl)
    ? '📋 https 地址已复制到剪贴板，直接粘到手机上'
    : '（剪贴板不可用，请手动复制上面的 https 地址）'));
}
console.log('');
console.log('   ⚠️ 这个地址只在「本脚本运行期间」有效 —— Ctrl+C 后隧道立即销毁、再打开就是 404；');
console.log('      且免费版下次会分到**另一个域名**（固定域名需升级 cpolar Plan）。');
console.log('      → 要长期可用 / 能发给别人的地址，请用已部署的线上站点；这里只负责「改完即看」。');
console.log('');
console.log('   手机直接打开上面的 https 地址即可 —— 不用连同一个 WiFi。');
console.log('   测 PWA：浏览器菜单 →「添加到主屏幕」。');
console.log('   隧道掉线会自动检测告警（每 2 分钟巡检一次）。');
console.log('   Ctrl+C 停止。');
console.log('');

startHealthCheck(httpsUrl || urls[0]);
