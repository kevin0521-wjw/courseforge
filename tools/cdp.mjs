#!/usr/bin/env node
/**
 * 极简 CDP 客户端：连到正在运行的 Electron，列出页面目标、在指定页面里跑一段 JS。
 *
 * 为什么不用现成的 puppeteer/playwright：
 *   本仓库运行时零依赖，工具脚本也不想引入重量级浏览器驱动；
 *   而「列目标 + 跑一段 JS」这两件事，Node 自带的 fetch + WebSocket（Node 22 已内置）就够了。
 *
 * 用法：
 *   node tools/cdp.mjs list                          列出所有页面目标
 *   node tools/cdp.mjs eval "<js>" [--target <子串>]  在匹配的页面里求值（默认第一个 page）
 *   node tools/cdp.mjs eval-file <文件> [--target <子串>]
 *
 * 退出码：0 成功；2 连不上（应用没起来）；3 找不到匹配的页面目标。
 */
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9555);
const BASE = `http://127.0.0.1:${PORT}`;

async function listTargets() {
  const res = await fetch(`${BASE}/json/list`);
  return res.json();
}

async function pickTarget(substr) {
  const targets = (await listTargets()).filter((t) => t.type === 'page');
  if (!targets.length) return null;
  if (!substr) return targets[0];
  return targets.find((t) => (t.url || '').includes(substr) || (t.title || '').includes(substr)) || null;
}

/** 跑一段表达式，等 Promise 落地，把结果按 JSON 打出来 */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (e) { /* 已关闭 */ }
      reject(new Error('CDP 求值超时（30s）'));
    }, 30000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true
        }
      }));
    };
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const r = msg.result || {};
      if (r.exceptionDetails) {
        return reject(new Error('页面抛异常：' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails)));
      }
      resolve(r.result ? r.result.value : undefined);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const ti = argv.indexOf('--target');
  const targetSub = ti >= 0 ? argv[ti + 1] : '';
  // 去掉 --target 及其值，剩下的位置参数才是真正的载荷
  const rest = argv.slice(1).filter((a, i) => !(ti >= 0 && (i === ti - 1 || i === ti)));

  const targets = await listTargets().catch(() => null);
  if (!targets) {
    console.error(`[cdp] 连不上 ${BASE} —— 应用没在跑？`);
    process.exit(2);
  }

  if (cmd === 'list') {
    targets.forEach((t) => console.log(`${t.type}\t${(t.title || '').slice(0, 30)}\t${t.url}`));
    return;
  }

  const target = await pickTarget(targetSub);
  if (!target) {
    console.error(`[cdp] 没有匹配 "${targetSub}" 的页面目标`);
    (await listTargets()).forEach((t) => console.error(`   ${t.type}\t${t.url}`));
    process.exit(3);
  }

  let expr;
  if (cmd === 'eval-file') expr = fs.readFileSync(rest[0], 'utf8');
  else if (cmd === 'eval') expr = rest[0];
  else {
    console.error('用法: node tools/cdp.mjs list | eval "<js>" | eval-file <file> [--target <子串>]');
    process.exit(1);
  }

  const out = await evaluate(target.webSocketDebuggerUrl, expr);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error('[cdp] ' + (err && err.message ? err.message : err));
  process.exit(1);
});
