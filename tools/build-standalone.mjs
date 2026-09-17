/**
 * 单文件打包：把 web/ 的 CSS/JS 内联进一个 HTML，输出 dist/CourseForge-standalone.html
 * 用途：分享给他人、双击即用、无服务器环境
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(ROOT, 'web');
// 可用 STANDALONE_OUT 覆盖输出路径：tests/standalone.test.mjs 需要在不弄脏
// dist/ 的前提下真的跑一遍构建（单文件版的剥离逻辑出过 bug，必须真跑才测得出来）。
const OUT = process.env.STANDALONE_OUT
  ? resolve(process.env.STANDALONE_OUT)
  : join(ROOT, 'dist', 'CourseForge-standalone.html');

const html = await readFile(join(WEB, 'index.html'), 'utf-8');
const css = await readFile(join(WEB, 'css', 'style.css'), 'utf-8');

// 脚本清单从 index.html 里按实际引用顺序派生，不手工维护。
// 手工清单一旦忘记加新模块，内联就会漏掉（末尾的检查会报错，但原因不直观）；
// 从 HTML 派生可以从根本上杜绝这种「加了文件忘了登记」的漂移。
const scripts = [...html.matchAll(/<script src="js\/([\w.-]+)"><\/script>/g)].map((m) => m[1]);
if (!scripts.length) {
  console.error('错误：index.html 里没有找到任何 js/ 脚本引用');
  process.exit(1);
}

let out = html.replace(
  /<link rel="stylesheet" href="css\/style.css">/,
  '<style>\n' + css + '\n</style>'
);

// PWA 资源无法内联（manifest / icon / service worker 都要求外部文件），
// 单文件版直接移除相关声明：file:// 下本就不支持安装，避免产生无效请求。
//
// ⚠️ 必须带 `g` 标志。之前没带，于是「只删掉第一个」——
// 当初 icon 只有一行 SVG，看着一直是对的；后来补了 PNG 兜底那一行，
// 第二个 <link rel="icon"> 就留在了产物里，指向一个并不存在的相对路径。
// 而末尾的自检又只查 stylesheet/script/manifest，没查 icon，
// 于是构建「成功」了、产物却是坏的。下面两个地方都补上了。
out = out.replace(/^\s*<link rel="manifest"[^>]*>\s*$/gm, '  <!-- 单文件版不含 PWA 安装能力（需要 PWA 请使用 web/ 目录部署的在线版） -->');
out = out.replace(/^\s*<link rel="icon"[^>]*>\s*$/gm, '');
out = out.replace(/^\s*<link rel="apple-touch-icon"[^>]*>\s*$/gm, '');

for (const name of scripts) {
  const code = await readFile(join(WEB, 'js', name), 'utf-8');
  if (code.includes('</script>')) {
    console.error(`错误：${name} 中包含 "</script>"，无法安全内联`);
    process.exit(1);
  }
  const tag = new RegExp(`<script src="js/${name.replace('.', '\\.')}"></script>`);
  if (!tag.test(out)) {
    console.error(`错误：index.html 中找不到脚本引用 js/${name}`);
    process.exit(1);
  }
  out = out.replace(tag, '<script>\n' + code + '\n</script>');
}

// 末尾自检：产物里不能残留任何指向外部文件的 <link>/<script>。
// 这里刻意按标签扫，而不是枚举已知类型 —— 枚举法正是上面漏掉 <link rel="icon">
// 的原因（清单里没列它，就永远查不到）。扫标签能自动覆盖将来新增的引用。
const dangling = [];
for (const m of out.matchAll(/<(?:link|script)\b[^>]*>/g)) {
  const tag = m[0];
  const url = (/href="([^"]+)"/.exec(tag) || /src="([^"]+)"/.exec(tag) || [])[1];
  if (!url) continue; // 内联后的 <script> 没有 src，正常
  if (/^(?:https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
  dangling.push(tag.trim().replace(/\s+/g, ' ').slice(0, 110));
}
if (dangling.length) {
  console.error('错误：产物里仍有指向外部文件的引用，单文件版打开会在这些请求上失败：');
  for (const d of dangling) console.error('  - ' + d);
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, out, 'utf-8');
// 按**字节**算大小：中文在 UTF-8 里占 3 字节，而 JS 的字符串长度按 UTF-16 码元算，
// 用 out.length 会系统性低估（本产物实测低估 18%），报出来的数字没有参考价值。
const bytes = Buffer.byteLength(out, 'utf-8');
console.log(`打包完成: ${OUT}（${(bytes / 1024).toFixed(1)} KB）`);
