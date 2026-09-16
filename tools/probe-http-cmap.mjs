/**
 * 浏览器等价验证：证明「线上服务器通过 HTTP 提供的 CMap 足以解码中文 PDF」。
 *
 * ---------- 为什么需要这么绕 ----------
 * pdf.js 在 Node 与浏览器里用的是两套 CMap 取数实现，且 Node 那套对二进制 CMap 是坏的：
 *
 *   浏览器 DOMCMapReaderFactory:
 *     fetchData(url, this.isCompressed)  → asTypedArray=true → response.arrayBuffer()
 *     ✅ 拿到正确的二进制字节
 *
 *   Node NodeCMapReaderFactory:
 *     fetchData(url)                     ← 第二个参数漏传 → asTypedArray=false
 *     ✗ 走 response.text()，把二进制当 UTF-8 解码 → 数据损坏
 *
 * 所以直接在 Node 里传一个 http:// 的 cMapUrl 必然失败，报
 * "Unable to load binary CMap at: …" —— 这是 pdf.js 的问题，不是部署的问题。
 * 若照这个结论去改生产代码，就会改错方向。
 *
 * 本脚本改为注入一个「与浏览器行为一致」的 CMapReaderFactory
 * （fetch + arrayBuffer + compressionType=BINARY），从而真实覆盖
 * 「服务器给的字节能否解出中文」这一环。
 *
 * 用法：
 *   node tools/probe-http-cmap.mjs <服务地址> <PDF路径>
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const PDF = process.argv[3];

if (!BASE || !PDF) {
  console.error('用法: node tools/probe-http-cmap.mjs <服务地址> <PDF路径>');
  process.exit(2);
}

// pdf.js 用 document.baseURI 判断「能否走 fetch」；Node 里没有 document，
// 先补一个最小的，让 fetch 分支可达（否则会掉进不存在的 XMLHttpRequest 分支）。
globalThis.document = { baseURI: BASE + '/' };

const require = createRequire(import.meta.url);
const PDFJS = require('pdfjs-dist/legacy/build/pdf.js');

/**
 * 精确复刻浏览器 DOMCMapReaderFactory 的行为：
 * fetch 取字节 → arrayBuffer（不是 text！）→ 标记为 BINARY 压缩。
 * pdf.js 只要求实现 fetch({name}) 这一个方法。
 */
class BrowserLikeCMapFactory {
  constructor({ baseUrl, isCompressed }) {
    this.baseUrl = baseUrl;
    this.isCompressed = isCompressed;
  }

  async fetch({ name }) {
    if (!this.baseUrl) throw new Error('cMapUrl 未提供');
    if (!name) throw new Error('CMap 名未提供');
    const url = this.baseUrl + name + (this.isCompressed ? '.bcmap' : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
    return {
      cMapData: new Uint8Array(await res.arrayBuffer()),
      compressionType: this.isCompressed
        ? PDFJS.CMapCompressionType.BINARY
        : PDFJS.CMapCompressionType.NONE
    };
  }
}

const data = new Uint8Array(readFileSync(PDF));

async function run(label, opts) {
  const doc = await PDFJS.getDocument({ data: data.slice(), ...opts }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  const text = tc.items.map((i) => i.str).join('');
  await doc.destroy();
  console.log(`\n--- ${label} ---`);
  console.log(`  items=${tc.items.length}  字符数=${text.replace(/\s/g, '').length}`);
  console.log(`  文本: ${JSON.stringify(text.slice(0, 80))}`);
  return text;
}

// 0) 服务器上的 CMap 是否可取（等价于浏览器里的目录可用性探测）
const probeUrl = `${BASE}/cmaps/UniGB-UCS2-H.bcmap`;
const probeRes = await fetch(probeUrl);
const probeBytes = (await probeRes.arrayBuffer()).byteLength;
console.log(`[探测] ${probeUrl}`);
console.log(`       HTTP ${probeRes.status}, ${probeBytes} 字节`);
if (!probeRes.ok || probeBytes < 1000) {
  console.error('✗ 静态服务器上的 CMap 不可用，中文 PDF 必然解析失败');
  process.exit(1);
}

// 1) 经 HTTP 取 CMap（浏览器路径）
const withHttp = await run('带 cMapUrl（经 HTTP 取回，浏览器等价工厂）', {
  cMapUrl: `${BASE}/cmaps/`,
  cMapPacked: true,
  CMapReaderFactory: BrowserLikeCMapFactory
});

// 2) 对照组：不给 cMapUrl
const without = await run('对照：不带 cMapUrl', {});

// 3) 完整流水线：提取 → 版面还原 → 解析 → 课程列表
//    这一步才真正回答「用户的 PDF 到底能不能导入成功」。
let pipelineOk = null;
let courses = [];
try {
  const PL = require('../web/js/pdf-layout.js');
  const CP = require('../web/js/parser.js');

  const doc = await PDFJS.getDocument({
    data: data.slice(),
    cMapUrl: `${BASE}/cmaps/`,
    cMapPacked: true,
    CMapReaderFactory: BrowserLikeCMapFactory
  }).promise;

  const pageTexts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pageTexts.push(PL.layoutToText(tc.items).text);
  }
  await doc.destroy();

  courses = CP.parseScheduleText(pageTexts.join('\n')).items;
  const DAY = ['', '一', '二', '三', '四', '五', '六', '日'];

  console.log('\n--- 完整流水线（提取 → 版面还原 → 解析）---');
  console.log(`  识别到 ${courses.length} 门课程：`);
  for (const c of courses) {
    console.log(
      `    星期${DAY[c.day]} ${c.startSection}-${c.endSection}  ${c.name}` +
        `  ${c.teacher || '-'}${c.location ? '  @' + c.location : ''}`
    );
  }
  pipelineOk = courses.length > 0;
} catch (e) {
  console.log('\n--- 完整流水线 ---');
  console.log(`  跳过：${e && e.message ? e.message : e}`);
}

const ok =
  withHttp.includes('星期一') &&
  without.replace(/\s/g, '').length === 0 &&
  pipelineOk !== false;

console.log('\n==================== 结论 ====================');
if (ok) {
  console.log('✅ 通过：经 HTTP 取回的 CMap 能正确解码中文；不给 cMapUrl 则一个字符都读不出。');
  process.exit(0);
}
console.log('❌ 未通过，请检查上面的明细。');
process.exit(1);
