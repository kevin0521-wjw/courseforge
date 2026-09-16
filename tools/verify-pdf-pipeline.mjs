/**
 * 端到端验证工具：对任意 PDF 走【真实链路】并打印解析结果。
 *
 * 用法：
 *   node tools/verify-pdf-pipeline.mjs <PDF 路径> [--cmaps <目录或 URL>]
 *
 * 链路：pdf.js 提取（含 CMap 解码）→ pdf-layout 版面还原 → parser 文本解析。
 * 这是「用户的 PDF 到底能不能导入成功」的唯一可信答案 —— 拿 Python 从内容流
 * 抽坐标做「等价验证」会绕过 pdf.js 这一层，历史上因此漏掉过两个真根因。
 *
 * ---------- 为什么要自带 CMap 工厂 ----------
 * pdf.js 在 Node 与浏览器里用两套 CMap 取数实现，Node 那套对二进制 CMap 是坏的：
 *   NodeNodeCMapReaderFactory.fetchData(url)  ← 漏传 isCompressed
 *     → 走 response.text()，把二进制当 UTF-8 解码 → 数据损坏
 *   浏览器 DOMCMapReaderFactory.fetchData(url, isCompressed)
 *     → response.arrayBuffer() → 正确
 * 本脚本注入一个与浏览器行为一致的工厂，因此能真实覆盖「字节能否解出中文」这一环。
 * 不传 --cmaps 时默认用仓库内的 web/cmaps（绝对路径，避免相对路径解析歧义）。
 */
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const pdfPath = args.find((a) => !a.startsWith('--'));
const cmapsFlag = args.indexOf('--cmaps');
const cmapArg = cmapsFlag >= 0 ? args[cmapsFlag + 1] : null;

if (!pdfPath) {
  console.error('用法: node tools/verify-pdf-pipeline.mjs <PDF 路径> [--cmaps <目录或 URL>]');
  process.exit(2);
}

const CMAPS = cmapArg
  ? (isAbsolute(cmapArg) || /^https?:/.test(cmapArg) ? cmapArg : join(ROOT, cmapArg)).replace(/\/?$/, '/')
  : join(ROOT, 'web', 'cmaps') + '/';

const PDFJS = require('pdfjs-dist/legacy/build/pdf.js');
const PL = require('../web/js/pdf-layout.js');
const CP = require('../web/js/parser.js');

/** 与浏览器 DOMCMapReaderFactory 行为一致的工厂（fetch + arrayBuffer + BINARY） */
class BrowserLikeCMapFactory {
  constructor({ baseUrl, isCompressed }) {
    this.baseUrl = baseUrl;
    this.isCompressed = isCompressed;
  }
  async fetch({ name }) {
    const isHttp = /^https?:/.test(this.baseUrl);
    const url = this.baseUrl + name + (this.isCompressed ? '.bcmap' : '');
    if (isHttp) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
      return {
        cMapData: new Uint8Array(await res.arrayBuffer()),
        compressionType: this.isCompressed ? PDFJS.CMapCompressionType.BINARY : PDFJS.CMapCompressionType.NONE
      };
    }
    return {
      cMapData: new Uint8Array(readFileSync(url)),
      compressionType: this.isCompressed ? PDFJS.CMapCompressionType.BINARY : PDFJS.CMapCompressionType.NONE
    };
  }
}

const DAY = ['', '一', '二', '三', '四', '五', '六', '日'];

async function main() {
  if (!existsSync(pdfPath)) {
    console.error(`找不到文件：${pdfPath}`);
    process.exit(2);
  }
  console.log(`文件：${pdfPath}`);
  console.log(`CMap：${CMAPS}`);

  const data = new Uint8Array(readFileSync(pdfPath));

  // ---- 第 0 步：对照组 —— 不给 cMapUrl 时能读出多少字 ----
  const bare = await PDFJS.getDocument({ data: data.slice() }).promise;
  const bareTc = await (await bare.getPage(1)).getTextContent();
  await bare.destroy();
  const bareChars = bareTc.items.map((i) => i.str).join('').replace(/\s/g, '').length;
  console.log(`\n[对照] 不带 cMapUrl：${bareTc.items.length} 个片段 / ${bareChars} 字符` +
    (bareChars === 0 ? '  ← 若无 cMapUrl 就是这样（CMap 编码字体读不出字）' : ''));

  // ---- 第 1 步：pdf.js 提取 + 版面还原 ----
  const doc = await PDFJS.getDocument({
    data: data.slice(),
    cMapUrl: CMAPS,
    cMapPacked: true,
    CMapReaderFactory: BrowserLikeCMapFactory
  }).promise;

  console.log(`页数：${doc.numPages}`);
  const pageTexts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rotated = tc.items.filter(
      (i) => i.str.trim() && (Math.abs(i.transform[1]) > 0.01 || Math.abs(i.transform[2]) > 0.01)
    ).length;
    const layout = PL.layoutToText(tc.items);
    console.log(
      `  第 ${p} 页：page.rotate=${page.rotate} 片段=${tc.items.length} ` +
      `其中旋转片段=${rotated} → isTable=${layout.isTable} rows=${layout.rows} cols=${layout.cols}`
    );
    pageTexts.push(layout.text);
  }
  await doc.destroy();

  // ---- 第 2 步：文本解析 ----
  const text = pageTexts.join('\n');
  const res = CP.parseScheduleText(text);
  console.log(`\n识别到 ${res.items.length} 门课程：`);
  for (const c of res.items) {
    console.log(
      `    星期${DAY[c.day]} ${c.startSection}-${c.endSection}节  ${c.name}` +
      `  ${c.teacher || '-'}${c.location ? '  @' + c.location : ''}` +
      (c.weeks ? `  (${c.weeks.length}周)` : '')
    );
  }
  if (res.warnings.length) {
    console.log(`\n告警 ${res.warnings.length} 条：`);
    for (const w of res.warnings) console.log('  - ' + w);
  } else {
    console.log('\n无告警。');
  }

  console.log('\n--- 版面还原文本 ---');
  console.log(text);

  process.exit(res.items.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('失败：', e && e.message ? e.message : e);
  process.exit(1);
});
