/**
 * 单文件打包：把 web/ 的 CSS/JS 内联进一个 HTML，输出 dist/CourseForge-standalone.html
 * 用途：分享给他人、双击即用、无服务器环境
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(ROOT, 'web');
const OUT = join(ROOT, 'dist', 'CourseForge-standalone.html');

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
// 单文件版直接移除相关声明：file:// 下本就不支持安装，避免产生无效请求
out = out.replace(/^\s*<link rel="manifest"[^>]*>\s*$/m, '  <!-- 单文件版不含 PWA 安装能力（需要 PWA 请使用 web/ 目录部署的在线版） -->\n');
out = out.replace(/^\s*<link rel="icon"[^>]*>\s*$/m, '');
out = out.replace(/^\s*<link rel="apple-touch-icon"[^>]*>\s*$/m, '');

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

if (/<link rel="stylesheet"|<script src=|rel="manifest"/.test(out)) {
  console.error('错误：仍有未内联的外部资源引用');
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, out, 'utf-8');
console.log(`打包完成: ${OUT}（${(out.length / 1024).toFixed(1)} KB）`);
