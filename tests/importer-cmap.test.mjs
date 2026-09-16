/**
 * CMap 源选择回归测试 —— 守护「中文 PDF 能不能解出文字」这条链路的最后一环。
 *
 * 背景（两轮误诊换来的教训）：
 *   importer.js 早期是「探测本地 cmaps/，2 秒没响应就回退 CDN」。
 *   在境内这是主动帮倒忙：本地目录同源随包发布、只是可能慢，
 *   而回退目标 jsdelivr 经常整个域名不可达。于是网络稍差时，
 *   它把唯一可用的源换成取不到的源。
 *   更坑的是 pdf.js 在 CMap 取不到时【只 warn 不抛错】，
 *   getTextContent() 静静返回空 items —— 界面只剩一句「PDF 中未提取到文字」，
 *   看起来像解析器坏了，为此连续误诊了两轮。
 *
 * 本文件用 vm 把真实的 importer.js 跑起来（DOM 用 stub 顶替），
 * 通过替换源码里的 CMAP_SOURCES 来构造各种源组合。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  runImporter, patchCMapSources, makeSmartCMapFactory, loadPdfJs,
  IMPORTER, ROOT, CMAPS, MISSING_CMAPS
} from './helpers/importer-harness.mjs';

const FIXTURE = join(ROOT, 'tests', 'fixtures', 'cjk-timetable-rotated.pdf');

const PDFJS = loadPdfJs();
const skip = PDFJS ? false : '未安装 pdfjs-dist（可选依赖），跳过 CMap 换源测试';

/** 合成一个注入了浏览器等价取源工厂的 pdfjsLib */
function makePdfJsLib() {
  const lib = { version: PDFJS.version, CMapCompressionType: PDFJS.CMapCompressionType };
  const Factory = makeSmartCMapFactory(PDFJS);
  Object.defineProperty(lib, 'getDocument', {
    value: (opts) => PDFJS.getDocument(Object.assign({ CMapReaderFactory: Factory }, opts)),
    writable: true,
    configurable: true
  });
  return lib;
}

const COURSE_COUNT = /解析出 12 条课程/;

test('夹具存在：旋转课表（12 门课，仓库内、无隐私）', () => {
  assert.ok(existsSync(FIXTURE), `缺少夹具 ${FIXTURE}；用 tools/make-rotated-timetable-fixture.py 生成`);
});

// ==================== 核心：换源逻辑 ====================

test('首选源可用时，一次就成（不该反复试错）', { skip }, async () => {
  const r = await runImporter({ pdfPath: FIXTURE, pdfjsLib: makePdfJsLib() });
  assert.match(r.summary, COURSE_COUNT, '本地 cmaps/ 可用时应直接解析成功；状态：' + r.status);
});

test('首选源取不到时必须自动换下一个源 —— 这是「PDF 中未提取到文字」的正面防线', { skip }, async () => {
  assert.ok(!existsSync(MISSING_CMAPS), '夹具前提：MISSING_CMAPS 目录不应存在');

  const patched = patchCMapSources(readFileSync(IMPORTER, 'utf8'), [MISSING_CMAPS, CMAPS + '/']);
  assert.ok(patched, '未能替换 CMAP_SOURCES —— 源码结构变了，这条测试会变成空转，必须修');

  const r = await runImporter({ pdfPath: FIXTURE, pdfjsLib: makePdfJsLib(), sourceCode: patched });
  assert.match(
    r.summary,
    COURSE_COUNT,
    '第一个源取不到时，应当自动改用下一个可用源；实际状态：' + r.status
  );
  assert.doesNotMatch(
    r.status,
    /读不出文字|未提取到文字/,
    '换源后不该再落到「没有文字」的结论上'
  );
});

test('所有源都取不到时，必须走图片识别兜底，而不是静默变成「未提取到文字」', { skip }, async () => {
  const patched = patchCMapSources(readFileSync(IMPORTER, 'utf8'), [MISSING_CMAPS]);
  assert.ok(patched, '未能替换 CMAP_SOURCES');

  // 只跑很短时间：目的不是等 OCR 出结果，而是确认它「没有装作没事」
  const r = await runImporter({
    pdfPath: FIXTURE,
    pdfjsLib: makePdfJsLib(),
    sourceCode: patched,
    timeoutMs: 8000
  });

  assert.ok(
    r.history.some((s) => /按图片识别|没有可用的文字层/.test(s)),
    '一个源都取不到时，应当明确转而做图片识别；实际状态轨迹：' + JSON.stringify(r.history)
  );
  assert.doesNotMatch(
    r.status,
    /^PDF 中未提取到文字$/,
    '不允许再用那句毫无诊断信息的旧提示掩盖真实原因'
  );
});

// ==================== 源码层守护：禁止退回单源/超时回退 ====================

test('源码：CMAP_SOURCES 必须是【多个】源，且按可靠性排序（本地在前）', () => {
  const src = readFileSync(IMPORTER, 'utf8');
  const m = /var CMAP_SOURCES = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, '找不到 CMAP_SOURCES 定义');

  const body = m[1];
  const entries = body.split(',').map((s) => s.trim()).filter(Boolean);
  assert.ok(entries.length >= 2, `CMap 源至少要有 2 个候选，当前 ${entries.length} 个：只留一个源等于没有兜底`);

  assert.match(
    entries[0],
    /^['"]cmaps\//,
    '第一个源必须是随包发布的【本地】cmaps/ 目录（相对路径）；' +
      '注意别用 /cmaps\\// 这种宽松写法 —— 镜像 URL 里也含 /cmaps/，会放过顺序错误'
  );
  assert.match(
    body,
    /npmmirror/,
    '必须包含境内镜像（registry.npmmirror.com）：jsdelivr/unpkg 在大陆经常不可达'
  );
});
