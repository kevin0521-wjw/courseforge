/**
 * CourseForge 课表分享图（Canvas 手绘 → PNG，不引任何图表库）
 *
 * 为什么要有这个：竞品（拾光课程表 / 超级课程表 等）都把「课表存成图片发群、发朋友圈」
 * 当传播入口 —— 直接截图会带上浏览器地址栏和一堆界面元素，尺寸也不统一。
 * 自己画一张固定宽度的卡片，可读性可控，用户也不用再去裁剪。
 *
 * 分三层，**只有中间那层碰 canvas**：
 *   1. buildLayout()  —— 纯函数：数据 → 绘图指令序列（ops）。Node 里直接可测。
 *   2. paint(ctx, layout) —— 只按指令画，不做任何计算。可用「记录型 mock ctx」测。
 *   3. drawToCanvas() / exportPNG() —— 浏览器胶水：建 canvas、toBlob、下载。
 *
 * 为什么不干脆返回一张 dataURL：那样「布局算得对不对」和「canvas 能不能用」
 * 就揉成一团了 —— 出了偏差根本分不清是算错了还是画错了。
 * 拆开之后，第一层的不变量（不越界、不重叠、字符不溢出）可以逐条断言。
 *
 * 已知取舍：
 *  - 量文字宽度要 measureText，而 layout 必须保持纯函数 → 用依赖注入：
 *    调用方传一个 measure(text, size) 进来，Node 测试传确定性估算函数。
 *  - 同一格多门课不缩成一坨，而是**分泳道**并排（和屏幕上周视图的做法一致），
 *    一个泳道里若还有多门课再纵向堆叠；纵向放不下的场次省略地点/教师。
 */
(function (root, factory) {
  var mod = (typeof module === 'object' && typeof module.exports === 'object');
  var CF = mod ? require('./core.js') : root.CourseForge;
  var api = factory(CF);
  if (mod) {
    module.exports = api;
  } else {
    root.CourseForgeShare = api;
  }
})(typeof self !== 'undefined' ? self : this, function (CF) {
  'use strict';

  // ==================== 版式常量 ====================
  // 全部集中在这里：想整体缩放卡片只改这几个数，不要散落到各处
  var WIDTH = 1080;      // 分享图宽度（微信/朋友圈的 3:4 竖图基准）
  var MARGIN = 48;
  var TIME_COL_W = 104;  // 左侧节次/时间列
  var HEAD_ROW_H = 68;
  var ROW_H = 92;        // 每个大节的基准高度
  var GAP = 6;           // 课块内边距（块与块之间的缝）
  var LANE_GAP = 6;      // 泳道之间的缝
  var RADIUS = 14;
  var ACCENT_W = 8;      // 课块左侧色条
  var FOOTER_H = 72;
  var MAX_PER_LANE = 3;  // 同一泳道最多纵向堆几门，超出显示 +N

  var FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Hiragino Sans GB",sans-serif';

  /** 卡片自身的界面色。课程配色不在这里，走 palette 参数（见 resolvePalette） */
  var THEMES = {
    light: {
      bg: '#ffffff', panel: '#f5f7fb', line: '#e5e7eb', grid: '#eef1f6',
      text: '#111827', muted: '#6b7280', brand: '#2f6fed', today: '#eef3fd'
    },
    dark: {
      bg: '#0f131a', panel: '#171c25', line: '#262e3b', grid: '#202733',
      text: '#e6eaf2', muted: '#98a2b3', brand: '#6f9dff', today: '#1b2740'
    }
  };

  var WEEKDAY = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  // ==================== 小工具 ====================

  /**
   * 默认的文字宽度估算（没有真实 measureText 时用）。
   * 中日韩字符按 1 个字号宽、西文按 0.55 估 —— 只用来决定「截到几个字」，
   * 估得略保守没关系（宁可早一点截断，也不要溢出格子）。
   */
  function estimateWidth(text, size) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      // 基本 CJK、全角标点、CJK 扩展
      var wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6);
      w += wide ? size : size * 0.55;
    }
    return w;
  }

  /** 按可用宽度截断并加省略号 */
  function fitText(text, size, maxWidth, measure) {
    var s = String(text == null ? '' : text);
    if (!s) return '';
    if (measure(s, size) <= maxWidth) return s;
    var ell = '…';
    var ellW = measure(ell, size);
    if (ellW > maxWidth) return '';
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var next = out + s.charAt(i);
      if (measure(next, size) + ellW > maxWidth) break;
      out = next;
    }
    return out ? out + ell : '';
  }

  /**
   * 把文字折成至多 maxLines 行，放不下时在最后一行加省略号。
   * 返回 { lines, truncated }。
   *
   * 为什么按字符折而不是按词折：中文课名没有词边界（「数据结构与算法分析」），
   * 按词折等于不折；夹在中间的英文缩写被拆开是可以接受的代价。
   */
  function wrapText(text, size, maxWidth, measure, maxLines) {
    var s = String(text == null ? '' : text);
    var limit = Math.max(1, maxLines || 1);
    var out = [];
    if (!s) return { lines: out, truncated: false };
    if (measure(s, size) <= maxWidth) return { lines: [s], truncated: false };

    var cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (cur && measure(cur + ch, size) > maxWidth) {
        out.push(cur);
        if (out.length === limit) {
          // 到行数上限了：把「本行已排好的 + 剩下的」一起截断塞进最后一行。
          // ⚠️ 必须是 cur + s.slice(i)；只写 s.slice(i) 会把当前行已排好的字丢掉
          //    （第一版就是这个错，短名字会凭空少第一个字）。
          var fitted = fitText(cur + s.slice(i), size, maxWidth, measure);
          if (fitted) out[limit - 1] = fitted;
          return { lines: out, truncated: !!fitted };
        }
        cur = ch;
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
    return { lines: out, truncated: false };
  }

  /**
   * 课名排版：优先一行放下；一行放不下就折行，**并允许把字号逐档降下来**
   * （每档 2px，最低 14px）以换取「整名可见」。
   *
   * 为什么值得单独写一个函数：课名是这张图上最重要的信息，而 7 天摊在 1080px 上时
   * 单列可用宽度只有约 89px —— 19px 字下只能放 4 个汉字。于是
   * 「数据结构与算法分析」显示成「数据结…」、「程序设计基础」显示成「程序设…」，
   * 等于没写。降到 17px 就能一行放 5 个字、两行放下全名，可读性差别很大。
   * 但**不能无脑缩字号**：短课名一行就放下，根本不会走到这个降档流程。
   */
  function fitName(name, maxWidth, baseSize, measure, maxLines) {
    var s = String(name == null ? '' : name);
    var limit = Math.max(1, maxLines || 1);
    var ladder = [baseSize, baseSize - 2, baseSize - 4, 14];
    var fallback = null;
    for (var i = 0; i < ladder.length; i++) {
      var size = Math.max(14, ladder[i]);
      var r = wrapText(s, size, maxWidth, measure, limit);
      if (!r.truncated) return { size: size, lines: r.lines };
      fallback = { size: size, lines: r.lines }; // 最小字号那一档，兜底
    }
    return fallback || { size: 14, lines: [s] };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /**
   * 课程配色表：以 core.js 的 COURSE_COLORS 为底，用 overrides 覆盖。
   * 浏览器端会把当前主题的 CSS 变量值解析出来传进来，
   * 这样深色主题下导出的图与屏幕上看到的配色一致（不必在 JS 里再抄一份深色值）。
   */
  function resolvePalette(overrides) {
    var out = {};
    var list = (CF && CF.COURSE_COLORS) || [];
    if (!list.length) {
      // core.js 没加载出来也不该让导出直接崩，给一份保底配色
      list = [{ key: 'blue', name: '湖蓝', main: '#2f6fed', bg: '#e8effd' }];
    }
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      out[c.key] = { key: c.key, name: c.name, main: c.main, bg: c.bg };
    }
    if (overrides) {
      for (var k in overrides) {
        if (!Object.prototype.hasOwnProperty.call(overrides, k)) continue;
        if (!out[k]) out[k] = { key: k, name: k, main: '#2f6fed', bg: '#e8effd' };
        if (overrides[k] && overrides[k].main) out[k].main = overrides[k].main;
        if (overrides[k] && overrides[k].bg) out[k].bg = overrides[k].bg;
      }
    }
    return out;
  }

  function colorOf(palette, key) {
    return palette[key] || palette.blue || { main: '#2f6fed', bg: '#e8effd' };
  }

  // ---- 颜色工具（深色主题下课块底色要压暗，见 darkenForTheme）----

  /** `#rgb` / `#rrggbb` → [r,g,b]；解析不了就返回 null（不猜，走兜底分支） */
  function parseHex(hex) {
    var s = String(hex == null ? '' : hex).trim().replace(/^#/, '');
    if (s.length === 3) {
      s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    }
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    var n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function toHex(rgb) {
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.max(0, Math.min(255, Math.round(rgb[i])));
      var h = v.toString(16);
      out += h.length === 1 ? '0' + h : h;
    }
    return out;
  }

  /** 感知亮度（0~255）。只用来判断「底色和文字色差得够不够远」 */
  function relLum(hex) {
    var c = parseHex(hex);
    if (!c) return 128;
    return c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  }

  var DARK_BG_L = 0.2;       // 深色主题下课块底色的目标亮度
  var DARK_BG_S_CAP = 0.35;  // 同时收一档饱和度，免得暗底上颜色过艳

  /**
   * 深色主题下把课块底色压暗（转 HSL 后压 L，保留色相）。
   *
   * 为什么非做不可 —— 真机样图上出现过的失败：用户在**浅色页面**里点「深色导出」，
   * 传进来的 palette 仍是页面当前主题的 CSS 变量值（bg 是 #e8effd 这种浅色），
   * 而 theme.text 在深色主题下是近白色 #e6eaf2 → 白字压浅底，
   * 课名**整片看不见**（不是变淡，是完全没有）。而 Node 测试里 palette 同样是浅色的，
   * 界面预览又只有 52vh 高、字很小，很容易就这么发出去了。
   *
   * 页面本来就是深色时 palette 里的 bg 已经是暗色（如 #1b2740），
   * 这时 l 已经很低，直接原样返回、不做二次压暗。
   */
  function darkenForTheme(hex) {
    var c = parseHex(hex);
    if (!c) return hex;
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2;
    if (l <= DARK_BG_L) return hex;

    var d = max - min;
    var h = 0, s = 0;
    if (d > 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    s = Math.min(s, DARK_BG_S_CAP);

    var c2 = (1 - Math.abs(2 * DARK_BG_L - 1)) * s;
    var x = c2 * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = DARK_BG_L - c2 / 2;
    var rgb;
    if (h < 60) rgb = [c2, x, 0];
    else if (h < 120) rgb = [x, c2, 0];
    else if (h < 180) rgb = [0, c2, x];
    else if (h < 240) rgb = [0, x, c2];
    else if (h < 300) rgb = [x, 0, c2];
    else rgb = [c2, 0, x];
    return toHex([(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255]);
  }

  /** 同一泳道里纵向排布（按节次先后） */
  function sortByTime(a, b) {
    return (a.startSection - b.startSection) || (a.endSection - b.endSection) ||
      String(a.name || '').localeCompare(String(b.name || ''));
  }

  /**
   * 泳道分配：同一天里**节次区间重叠**的课不能画在同一泳道，否则会叠在一起看不清。
   * 贪心即可：按开始节次排序，能塞进已有泳道就塞，塞不进就新开一条。
   * 返回 [[course, ...], ...]。
   */
  function assignLanes(courses) {
    var lanes = [];
    var sorted = courses.slice().sort(sortByTime);
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      var placed = false;
      for (var l = 0; l < lanes.length; l++) {
        var last = lanes[l][lanes[l].length - 1];
        // 只跟该泳道**最后一门**比：前面的已经和它不重叠了
        if (last.endSection < c.startSection) {
          lanes[l].push(c);
          placed = true;
          break;
        }
      }
      if (!placed) lanes.push([c]);
    }
    return lanes;
  }

  /** 课块的周次说明（整学期视图里才有意义） */
  function weeksLabel(course) {
    if (!CF || typeof CF.weeksText !== 'function') return '';
    try {
      // ⚠️ weeksText 返回的文案**本身就带「周」**（如 "1-16 周"、"单周"）。
      // 这里曾经又补了一个「周」，于是图上印出「1-16 周周」——
      // 屏幕上不显示这段文字，所以只有把图导出来才看得见（测试抓到的）。
      return CF.weeksText(course.weeks) || '';
    } catch (e) {
      return '';
    }
  }

  function sectionSpan(course) {
    var start = Number(course.startSection) || 1;
    var end = Number(course.endSection) || start;
    return { start: start, end: end < start ? start : end };
  }

  // ==================== 第一层：布局（纯函数） ====================

  /**
   * 数据 → 绘图指令序列。
   *
   * @param {Object} input
   *   courses      课程数组
   *   settings     学期设置（sectionsPerDay / showWeekend / timePreset ...）
   *   semesterName 标题里的学期名
   *   week         当前周（scope='current' 时用来筛课与显示）
   *   scope        'current'（只看本周）| 'all'（整学期一览）
   *   theme        'light' | 'dark'
   *   showWeekend  是否显示周末（不传则读 settings.showWeekend）
   *   palette      课程配色（见 resolvePalette）
   *   today        今天的 day（1~7，可选；本周视图里高亮今天那一列）
   *   measure      (text, size) => 宽度；不传用内置估算
   * @returns {{width,height,ops,meta}}
   */
  function buildLayout(input) {
    var o = input || {};
    var settings = o.settings || {};
    var measure = typeof o.measure === 'function' ? o.measure : estimateWidth;
    var theme = THEMES[o.theme === 'dark' ? 'dark' : 'light'];
    var palette = o.palette || resolvePalette();
    var scope = o.scope === 'all' ? 'all' : 'current';
    var isDark = o.theme === 'dark';
    // 同一个颜色 key 只压暗一次（一张图里同一个配色会出现在很多块上）
    var darkBgCache = {};
    function blockBgOf(col) {
      if (!(col.key in darkBgCache)) darkBgCache[col.key] = darkenForTheme(col.bg);
      return darkBgCache[col.key];
    }

    var showWeekend = typeof o.showWeekend === 'boolean'
      ? o.showWeekend
      : (settings.showWeekend !== false);
    var totalSections = clamp(Number(settings.sectionsPerDay) || 12, 1, 20);
    var days = [];
    for (var d = 1; d <= (showWeekend ? 7 : 5); d++) days.push(d);

    var courses = Array.isArray(o.courses) ? o.courses : [];
    var week = Number(o.week) || 1;

    // ---- 筛选：本周视图只留覆盖该周的课 ----
    var visible = [];
    var hiddenByWeek = 0;
    for (var i = 0; i < courses.length; i++) {
      var c = courses[i];
      if (!c || !c.name) continue;
      var sp = sectionSpan(c);
      if (sp.start > totalSections) continue; // 节次超出当前作息（换过作息预设）→ 画不出来
      if (scope === 'current' && CF && typeof CF.courseCoversWeek === 'function' &&
          !CF.courseCoversWeek(c, week)) {
        hiddenByWeek++;
        continue;
      }
      visible.push(c);
    }

    // ---- 尺寸 ----
    var tableW = WIDTH - MARGIN * 2 - TIME_COL_W;
    var colW = tableW / days.length;
    var gridTop = MARGIN + 96;                      // 标题区高度
    var gridH = HEAD_ROW_H + totalSections * ROW_H;
    var footerTop = gridTop + gridH + 26;
    var height = footerTop + FOOTER_H + MARGIN - 16;

    var ops = [];
    var blocks = [];
    var meta = {
      scope: scope, week: week, theme: o.theme === 'dark' ? 'dark' : 'light',
      days: days, sections: totalSections,
      courseCount: visible.length, hiddenByWeek: hiddenByWeek,
      paletteUsed: {}
    };

    function rect(x, y, w, h, fill, radius, stroke) {
      var op = { type: 'rect', x: x, y: y, w: w, h: h, fill: fill, radius: radius || 0 };
      if (stroke) op.stroke = stroke;
      ops.push(op);
      return op;
    }

    function text(str, x, y, size, color, opts) {
      var t = opts || {};
      ops.push({
        type: 'text', text: String(str), x: x, y: y, size: size, color: color,
        weight: t.weight || 'normal', align: t.align || 'left',
        baseline: t.baseline || 'middle',
        maxWidth: t.maxWidth || 0
      });
    }

    // ---- 底 ----
    rect(0, 0, WIDTH, height, theme.bg, 0);

    // ---- 标题区 ----
    // 小品牌标：与图标同一套造型（圆角方块 + 白色牌身 + 两个彩色格子）
    var markSize = 56, markY = MARGIN, markX = MARGIN;
    rect(markX, markY, markSize, markSize, theme.brand, 14);
    rect(markX + 12, markY + 16, markSize - 24, markSize - 26, '#ffffff', 6);
    rect(markX + 18, markY + 30, 10, 7, '#2f6fed', 2);
    rect(markX + 32, markY + 30, 10, 7, '#0e9f6e', 2);

    var titleX = markX + markSize + 20;
    var titleMax = WIDTH - MARGIN - titleX;
    text(fitText(o.semesterName || '我的课表', 34, titleMax, measure), titleX, markY + 18, 34,
      theme.text, { weight: 'bold', maxWidth: titleMax });

    var weekLabel = scope === 'current'
      ? '第 ' + week + ' 周 · 本周课程'
      : '全部周次一览（共 ' + visible.length + ' 门）';
    text(weekLabel, titleX, markY + 44, 19, theme.muted, { maxWidth: titleMax });

    // ---- 表头行 ----
    var headY = gridTop;
    rect(MARGIN, headY, WIDTH - MARGIN * 2, HEAD_ROW_H, theme.panel, RADIUS);
    text('节次', MARGIN + TIME_COL_W / 2, headY + HEAD_ROW_H / 2, 19, theme.muted,
      { align: 'center' });

    for (var di = 0; di < days.length; di++) {
      var day = days[di];
      var colX = MARGIN + TIME_COL_W + di * colW;
      if (scope === 'current' && Number(o.today) === day) {
        rect(colX + 1, headY + 1, colW - 2, HEAD_ROW_H - 2, theme.today, RADIUS);
      }
      text(WEEKDAY[day - 1], colX + colW / 2, headY + HEAD_ROW_H / 2, 22, theme.text,
        { align: 'center', weight: 'bold', maxWidth: colW - 12 });
    }

    // ---- 行：节次 + 时间 + 分隔线 ----
    var bodyY = headY + HEAD_ROW_H;
    for (var s = 1; s <= totalSections; s++) {
      var rowY = bodyY + (s - 1) * ROW_H;
      var st = (CF && typeof CF.getSectionTime === 'function')
        ? CF.getSectionTime(settings, s) : null;

      if (scope === 'current' && o.today && days.indexOf(Number(o.today)) >= 0) {
        var todayIdx = days.indexOf(Number(o.today));
        rect(MARGIN + TIME_COL_W + todayIdx * colW + 1, rowY + 1, colW - 2, ROW_H - 2,
          theme.today, 0);
      }

      // 节次号与起止时间：和屏幕上的作息一致，别让看的人再去猜几点上课
      text(String(s), MARGIN + TIME_COL_W / 2, rowY + ROW_H / 2 - 11, 21, theme.text,
        { align: 'center', weight: 'bold' });
      var timeStr = st && st.start && st.end ? (st.start + '–' + st.end) : '';
      if (timeStr) {
        text(timeStr, MARGIN + TIME_COL_W / 2, rowY + ROW_H / 2 + 13, 14, theme.muted,
          { align: 'center', maxWidth: TIME_COL_W - 8 });
      }

      if (s < totalSections) {
        ops.push({
          type: 'line', x1: MARGIN + 8, y1: rowY + ROW_H, x2: WIDTH - MARGIN - 8, y2: rowY + ROW_H,
          color: theme.grid, width: 1
        });
      }
    }

    // 列分隔线（表头以下）
    for (var ci = 1; ci < days.length; ci++) {
      var lx = MARGIN + TIME_COL_W + ci * colW;
      ops.push({ type: 'line', x1: lx, y1: bodyY, x2: lx, y2: bodyY + totalSections * ROW_H,
        color: theme.grid, width: 1 });
    }

    // ---- 课块 ----
    for (var dj = 0; dj < days.length; dj++) {
      var dcur = days[dj];
      var dayCourses = [];
      for (var vi = 0; vi < visible.length; vi++) {
        if (visible[vi].day === dcur) dayCourses.push(visible[vi]);
      }
      if (!dayCourses.length) continue;

      var lanes = assignLanes(dayCourses);
      var laneW = (colW - LANE_GAP * (lanes.length - 1) - GAP * 2) / lanes.length;

      for (var li = 0; li < lanes.length; li++) {
        var lane = lanes[li];
        var laneX = MARGIN + TIME_COL_W + dj * colW + GAP + li * (laneW + LANE_GAP);

        // 泳道内按节次顺序纵向排；单门课直接铺满自己那一格
        for (var k = 0; k < lane.length; k++) {
          var course = lane[k];
          var csp = sectionSpan(course);
          var span = csp.end - csp.start + 1;
          var blockY = bodyY + (csp.start - 1) * ROW_H + GAP;
          var blockH = span * ROW_H - GAP * 2;
          if (blockY + blockH > bodyY + totalSections * ROW_H) {
            blockH = bodyY + totalSections * ROW_H - GAP - blockY;
          }
          if (blockH < 18) continue; // 实在放不下就放弃这一块，总比画出个碎片强

          var col = colorOf(palette, course.color);
          // 深色主题下课块底色必须压暗：theme.text 是近白色，
          // 而 palette 的 bg 可能还是浅色（浅色页面里点「深色导出」）—— 不压就成了白底白字。
          var blockBg = isDark ? blockBgOf(col) : col.bg;
          meta.paletteUsed[col.key] = true;

          rect(laneX, blockY, laneW, blockH, blockBg, RADIUS);
          rect(laneX, blockY, ACCENT_W, blockH, col.main, 0);

          var padL = ACCENT_W + 9;
          var innerW = laneW - padL - 8;
          var innerX = laneX + padL;
          if (innerW < 16) continue; // 泳道窄到放不下字，留色块即可

          // 高度决定给多少信息：挤的时候只留课名，别让文字互相盖住
          var roomy = blockH >= 92;
          var compact = blockH < 46;
          var nameSize = compact ? 15 : 19;
          var nameY = compact ? blockY + blockH / 2 : blockY + 15 + nameSize / 2;

          // 课名：能一行放下最好；放不下就折两行并把字号降一档，
          // 宁可字小一点，也不要「数据结…」这种等于没写的截断。
          // 只有一个大节的格子（80px 高）塞不下两行，只折一行。
          var nameLayout = compact
            ? { size: nameSize, lines: [fitText(course.name, nameSize, innerW, measure)] }
            : fitName(course.name, innerW, nameSize, measure, roomy ? 2 : 1);
          var nameLineH = nameLayout.size + 3;
          for (var nl = 0; nl < nameLayout.lines.length; nl++) {
            text(nameLayout.lines[nl], innerX, nameY + nl * nameLineH, nameLayout.size,
              theme.text, { weight: 'bold', maxWidth: innerW });
          }

          if (!compact) {
            // 地点/教师接在课名最后一行下面（折了行就要跟着往下挪，否则会压在课名上）
            var lineY = nameY + (nameLayout.lines.length - 1) * nameLineH +
              nameLayout.size / 2 + 12;
            var place = course.location || '';
            if (place) {
              text(fitText(place, 15, innerW, measure), innerX, lineY, 15, theme.muted,
                { maxWidth: innerW });
              lineY += 18;
            }
            if (roomy && course.teacher) {
              text(fitText(course.teacher, 14, innerW, measure), innerX, lineY, 14,
                theme.muted, { maxWidth: innerW });
              lineY += 17;
            }
            if (roomy && o.scope === 'all') {
              var wl = weeksLabel(course);
              if (wl) {
                text(fitText(wl, 13, innerW, measure), innerX, lineY, 13, theme.muted,
                  { maxWidth: innerW });
              }
            }
          }

          blocks.push({
            courseId: course.id, name: course.name, day: dcur,
            start: csp.start, end: csp.end, lane: li,
            x: laneX, y: blockY, w: laneW, h: blockH, color: col.key
          });
        }
      }

      // 泳道多于 MAX_PER_LANE 时，多出来的不画、但要说清「还有几门」
      for (var lj = 0; lj < lanes.length; lj++) {
        if (lanes[lj].length <= MAX_PER_LANE) continue;
        var overflow = lanes[lj].length - MAX_PER_LANE;
        var ovCourse = lanes[lj][MAX_PER_LANE - 1];
        var ovSp = sectionSpan(ovCourse);
        var ovY = bodyY + (ovSp.end - 1) * ROW_H + GAP;
        var ovX = MARGIN + TIME_COL_W + dj * colW + GAP + lj * (laneW + LANE_GAP);
        text('+' + overflow + ' 门', ovX + laneW - 6, clamp(ovY + 12, bodyY, bodyY + gridH - 12),
          13, theme.muted, { align: 'right', maxWidth: laneW });
      }
    }

    // ---- 页脚 ----
    ops.push({ type: 'line', x1: MARGIN, y1: footerTop, x2: WIDTH - MARGIN, y2: footerTop,
      color: theme.line, width: 1 });
    var footText = visible.length
      ? ('共 ' + visible.length + ' 门课程' + (hiddenByWeek ? ' · 另有 ' + hiddenByWeek + ' 门不在本周' : ''))
      : '这段时间还没有课';
    text(footText, MARGIN, footerTop + FOOTER_H / 2, 17, theme.muted,
      { maxWidth: WIDTH - MARGIN * 2 - 240 });
    text('课表工坊 CourseForge', WIDTH - MARGIN, footerTop + FOOTER_H / 2, 17, theme.brand,
      { align: 'right', weight: 'bold', maxWidth: 232 });

    meta.hiddenInLaneOverflow = blocks.length;
    return { width: WIDTH, height: height, ops: ops, blocks: blocks, meta: meta, theme: theme };
  }

  // ==================== 第二层：绘制（只执行指令） ====================

  /** 圆角矩形路径。不用 ctx.roundRect —— 老 WebView 没有，而且自己画更好测 */
  function roundRectPath(ctx, x, y, w, h, r) {
    var rr = clamp(r || 0, 0, Math.min(w, h) / 2);
    ctx.beginPath();
    if (!rr) {
      ctx.rect(x, y, w, h);
      return;
    }
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function paint(ctx, layout) {
    if (!ctx || !layout || !layout.ops) return 0;
    var ops = layout.ops;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.type === 'rect') {
        roundRectPath(ctx, op.x, op.y, op.w, op.h, op.radius);
        ctx.fillStyle = op.fill;
        ctx.fill();
        if (op.stroke) {
          ctx.lineWidth = 1;
          ctx.strokeStyle = op.stroke;
          ctx.stroke();
        }
      } else if (op.type === 'text') {
        ctx.font = (op.weight === 'bold' ? 'bold ' : '') + op.size + 'px ' + FONT;
        ctx.fillStyle = op.color;
        ctx.textAlign = op.align;
        ctx.textBaseline = op.baseline;
        if (op.maxWidth > 0) ctx.fillText(op.text, op.x, op.y, op.maxWidth);
        else ctx.fillText(op.text, op.x, op.y);
      } else if (op.type === 'line') {
        ctx.beginPath();
        ctx.moveTo(op.x1, op.y1);
        ctx.lineTo(op.x2, op.y2);
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width || 1;
        ctx.stroke();
      }
    }
    return ops.length;
  }

  // ==================== 第三层：浏览器胶水 ====================

  /** 把布局画到一张新的 canvas 上（返回 canvas，方便预览与导出复用） */
  function drawToCanvas(layout, doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) throw new Error('没有可用的 document，无法创建 canvas');
    var canvas = d.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境不支持 Canvas 2D，无法生成图片');
    ctx.fillStyle = layout.theme ? layout.theme.bg : '#ffffff';
    ctx.fillRect(0, 0, layout.width, layout.height);
    paint(ctx, layout);
    return canvas;
  }

  /**
   * 取一个「量文字宽度」的函数。
   * 同一个 2d context 复用即可 —— 频繁建 canvas 会让浏览器反复分配离屏缓冲。
   */
  function makeMeasure(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    var ctx = null;
    if (d) {
      try {
        ctx = d.createElement('canvas').getContext('2d');
      } catch (e) {
        ctx = null;
      }
    }
    if (!ctx) return estimateWidth;
    return function (t, size) {
      ctx.font = size + 'px ' + FONT;
      return ctx.measureText(String(t)).width;
    };
  }

  /** 建议文件名（和 ICS.suggestFileName 一个路数：带日期，便于区分多次导出） */
  function suggestFileName(now, semesterName, scope, week) {
    var d = now instanceof Date ? now : new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
    var name = String(semesterName || '课表').replace(/[\\/:*?"<>|\s]/g, '').slice(0, 20);
    var tail = scope === 'all' ? '全部周次' : ('第' + (Number(week) || 1) + '周');
    return '课表-' + name + '-' + tail + '-' + stamp + '.png';
  }

  /**
   * 导出 PNG。onDone(err, {blob, fileName}) —— 用回调而不是 Promise，
   * 因为 toBlob 在部分老 WebView 上只有回调形式，包 Promise 反而要处理两种返回。
   */
  function exportPNG(layout, opts, onDone) {
    var o = opts || {};
    var doc = o.document || (typeof document !== 'undefined' ? document : null);
    var done = typeof onDone === 'function' ? onDone : function () {};
    var canvas;
    try {
      canvas = drawToCanvas(layout, doc);
    } catch (e) {
      done(e);
      return;
    }
    var finish = function (blob) {
      if (!blob) { done(new Error('生成图片失败（toBlob 返回空）')); return; }
      done(null, { blob: blob, fileName: o.fileName || suggestFileName(new Date(), '', layout.meta.scope, layout.meta.week) });
    };
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(function (blob) { finish(blob); }, 'image/png');
    } else if (typeof canvas.toDataURL === 'function') {
      // 兜底：把 dataURL 转回 Blob
      try {
        var url = canvas.toDataURL('image/png');
        var bin = atob(url.split(',')[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        finish(new Blob([arr], { type: 'image/png' }));
      } catch (e) {
        done(e);
      }
    } else {
      done(new Error('当前环境不支持导出图片'));
    }
  }

  return {
    // 常量（测试与调用方都要用，别让它们各写一份）
    WIDTH: WIDTH, MARGIN: MARGIN, TIME_COL_W: TIME_COL_W, HEAD_ROW_H: HEAD_ROW_H,
    ROW_H: ROW_H, GAP: GAP, ACCENT_W: ACCENT_W, FOOTER_H: FOOTER_H,
    MAX_PER_LANE: MAX_PER_LANE, FONT: FONT, THEMES: THEMES, WEEKDAY: WEEKDAY,
    // 第一层
    buildLayout: buildLayout,
    // 第二层
    paint: paint, roundRectPath: roundRectPath,
    // 第三层
    drawToCanvas: drawToCanvas, exportPNG: exportPNG,
    // 工具（单独导出是为了能单独测）
    resolvePalette: resolvePalette, estimateWidth: estimateWidth,
    fitText: fitText, wrapText: wrapText, fitName: fitName,
    assignLanes: assignLanes, suggestFileName: suggestFileName,
    // 颜色工具（单独导出是为了能单独测）
    parseHex: parseHex, toHex: toHex, relLum: relLum, darkenForTheme: darkenForTheme,
    makeMeasure: makeMeasure
  };
});
