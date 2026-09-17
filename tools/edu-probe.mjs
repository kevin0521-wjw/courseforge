#!/usr/bin/env node
/**
 * 教务系统接口探针（开发工具，不参与打包）
 *
 * ==================== 为什么需要它 ====================
 *
 * 正方 jwglxt 的课表接口地址、参数名、响应字段在不同版本/不同学校之间会变：
 * 公开资料里同一件事有 `xskbcx_cxXsgrkb.html` 与 `xskbcx_cxXsKb.html` 两种说法，
 * 参数也有人说要 `kzlx=ck`、有人说不用。
 *
 * 网页上「照着资料写」和「看真实响应」是两回事 —— 前者会让你把错误假设
 * 一路写进解析层，最后表现为「导入结果少了几天课」这种不报错但很坏的 bug。
 * 所以这个工具只做一件事：**把当前登录会话下所有候选接口的真实响应摊开看**。
 *
 * 它连的是已经跑起来的桌面端窗口（默认 127.0.0.1:9555），在教务窗口内执行 fetch：
 * 同源、cookie 自动带上，不碰任何登录凭据，也不改变会话状态（全是只读 GET/POST 查询）。
 *
 * 用法：
 *   # 1) 带上调试端口启动桌面端（只在排查时这么起）
 *   desktop/node_modules/electron/dist/electron.exe . --remote-debugging-port=9555
 *   # 2) 在应用里完成登录，停在课表页
 *   # 3) 跑探针
 *   node tools/edu-probe.mjs                # 默认端口 9555
 *   node tools/edu-probe.mjs --port 9555 --out .probe   # 顺便把原始响应落盘
 *
 * ⚠️ 落盘的响应里含真实课表内容（课程名/教室/教师）。如果要提交进仓库，
 *    必须先脱敏，别把原始文件直接 git add。
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PORT = Number(arg('port', process.env.CDP_PORT || 9555));
const OUT_DIR = arg('out', '');

/** 这些是本轮要摊开对比的候选：路径 × 请求体，全都试一遍再下结论 */
const CANDIDATES = [
  { name: '个人课表·标准参数', url: '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151', body: 'xnm=&xqm=&kzlx=ck' },
  { name: '个人课表·无 kzlx', url: '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151', body: 'xnm=&xqm=' },
  { name: '个人课表·显式学年', url: '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151', body: 'xnm=' + new Date().getFullYear() + '&xqm=3&kzlx=ck' },
  { name: '旧版 cxXsKb', url: '/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151', body: 'xnm=&xqm=&kzlx=ck' },
  { name: '班级课表', url: '/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151', body: 'xnm=&xqm=' }
];

/** 课表页面本身（GET）—— 里面有 xnm/xqm 下拉选项和模块 JS 的真实路径 */
const PAGE_URL = '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151';

async function cdpJson(p) {
  const r = await fetch('http://127.0.0.1:' + PORT + p);
  if (!r.ok) throw new Error('CDP ' + p + ' → HTTP ' + r.status);
  return r.json();
}

/** 极简 CDP 客户端：只需要 Runtime.evaluate 一个能力，不值得引依赖 */
class Session {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else w.resolve(msg.result);
    });
  }

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const to = setTimeout(() => reject(new Error('连接 CDP 超时')), 10000);
      ws.addEventListener('open', () => { clearTimeout(to); resolve(new Session(ws)); });
      ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('连接 CDP 失败')); });
    });
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(method + ' 超时')); }
      }, 60000);
    });
  }

  /** 在页面里求值并取回可序列化结果（支持 await） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || '页面内执行出错');
    }
    return r.result ? r.result.value : undefined;
  }

  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

/**
 * 在教务窗口里跑的探针主体。
 * 一次性把「页面信息 + 页面内脚本清单 + 学期下拉 + 各候选接口响应」全取回来，
 * 减少 CDP 往返，也避免中间状态变化导致前后对不上。
 */
function probeScript(pageUrl, candidates) {
  return `(async function () {
    var out = { page: {}, scripts: [], semesters: null, menus: [], results: [] };

    /* 1) 当前页面信息：判断是停在登录页还是已经登录成功 */
    out.page = {
      href: location.href,
      title: document.title,
      hasLoginForm: !!document.getElementById('yhm'),
      cookieVisible: String(document.cookie || '').indexOf('JSESSIONID') >= 0
    };

    async function get(u) {
      try {
        var r = await fetch(u, { method: 'GET', credentials: 'same-origin' });
        return { status: r.status, url: r.url, text: await r.text() };
      } catch (e) { return { status: 0, error: String((e && e.message) || e) }; }
    }
    async function post(u, b) {
      try {
        var r = await fetch(u, {
          method: 'POST', credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: b
        });
        return { status: r.status, url: r.url, text: await r.text() };
      } catch (e) { return { status: 0, error: String((e && e.message) || e) }; }
    }

    /* 2) 课表页面 HTML：拿模块 JS 的真实路径与学期下拉 */
    var pg = await get(${JSON.stringify(pageUrl)});
    out.pageGet = { status: pg.status, url: pg.url, len: (pg.text || '').length, error: pg.error || '' };
    if (pg.text) {
      var re = /<script[^>]+src=["']([^"']+)["']/gi, m, seen = {};
      while ((m = re.exec(pg.text))) { if (!seen[m[1]]) { seen[m[1]] = 1; out.scripts.push(m[1]); } }
      /* 学期下拉：xnm=学年、xqm=学期；只看选项文本，不提交任何东西 */
      var sel = pg.text.match(/<select[^>]*id=["']xnm["'][\\s\\S]{0,1200}?<\\/select>/i);
      var selq = pg.text.match(/<select[^>]*id=["']xqm["'][\\s\\S]{0,1200}?<\\/select>/i);
      var opts = function (s) {
        if (!s) return null;
        var o = [], r2 = /<option[^>]*value=["']?([^"'\\s>]*)["']?[^>]*>([^<]*)</gi, mm;
        while ((mm = r2.exec(s[0]))) o.push({ value: mm[1], text: mm[2].trim() });
        return o;
      };
      out.semesters = { xnm: opts(sel), xqm: opts(selq) };
      out.pageGet.head = pg.text.slice(0, 600);
    }

    /* 3) 左侧菜单里真正的课表入口（各校菜单文案不同，别写死） */
    var links = document.querySelectorAll('a[href], [onclick]');
    for (var i = 0; i < links.length && out.menus.length < 30; i++) {
      var t = (links[i].textContent || '').replace(/\\s+/g, ' ').trim();
      var raw = (links[i].getAttribute('href') || '') + ' ' + (links[i].getAttribute('onclick') || '');
      if (!/kb|kbcx|课表/i.test(raw + ' ' + t)) continue;
      var mm2 = /(\\/jwglxt\\/[\\w\\/]+\\.html[^\\s'"<>]*)/i.exec(raw);
      out.menus.push({ text: t.slice(0, 30), path: mm2 ? mm2[1] : raw.slice(0, 80) });
    }

    /* 4) 逐个候选接口实测 */
    var cands = ${JSON.stringify(candidates)};
    for (var k = 0; k < cands.length; k++) {
      var res = await post(cands[k].url, cands[k].body);
      var text = res.text || '';
      var j = null;
      try { j = JSON.parse(text); } catch (e) { /* 不是 JSON 就留 null */ }
      out.results.push({
        name: cands[k].name,
        url: cands[k].url,
        body: cands[k].body,
        status: res.status,
        finalUrl: res.url,
        error: res.error || '',
        len: text.length,
        isJson: !!j,
        shape: j ? Object.keys(j).slice(0, 20) : null,
        kbRows: j && j.kbList ? j.kbList.length : (Array.isArray(j) ? j.length : null),
        head: text.slice(0, 300)
      });
    }
    return out;
  })()`;
}

async function main() {
  console.log('[edu-probe] 连接 CDP 127.0.0.1:' + PORT + ' …');
  let targets;
  try {
    targets = await cdpJson('/json/list');
  } catch (e) {
    console.error('❌ 连不上调试端口：' + e.message);
    console.error('   桌面端需要用 --remote-debugging-port=' + PORT + ' 启动。');
    process.exit(2);
  }

  const edu = targets.find((t) => /^https?:\/\//.test(t.url || '') && /jwglxt|jwxt/i.test(t.url));
  if (!edu) {
    console.error('❌ 没找到教务窗口。当前可用窗口：');
    targets.forEach((t) => console.error('   ' + t.type + '  ' + String(t.url).slice(0, 90)));
    console.error('   先在应用里点「一键登录并取课表」或「打开教务系统窗口」并完成登录。');
    process.exit(3);
  }

  console.log('[edu-probe] 教务窗口: ' + edu.url.slice(0, 90));
  const s = await Session.connect(edu.webSocketDebuggerUrl);
  try {
    await s.send('Runtime.enable');
    const out = await s.eval(probeScript(PAGE_URL, CANDIDATES));

    console.log('\n=== 1. 当前页面 ===');
    console.log('  URL      ' + out.page.href.slice(0, 100));
    console.log('  标题     ' + out.page.title);
    console.log('  登录表单 ' + (out.page.hasLoginForm ? '仍在（未登录或已退出）' : '已消失（已登录）'));
    console.log('  可见cookie含 JSESSIONID: ' + out.page.cookieVisible);

    console.log('\n=== 2. 课表页面 GET ===');
    console.log('  status=' + out.pageGet.status + ' len=' + out.pageGet.len
      + (out.pageGet.url && out.pageGet.url !== PAGE_URL ? ' final=' + out.pageGet.url.slice(0, 70) : ''));
    if (out.scripts.length) {
      console.log('  页面引用的脚本（≈30 个，找 kbcx 相关的那个）：');
      out.scripts.filter((x) => /kb|jwglxt|comp/i.test(x)).slice(0, 12)
        .forEach((x) => console.log('    ' + x));
    }
    if (out.semesters && (out.semesters.xnm || out.semesters.xqm)) {
      console.log('  学期下拉：');
      console.log('    xnm=' + JSON.stringify(out.semesters.xnm));
      console.log('    xqm=' + JSON.stringify(out.semesters.xqm));
    } else {
      console.log('  学期下拉：没解析到（可能接口改变量名，或页面未登录时是空壳）');
    }

    console.log('\n=== 3. 菜单里的课表入口 ===');
    if (!out.menus.length) console.log('  （无）');
    out.menus.forEach((m) => console.log('  ' + m.text + '  →  ' + m.path));

    console.log('\n=== 4. 候选接口实测 ===');
    out.results.forEach((r) => {
      const flag = r.kbRows ? '✅ ' + r.kbRows + ' 条' : (r.isJson ? '⚠️ 是 JSON 但没有 kbList' : '❌ 不是 JSON');
      console.log('\n  【' + r.name + '】' + flag);
      console.log('    ' + r.url);
      console.log('    body=' + r.body + '  →  status=' + r.status + ' len=' + r.len
        + (r.error ? '  error=' + r.error : ''));
      if (r.finalUrl && r.finalUrl.indexOf('/login') >= 0) console.log('    ⚠️ 被重定向到登录页 = 会话失效');
      if (r.shape) console.log('    顶层字段: ' + JSON.stringify(r.shape));
      if (!r.kbRows) console.log('    开头: ' + String(r.head).replace(/\s+/g, ' ').slice(0, 200));
    });

    if (OUT_DIR) {
      const dir = path.resolve(ROOT, OUT_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'edu-probe.json'),
        JSON.stringify(out, null, 2), 'utf8');
      console.log('\n[edu-probe] 原始结果已写入 ' + path.relative(ROOT, path.join(dir, 'edu-probe.json'))
        + '（含真实课表内容，提交前必须脱敏）');
    }

    const ok = out.results.filter((r) => r.kbRows);
    console.log('\n--- 结论 ---');
    if (ok.length) {
      console.log('✅ 可用接口：' + ok.map((r) => r.name + '（' + r.kbRows + ' 条）').join('、'));
    } else if (out.page.hasLoginForm) {
      console.log('⏸ 还在登录页，先完成登录再跑一次。');
    } else {
      console.log('❌ 所有候选都没返回 kbList —— 需要按「脚本清单」里的 kbcx 模块 JS 继续挖真实地址。');
    }
  } finally {
    s.close();
  }
}

main().catch((e) => {
  console.error('❌ ' + (e && e.stack || e));
  process.exit(1);
});
