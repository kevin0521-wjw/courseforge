/**
 * 决定性验证：pdf.js 缺 cMapUrl 时能否解出中文
 *
 * 这份课表用 STSong-Light-UniGB-UCS2-H（CMap 编码的 CID 字体），
 * pdf.js 必须加载对应的 .bcmap 才能解码；缺了会返回空字符串。
 *
 * 同一个文件跑两遍：A 不带 cMapUrl，B 带 cMapUrl，对比结果。
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);

const PDFJS = require('pdfjs-dist/legacy/build/pdf.js');
const CMAP = 'web/cmaps/';

const PDF_PATH = process.argv[2];
if (!PDF_PATH) {
  console.error('用法: node probe-cmap.mjs <pdf路径>');
  process.exit(2);
}

const data = new Uint8Array(readFileSync(PDF_PATH));

async function extract(label, opts) {
  const doc = await PDFJS.getDocument({ data: data.slice(), ...opts }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();

  const items = tc.items.map((i) => i.str);
  const nonEmpty = items.filter((s) => s && s.trim());
  const joined = items.join('').replace(/\s/g, '');

  console.log(`\n--- ${label} ---`);
  console.log(`  items 总数      : ${items.length}`);
  console.log(`  非空 item 数    : ${nonEmpty.length}`);
  console.log(`  拼接后非空白字符: ${joined.length}`);
  console.log(`  前 60 字        : ${JSON.stringify(joined.slice(0, 60))}`);
  await doc.destroy();
  return joined.length;
}

const noCmap = await extract('A. 不带 cMapUrl（= 当前线上代码）', {});
const withCmap = await extract('B. 带 cMapUrl + cMapPacked（= 修复后）', {
  cMapUrl: CMAP,
  cMapPacked: true
});

console.log('\n==================== 结论 ====================');
console.log(`不带 cMapUrl 提取到 ${noCmap} 个字符`);
console.log(`带   cMapUrl 提取到 ${withCmap} 个字符`);
if (noCmap === 0 && withCmap > 0) {
  console.log('✅ 假设成立：缺 cMapUrl 就是「未提取到文字」的根因');
} else if (noCmap > 0) {
  console.log('❌ 假设不成立：不带 cMapUrl 也能提取到文字，需另寻原因');
} else {
  console.log('⚠️ 两种情况都提取不到，需继续排查');
}
