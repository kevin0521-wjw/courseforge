/**
 * CourseForge 教务系统自动登录（桌面端主进程用）
 *
 * ==================== 核心取舍：为什么不自写 RSA ====================
 *
 * 正方 jwglxt 的登录要做四件事：取 RSA 公钥 → 用 PKCS#1 填充加密密码 →
 * 带上 csrftoken 等隐藏字段 POST → 收 JSESSIONID cookie。
 * 技术上完全可以用 Node 的 crypto 自己实现（把 modulus/exponent 拼成 PKCS#1 DER
 * 塞进 crypto.publicEncrypt）。**但这里故意不这么做**，原因是失败模式太毒：
 *
 *   - DER 拼错 / 填充方式差一点，服务端只会回「用户名或密码错误」，
 *     和真输错密码**完全无法区分**。调试时会被误导去查密码，越查越远。
 *   - 本校登录配置里有 `dlsbsdsj=3`（失败次数上限）与 `yzcskz=3`：
 *     连续失败会逐步加上验证码、甚至临时锁定。拿真账号试加密实现对不对，
 *     代价可能是账号被锁 —— 这个风险不该让用户承担。
 *   - csrftoken 的填充方式各校版本不一，且要先建立会话。
 *
 * 所以这里只做两件确定性很高的事：把 `#yhm` / `#mm` 填好，然后点 `#dl`，
 * 剩下的交给**学校页面自己的 login.js**。好处是流程永远与学校保持同步；
 * 代价只是登录页改版时要跟着改选择器 —— 而选择器一坏就是「找不到表单」的
 * 明确报错，不会伪装成密码错误。这个代价换得的值。
 *
 * 本模块只负责**生成脚本/判定状态**（纯函数，可在 Node 直接单测），
 * 不碰 Electron，也不碰任何全局状态。
 */
'use strict';

/** 正方 jwglxt 的登录页路径（各校一致） */
const LOGIN_PATH = '/jwglxt/xtgl/login_slogin.html';

/**
 * 内置的课表候选入口。
 *
 * ⚠️ 这里踩过一个坑，记下来免得再犯：正方同一个 `.html` 是**双面的** ——
 * GET 返回课表页面（带学期下拉、表格容器），POST 才返回 kbList 的 JSON。
 * 也就是说「页面路径」和「数据接口路径」本来就是同一个，不存在
 * `_cxXsgrkb`（页面）对应 `_cxXsKb`（接口）这种成对关系 —— 我第一版按后者
 * 硬编码了 guessApiPath，接口名整个是错的，还多绕了一层。
 * 两种路径名在不同版本里都真实出现过，所以两个都留着按顺序试。
 *
 * gnmkdm=N2151 是「学生课表查询」的菜单码，各校一致。
 * 运行时还会从教务系统左侧菜单里**动态发现**真实入口，见 buildMenuProbeScript。
 */
const TIMETABLE_CANDIDATES = [
  {
    name: '学生个人课表',
    page: '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151',
    api: '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151'
  },
  {
    name: '学生课表（备用路径名）',
    page: '/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151',
    api: '/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151'
  }
];

/**
 * 数据接口的兜底请求体。
 *
 * 学年/学期**必须显式给出**：正方页面自己是读 `#xnm` / `#xqm` 两个下拉的当前值
 * 发出去的，发空值只有一部分版本会替我们补上当前学期，另一部分直接回一个空
 * kbList —— 而这种失败**不报错**，表现成「提示导入成功但一节课都没有」，最难查。
 * 所以运行时先 GET 课表页、从下拉里读出服务端给的当前学期（parseSemesterOptions），
 * 读不到才退回这个空值兜底。
 *
 * kzlx=ck 是「查看」控制位。公开资料里常被省略，但页面 JS 一直在发，带上更稳。
 */
const TIMETABLE_BODY = 'xnm=&xqm=&kzlx=ck';

/** 按具体学期拼请求体（值一律转义，学期值是从外部页面读来的，属于外部输入） */
function bodyFor(xnm, xqm) {
  const q = (v) => encodeURIComponent(String(v == null ? '' : v).trim());
  return 'xnm=' + q(xnm) + '&xqm=' + q(xqm) + '&kzlx=ck';
}

/**
 * 把用户填的教务系统网址解析成登录页地址。
 * 不负责协议校验（那是 main.js 的 sanitizeUrl 干的事），只做路径归一化：
 * 用户可能填首页、填课表页、甚至填菜单位置，一律换算到登录页。
 */
function loginUrlFrom(raw) {
  let u;
  try {
    u = new URL(String(raw == null ? '' : raw));
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.origin + LOGIN_PATH;
}

/** 当前是不是还停在登录页上（用来判定「还没登录」） */
function isLoginPage(url) {
  return /login_slogin/i.test(String(url == null ? '' : url));
}

/**
 * 生成「填表并点登录」的脚本。
 *
 * 安全要点：用户名/密码一律 JSON.stringify 之后注入。
 * 密码里一个引号就能把脚本拼断，一个恶意用户名就能在教务页面里执行任意代码。
 * 注意这里**不做「过滤非法字符」** —— 过滤会改掉用户真实的密码，
 * 必须原样传递，靠转义而不是靠清洗来保证安全。
 */
function buildFillScript(username, password) {
  const u = JSON.stringify(String(username == null ? '' : username));
  const p = JSON.stringify(String(password == null ? '' : password));
  return '(function () {' +
    'var u = ' + u + ', p = ' + p + ';' +
    'var yhm = document.getElementById("yhm"), mm = document.getElementById("mm"), dl = document.getElementById("dl");' +
    'if (!yhm || !mm || !dl) return { ok: false, reason: "noform" };' +
    // 学校开了验证码就直接退出，交给用户在窗口里手输 —— 猜验证码既不可能也不体面。
    // 三个信号任一命中即视为「需要验证码」：隐藏配置项 dlsfbxyzm=1 / #yzmDiv 可见 / #yzm 输入框可见
    'var yzmDiv = document.getElementById("yzmDiv"), yzmInp = document.getElementById("yzm");' +
    'var yzmCfg = document.getElementById("dlsfbxyzm");' +
    'if (yzmCfg && yzmCfg.value === "1") return { ok: false, reason: "captcha" };' +
    'if (yzmDiv && yzmDiv.offsetParent !== null) return { ok: false, reason: "captcha" };' +
    'if (yzmInp && yzmInp.offsetParent !== null) return { ok: false, reason: "captcha" };' +
    // 少数学校版本要求勾《用户协议》，勾上了才能提交
    'var agree = document.getElementById("agreePolicy");' +
    'if (agree && !agree.checked) agree.checked = true;' +
    // 清掉上一次的失败提示，避免「新一次尝试」被旧红字污染
    'var tips = document.getElementById("tips"), kt = document.getElementById("dlktsxx");' +
    'if (tips) { tips.textContent = ""; tips.style.display = "none"; }' +
    'if (kt) { kt.textContent = ""; kt.style.display = "none"; }' +
    'yhm.value = u; mm.value = p; mm.type = "password";' +
    // 页面 JS 读的是 DOM 里的值，理论上不用派发事件；但有些版本绑了 input 校验，
    // 派发一次零成本，能避免「值填了但校验没跑」这类玄学问题
    'try {' +
    '  yhm.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  mm.dispatchEvent(new Event("input", { bubbles: true }));' +
    '} catch (e) {}' +
    'dl.click();' +
    'return { ok: true };' +
    '})()';
}

/**
 * 生成「读登录状态」的脚本。
 * 判定依据全部来自学校页面本身的信号，不靠 sleep 猜：
 *  - 离开登录页  = 成功（正方登录成功后跳 index_initMenu）
 *  - #dl 恢复可用 + 提示区有文字 = 失败，且文案就在那儿
 *  - 提示区两个容器都读：老版本用 #tips，V-9.0 另有 #dlktsxx（alert-danger）
 *  - dlsfbxyzm=1 / #yzmDiv / #yzm 可见 = 需要验证码
 */
function buildStatusScript() {
  return '(function () {' +
    'var dl = document.getElementById("dl"), tips = document.getElementById("tips"), yzmDiv = document.getElementById("yzmDiv");' +
    'var kt = document.getElementById("dlktsxx"), yzmInp = document.getElementById("yzm"), yzmCfg = document.getElementById("dlsfbxyzm");' +
    'var busy = !!dl && (dl.hasAttribute("disabled") || /登录中|Logining/.test(dl.textContent || ""));' +
    'var tip = (tips && tips.textContent ? tips.textContent.trim() : "") || (kt && kt.textContent ? kt.textContent.trim() : "");' +
    'return {' +
    '  onLoginPage: /login_slogin/i.test(location.href),' +
    '  busy: busy,' +
    '  tip: tip,' +
    '  captchaVisible: !!((yzmCfg && yzmCfg.value === "1") || (yzmDiv && yzmDiv.offsetParent !== null) || (yzmInp && yzmInp.offsetParent !== null))' +
    '};' +
    '})()';
}

/**
 * 从登录状态判定该做什么。
 * 返回 { state, message }，state ∈ success | fail | captcha | pending
 */
function classifyStatus(st) {
  if (!st) return { state: 'pending' };
  if (st.captchaVisible) {
    return { state: 'captcha', message: '教务系统要求填验证码，请在弹出的窗口里手动输完再点登录' };
  }
  if (!st.onLoginPage) return { state: 'success' };
  if (!st.busy && st.tip) {
    return { state: 'fail', message: withLockHint(st.tip) };
  }
  return { state: 'pending' };
}

/**
 * 失败文案润色：正方在连续失败后会开始加验证码/限流，
 * 这句提醒能拦住「再点一次试试」这种让事情变糟的直觉。
 */
function withLockHint(tip) {
  const t = String(tip == null ? '' : tip).trim();
  if (!t) return t;
  if (/次数|锁定|稍后|限流|过于频繁/.test(t)) {
    return t + '（连续失败会触发验证码或临时锁定，先别重复尝试）';
  }
  return t;
}

/**
 * 从教务系统的左侧菜单里发现真实的课表入口。
 * 各校菜单项名称不同（学生课表查询 / 我的课表 / 学期课表…），
 * 所以既按 URL 特征找（路径含 kb / kbcx），也按菜单文字找（含「课表」）。
 */
function buildMenuProbeScript() {
  return '(function () {' +
    'var out = [], seen = {};' +
    'function add(u, t) {' +
    '  if (!u || seen[u]) return;' +
    '  seen[u] = 1;' +
    '  out.push({ url: u, text: String(t || "").replace(/\\s+/g, " ").trim().slice(0, 40) });' +
    '}' +
    'var nodes = document.querySelectorAll("a[href], [onclick]");' +
    'for (var i = 0; i < nodes.length; i++) {' +
    '  var el = nodes[i];' +
    '  var t = (el.textContent || el.title || "");' +
    '  var raw = (el.getAttribute("href") || "") + " " + (el.getAttribute("onclick") || "");' +
    '  var byPath = /(\\/jwglxt\\/[\\w\\/]*(?:kb|kbcx)[\\w\\/]*\\.html[^\\s\'"<>]*)/i.exec(raw);' +
    '  if (byPath) { add(byPath[1], t); continue; }' +
    '  var byText = /(\\/jwglxt\\/[\\w\\/]+\\.html\\?[^\\s\'"<>]*gnmkdm=[\\w]+)/.exec(raw);' +
    '  if (byText && /课表|课程表/.test(t)) add(byText[1], t);' +
    '}' +
    'return out;' +
    '})()';
}

/**
 * 生成「在教务窗口里请求数据接口」的脚本。
 * 在窗口内 fetch 的好处：同源，cookie 自动带上，不依赖主进程同步 cookie jar；
 * 跨域/CORS 问题天然不存在。
 */
function buildFetchScript(url, body) {
  const u = JSON.stringify(String(url == null ? '' : url));
  const b = JSON.stringify(String(body == null ? '' : body));
  return '(function () {' +
    'return fetch(' + u + ', {' +
    '  method: "POST",' +
    '  credentials: "same-origin",' +
    '  headers: {' +
    '    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",' +
    '    "X-Requested-With": "XMLHttpRequest"' +
    '  },' +
    '  body: ' + b +
    '}).then(function (r) {' +
    '  return r.text().then(function (t) {' +
    '    return { status: r.status, finalUrl: r.url, body: t.length > 2000000 ? t.slice(0, 2000000) : t };' +
    '  });' +
    '})["catch"](function (e) { return { status: 0, error: String((e && e.message) || e) }; });' +
    '})()';
}

/**
 * 生成「GET 一个站内页面」的脚本。
 * GET 课表页有两个用处：一是拿学期下拉的当前值，二是顺便把会话状态顶到
 * 「已进入课表模块」，POST 数据接口时更接近页面的真实行为。
 */
function buildPageGetScript(url) {
  const u = JSON.stringify(String(url == null ? '' : url));
  return '(function () {' +
    'return fetch(' + u + ', { method: "GET", credentials: "same-origin" })' +
    '.then(function (r) { return r.text().then(function (t) {' +
    '  return { status: r.status, finalUrl: r.url, text: t.length > 1000000 ? t.slice(0, 1000000) : t };' +
    '}); })["catch"](function (e) { return { status: 0, error: String((e && e.message) || e) }; });' +
    '})()';
}

/**
 * 从课表页 HTML 里读学期下拉的当前值（纯函数，可单测）。
 *
 * 为什么费这个劲而不是自己按月份推算当前学期：
 *   - 各校开学日不同，还有小学期、寒假小学期，规则推不准；
 *   - 服务端已经把「当前学期」渲染在页面上（带 selected 的那个 option），
 *     这是唯一的权威来源，直接抄最省事。
 * 取值顺序：带 selected 的 → 第一个有 value 的 → 第一个，取不到就是空串。
 */
function parseSemesterOptions(html) {
  const out = { xnm: '', xqm: '' };
  const src = String(html == null ? '' : html);

  ['xnm', 'xqm'].forEach((id) => {
    const sel = new RegExp('<select[^>]*id=["\']' + id + '["\'][\\s\\S]{0,4000}?</select>', 'i')
      .exec(src);
    if (!sel) return;

    const opts = [];
    const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let m;
    while ((m = re.exec(sel[0]))) {
      const val = /value\s*=\s*["']?([^"'\s>]*)["']?/i.exec(m[1]);
      opts.push({
        value: val ? val[1] : '',
        // option 文本里可能嵌标签，去掉再压空白，避免把 HTML 当学期名
        text: m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
        selected: /\bselected\b/i.test(m[1])
      });
    }
    if (!opts.length) return;

    const chosen = opts.find((o) => o.selected) || opts.find((o) => o.value) || opts[0];
    out[id] = chosen.value || '';
  });

  return out;
}

/**
 * 把一次接口响应翻译成一句人能看懂的诊断。
 *
 * 存在的理由：接口不通和「这学期确实没课」在代码里长得几乎一样（都不是 kbList），
 * 但用户该做的事完全不同 —— 一个要去检查登录，一个本来就没事。
 * 第一版两种情况都报「没找到课表」，等于把排查工作全丢回给用户。
 */
function describeKbResponse(status, text) {
  if (status !== 200) return 'HTTP ' + status;
  const t = String(text == null ? '' : text);
  if (!t) return '响应是空的';

  const head = t.slice(0, 4000);
  if (/login_slogin|请先登录|用户登录|重新登录/.test(head)) {
    return '被重定向到登录页（会话已失效，重新登录一次即可）';
  }

  let obj;
  try {
    obj = JSON.parse(t);
  } catch (e) {
    return '不是 JSON（开头是：' + t.replace(/\s+/g, ' ').slice(0, 60) + '）';
  }

  const counts = [];
  const collect = (o) => {
    if (!o || typeof o !== 'object') return;
    ['kbList', 'xskbList', 'kbListXq'].forEach((k) => {
      if (Object.prototype.toString.call(o[k]) === '[object Array]') counts.push(o[k].length);
    });
  };
  collect(obj);
  if (obj && typeof obj === 'object') collect(obj.data);

  if (!counts.length) {
    return 'JSON 里没有课表数组（顶层字段：' + Object.keys(obj).slice(0, 10).join('、') + '）';
  }
  if (!counts.some((n) => n > 0)) {
    return '课表数组是空的（该学期没有课，或学期参数不对）';
  }
  return '有课表数据';
}

/**
 * 判断接口响应「像不像课表数据」——只看外壳，不看字段。
 *
 * 为什么只做轻量判断：字段级解析在 web/js/edu-html.js 的 parseZfKbList 里，
 * 那一层有单测、网页版与桌面端共用。主进程这里只负责**挑通道**：
 * 这个候选接口到底有没有吐课表，有就把原始文本交给渲染进程去解析。
 * 两处都做字段解析等于把同一份逻辑写两遍，迟早会不一致。
 */
function hasKbList(text) {
  let obj;
  try {
    obj = JSON.parse(String(text == null ? '' : text));
  } catch (e) {
    return false;
  }
  const isArr = (v) => Object.prototype.toString.call(v) === '[object Array]' && v.length > 0;
  if (isArr(obj)) return true;
  if (!obj || typeof obj !== 'object') return false;
  if (isArr(obj.kbList) || isArr(obj.xskbList) || isArr(obj.kbListXq)) return true;
  return !!(obj.data && typeof obj.data === 'object'
    && (isArr(obj.data.kbList) || isArr(obj.data.xskbList)));
}

module.exports = {
  LOGIN_PATH,
  TIMETABLE_CANDIDATES,
  TIMETABLE_BODY,
  bodyFor,
  loginUrlFrom,
  isLoginPage,
  buildFillScript,
  buildStatusScript,
  buildMenuProbeScript,
  buildFetchScript,
  buildPageGetScript,
  parseSemesterOptions,
  describeKbResponse,
  hasKbList,
  classifyStatus,
  withLockHint
};
