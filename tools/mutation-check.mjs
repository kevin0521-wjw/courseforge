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

/** 调试用：MUT_ONLY=12 只跑第 13 个变异（下标从 0 起） */
const ONLY = process.env.MUT_ONLY !== undefined ? Number(process.env.MUT_ONLY) : null;

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
  try {
    return execSync(`"${NODE}" --test`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT
    });
  } catch (e) {
    // 测试有失败断言时 execSync 会抛错，但 stdout 里仍然有完整报告 —— 正常路径。
    // 真正异常的是「stdout 和 stderr 都为空」，那说明进程根本没起来（如语法错误
    // 导致整个模块加载失败），此时必须把 e.message 带出来，否则只剩一个空字符串。
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
  if (ONLY !== null && mutations.indexOf(m) !== ONLY) continue;
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
