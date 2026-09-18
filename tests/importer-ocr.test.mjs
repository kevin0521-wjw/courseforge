/**
 * OCR 输出归一化回归 —— 守护「照片识别 → 解析」链路的最后一环。
 *
 * 背景（2026-09-19 两端真机探针抓到的真问题）：
 *   Tesseract（chi_sim）对中文的通病是字与字之间插空格（「高 等 数 学 A 1」），
 *   而行解析按 token 切分、课名只取第一个 token —— 真机实测课名全变成
 *   「高」「数据」「大」「操作」「大」，五门课全废。
 *   修复：OCR 输出在喂解析器前按行去掉全部行内空白（normalizeOcrText）。
 *
 * 本文件用 vm 把真实的 importer.js + parser.js 跑起来（DOM 桩来自 harness），
 * 直接验证：① 归一化函数本身的规则；② 归一化后的 OCR 文本能被解析器还原成完整课程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';

import { makeDom, WEB, IMPORTER } from './helpers/importer-harness.mjs';

/** 装载真实 importer.js + parser.js（不 mount，不触发任何网络） */
function loadImporter() {
  const env = makeDom();
  const win = {
    document: env.documentStub,
    location: { protocol: 'http:', href: 'http://127.0.0.1:5199/' },
    navigator: {},
    addEventListener() {}
  };
  win.window = win;
  win.self = win;
  const ctx = vm.createContext({
    window: win, self: win, document: env.documentStub, navigator: {},
    location: win.location, console, setTimeout, clearTimeout
  });
  for (const f of ['core.js', 'parser.js', 'pdf-layout.js']) {
    vm.runInContext(readFileSync(join(WEB, 'js', f), 'utf8'), ctx, { filename: f });
  }
  vm.runInContext(readFileSync(IMPORTER, 'utf8'), ctx, { filename: 'importer.js' });
  assert.ok(win.CourseImporter, 'importer.js 没有挂到 window.CourseImporter');
  assert.ok(typeof win.CourseImporter.normalizeOcrText === 'function',
    'CourseImporter.normalizeOcrText 必须导出（测试与回归的锚点）');
  return win;
}

test('normalizeOcrText：中文片间空格全部去掉（chi_sim 通病）', () => {
  const w = loadImporter();
  const out = w.CourseImporter.normalizeOcrText('高 等 数 学 A 1 周 一 3 - 4 节');
  assert.equal(out, '高等数学A1周一3-4节');
  w.close && w.close();
});

test('normalizeOcrText：全角空格 / Tab / 不换行空格一并清掉，换行保留', () => {
  const w = loadImporter();
  const out = w.CourseImporter.normalizeOcrText('数据结构\t周三　5,6节\u00a01-16周\n大 学 英 语');
  assert.equal(out, '数据结构周三5,6节1-16周\n大学英语');
  w.close && w.close();
});

test('normalizeOcrText：null/undefined 安全', () => {
  const w = loadImporter();
  assert.equal(w.CourseImporter.normalizeOcrText(null), '');
  assert.equal(w.CourseImporter.normalizeOcrText(undefined), '');
  w.close && w.close();
});

test('端到端：被 OCR 空格拆散的五门课，归一化后能完整还原（修复前课名只剩单字）', () => {
  const w = loadImporter();
  // 模拟 chi_sim 真实输出：每个字符之间都有空格
  const ocrText = [
    '高 等 数 学 A 1 周 一 3 - 4 节 第 1 - 1 6 周 D 楼 2 0 2 张 三',
    '数 据 结 构 周 三 5 , 6 节 1 - 1 6 周 ( 单 ) B J 1 0 2 李 四',
    '大 学 英 语 周 二 1 - 2 节 1 - 1 6 周 A 楼 3 0 5 王 五',
    '操 作 系 统 周 四 3 - 4 节 1 - 1 6 周 C 楼 4 0 1 孙 七',
    '大 学 体 育 周 五 1 8 : 0 0 - 1 9 : 4 0 体 育 馆 赵 六'
  ].join('\n');
  const normalized = w.CourseImporter.normalizeOcrText(ocrText);
  const res = w.CourseParser.parseScheduleText(normalized, { totalWeeks: 16 });
  const names = res.items.map((c) => c.name);
  for (const expect of ['高等数学A1', '数据结构', '大学英语', '操作系统', '大学体育']) {
    assert.ok(names.some((n) => n.indexOf(expect) !== -1),
      '课名「' + expect + '」应被完整还原，实际解析出: ' + names.join('、'));
  }
  // 星期也要对上：归一化不能把「周X」弄丢。
  // ⚠️ res.items 是 vm 世界的数组，直接 .map 会得到 vm realm 的 Array，
  // deepStrictEqual 比原型就炸 —— 先 Array.from 拷进宿主世界
  const days = Array.from(res.items).map((c) => c.day).sort((a, b) => a - b);
  assert.deepEqual(days, [1, 2, 3, 4, 5], '五门课应分别落在周一~周五，实际: ' + days.join(','));
  w.close && w.close();
});

test('反例守护：文字层 / 粘贴文本路径【不】走归一化 —— 带空格的正常输入解析行为不变', () => {
  const w = loadImporter();
  // 这是用户粘贴路径的典型输入：空格承载分隔语义。normalizeOcrText 不该被用在这里，
  // 而解析器对它的行为必须与历史一致（课名 = 高等数学A1，不是 高等数学A1周一… 粘一团）
  const pasted = '高等数学A1 周一 3-4节 第1-16周 D楼202 张三';
  const res = w.CourseParser.parseScheduleText(pasted, { totalWeeks: 16 });
  assert.equal(res.items.length, 1, '一行一门课');
  assert.equal(res.items[0].name, '高等数学A1');
  assert.equal(res.items[0].day, 1);
  assert.equal(res.items[0].startSection, 3);
  assert.equal(res.items[0].endSection, 4);
  w.close && w.close();
});
