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

// ==================== 桌面端：cfcmap:// 随包协议源 ====================
/**
 * 桌面端主窗口是 file:// 加载，Chromium 禁止 file:// 页面 fetch ——
 * 相对路径 'cmaps/' 在桌面端必然失败，之前全靠 CDN 兜底，
 * 弱网/离线时中文 PDF 一个字都解不出。
 * 修复：主进程注册 cfcmap:// 特权协议只服务随包 cmaps/，preload 交来基地址，
 * importer 把它插到源链最前。
 */

test('桌面端：协议源排最前，其余源全坏时仍能解出文字（弱网不靠 CDN）', { skip }, async () => {
  // 把随包相对路径与 CDN 全部置坏 —— 模拟「协议源若不生效就彻底没辙」的极端情况
  const patched = patchCMapSources(readFileSync(IMPORTER, 'utf8'), [MISSING_CMAPS]);
  assert.ok(patched, '未能替换 CMAP_SOURCES');

  const r = await runImporter({
    pdfPath: FIXTURE,
    pdfjsLib: makePdfJsLib(),
    sourceCode: patched,
    // SmartCMapFactory 对非 http 源按本地文件读取，等价于协议源命中随包目录
    desktopCmapBase: CMAPS + '/'
  });
  assert.match(
    r.summary,
    COURSE_COUNT,
    '桌面端应优先用随包协议源解出文字，而不是落到 CDN；实际状态：' + r.status
  );
});

test('网页版：没有 CourseForgeDesktop 时行为与旧版完全一致', { skip }, async () => {
  const patched = patchCMapSources(readFileSync(IMPORTER, 'utf8'), [CMAPS + '/']);
  assert.ok(patched, '未能替换 CMAP_SOURCES');
  const r = await runImporter({ pdfPath: FIXTURE, pdfjsLib: makePdfJsLib(), sourceCode: patched });
  assert.match(r.summary, COURSE_COUNT, '网页版基线：本地 cmaps/ 可用即成功；状态：' + r.status);
});

test('源码：桌面端协议源必须插到源链最前（DESKTOP_CMAP_BASE / CMAP_ORDER）', () => {
  const src = readFileSync(IMPORTER, 'utf8');
  assert.match(
    src,
    /var DESKTOP_CMAP_BASE = \(window\.CourseForgeDesktop && window\.CourseForgeDesktop\.cmapBase\) \|\| null;/,
    '必须从桌面桥读取 cmapBase（网页版没有桥，值为 null）'
  );
  assert.match(
    src,
    /var CMAP_ORDER = DESKTOP_CMAP_BASE \? \[DESKTOP_CMAP_BASE\]\.concat\(CMAP_SOURCES\) : CMAP_SOURCES;/,
    'CMAP_ORDER 必须把桌面协议源插到 CMAP_SOURCES 最前面'
  );
  assert.doesNotMatch(
    src,
    /CMAP_SOURCES\.slice\(\)|CMAP_SOURCES\.filter\(/,
    'openWithWorkingCMap 必须使用 CMAP_ORDER（含桌面协议源），不能直接消费 CMAP_SOURCES'
  );
});

test('桌面端协议链路三件套：main 注册 / preload 暴露 / importer 消费', () => {
  const mainSrc = readFileSync(join(ROOT, 'desktop', 'main.js'), 'utf8');
  const preloadSrc = readFileSync(join(ROOT, 'desktop', 'preload.js'), 'utf8');

  // main.js：ready 前注册特权协议；handler 限定 host 并防路径穿越
  assert.match(mainSrc, /registerSchemesAsPrivileged/, 'main.js 必须注册 cfcmap 特权协议（且必须在 app ready 之前）');
  assert.match(mainSrc, /supportFetchAPI: true/, '协议必须开 supportFetchAPI —— 页面要 fetch .bcmap');
  assert.match(mainSrc, /u\.hostname !== 'cmaps'/, 'handler 必须限定 host=cmaps，不得变成任意文件读取');
  assert.match(
    mainSrc,
    /startsWith\(CMAP_BASE \+ path\.sep\)/,
    'handler 必须防路径穿越：resolve 后必须仍在 cmaps/ 目录内'
  );
  assert.match(
    mainSrc,
    /registerCmapProtocol\(\);\s*registerEduIpc/,
    '协议处理器必须在创建窗口之前注册'
  );

  // preload.js：把基地址安全地交给页面
  assert.match(preloadSrc, /cmapBase: 'cfcmap:\/\/cmaps\/'/, 'preload 必须暴露 cmapBase 基地址');
});
