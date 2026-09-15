// 变异测试脚本：依次破坏被测试守护的代码，确认对应断言真的会变红。
// 用法：node tools/mutation-check.mjs [node 可执行文件路径]
// 目的：防止「护栏永远通过、等于没写」—— 如果删掉某段代码后测试仍全绿，说明它没被守护。
// 实现上用「子串定位 + 替换」而不是复杂正则，避免转义地狱；脚本结束会还原源文件。
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// 脚本在 tools/ 下，源文件在仓库根的 web/js/，需要显式定位到仓库根
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web/js/parser.js');
const NODE = process.argv[2] || process.execPath;
const original = fs.readFileSync(SRC, 'utf8');

function between(text, startAnchor, endAnchor) {
  const i = text.indexOf(startAnchor);
  if (i < 0) return null;
  const j = text.indexOf(endAnchor, i + startAnchor.length);
  if (j < 0) return null;
  return text.slice(i, j + endAnchor.length);
}

const mutations = [];

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
  const target = between(original, 'var tm = /(?:教师|老师|授课)', '.exec(rest);');
  mutations.push({
    name: '教师捕获退回会吞掉「/选」「/地点」的旧写法',
    apply: (s) => (target ? s.replace(target, 'var tm = /(?:教师|老师|授课)[:：]\\s*([^\\s,;，]+)/.exec(rest); // MUTANT') : s)
  });
}

// 3) 显式教师全量清理退回单次 replace
{
  const startsWith = "      if (teacherExplicit) {\n        rest = rest.replace(";
  mutations.push({
    name: '显式教师全量清理退回单次 replace（残留 /选 片段）',
    apply: (s) => {
      const i = s.indexOf(startsWith);
      if (i < 0) return s;
      const j = s.indexOf("';", s.indexOf("  );\n      }", i));
      const end = s.indexOf('      }', i);
      if (end < 0) return s;
      return s.slice(0, i) +
        "if (teacherExplicit) {\n        rest = rest.replace(/(?:教师|老师|授课)[:：]\\s*[^\\s,;，]+/, ' '); // MUTANT\n      }" +
        s.slice(end + '      }'.length);
    }
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
let restored = false;
function restore() {
  if (restored) return;
  fs.writeFileSync(SRC, original);
  restored = true;
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(1); });

for (const m of mutations) {
  const mutated = m.apply(original);
  if (mutated === original) {
    console.log(`\n[跳过] ${m.name} —— 模式未匹配，无法注入变异`);
    continue;
  }
  let out = '';
  try {
    fs.writeFileSync(SRC, mutated);
    restored = false;
    out = execSync(`"${NODE}" --test`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  } finally {
    // 无论测试成功、失败还是抛异常，都必须还原 —— 否则变异会留在工作区
    // （曾经因为中途打断，把 // MUTANT 行留在了源文件里，污染后续所有测试）
    restore();
  }
  const failed = (out.match(/^not ok \d+ - (.+)$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, ''));
  const summary = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out);
  console.log(`\n[变异] ${m.name}`);
  console.log(`  结果: pass=${summary ? summary[1] : '?'} fail=${summary ? summary[2] : '?'}`);
  if (failed.length) failed.forEach((f) => console.log(`  ✅ 变红: ${f}`));
  else console.log('  ⚠️ 没有任何断言变红 —— 这段代码没有被测试守护！');
}

// 收尾自检：确认源文件已还原、且没有残留变异标记
restore();
const after = fs.readFileSync(SRC, 'utf8');
if (after !== original || /MUTANT/.test(after)) {
  console.error('\n❌ 源文件还原失败，请检查 web/js/parser.js！');
  process.exit(1);
}
console.log('\n✅ 已恢复原始文件，未残留任何变异。');
