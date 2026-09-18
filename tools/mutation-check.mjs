// 变异测试脚本：依次破坏被测试守护的代码，确认对应断言真的会变红。
// 用法：node tools/mutation-check.mjs [node 可执行文件路径]
// 目的：防止「护栏永远通过、等于没写」—— 如果删掉某段代码后测试仍全绿，说明它没被守护。
// 实现上用「子串定位 + 替换」而不是复杂正则，避免转义地狱；脚本结束会还原源文件。
//
// 每个变异可以指定：
//   file     要改的文件（parser / layout / fixtureGen），默认 parser
//   apply(s) 返回改后的内容；返回原内容表示「没匹配上」，会被跳过
//   prepare  注入变异后 / 还原后要执行的收尾动作（如重新生成 PDF 夹具）
//   comment  该文件语言的注释符，默认 '//'；Python 夹具生成器必须写 '#'
//   equivalent  标记为「已知等价变异」—— 该改动不可能改变任何输入下的行为，
//               因此测试全绿是【正确】的，不算假护栏。必须同时写 reason 说明理由。
//               这是变异测试的标准处理：等价变异无法靠测试杀死，只能显式登记，
//               否则会长期污染信号，逼着人去写一条只为凑红而存在的假断言。
//
// ⚠️ 关于 comment：变异标记（MUTANT）会被插进目标文件的源码里当「污染指纹」，
//   所以它必须是【那个语言的合法注释】。曾经把 `// MUTANT` 追加到 Python 脚本行尾，
//   而 Python 里 `//` 是整除运算符 —— 脚本随即报错，prepare() 抛异常，
//   在 stdio:'ignore' 下 stdout/stderr 全为空，最终只看到一个 `pass=?`，
//   看起来像「测试没红」，实际是夹具根本没重建成功。
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// 脚本在 tools/ 下，源文件在仓库根的 web/js/，需要显式定位到仓库根
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.argv[2] || process.execPath;

const FILES = {
  parser: path.join(ROOT, 'web/js/parser.js'),
  layout: path.join(ROOT, 'web/js/pdf-layout.js'),
  importer: path.join(ROOT, 'web/js/importer.js'),
  eduHtml: path.join(ROOT, 'web/js/edu-html.js'),
  eduLogin: path.join(ROOT, 'desktop/edu-login.js'),
  credStore: path.join(ROOT, 'desktop/cred-store.js'),
  desktopPkg: path.join(ROOT, 'desktop/package.json'),
  sw: path.join(ROOT, 'web/sw.js'),
  standalone: path.join(ROOT, 'tools/build-standalone.mjs'),
  indexHtml: path.join(ROOT, 'web/index.html'),
  share: path.join(ROOT, 'web/js/share-image.js'),
  widgetStore: path.join(ROOT, 'desktop/widget-store.js'),
  shellLayout: path.join(ROOT, 'desktop/shell-layout.js'),
  widgetUi: path.join(ROOT, 'web/js/widget.js'),
  app: path.join(ROOT, 'web/js/app.js'),
  core: path.join(ROOT, 'web/js/core.js'),
  remind: path.join(ROOT, 'web/js/remind.js'),
  webdav: path.join(ROOT, 'web/js/webdav.js'),
  webdavClient: path.join(ROOT, 'desktop/webdav-client.js'),
  updateChecker: path.join(ROOT, 'desktop/update-checker.js'),
  fixtureGen: path.join(ROOT, 'tools/make-rotated-timetable-fixture.py')
};
const FIXTURE = 'tests/fixtures/cjk-timetable-rotated.pdf';

/** 原始内容按需读取（变异可能落在不同文件上） */
const originals = {};
function origOf(key) {
  const p = FILES[key];
  if (!(p in originals)) originals[p] = fs.readFileSync(p, 'utf8');
  return originals[p];
}
const PARSER_ORIG = origOf('parser');

/** 用当前（可能已被变异的）生成脚本重建 PDF 夹具 */
function rebuildFixture() {
  try {
    execSync(`python "${FILES.fixtureGen}" "${FIXTURE}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT
    });
  } catch (e) {
    // 绝不能静默吞掉：生成器报错时必须把它的 stderr 带出来，
    // 否则上层只会看到一个空输出，无从判断是「测试没红」还是「夹具没生成」。
    const detail = [(e.stdout || ''), (e.stderr || '')].join('').trim();
    throw new Error(
      `夹具生成失败（退出码 ${e.status}）:\n${detail || '(生成器无输出)'}\n` +
      `命令: python "${FILES.fixtureGen}" "${FIXTURE}"`
    );
  }
}

function between(text, startAnchor, endAnchor) {
  const i = text.indexOf(startAnchor);
  if (i < 0) return null;
  const j = text.indexOf(endAnchor, i + startAnchor.length);
  if (j < 0) return null;
  return text.slice(i, j + endAnchor.length);
}

const mutations = [];

/**
 * 调试用：只跑指定的变异，避免为了验一条而等十几分钟。
 * 支持单个下标、列表和范围（下标从 0 起）：
 *   MUT_ONLY=12        第 13 条
 *   MUT_ONLY=38-67     38 到 67 号
 *   MUT_ONLY=1,5,9     指定几条
 */
const ONLY_SPEC = String(process.env.MUT_ONLY || '').trim();
function onlyMatch(i) {
  if (!ONLY_SPEC) return true;
  for (const part of ONLY_SPEC.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(p);
    if (range) {
      if (i >= Number(range[1]) && i <= Number(range[2])) return true;
      continue;
    }
    if (Number(p) === i) return true;
  }
  return false;
}

// ==================== parser.js ====================

// 1) stripCourseCode 变成恒等函数
{
  const anchor = "  function stripCourseCode(name) {\n    if (!name) return '';";
  mutations.push({
    name: 'stripCourseCode 变成恒等函数',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, anchor + '\n    return String(name).trim(); // MUTANT') : s)
  });
}

// 2) 教师捕获退回旧写法（会吞掉 / 后面的内容）
{
  const target = between(PARSER_ORIG, 'var tm = /(?:教师|老师|授课)', '.exec(rest);');
  mutations.push({
    name: '教师捕获退回会吞掉「/选」「/地点」的旧写法',
    apply: (s) => (target ? s.replace(target, 'var tm = /(?:教师|老师|授课)[:：]\\s*([^\\s,;，]+)/.exec(rest); // MUTANT') : s)
  });
}

// 3) 显式教师全量清理去掉 g 标志
//
// ⚠️ 这个变异【是等价变异】，实测删掉 g 后测试仍 284/284 全绿。
//    原因：清理正则要求「教师|老师|授课」+ 冒号，一行的剩余文本里
//    正常情况下只可能出现一处这样的标注（真实教务课表如「教师:闵伟/选」）。
//    只有「同一行两处标注」（如「教师:张三 授课:李四」）才会让 g 起作用，
//    而这种写法在各教务系统导出格式里都没出现过。
//    真正有价值的那半个行为（清理必须吃掉 /选 残片，否则残片会污染课名）
//    由下面第 7 个变异单独守护，实测能变红 —— 覆盖没有缺口。
//    因此这里保留 g 作为纯防御性写法，并把本变异登记为等价变异，
//    不伪造一条只为凑红而存在的断言。
{
  const anchor = "(?:选修|必修|限选|任选|公选|选|必)?\\s*/g,";
  mutations.push({
    name: '显式教师清理去掉 g 标志（多处标注只清第一处）',
    equivalent:
      '清理正则的前缀必须是「教师/老师/授课 + 冒号」，同一行剩余文本里不会出现两处；' +
      '该改动在任何真实输入下行为完全相同。清理「不吃残片」的真问题由第 7 个变异守护。',
    apply: (s) =>
      s.includes(anchor) ? s.replace(anchor, "(?:选修|必修|限选|任选|公选|选|必)?\\s*/, // MUTANT") : s
  });
}

// 4) pendingName 用完不清空
{
  const target = "      if (!name) {\n        name = pendingName;\n        pendingName = '';\n      } else {";
  mutations.push({
    name: 'pendingName 用完不清空（恢复跨行泄漏）',
    apply: (s) => (s.includes(target) ? s.replace(target, "if (!name) name = pendingName;\n      if (name) { // MUTANT") : s)
  });
}

// 5) 剥离规则放宽到「任何括号都剥」（会误伤「大学英语(听说)」）
{
  const anchor = "      var next = out.replace(";
  mutations.push({
    name: '剥离规则放宽为「任意括号都剥」（误伤汉字括号课名）',
    apply: (s) => {
      if (!s.includes(anchor)) return s;
      const lineEnd = s.indexOf(';\n', s.indexOf(anchor));
      return s.slice(0, s.indexOf(anchor)) + "      var next = out.replace(/\\s*[（(\\[]\\s*[^（()）\\[\\]]*\\s*[)）\\]]\\s*$/g, ''); // MUTANT" + s.slice(lineEnd);
    }
  });
}

// 6) 去掉「孤立左括号」收尾清理
{
  const anchor = "    out = out.replace(/[\\s（(\\[【]+$/, '');";
  mutations.push({
    name: '去掉孤立左括号收尾清理（课名残留「(」）',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    // MUTANT: 收尾清理已移除') : s)
  });
}

// 7) 去掉「选课类型残片」清理（教师标注清理不再吃掉后随的「选」）
{
  const anchor = '\\s*(?:选修|必修|限选|任选|公选|选|必)?\\s*/g,';
  mutations.push({
    name: '教师标注清理不再吃掉「/选」残片',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '\\s*/g, // MUTANT') : s)
  });
}

// 8) 「详情行互换」去掉「本行已显式写 教师:X」门槛。
//    会误伤「线性代数 星期四 5-6节 1-16周 教师:郑十」这类行：首 token 被当人名，
//    课名被上一门课顶替（实测「线性代数」变成「体育」）。
{
  const anchor = '!teacher && !teacherExplicit &&';
  mutations.push({
    name: '互换逻辑去掉「教师标注」门槛（4 字课名被上一门顶替）',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '!teacher && // MUTANT') : s)
  });
}

// 9) 「详情行互换」去掉「本行只剩一个内容 token」门槛。
//    会让「线性代数 (GBK0102003) …」这种自带课程编号的行也去继承上一行课名。
{
  const anchor = 'parts.nonLocCount === 1 &&';
  mutations.push({
    name: '互换逻辑去掉「仅剩一个内容 token」门槛',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '// MUTANT') : s)
  });
}

// 10) 输出教师时改回 parts.teacher（丢弃互换出来的教师）
//     标记必须写成【块注释】留在行内 —— 写成 `// MUTANT` 会把这行末尾的逗号
//     一起注释掉，对象字面量随即语法错误，测试会以「整个测试文件加载失败」
//     的形式全红，看起来像「变异生效了」，其实被测代码根本没跑起来（踩过一次）。
{
  const anchor = "teacherExplicit || teacher || ''";
  mutations.push({
    name: '输出教师改回 parts.teacher（详情行教师丢失）',
    apply: (s) =>
      s.includes(anchor) ? s.replace(anchor, "teacherExplicit || /* MUTANT */ parts.teacher || ''") : s
  });
}

// ==================== pdf-layout.js ====================

// 11) 去掉整页扶正（带 content-stream cm 旋转的 PDF 会整页被清空）
{
  const anchor = 'items = rectifyItems(items); // 先扶正整页';
  mutations.push({
    name: 'normalizeItems 不再调用 rectifyItems（旋转 PDF 整页清空）',
    file: 'layout',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '// MUTANT: 未扶正') : s)
  });
}

// 12) 扶正角度改为量化值（累积漂移会拆散表头、列识别失效）
{
  const anchor = 'var theta = n ? sum / n : target;';
  mutations.push({
    name: '扶正角度量化到 0.1 弧度（累积漂移拆散表头）',
    file: 'layout',
    apply: (s) =>
      s.includes(anchor)
        ? s.replace(anchor, 'var theta = n ? Math.round((sum / n) / 0.1) * 0.1 : target; // MUTANT')
        : s
  });
}

// ==================== 夹具生成器 ====================

// 13) 夹具丢掉内容流旋转矩阵 —— 复刻「第一版夹具」的坑：
//     只留页级 /Rotate，看起来很像，实则完全触发不了旋转分支。
//     注意标记用 '#' 而不是 '//'：这是 Python 文件，'//' 是整除运算符不是注释。
{
  const anchor = 'parts = [CM_ROTATE]';
  mutations.push({
    name: '夹具丢掉内容流旋转矩阵（夹具不再 representative）',
    file: 'fixtureGen',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, 'parts = []  # MUTANT') : s),
    prepare: () => rebuildFixture()
  });
}

// ==================== CMap 源选择（「PDF 中未提取到文字」的真根因所在）====================

// 14) 只留一个 CMap 源 —— 等于没有兜底。
//     在境内这是致命的：唯一那个源取不到时，整页文字凭空消失，
//     而 pdf.js 只 warn 不抛错，界面只剩一句「PDF 中未提取到文字」。
{
  mutations.push({
    name: 'CMap 只留一个源（首选取不到就彻底没辙）',
    file: 'importer',
    apply: (s) => s.replace(
      /var CMAP_SOURCES = \[[\s\S]*?\];/,
      "var CMAP_SOURCES = ['cmaps/']; // MUTANT"
    )
  });
}

// 15) 把本地源从首位挪走 —— 违反了「同源随包目录最可靠」这个排序原则
{
  mutations.push({
    name: 'CMap 源顺序颠倒（把最可靠的本地目录挪到后面）',
    file: 'importer',
    apply: (s) => s.replace(
      /var CMAP_SOURCES = \[[\s\S]*?\];/,
      "var CMAP_SOURCES = ['https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/cmaps/', " +
      "'cmaps/']; // MUTANT"
    )
  });
}

// 16) 解不出文字时不换源、直接放弃 —— 复刻旧版「一次失败就完事」的行为
{
  const anchor = 'return doc.destroy().then(function () { return tryAt(i + 1); });';
  mutations.push({
    name: '解不出文字时不换源（退回单源行为）',
    file: 'importer',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, 'return doc.destroy().then(function () { return null; }); // MUTANT')
      : s)
  });
}

// 17) 实试时不复制 ArrayBuffer —— pdf.js 会把它 detach，第二次就是空 buffer
{
  mutations.push({
    name: '实试时不复制 ArrayBuffer（第二个源拿到空数据）',
    file: 'importer',
    apply: (s) => s.replace(/buf\.slice\(0\)/g, 'buf /* MUTANT */')
  });
}

// 18) SW 退回 cache-first —— 已发布的修复要用户访问两次才生效，
//     制造出「我这边改好了、用户还说不行」的假象（上两轮就是这么被带偏的）
{
  mutations.push({
    name: 'SW 退回 cache-first（修复延迟一两次访问才生效）',
    file: 'sw',
    apply: (s) => {
      const seg = between(s, 'event.respondWith(', '  );\n});');
      if (!seg) return s;
      const replaced = [
        'event.respondWith(',
        '    caches.match(req, { ignoreSearch: true }).then((hit) => {',
        '      if (hit) {',
        '        fetch(req).then(save).catch(() => {}); // MUTANT',
        '        return hit;',
        '      }',
        '      return fetch(req).then(save).catch(() => Response.error());',
        '    })',
        '  );',
        '});'
      ].join('\n');
      return s.replace(seg, replaced);
    }
  });
}

// ==================== 教务直连：自动登录与账号存储 ====================

// 19) 填表时不用 JSON.stringify 转义，改成裸拼字符串。
//     这是最危险的一处：密码里一个引号就会把脚本拼断（静默失败，最难查），
//     而恶意用户名能直接在教务页面里执行代码。护栏必须能挡住。
{
  mutations.push({
    name: '自动登录：用户名/密码不再转义，裸拼进脚本',
    file: 'eduLogin',
    apply: (s) => {
      const seg = between(
        s,
        "  const u = JSON.stringify(String(username == null ? '' : username));",
        "  const p = JSON.stringify(String(password == null ? '' : password));"
      );
      if (!seg) return s;
      const replaced = [
        '  const u = \'"\' + String(username == null ? \'\' : username) + \'"\'; // MUTANT',
        '  const p = \'"\' + String(password == null ? \'\' : password) + \'"\';'
      ].join('\n');
      return s.replace(seg, replaced);
    }
  });
}

// 20) 没有星期信息的记录直接塞到周一（而不是跳过）。
//     这个降级的后果很隐蔽：课表看起来一切正常，但课被摆到了错误的一天，
//     用户照着走会真的跑错教室 —— 属于「看起来能用」的假成功。
{
  mutations.push({
    name: '课表接口解析：缺星期不再跳过，默认塞到周一',
    file: 'eduHtml',
    apply: (s) => {
      const seg = between(
        s,
        '      var day = dayFromRow(row, got.dayMap);',
        '      if (!day) { skipped++; continue; }'
      );
      if (!seg) return s;
      return s.replace(seg, [
        '      var day = dayFromRow(row, got.dayMap); // MUTANT',
        '      if (!day) day = 1;'
      ].join('\n'));
    }
  });
}

// 21) 加密能力不可用时降级成明文保存。
//     用户永远不会知道自己的密码躺在硬盘上 —— 隐私事故的典型形态。
{
  mutations.push({
    name: '账号存储：加密不可用时降级成明文保存',
    file: 'credStore',
    apply: (s) => {
      const anchor = "    if (!available()) return { ok: false, reason: 'noenc' };";
      if (!s.includes(anchor)) return s;
      return s.replace(anchor, '    if (!available()) return { ok: true }; // MUTANT');
    }
  });
}

// ==================== 打包配置 ====================

// 22) 打包白名单从「*.js」改成显式枚举，且漏掉新模块。
//     这是本项目真实踩过的坑：构建照样成功、产物照样生成，
//     装完点图标才报 Cannot find module —— 只有断言能拦住。
{
  mutations.push({
    name: '打包白名单改成显式枚举并漏掉模块（构建仍会成功）',
    file: 'desktopPkg',
    apply: (s) => {
      if (!s.includes('"*.js"')) return s;
      return s.replace('"*.js"', '"main.js",\n      "preload.js"');
    }
  });
}

// ==================== 单文件版构建（tools/build-standalone.mjs）====================

// 23) 剥离 <link rel="icon"> 时去掉 g 标志。
//     这是**真实发生过的 bug**：当初 icon 只有一行 SVG，不带 g 也看不出问题；
//     后来给 iOS 补了 PNG 兜底那一行，第二个 <link rel="icon"> 就留在了产物里，
//     指向一个相对于单文件 HTML 并不存在的路径（双击打开会 404）。
//     注意这里必须锚在整条语句上：文件注释里也出现了 <link rel="icon"> 字样，
//     只锚标签会改到注释上，变异就变成了空操作。
{
  const anchor = 'out = out.replace(/^\\s*<link rel="icon"[^>]*>\\s*$/gm, \'\');';
  mutations.push({
    name: '单文件版剥离 icon 时漏掉 g 标志（只删第一个，剩下的残留成坏引用）',
    file: 'standalone',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, anchor.replace('$/gm', '$/m') + ' // MUTANT')
      : s)
  });
}

// 24) 上面的 bug 再叠加「末尾自检失效」—— 也就是**当初那个 bug 的真实形态**：
//     剥离逻辑坏了，而构建期自检又查不到（旧版只枚举 stylesheet/script/manifest）。
//     这时构建会「成功」并产出坏文件，唯一还能拦住它的就是 tests/standalone.test.mjs。
//
//     ⚠️ 单独禁用自检（不叠加 23）是**等价变异**：剥离逻辑本身是对的，
//        关掉一个查不出问题的检查不会产生任何可观测差异。所以这里必须两处一起改，
//        否则它会以「假护栏」的名义被误报（我第一版就是这么写错的）。
//     这条变异与 23 的分工：23 证明构建期自检有效，24 证明测试层**独立**有效。
{
  const strip = 'out = out.replace(/^\\s*<link rel="icon"[^>]*>\\s*$/gm, \'\');';
  const guard = 'if (dangling.length) {';
  mutations.push({
    name: '剥离逻辑漏 g + 自检失效（构建会成功，只剩测试能拦）',
    file: 'standalone',
    apply: (s) => {
      if (!s.includes(strip) || !s.includes(guard)) return s;
      return s
        .replace(strip, strip.replace('$/gm', '$/m'))
        .replace(guard, 'if (false && dangling.length) { // MUTANT');
    }
  });
}

// ==================== 图标（web/index.html + 产物）====================

// 25) apple-touch-icon 换回 SVG —— **这是真实存在过的缺陷**。
//     iOS 的 apple-touch-icon 只认 PNG，挂 SVG 会让「添加到主屏幕」拿不到图标：
//     页面装得上，图标是空白，而且在桌面浏览器里完全看不出来（桌面读的是
//     <link rel="icon">）。只有断言能拦。
{
  const anchor = 'href="icon-180.png" sizes="180x180"';
  mutations.push({
    name: 'apple-touch-icon 换成 SVG（iOS 上主屏图标会空白）',
    file: 'indexHtml',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, 'href="icon.svg"') // MUTANT
      : s)
  });
}

// 注：maskable 图标「四边不得透明」这条护栏的变异体是**二进制产物**，
// 没法用文本替换注入（要真去改 PNG 的像素），所以这里不登记；
// 它的有效性是手工验证过的：把 maskable 上边一条像素抹成透明 → 测试精确报出
// 「边缘有 514 个透明像素」。

// ==================== 课表分享图（web/js/share-image.js）====================
//
// 这个功能的验收标准是「导出的图看着对」，最容易出现的失败不是崩溃，
// 而是「图导出来了、但某处明显不对」：两门课叠一起、课名切一半、
// 切了深色主题图没变。所以这里挑的变异都是**那种肉眼一看就废、代码却照跑不误**的改动。

// 26) 泳道边界判断写成 <=（相邻节次的两门课被当成不冲突）。
//     如「1-2 节」与「2-3 节」共享第 2 节，写成 <= 就会把后一门叠在前一门身上。
//     这类 off-by-one 是泳道算法最典型的 bug，而且画出来只是「两个字重叠」，
//     不会报任何错。
{
  const anchor = '        if (last.endSection < c.startSection) {';
  mutations.push({
    name: '泳道边界写成 <=（相邻节次的两门课叠在一起）',
    file: 'share',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '        if (last.endSection <= c.startSection) { // MUTANT') : s)
  });
}

// 27) 周次文案再补一个「周」—— **这是真实发生过的 bug**（图上印出「1-16 周周」）。
//     屏幕上根本不显示这段文字，所以只有真把图导出来才看得见。
{
  const anchor = "      return CF.weeksText(course.weeks) || '';";
  mutations.push({
    name: '周次文案重复补「周」（图上印出「1-16 周周」）',
    file: 'share',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "      return (CF.weeksText(course.weeks) || '') + '周'; // MUTANT")
      : s)
  });
}

// 28) 截断时不计省略号本身的宽度 → 截断结果仍然比可用宽度宽一点点，
//     正好糊住隔壁泳道。试断言的是「截断后真的放得下」，不只「有没有省略号」。
{
  const anchor = '      if (measure(next, size) + ellW > maxWidth) break;';
  mutations.push({
    name: '截断时不计省略号宽度（课名仍然溢出格子）',
    file: 'share',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '      if (measure(next, size) > maxWidth) break; // MUTANT')
      : s)
  });
}

// 29) 课块纵向定位差一节（`start - 1` 写成 `start`）。
//     结果「第 1 节的课」被画到第 2 节的位置，整张表的课都错行一边。
{
  const anchor = '          var blockY = bodyY + (csp.start - 1) * ROW_H + GAP;';
  mutations.push({
    name: '课块纵向错位一节（第 1 节的课画到第 2 节的位置）',
    file: 'share',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '          var blockY = bodyY + csp.start * ROW_H + GAP; // MUTANT')
      : s)
  });
}

// 30) 不再跳过「节次超出当前作息」的课。
//     换过作息预设后老数据里常有 13~16 节的课（比如从 12 节改成 10 节）。
//     注意这条的**可观测后果不是画到画布外**——往下那块「高度不足 18px 就放弃」
//     的兜底会顺手把它丢掉。真正的后果是：这门课被算进了 visible，
//     于是页脚写「共 2 门课程」而图上只有 1 块 —— 用户会以为课丢了。
//     第一版就是只断言 blocks 内容，结果这条变异全绿（假护栏），
//     补了「页脚门数 == 课块数」的断言才拦住。
{
  const anchor = '      if (sp.start > totalSections) continue; // 节次超出当前作息（换过作息预设）→ 画不出来';
  mutations.push({
    name: '不跳过超出当前作息的节次（页脚门数与图上课块数不一致）',
    file: 'share',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '      // MUTANT: 不再跳过超界节次')
      : s)
  });
}

// 31) 深色主题的底色写成浅色（切了主题但图没变）。
//     开关动了、预览也重画了，就是颜色没跟上 —— 用户会以为「深色导出坏了」。
{
  const anchor = "      bg: '#0f131a', panel: '#171c25', line: '#262e3b', grid: '#202733',";
  mutations.push({
    name: '深色主题底色写成浅色（切了主题但图没变）',
    file: 'share',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "      bg: '#ffffff', panel: '#171c25', line: '#262e3b', grid: '#202733', // MUTANT")
      : s)
  });
}

// 32) overrides 不再覆盖配色 —— 浏览器端把当前主题的 CSS 变量解析出来传进来，
//     就是为了让导出的图跟随屏幕配色；这条一断，深色主题下导出的还是浅色配色方案。
{
  const anchor = '        if (overrides[k] && overrides[k].main) out[k].main = overrides[k].main;';
  mutations.push({
    name: '配色 overrides 不生效（导出的图不跟随当前主题配色）',
    file: 'share',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '        // MUTANT: overrides 不再覆盖 main') : s)
  });
}

// 33) 未知颜色 key 不再回落到默认色 → colorOf 返回 undefined，
//     往下读 col.key 直接抛 TypeError，整张图导不出来。
//     （core.js 里删一个颜色、或老数据里存着已废弃的 key，就是这个场景。）
{
  const anchor = "    return palette[key] || palette.blue || { main: '#2f6fed', bg: '#e8effd' };";
  mutations.push({
    name: '未知配色 key 不回落（整张图导出直接崩）',
    file: 'share',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    return palette[key]; // MUTANT') : s)
  });
}

// 34) 圆角半径不再被边长一半夹住 → path 自交，画出奇怪形状。
//     老 WebView 没有 roundRect，路径是手画的，夹取这一步不能少。
{
  const anchor = '    var rr = clamp(r || 0, 0, Math.min(w, h) / 2);';
  mutations.push({
    name: '圆角半径不再夹到边长一半（path 自交）',
    file: 'share',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    var rr = r || 0; // MUTANT') : s)
  });
}

// 35) 课名只允许一行 —— 退回「数据结…」那种等于没写的截断。
//     这是真机上第一版样图的真实观感问题（截图里「数据结构与算法分析」只剩三个字），
//     Node 测试原本也不拦，因为「截断了」和「截断得没法读」都是截断。
{
  const anchor = '            : fitName(course.name, innerW, nameSize, measure, roomy ? 2 : 1);';
  mutations.push({
    name: '课名只允许一行（退回「数据结…」）',
    file: 'share',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '            : fitName(course.name, innerW, nameSize, measure, 1); // MUTANT')
      : s)
  });
}

// 36) 课名排版不再降档字号 —— 只能靠截断收场。
//     单列可用宽度只有约 89px，19px 字下就 4 个汉字，「数据结构与算法分析」必然被砍。
{
  const anchor = '    var ladder = [baseSize, baseSize - 2, baseSize - 4, 14];';
  mutations.push({
    name: '课名排版不降字号（中等长度课名被截断）',
    file: 'share',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    var ladder = [baseSize]; // MUTANT')
      : s)
  });
}

// 37) 折行截断时丢掉本行已排好的字（写成 s.slice(i) 而不是 cur + s.slice(i)）。
//     这是我在写这个函数时真的差点犯的错：表现出来是**短名字凭空少头一个字**，
//     而且只在「行数用尽」这条分支上才出现，肉眼扫代码很难发现。
{
  const anchor = '          var fitted = fitText(cur + s.slice(i), size, maxWidth, measure);';
  mutations.push({
    name: '折行截断丢掉本行已排好的字（名字少头一个字）',
    file: 'share',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '          var fitted = fitText(s.slice(i), size, maxWidth, measure); // MUTANT')
      : s)
  });
}

// 38) 深色主题下课块底色不再压暗 → **白底白字，课名整片看不见**。
//     这是真机样图上真实出现过的缺陷（浅色页面里点「深色导出」触发），
//     而所有「结构性」的检查全都通过：尺寸对、指令合法、PNG 完整、色条颜色正确。
//     只有「数像素 / 比亮度」这种判据拦得住 —— 也正是这条变异存在的理由。
{
  const anchor = '          var blockBg = isDark ? blockBgOf(col) : col.bg;';
  mutations.push({
    name: '深色主题课块底色不压暗（白底白字，课名看不见）',
    file: 'share',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '          var blockBg = col.bg; // MUTANT')
      : s)
  });
}

// ==================== 桌面常驻小组件：数据中枢 ====================
//
// 这一批守护的是「三处文案的唯一来源」（托盘提示 / 托盘菜单 / 小组件窗口）。
// 共同点是：错了不会崩，只会**说错话** —— 未开学被说成「14 天没有课」、
// 下周三被说成「周三」、作息没配被说成「没课」。这类错用户会当成产品缺陷，
// 但任何结构化检查都看不出来，只能靠断言钉住。

// 39) 未开学时不再单独分支 → 落到「接下来 14 天没有课」
{
  const anchor = "  if (view.phase === 'beforeterm') {";
  mutations.push({
    name: '未开学不单独说「距开学还有 N 天」',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "  if (false && view.phase === 'beforeterm') { // MUTANT")
      : s)
  });
}

// 40) 周次文案去掉下界判断 → 「第 0 周」「第 -2 周」
{
  const anchor = "  if (week < 1) return '未开学';";
  mutations.push({
    name: '周次文案不处理开学前（界面露出「第 0 周」）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '  // MUTANT') : s)
  });
}

// 41) 跨天称呼前缀写成「下周」→「下周周三」（同一类「周」重复拼接的坑）
{
  const anchor = "  return (sameWeek ? '本' : '下') + CF.DAY_NAMES[R.weekdayOf(targetStart) - 1];";
  mutations.push({
    name: '跨天称呼拼成「下周周三」（前缀与 DAY_NAMES 都带「周」）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "  return (sameWeek ? '本周' : '下周') + CF.DAY_NAMES[R.weekdayOf(targetStart) - 1]; // MUTANT")
      : s)
  });
}

// 42) 把「明天」的分支去掉 → 明天的课被说成「本周X」
{
  const anchor = "  if (daysAhead === 1) return '明天';";
  mutations.push({
    name: '去掉「明天」的分支（次日课程被说成本周某天）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '  // MUTANT') : s)
  });
}

// 43) 精确时刻退化成「从取整到分钟的字段反推」→ 秒级倒计时最多偏 30 秒。
//     这是实现过程中真实出现过的缺陷：测试用具例落在分钟中段才发现。
{
  const anchor = '    startAt: raw.start.getTime(),';
  mutations.push({
    name: 'item 不给精确 startAt（渲染层只能从取整到分钟的值反推，秒级倒计时会偏）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    startAt: now.getTime() + startInMin * 60000, // MUTANT')
      : s)
  });
}

// 44) 跨天的课也给 startsInMin（界面会出现「还有 10080 分钟」）
{
  const anchor = '    startsInMin: daysAhead === 0 ? startInMin : null,';
  mutations.push({
    name: '跨天的课也给分钟倒计时（「还有 10080 分钟」）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    startsInMin: startInMin, // MUTANT')
      : s)
  });
}

// 45) phase 优先级颠倒：next 抢在 current 前面
{
  const anchor = "    else if (view.current) view.phase = 'current';\n    else if (view.next) view.phase = 'next';";
  mutations.push({
    name: 'phase 优先级颠倒（正在上课被报成「即将上课」）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "    else if (view.next) view.phase = 'next'; // MUTANT\n    else if (view.current) view.phase = 'current';")
      : s)
  });
}

// 46) 作息缺失判定写反 → 今天没课的日子被报成「作息时间缺失」
{
  const anchor = '    const missingTimes = listedToday.length > 0 && tl.items.length === 0;';
  mutations.push({
    name: '作息缺失判定写反（没课的日子被报成作息缺失）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    const missingTimes = listedToday.length === 0 || tl.items.length > 0; // MUTANT')
      : s)
  });
}

// 47) 放假标记被忽略 → 放假当天照常显示要上课
{
  const anchor = '    view.off = !!tl.off;';
  mutations.push({
    name: '忽略放假标记（放假当天仍显示要上课）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    view.off = false; // MUTANT') : s)
  });
}

// 48) tooltip 不再限制长度
{
  const anchor = "    return full.length > 120 ? full.slice(0, 119) + '…' : full;";
  mutations.push({
    name: 'tooltip 不做长度截断（Windows 会把它切在半路）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    return full; // MUTANT') : s)
  });
}

// 49) 无数据时错误地报成「没课」而不是「去导入」
{
  const anchor = "      phase: 'nodata',";
  mutations.push({
    name: '无课表被报成「没课」（用户不知道该去导入）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, "      phase: 'none', // MUTANT") : s)
  });
}

// ==================== 桌面常驻小组件：窗口几何与偏好 ====================
//
// 这一批守护的是一个**用户自己救不回来**的场景：小组件没有任务栏按钮，
// 窗口一旦落在屏幕外就再也抓不回来（拔外接屏、改分辨率都会触发）。

// 50) 位置校验形同虚设 → 屏幕外的坐标被原样采用
{
  // ⚠️ 锚点必须含上下文：光写 isVisibleOn( 会和别处的调用混
  const anchor = '  if (isVisibleOn(saved, s, areas)) {\n    return { x: Math.round(saved.x), y: Math.round(saved.y) };';
  mutations.push({
    name: '位置校验形同虚设（屏幕外的坐标被原样采用，窗口再也找不回来）',
    file: 'shellLayout',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '  if (true) { // MUTANT\n    return { x: Math.round(saved.x), y: Math.round(saved.y) };')
      : s)
  });
}

// 51) 可见门槛降到 0 → 只露一条 1px 的边也算「看得见」
{
  const anchor = 'const MIN_VISIBLE = 48;';
  mutations.push({
    name: '可见门槛降为 0（只露一条边也算看得见，用户抓不到窗口）',
    file: 'shellLayout',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, 'const MIN_VISIBLE = 0; // MUTANT') : s)
  });
}

// 52) 回落位置丢掉边缘留白
{
  const anchor = '    x: Math.round(a.x + a.width - s.width - EDGE),';
  mutations.push({
    name: '回落位置丢掉边缘留白（贴死在屏幕边上）',
    file: 'shellLayout',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    x: Math.round(a.x + a.width - s.width), // MUTANT')
      : s)
  });
}

// 53) 偏好文件读到数组也当合法
{
  const anchor = "    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};";
  mutations.push({
    name: '偏好文件读到数组也当合法结构',
    file: 'shellLayout',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "    return (parsed && typeof parsed === 'object') ? parsed : {}; // MUTANT")
      : s)
  });
}

// 54) 写盘失败假装成功 → 位置记不住，用户每次都要重拖
{
  const anchor = '  } catch (e) {\n    return false;\n  }\n}';
  const target = "function savePrefs(file, prefs) {";
  mutations.push({
    name: '偏好写盘失败假装成功（位置记不住却没有任何提示）',
    file: 'shellLayout',
    apply: (s) => {
      const i = s.indexOf(target);
      if (i < 0) return s;
      const j = s.indexOf(anchor, i);
      if (j < 0) return s;
      return s.slice(0, j) + '  } catch (e) {\n    return true; // MUTANT\n  }\n}' + s.slice(j + anchor.length);
    }
  });
}

// 55) 图标候选倒着找（放着清晰的 .ico 不用，用了最糊的兜底 PNG）
{
  // ⚠️ 锚点必须含上一行：单写 for 循环会先命中 isVisibleOn 里的同款循环
  const anchor = '  const list = Array.isArray(candidates) ? candidates : [];\n  for (let i = 0; i < list.length; i++) {';
  mutations.push({
    name: '图标候选倒着找（放着清晰的 .ico 不用，用了兜底的 PNG）',
    file: 'shellLayout',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '  const list = Array.isArray(candidates) ? candidates : [];\n  for (let i = list.length - 1; i >= 0; i--) { // MUTANT')
      : s)
  });
}

// ==================== 桌面常驻小组件：渲染层 ====================

// 56) 回到「用取整到分钟的字段反推锚点」——即第 43 条那个缺陷的渲染侧版本
{
  const anchor = '      a.nextAt = v.next.startAt;';
  mutations.push({
    name: 'anchorsOf 从取整到分钟的 startsInMin 反推时刻（秒级倒计时最多偏 30 秒）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '      a.nextAt = base + v.next.startsInMin * 60000; // MUTANT')
      : s)
  });
}

// 57) 跨天的课也给倒计时锚点
{
  const anchor = "    if (v.phase === 'next' && v.next && v.next.daysAhead === 0";
  mutations.push({
    name: 'anchorsOf 跨天的课也给锚点（显示成「还有 10080 分钟」）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "    if (v.phase === 'next' && v.next && true")
      : s)
  });
}

// 58) 进度百分比不再夹取 → 进度条会溢出
{
  const anchor = '    return Math.max(0, Math.min(100, p));';
  mutations.push({
    name: '进度百分比不夹取（进度条宽度溢出）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    return p; // MUTANT') : s)
  });
}

// 59) 一小时以上不再切换到「小时」单位
{
  const anchor = "    if (h > 0) return m > 0 ? (h + ' 小时 ' + m + ' 分钟') : (h + ' 小时');";
  mutations.push({
    name: '倒计时不切换到小时单位（显示成「135 分钟」）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    // MUTANT') : s)
  });
}

// 60) 十分钟以内不再精确到秒
{
  const anchor = "    if (m >= 10) return m + ' 分钟';";
  mutations.push({
    name: '十分钟以内不给秒（临上课前只能看到「9 分钟」）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, "    if (m >= 1) return m + ' 分钟'; // MUTANT") : s)
  });
}

// 61) 放假时不再把「下一节课」顶上来（只说放假，等于什么也没回答）
{
  const anchor = "    if (v.phase === 'off') return v.next || null;";
  mutations.push({
    name: '放假时不再显示下一节课',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    if (v.phase === \'off\') return null; // MUTANT') : s)
  });
}

// 62) 不是今天的课不加日期前缀（「08:00 ~ 09:40」会被当成今天要上课）
{
  const anchor = '    if (s.daysAhead > 0) parts.push(s.dayLabel);';
  mutations.push({
    name: '非当天的课不加日期前缀（明天的时间被当成今天的）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    // MUTANT') : s)
  });
}

// 63) 正在上课时也说「今天还有 N 节」而不是「今天最后一节」
{
  const anchor = "      return v.todayRemaining > 0 ? '今天还有 ' + v.todayRemaining + ' 节' : '今天最后一节';";
  mutations.push({
    name: '今天最后一节课也显示「今天还有 0 节」',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "      return '今天还有 ' + v.todayRemaining + ' 节'; // MUTANT")
      : s)
  });
}

// 64) 渲染时不再设置 data-phase（配色与进度条显隐全部失灵）
{
  const anchor = "    if (card && card.setAttribute) card.setAttribute('data-phase', v.phase || 'nodata');";
  mutations.push({
    name: 'render 不设置 data-phase（配色与进度条显隐全部失灵）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '    // MUTANT') : s)
  });
}

// 65) 挂载时不再主动拉一次数据（要干等 30 秒的 tick）
{
  const anchor = '    pull();\n\n    // 每秒重画一次';
  mutations.push({
    name: 'boot 挂载时不主动拉数据（先空白，干等 30 秒）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor) ? s.replace(anchor, '\n    // 每秒重画一次 // MUTANT') : s)
  });
}

// 66) 关闭按钮接成「打开课表」（点 ✕ 反而弹出主窗口）
{
  const anchor = "    if (close) close.addEventListener('click', function () { api.hide(); });";
  mutations.push({
    name: '关闭按钮接成 openMain（点 ✕ 反而弹出主窗口）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "    if (close) close.addEventListener('click', function () { api.openMain(); }); // MUTANT")
      : s)
  });
}

// ==================== 课表快照推送（网页端 → 主进程） ====================

// 67) persist() 不再推送快照 → 托盘长期显示旧数据
{
  const anchor = '    ST.save({ version: 2, activeId: state.activeId, semesters: state.semesters });\n    pushToDesktop();';
  mutations.push({
    name: 'persist 不再把课表推给主进程（托盘长期显示旧数据）',
    file: 'app',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    ST.save({ version: 2, activeId: state.activeId, semesters: state.semesters }); // MUTANT')
      : s)
  });
}

// 68) 推送失败把异常抛出去 → 课表保存被桌面外壳拖累
//
// ⚠️ 这里刻意**不动 try 的括号结构**：把 `try {` 换成 `{` 会造出语法错误，
//    整个 app.js 加载不起来、所有用例一起红 —— 那种「红」是假阳性，
//    证明不了这条断言真的在守护「异常被吞掉」这个行为。
//    改 catch 体才是语法合法的、指向行为的变异。
{
  const anchor = '    } catch (e) {\n      return; // 桥不可用：当作网页版处理';
  mutations.push({
    name: '推送异常不吞掉（桌面外壳出问题会连累课表保存）',
    file: 'app',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    } catch (e) {\n      throw e; // MUTANT')
      : s)
  });
}

// ==================== 考试与事件（P3） ====================

// 69) 倒计时文案烂掉：「今天」说成「还有 0 天」——语气错得很难看
{
  const anchor = "  function countdownTextOf(daysLeft) {\n    if (daysLeft === 0) return '今天';";
  mutations.push({
    name: '倒计时文案：今天说成「还有 0 天」（机器味）',
    file: 'core',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "  function countdownTextOf(daysLeft) {\n    if (daysLeft === 0) return '还有 0 天'; // MUTANT")
      : s)
  });
}

// 70) 过滤过去的失效：考完试还挂在倒计时条上
{
  const anchor = '      if (left == null || left < 0) continue;';
  mutations.push({
    name: 'upcomingEvents：过去的日期不再过滤（考完试还挂在条上）',
    file: 'core',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '      if (left == null) continue; // MUTANT')
      : s)
  });
}

// 71) 清洗不再丢坏数据：空名字的事件原样通过
{
  const anchor = '    if (!name || !d) return null;';
  mutations.push({
    name: 'normalizeEvent：空名字 / 坏日期不再丢弃（一条坏数据污染整个列表）',
    file: 'core',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    if (!d) return null; // MUTANT（名字不再校验）')
      : s)
  });
}

// 72) 托盘考试行的 7 天门槛失效：远期考试也挤上托盘
{
  const anchor = "        if (ev.kind !== 'exam' || ev.daysLeft > 7) continue;";
  mutations.push({
    name: 'tooltip：7 天门槛失效（远期考试也挤上托盘，挤掉真正要紧的两行）',
    file: 'widgetStore',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "        if (ev.kind !== 'exam') continue; // MUTANT（不再看天数）")
      : s)
  });
}

// 73) 挂件事件行不再用主进程文案：countdownText 被无视（退化为拼数字）
{
  const anchor = "    return (ev.kind === 'exam' ? '📝 ' : '📌 ') + ev.name + ' · ' + cd;";
  mutations.push({
    name: 'eventLineOf：无视 countdownText（拼出「高数期末 · 4」这种半截话）',
    file: 'widgetUi',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "    return (ev.kind === 'exam' ? '📝 ' : '📌 ') + ev.name + ' · ' + ev.daysLeft; // MUTANT")
      : s)
  });
}

// 74) 考试提醒去重失效：账本被无视，同一条考试一天弹到天黑
{
  const anchor = '      if (map[ev.id] === todayKey) continue;';
  mutations.push({
    name: 'dueExamAlerts：去重账本失效（同一条考试一天弹到天黑）',
    file: 'remind',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '      // MUTANT（不再看账本）')
      : s)
  });
}

// 75) 考试提醒 7 天上限失效：下个月的考试也开始每天弹
{
  const anchor = '      if (left == null || left < 0 || left > lead) continue;';
  mutations.push({
    name: 'dueExamAlerts：lead 上限失效（远期考试也被卷进提醒窗口）',
    file: 'remind',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '      if (left == null || left < 0) continue; // MUTANT（不再看上限）')
      : s)
  });
}

// 76) 添加考试后不再即时检查：录入一门 3 天后的考试却毫无反馈
{
  const anchor = "    runExamTick();\n    if (!document.getElementById('toast').hidden) return; // 弹了考试提醒就别再盖「已添加」";
  mutations.push({
    name: 'onAddEvent：添加后不再即时检查（录入手边的考试却毫无反馈）',
    file: 'app',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    // MUTANT: 添加后不再即时检查')
      : s)
  });
}

// 77) 复制按钮的剪贴板守卫失效：不支持的直接 TypeError（被 catch 吞成「复制失败」）
{
  const anchor = "    if (!nav.clipboard || typeof nav.clipboard.write !== 'function'\n      || typeof window.ClipboardItem !== 'function') {";
  mutations.push({
    name: 'onCopyShare：剪贴板守卫失效（不支持的报「复制失败」而不是引导去保存）',
    file: 'app',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    if (false) { // MUTANT（守卫被拆）')
      : s)
  });
}

// 78) 协议白名单失效：file:// / ftp:// 也能过配置清洗（URL 解析层会放行任意协议）
{
  const anchor = "    if (!/^https?:\\/\\//i.test(url)) return null;";
  mutations.push({
    name: 'normalizeConfig：协议白名单失效（file:// / ftp:// 混进 WebDAV 配置）',
    file: 'webdav',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    // MUTANT（不再验协议）')
      : s)
  });
}

// 79) 云端载荷安检失效：服务器返回什么都直接进工作区
{
  const anchor = '    if (data.version === 2 && Array.isArray(data.semesters)) return data;';
  mutations.push({
    name: 'validateBackupText：结构安检失效（云端返回什么都当合法备份）',
    file: 'webdav',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    return data; // MUTANT（不再验结构）')
      : s)
  });
}

// 80) 认证头被拆：Basic 头变成空串（所有请求裸奔，服务器必然 401）
{
  const anchor = "    return 'Basic ' + Buffer.from(String(username || '') + ':' + String(password || ''), 'utf8').toString('base64');";
  mutations.push({
    name: 'webdav-client：认证头被拆（请求不带 Basic 凭据，必然 401）',
    file: 'webdavClient',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "    return ''; // MUTANT（认证头不再生成）")
      : s)
  });
}

// 81) 重定向不再跟随：坚果云式甩地址直接当失败
{
  const anchor = '        current = new URL(res.headers.location, current).href;';
  mutations.push({
    name: 'webdav-client：302 重定向不再跟随（服务器甩一次地址就报错）',
    file: 'webdavClient',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "        return { ok: false, status: res.status, message: 'MUTANT: 3xx 当失败' };")
      : s)
  });
}

// 82) 云同步配置不再落盘：保存按钮变成安慰剂
{
  const anchor = '    saveCloudCfg(toStore);';
  mutations.push({
    name: 'onCloudSave：配置不再落盘（保存按钮点了白点，下次全要重填）',
    file: 'app',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    // MUTANT: 配置不再持久化')
      : s)
  });
}

// 83) 版本比较翻转：远端更旧也报「发现新版本」，诱导用户降级重装
{
  const anchor = '    if (cmp > 0) {';
  mutations.push({
    name: 'update-checker：版本比较翻转（旧版本也报有更新，诱导降级）',
    file: 'updateChecker',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    if (cmp !== 0) { // MUTANT（比较翻转）')
      : s)
  });
}

// 84) html_url 白名单失效：API 响应里的任意链接直达用户
{
  const anchor = "    const htmlUrl = (data && typeof data.html_url === 'string'\n      && /^https:\\/\\/github\\.com\\//.test(data.html_url)) ? data.html_url : RELEASES_PAGE;";
  mutations.push({
    name: 'update-checker：下载链接白名单失效（被篡改的响应可把用户引去任意站点）',
    file: 'updateChecker',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, "    const htmlUrl = (data && typeof data.html_url === 'string') ? data.html_url : RELEASES_PAGE; // MUTANT（白名单拆掉）")
      : s)
  });
}

// 85) 404 当错误：还没发过版的应用每次点「检查更新」都弹「检查失败」
{
  const anchor = '    if (res.status === 404) {\n      return { ok: true, status: \'norelease\', current, message: \'还没有发布过版本，暂时无需检查\' };';
  mutations.push({
    name: 'update-checker：404 预期态当错误（无 release 时永远「检查失败」）',
    file: 'updateChecker',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    if (res.status === 404) {\n      return { ok: false, status: \'error\', current, message: \'MUTANT: 404 当错误\' };')
      : s)
  });
}

// 86) 检查更新区不再按桥显隐：网页版也亮出「检查更新」按钮（点了必然失败）
{
  const anchor = '    var field = document.getElementById(\'updateField\');\n    if (field) field.hidden = !window.CourseForgeDesktop;';
  mutations.push({
    name: 'syncUpdateUI：网页版也显示检查更新按钮（无桥时点了只能失败）',
    file: 'app',
    apply: (s) => (s.includes(anchor)
      ? s.replace(anchor, '    var field = document.getElementById(\'updateField\');\n    if (field) field.hidden = false; // MUTANT（不再按桥显隐）')
      : s)
  });
}

// ==================== 运行 ====================
// 保险 0：开始之前先确认工作区是干净的。
// 曾经发生过：上一次运行被 SIGTERM（超时）强杀，把 // MUTANT 留在了源文件里，
// 于是下一次运行的「基线」本身就是坏的 —— 每个变异都「变红」，
// 结果全不可信，而人眼很难察觉。宁可拒绝运行，也不能给出假结论。
for (const p of Object.values(FILES)) {
  const content = fs.readFileSync(p, 'utf8');
  if (/MUTANT/.test(content)) {
    console.error(`\n❌ ${p} 里残留着上一次未还原的变异标记（// MUTANT）。`);
    console.error('   请先手动还原该文件，再运行本脚本 —— 否则变异结论全部不可信。');
    process.exit(2);
  }
}

function runTests() {
  // 单轮全量测试的上限。正常一轮 30~60 秒；超过说明这条变异让某个测试挂死
  // （实测：某条变异让 jsdom 用例死循环，execSync 没超时就挂了 45 分钟）。
  // 超时必须强杀并标成「无效判定」—— 它既不是护栏有效也不是假护栏。
  const TEST_TIMEOUT_MS = 180000;
  try {
    return execSync(`"${NODE}" --test`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
      timeout: TEST_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch (e) {
    // 测试有失败断言时 execSync 会抛错，但 stdout 里仍然有完整报告 —— 正常路径。
    // 真正异常的是「stdout 和 stderr 都为空」，那说明进程根本没起来（如语法错误
    // 导致整个模块加载失败），此时必须把 e.message 带出来，否则只剩一个空字符串。
    if (e.killed) {
      return `[测试超时 ${TEST_TIMEOUT_MS / 1000}s 被强杀 —— 该变异很可能让某个测试死循环]`;
    }
    const out = (e.stdout || '') + (e.stderr || '');
    return out || `[测试进程未产出任何输出] ${e.message}`;
  }
}

// 保险 1：基线必须全绿。基线不绿时任何「变红」都说明不了问题。
{
  const out = runTests();
  const s = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out);
  const pass = s ? Number(s[1]) : -1;
  const fail = s ? Number(s[2]) : -1;
  console.log(`基线：pass=${pass} fail=${fail}`);
  if (fail !== 0) {
    console.error('❌ 基线测试不是全绿，先修好再跑变异（否则「变红」没有诊断意义）。');
    process.exit(2);
  }
}

let dirty = null; // 当前被变异过的文件路径
function restore() {
  if (dirty) {
    fs.writeFileSync(dirty, originals[dirty]);
    dirty = null;
  }
}
// 超时强杀（SIGTERM）也必须还原 —— 只挂 SIGINT 是不够的，实测被 SIGTERM 杀掉后
// 变异会永久留在源文件里。
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    restore();
    if (sig !== 'exit') process.exit(1);
  });
}

// 统计三类结果，最后汇总时必须把「无效判定」单列 ——
// 它既不是「护栏有效」也不是「假护栏」，而是「这轮结论根本不能用」。
const stats = { red: 0, fake: 0, skipped: 0, inconclusive: 0, equivalent: 0 };

for (const m of mutations) {
  if (!onlyMatch(mutations.indexOf(m))) continue;
  const key = m.file || 'parser';
  const filePath = FILES[key];
  const orig = origOf(key);
  const mutated = m.apply(orig);
  if (mutated === orig) {
    console.log(`\n[跳过] ${m.name} —— 模式未匹配，无法注入变异`);
    stats.skipped++;
    continue;
  }
  let out = '';
  let prepError = null;
  try {
    fs.writeFileSync(filePath, mutated);
    dirty = filePath;
    if (m.prepare) m.prepare();
    out = runTests();
  } catch (e) {
    // prepare（如重建夹具）失败与「测试没变红」是两回事，必须分开报告。
    prepError = e.message;
    out = '';
  } finally {
    // 无论测试成功、失败还是抛异常，都必须还原 —— 否则变异会留在工作区
    // （曾经因为中途打断，把 // MUTANT 行留在了源文件里，污染后续所有测试）
    restore();
    if (m.prepare) {
      try {
        m.prepare();
      } catch (e) {
        console.error(`  ⚠️ 还原夹具时也失败：${e.message}`);
      }
    }
  }
  const failed = (out.match(/^not ok \d+ - (.+)$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, ''));
  const summary = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out);
  console.log(`\n[变异] ${m.name}`);
  if (prepError) {
    console.log(`  ❌ 变异注入后无法重建被测环境，本轮结论无效：`);
    console.log('  ' + prepError.split('\n').join('\n  '));
    console.log('  结果: pass=? fail=? （跳过判定）');
    stats.inconclusive++;
    continue;
  }
  if (!summary) {
    // 拿不到摘要时必须把原因说出来，不能只报一个 pass=? ——
    // 那既可能是「测试进程真的崩了」，也可能只是工具自身出错，两者含义完全不同。
    console.log(`  ⚠️ 未取到测试摘要（输出 ${out.length} 字符）。尾部内容：`);
    console.log('  ' + out.slice(-400).split('\n').join('\n  '));
    stats.inconclusive++;
  }
  console.log(`  结果: pass=${summary ? summary[1] : '?'} fail=${summary ? summary[2] : '?'}`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  ✅ 变红: ${f}`));
    stats.red++;
    if (m.equivalent) {
      console.log('  ⚠️ 该变异被登记为「等价变异」，但实际变红了 —— 说明等价的判断有误，请更新登记。');
    }
  } else if (m.equivalent) {
    // 等价变异：测试全绿是正确结果，不是假护栏。必须把理由打出来，
    // 否则下一个人只会看到一个「没变红」的条目，又去写假断言凑红。
    console.log('  ⓘ 已登记为等价变异（该改动不改变任何输入下的行为），不计入假护栏。');
    console.log(`    理由：${m.equivalent}`);
    stats.equivalent++;
  } else {
    console.log('  ⚠️ 没有任何断言变红 —— 这段代码没有被测试守护！');
    stats.fake++;
  }
}

console.log(
  `\n==== 汇总：护栏有效 ${stats.red} · 假护栏 ${stats.fake} · ` +
  `等价变异 ${stats.equivalent} · 跳过 ${stats.skipped} · 无效判定 ${stats.inconclusive} ====`
);
if (stats.fake || stats.inconclusive) {
  console.error('❌ 存在假护栏或无效判定，变异测试【未通过】。');
}

// 收尾自检：确认所有被改过的文件都已还原、且没有残留变异标记
restore();
let bad = false;
for (const p of Object.values(FILES)) {
  if (!(p in originals)) continue;
  const after = fs.readFileSync(p, 'utf8');
  if (after !== originals[p] || /MUTANT/.test(after)) {
    console.error(`\n❌ 源文件还原失败，请检查 ${p}！`);
    bad = true;
  }
}
if (bad) process.exit(1);
console.log('\n✅ 已恢复原始文件，未残留任何变异。');
