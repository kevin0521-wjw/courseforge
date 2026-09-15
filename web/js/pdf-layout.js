/**
 * PDF 版面还原引擎
 *
 * 为什么需要它：
 *  pdf.js 的 getTextContent() 给出的是「一堆带坐标的文字片段」，不是文本行。
 *  早期实现直接 `items.map(it => it.str).join(' ')`，把坐标全部丢掉 ——
 *  课表这类「靠位置表意」的版面会当场塌陷：
 *    星期一  星期二  星期三  |  1  C++程序设计  学术英语  (1-2节)…
 *  两门课并排出现，但谁属于星期一、谁属于星期五，信息只存在于坐标里，丢了就再也找不回。
 *
 * 本模块的做法：
 *  1. 按 y 坐标把片段聚成「视觉行」（同一行的片段 y 接近）
 *  2. 行内按 x 排序，并按「间距突变」判断该不该插分隔符 —— 格子边界就是间距突变处
 *  3. 跨行识别「列边界」（x 坐标的稳定分界），把每行切成与列对齐的单元格
 *  4. 输出「用制表符分隔的表格文本」交给文本解析引擎，让每一格天然带上行列语义
 *
 * 纯函数，不依赖 DOM 与 pdf.js，可在 Node 直接测试。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoursePdfLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 同一行的 y 容差：PDF 里同一行的片段 y 常有零点几的抖动 */
  var ROW_TOL = 3;

  /** 间距超过「行内中位字宽」的这个倍数，就认为跨了格子 */
  var GAP_RATIO = 1.8;

  /** 表格需要至少这么多列，否则按普通文本处理 */
  var MIN_TABLE_COLS = 3;

  /**
   * 同一列内，相邻两行的 y 间距超过此值就认为跨了格子。
   *
   * ⚠️ 实测修正（变异测试发现）：这份上海大学课表【没有】空行占位 ——
   * 所有相邻行距都落在 11.5~15.6pt 之间，全部小于本阈值，
   * 也就是说本分支在这份文件上【从不触发】，真正起作用的断格依据是
   * 下面的「内容形态」判断（见 MIN_BREAK_GAP 与 isCourseNameLike）。
   * 保留它是为兼容「用空行分隔课程」的其它学校课表 —— 那种文件里行距会明显跳大。
   * 因此不要指望靠调这个值来修这份 PDF 的断格问题。
   */
  var MERGE_GAP = 22;

  /**
   * 间距未达 MERGE_GAP 时，若遇到新的课名，仍需此最小间距才断开。
   * 课名与上一门的学分行可能只隔 12pt，此时靠形态判断；
   * 但同一门课内「课名」与「编号」也可能只隔 13pt，所以要留一个下限避免误切。
   *
   * ⚠️ 实测修正（变异测试发现）：本文件的实际行距集中在 11.5~15.6pt，
   * 所以本阈值在 [11.5, 15.6] 区间内取值都不改变结果 —— 它在 【13, 15.6) 内才有区分力。
   * 换言之：真正决定成败的是 isCourseNameLike 的形态判断，本常量只是安全下限。
   */
  var MIN_BREAK_GAP = 13;

  /**
   * 判断一段文字是否像「课程名」。
   * 同格内的其他行都有明显的形态特征（括号编号、节次标记、教师、学分备注），
   * 而课程名是「中文/英文短语」或「体育(1)」这类，不以这些标记开头。
   */
  function isCourseNameLike(t) {
    var s = String(t || '').trim();
    if (!s) return false;
    // 括号开头 → 课程编号或节次
    if (/^[(（]/.test(s)) return false;
    // 斜杠开头的备注残片（如「/选课备注:」被切断后的「/」）
    if (/^[\/／]/.test(s)) return false;
    // 备注行过滤。⚠️ 实测（变异测试）：本份上海大学课表里这些文本都与课名同在
    // 一个格子内、不会被单独喂进来 —— 删掉本行输出完全不变，属于「兼容其它
    // 学校课表」的防御性分支（有些学校的备注会单独占一格）。不要靠它来修断格问题。
    if (/^(?:选课)?课备注|学分[:：]|教师[:：]|地点[:：]/.test(s)) return false;
    // 纯编号、纯数字
    if (/^[A-Za-z]?\d+$/.test(s)) return false;
    // 字母 + 括号 + 长数字码，如 B(1)(GBK0101003) —— 这是课程编号行不是课名
    if (/^[A-Za-z]{1,3}\s*\([^)]*\)/.test(s) && /\d{5,}/.test(s)) return false;
    // 必须含有中文或足够长的字母词，才可能是课名
    if (!/[\u4e00-\u9fa5]/.test(s) && s.replace(/[^A-Za-z]/g, '').length < 3) return false;
    return true;
  }

  function isFiniteNum(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /**
   * 取片段的字号。pdf.js 的 transform 是 [a,b,c,d,e,f]，
   * 其中 d 近似竖直缩放即字号，用 |d| 比 height 稳（旋转文本也适用）。
   */
  function fontSizeOf(item) {
    var tr = item.transform;
    if (tr && isFiniteNum(tr[3]) && Math.abs(tr[3]) > 0.01) return Math.abs(tr[3]);
    if (isFiniteNum(item.height) && item.height > 0.01) return item.height;
    return 0;
  }

  /**
   * 取片段的起始 x。transform[4] 是文字基线的 x；
   * 若给了 width，则用 viewport 换算后的宽度做右侧兜底估算。
   */
  function xOf(item) {
    var tr = item.transform;
    if (tr && isFiniteNum(tr[4])) return tr[4];
    return 0;
  }

  function yOf(item) {
    var tr = item.transform;
    if (tr && isFiniteNum(tr[5])) return tr[5];
    return 0;
  }

  /**
   * 估算片段宽度（未旋转时）。pdf.js 在部分版本会直接给 width，
   * 没有就按「字符数 × 字号 × 0.55」粗估（中文约等于 1.0，西文约 0.5，折中取 0.55 偏保守）。
   */
  function widthOf(item) {
    if (isFiniteNum(item.width) && item.width > 0) return item.width;
    var s = typeof item.str === 'string' ? item.str : '';
    if (!s) return 0;
    var fs = fontSizeOf(item) || 10;
    var wide = 0;
    for (var i = 0; i < s.length; i++) {
      // 中日韩与全角标点按 1 字宽算，其余按 0.5
      var c = s.charCodeAt(i);
      wide += (c > 0x2e80) ? 1 : 0.5;
    }
    return wide * fs;
  }

  /** 把 pdf.js 的 textContent.items 转成规整的片段数组（过滤空串与旋转文本） */
  function normalizeItems(items) {
    var out = [];
    if (!items || !items.length) return out;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.str !== 'string') continue;
      if (!it.str.replace(/\s/g, '')) continue;
      var tr = it.transform || [];
      // b、c 是旋转分量；课表不会有旋转文字，有的话宁可跳过也不要污染坐标
      if (isFiniteNum(tr[1]) && isFiniteNum(tr[2]) &&
          (Math.abs(tr[1]) > 0.01 || Math.abs(tr[2]) > 0.01)) continue;
      out.push({
        str: it.str,
        x: xOf(it),
        y: yOf(it),
        w: widthOf(it),
        size: fontSizeOf(it)
      });
    }
    return out;
  }

  /** 按 y 聚成视觉行：y 接近的归为一行，行内按 x 升序 */
  function groupRows(items) {
    var sorted = items.slice().sort(function (a, b) {
      if (Math.abs(a.y - b.y) > ROW_TOL) return b.y - a.y; // PDF 的 y 向上为正，行序要倒过来
      return a.x - b.x;
    });
    var rows = [];
    var cur = null;
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      if (!cur || Math.abs(cur.y - it.y) > ROW_TOL) {
        cur = { y: it.y, items: [it] };
        rows.push(cur);
      } else {
        cur.items.push(it);
        // 行的代表 y 取平均，避免首个片段的抖动带偏整行
        cur.y = (cur.y * (cur.items.length - 1) + it.y) / cur.items.length;
      }
    }
    for (var r = 0; r < rows.length; r++) {
      rows[r].items.sort(function (a, b) { return a.x - b.x; });
    }
    return rows;
  }

  /**
   * 行内切分：间距明显大于常规字间距时打断，得到一个「视觉单元格」。
   * 课表里同一格内的多行文字（课程名/教师/地点各占一行）会因为 y 不同而落在不同的视觉行，
   * 所以这里不试图合并多行，只负责把「同一视觉行里的不同格子」分开。
   */
  function splitCells(row) {
    var items = row.items;
    if (!items.length) return [];
    if (items.length === 1) {
      return items[0].str.replace(/\s/g, '') ? [{ text: items[0].str, x: items[0].x, end: items[0].x + items[0].w, size: items[0].size }] : [];
    }

    // 判断「该不该断」不能只看间距与中位数的比值：
    // 课表里同一格子内的文字是「上下排」的（y 不同已在 groupRows 分开），
    // 因此同一视觉行内相邻片段的间距只要超过阈值就该断。
    // 阈值取「前一个片段的字号」的 0.8 倍 —— 正常字间空格远小于此，
    // 而跨格子（含格内边距）的间距通常大于一个汉字宽。
    var cells = [];
    var cur = { text: items[0].str, x: items[0].x, end: items[0].x + items[0].w, size: items[0].size };
    for (var j = 1; j < items.length; j++) {
      var it = items[j];
      var gap = it.x - cur.end;
      var thresh = Math.max((cur.size || 10) * 0.8, 3);
      if (gap > thresh) {
        cells.push(cur);
        cur = { text: it.str, x: it.x, end: it.x + it.w, size: it.size };
      } else {
        cur.text += it.str;
        cur.end = it.x + it.w;
      }
    }
    cells.push(cur);
    for (var k = 0; k < cells.length; k++) cells[k].text = cells[k].text.replace(/\s+$/, '');
    return cells.filter(function (c) { return c.text.replace(/\s/g, ''); });
  }

  /**
   * 找出稳定的列边界（x 坐标分界）。
   *
   * 为什么不直接用「出现频次最高的 x」：
   *  课表里「星期三只有一门课」这种情况很常见，那一列的 x 只出现一两次，
   *  按频次筛会被丢掉，导致整列的课跑到别列去。
   *
   * 这里改用「等差数列」假设：课表列宽是等距的（教科书式表格都是如此），
   *  只要找到两个锚点（出现次数最多的 x），就能推出整排列边界，
   *  再让每个出现的 x 吸附到最近的等差格点上。这样偶发列也不会丢。
   */
  function findColumns(rowsOfCells, totalRows) {
    var TOL = 12; // 吸附容差：小于半个列宽即可（列宽通常 80~120pt）
    var counts = [];
    for (var r = 0; r < rowsOfCells.length; r++) {
      var cells = rowsOfCells[r];
      for (var c = 0; c < cells.length; c++) {
        var x = cells[c].x;
        var hit = null;
        for (var b = 0; b < counts.length; b++) {
          if (Math.abs(counts[b].x - x) <= TOL) { hit = counts[b]; break; }
        }
        if (hit) { hit.n++; hit.sum += x; hit.x = hit.sum / hit.n; }
        else counts.push({ x: x, n: 1, sum: x });
      }
    }
    if (!counts.length) return [];
    counts.sort(function (a, b) { return a.x - b.x; });

    // 锚点：出现次数足够多的 x（至少 2 次，或者占行数 10%）
    var need = Math.max(2, Math.ceil(totalRows * 0.1));
    var anchors = counts.filter(function (b) { return b.n >= need; }).map(function (b) { return b.x; });

    if (anchors.length >= 3) {
      // 用相邻锚点的中位间距当列宽，比首尾平均更抗噪
      var diffs = [];
      for (var i = 1; i < anchors.length; i++) diffs.push(anchors[i] - anchors[i - 1]);
      diffs.sort(function (a, b) { return a - b; });
      var unit = diffs[Math.floor(diffs.length / 2)];

      // 列宽太小说明锚点其实来自同一列内的不同缩进，不能当等差数列用
      if (unit >= 30) {
        // 以最左锚点为基准向两侧延伸，生成完整等差列
        var base = anchors[0];
        var cols = [];
        // 向左最多回退两格（有些表的最左列没有锚点）
        var back = Math.min(1, Math.floor(base / unit));
        for (var k = back; k >= 1; k--) cols.push(base - unit * k);
        // 向右延伸到覆盖所有出现过的 x
        var maxX = counts[counts.length - 1].x;
        var steps = Math.ceil((maxX - base) / unit) + 1;
        for (var s = 0; s <= steps; s++) cols.push(base + unit * s);

        // 只保留「确有元素落在附近」的列，避免右侧留出大量空列
        var kept = [];
        for (var m = 0; m < cols.length; m++) {
          for (var n = 0; n < counts.length; n++) {
            if (Math.abs(counts[n].x - cols[m]) <= unit * 0.45) { kept.push(cols[m]); break; }
          }
        }
        if (kept.length >= MIN_TABLE_COLS) return kept;
      }
    }

    // 退路：等差假设不成立（表格不规则），就用去重后的锚点
    return anchors.length >= MIN_TABLE_COLS ? anchors : counts.map(function (b) { return b.x; });
  }

  /** 把一个单元格按列边界归位，返回它落在第几列 */
  function columnIndex(cols, x) {
    var idx = 0;
    for (var i = 0; i < cols.length; i++) {
      if (x >= cols[i] - 8) idx = i;
      else break;
    }
    return idx;
  }

  var DAY_CN = ['', '一', '二', '三', '四', '五', '六', '日'];

  /**
   * 从表头行认出「哪一列是星期几」。
   * 表头文字可能是「星期一」「周一」「周一(Mon)」等形式；
   * 认出来后返回 { colIndex: dayNumber } 的映射，供数据行补星期用。
   * @returns {{map:Object, rowIndex:number}} rowIndex 为表头所在视觉行（-1 表示没找到）
   */
  function findDayColumns(rowsOfCells, cols) {
    for (var r = 0; r < rowsOfCells.length; r++) {
      var cells = rowsOfCells[r];
      var found = 0;
      var local = {};
      for (var c = 0; c < cells.length; c++) {
        var text = cells[c].text;
        // 只认纯粹的星期词（允许后面跟括号注释），避免把「周次」或含星期的长句算进来
        var m = text.match(/^\s*(?:星期|周)\s*([一二三四五六日天]|1|2|3|4|5|6|7)\s*(?:\(.*\))?\s*$/);
        if (!m) continue;
        var ch = m[1];
        var day = '一二三四五六日天'.indexOf(ch) >= 0
          ? '一二三四五六日天'.indexOf(ch) + 1
          : parseInt(ch, 10);
        if (day >= 1 && day <= 7) {
          // 表头文字可能居中排版，用该格的实际 x 归位到列
          local[columnIndex(cols, cells[c].x)] = day;
          found++;
        }
      }
      // 至少认出 4 个星期才算真正的表头行
      if (found >= 4) return { map: local, rowIndex: r };
    }
    return { map: {}, rowIndex: -1 };
  }

  /**
   * 判断一格文字是否只是「节次标记」（如 "1"、"第3节"、"5 学术英语" 里的 5）。
   * 课表的节次列是分节标志，用来划定「一个格子从哪开始」，本身不是课程内容。
   */
  function isSectionMarker(text) {
    return /^(?:第)?\d{1,2}(?:\s*[-~至]\s*\d{1,2})?\s*节?$/.test(String(text).trim());
  }

  /**
   * 把表格按「节次」切成格子，再把同格的多行文字合并。
   *
   * 为什么用节次行的 y 坐标当边界（而不是「遇到节次行就开新段」）：
   *  课表格子里「课程名 / 课程编号 / 节次周次教师 / 学分」是多行堆叠的，
   *  这些行的 y 落在该节次与下一节次之间。只要拿节次列各行的 y 当分界线，
   *  就能把任意列的文字准确归入它所属的那个格子，不会跨格串行。
   *  早先按「行序」分段的写法会把同一格拆成两段（如「C++程序设计」与「(1-2节)…」分家）。
   *
   * @param {Array<{y:number, cells:Array}>} dataRows - 数据行（已排除表头与噪声行），带 y 坐标
   * @param {Array} cols - 列边界 x
   * @param {Object} dayOfCol - 列号 → 星期几
   */
  function mergeSegments(dataRows, cols, dayOfCol) {
    // 1. 把每行摊成「列号 → 文本」，便于按列处理
    var grid = dataRows.map(function (row) {
      var arr = [];
      for (var i = 0; i < cols.length; i++) arr.push('');
      for (var c = 0; c < row.cells.length; c++) {
        var ci = columnIndex(cols, row.cells[c].x);
        arr[ci] = arr[ci] ? (arr[ci] + ' ' + row.cells[c].text) : row.cells[c].text;
      }
      return { y: row.y, arr: arr };
    });

    // 2. 找节次列：统计各列中「纯节次标记」的出现行数，最多者为节次列
    var numHits = [];
    for (var k = 0; k < cols.length; k++) numHits.push(0);
    for (var r = 0; r < grid.length; r++) {
      for (var q = 0; q < cols.length; q++) {
        if (isSectionMarker(grid[r].arr[q])) numHits[q]++;
      }
    }
    var secCol = -1;
    var best = 0;
    for (var w = 0; w < numHits.length; w++) if (numHits[w] > numHits[best]) best = w;
    if (numHits[best] >= 3) secCol = best;

    // 3. 用节次行的 y 作为格子边界（降序排列，因为 PDF 的 y 越大越靠上）
    var bounds = [];
    if (secCol >= 0) {
      for (var b = 0; b < grid.length; b++) {
        if (isSectionMarker(grid[b].arr[secCol])) bounds.push(grid[b].y);
      }
    }
    bounds.sort(function (a, b) { return b - a; });

    var out = [];
    // 逐列聚类：同一列内，按 y 间距把一个格子的多行合成一门课。
    //
    // 为什么不用「节次数字的 y」当格子边界：
    //  实测这份课表里，节次 N+1 的数字与该格最后一行详情印在同一 y 上，
    //  用节次 y 划界必然让相邻格互相吞内容。改看「列内的行间距」则很干净：
    //  同一格内行距约 12~16pt，跨格（空行/边框）会明显拉大，据此就能准确断开。
    //  以星期一列为例：y 399.6→349.0 连成一片（一门课），
    //  349.0 到 334.6 空出 14.4 但有整整一行的空缺，按「连续行号」判断即可分开。
    for (var c4 = 0; c4 < cols.length; c4++) {
      if (c4 === secCol) continue;
      // 收集该列所有非空文本（带 y）
      var colItems = [];
      for (var g2 = 0; g2 < grid.length; g2++) {
        var v2 = grid[g2].arr[c4];
        if (!v2) continue;
        colItems.push({ y: grid[g2].y, text: v2 });
      }
      colItems.sort(function (a, b) { return b.y - a.y; });

      // 按时段标签切断（上午/下午/晚上出现在列里说明跨了时段，不算课程内容）
      var blocks = [];
      var curBlock = null;
      for (var m2 = 0; m2 < colItems.length; m2++) {
        var item = colItems[m2];
        var txt = item.text.trim();
        if (/^(?:上午|下午|晚上|中午|早晨)$/.test(txt)) { curBlock = null; continue; }

        var prev = curBlock ? curBlock.lastY : null;
        var gap2 = prev === null ? 0 : (prev - item.y);

        // 是否该开新的一格，取决于两点：
        //  1) 间距明显变大（课与课之间通常留有空行）
        //  2) 当前行看起来是「一门新课的课名」——课程名不带括号、不以 / 或「课备注」开头，
        //     而同一格的其余行总是「(编号)」「(N-M节)…」「课备注:/学分:…」这类形态。
        // 只看间距会把「上一门的学分行」和「下一门的课名」误并（实测间距 14.4 与 13.6 难分），
        // 加上形态判断就能稳定切开。
        var looksLikeName = isCourseNameLike(txt);
        // 断格规则：
        //  - 间距超过 MERGE_GAP（明显空行）→ 必断
        //  - 出现新的「课名」且当前块里已有课名 → 断（这是下一门课的开头）
        //  - 仅「像课名」但当前块还没有课名 → 不断（它就是本门的课名）
        var newBlock = !curBlock || gap2 > MERGE_GAP ||
          (looksLikeName && curBlock.hasName && gap2 > MIN_BREAK_GAP);
        if (newBlock) {
          curBlock = { texts: [txt], lastY: item.y, hasName: looksLikeName };
          blocks.push(curBlock);
        } else {
          curBlock.texts.push(txt);
          curBlock.lastY = item.y;
          if (looksLikeName) curBlock.hasName = true;
        }
      }
      for (var b2 = 0; b2 < blocks.length; b2++) {
        if (!blocks[b2].texts.length) continue;
        var blockText = blocks[b2].texts.join(' ');
        // 一个格子里可能并排/竖排多门课，拆成独立行交给解析引擎
        var pieces = splitCourses(blockText);
        for (var p2 = 0; p2 < pieces.length; p2++) {
          if (!pieces[p2]) continue;
          out.push({ day: dayOfCol[c4] || null, text: pieces[p2] });
        }
      }
    }
    return out;
  }

  /**
   * 把一个格子里的文字拆成「每门课一行」。
   *
   * 课表一个格子里可能堆着多门课（同一天同一时段连上两门），
   * 连在一起会让解析引擎只认出第一门。
   *
   * 切分依据：每门课都有且只有一个「(N-M节)」时间锚点，
   * 锚点前的文字（课名+课程编号）与锚点后的文字（周次+教师+学分）属于同一门课。
   * 于是「第 k 个锚点之前、第 k-1 个锚点之后」就是第 k 门课的完整描述。
   * 这比按课程编号切稳：编号有 (1)(GBK…) 这类多段形式，容易切偏。
   */
  function splitCourses(text) {
    var s = String(text || '').trim();
    if (!s) return [];

    // 时间锚点：(N-M节) / (N节) —— 有些课表写作「第N-M节」
    var re = /\(\s*(?:第)?\s*\d{1,2}\s*[-~至]?\s*\d{0,2}\s*节\s*\)/g;
    var marks = [];
    var m;
    while ((m = re.exec(s)) !== null) marks.push({ at: m.index, end: m.index + m[0].length });
    if (marks.length <= 1) return [s];

    // 每门课的形状是：课名 …课程编号… (N-M节) 周次/教师 学分备注
    // 也就是「锚点在中间」。所以第 k 门的起点 = 第 k-1 个锚点之后、
    // 终点 = 第 k 个锚点之后紧邻的「学分/备注」段结束处。
    // 由于学分备注紧跟在锚点后且以「学分:」结尾，用锚点作为切分点最稳：
    // 把所有锚点位置排好，把「锚点后的尾巴」归给本门课，
    // 而「锚点前的课名」归给下一个锚点所在的课 —— 即从本锚点前最后一个「课名起点」开始。
    var parts = [];
    for (var i = 0; i < marks.length; i++) {
      // 本门课的描述：从「上一个锚点的尾巴结束」到「本锚点的尾巴结束」
      var prevEnd = i === 0 ? 0 : marks[i - 1].end;
      // 本门的尾巴：锚点之后，直到下一个锚点前的「课名前缀」开始处。
      // 「课名前缀」= 下一个锚点之前、最后一个「学分:…」之后的文字。
      var nextAt = i + 1 < marks.length ? marks[i + 1].at : s.length;
      var head = s.slice(prevEnd, marks[i].at).trim();     // 课名 + 课程编号
      var tail = s.slice(marks[i].at, nextAt).trim();      // 节次 + 周次 + 教师 + 学分
      var seg = (head + ' ' + tail).trim();
      if (seg) parts.push(seg);
    }
    return parts;
  }

  /** 判断一行是否属于课表正文之外的内容（标题、学号、打印时间等） */
  function isNoiseRow(line) {
    var s = String(line).replace(/[\s\t]/g, '');
    if (!s) return true;
    // 学期/学号/课表标题/打印时间/统计脚注
    if (/学号|课表$|打印时间|^\d{4}-\d{4}学年|理论.*实验.*上机|制表/.test(s)) return true;
    return false;
  }

  /**
   * 主入口：把 pdf.js 的 items 还原成「表格文本」。
   *
   * @param {Array} items - textContent.items
   * @param {Object} [opts]
   * @param {boolean} [opts.tagDays=true] - 是否给每格补上「星期X」前缀。
   *   课表的星期写在表头，数据行里没有；而文本解析引擎是按行独立判断的，
   *   不给每格补星期，所有数据行都会被「缺少星期」丢掉。
   * @returns {{ text: string, rows: number, cols: number, isTable: boolean }}
   *   text 为制表符分列的文本；不是表格时退化为「每视觉行一行」的普通文本。
   */
  function layoutToText(items, opts) {
    var tagDays = !(opts && opts.tagDays === false);
    var norm = normalizeItems(items);
    if (!norm.length) return { text: '', rows: 0, cols: 0, isTable: false };

    var rows = groupRows(norm);
    var rowsOfCells = rows.map(splitCells);

    // 用「非空行」判断列数，避免大量单格行把列数压低
    var meaningful = rowsOfCells.filter(function (cs) { return cs.length >= 2; });
    var cols = findColumns(meaningful.length >= 2 ? meaningful : rowsOfCells, rows.length);

    var isTable = cols.length >= MIN_TABLE_COLS && meaningful.length >= 2;

    if (!isTable) {
      // 不是表格：退化成「每视觉行一行」，至少不比原来更差
      var plain = [];
      for (var r0 = 0; r0 < rowsOfCells.length; r0++) {
        if (!rowsOfCells[r0].length) continue;
        plain.push(rowsOfCells[r0].map(function (c) { return c.text; }).join(' '));
      }
      return { text: plain.join('\n'), rows: plain.length, cols: cols.length, isTable: false };
    }

    var found = tagDays ? findDayColumns(rowsOfCells, cols) : { map: {}, rowIndex: -1 };
    var dayOfCol = found.map;
    var headerIdx = found.rowIndex;

    // 只保留表头之后的行作为数据（表头之前的都是标题/学号之类的抬头信息）
    var startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;
    var dataRows = [];
    var clean = [];
    for (var d = startIdx; d < rowsOfCells.length; d++) {
      var plain = rows[d].items.map(function (it) { return it.str; }).join('');
      if (isNoiseRow(plain)) continue;
      clean.push(rowsOfCells[d]);
      dataRows.push({ y: rows[d].y, cells: rowsOfCells[d] });
    }

    var merged = mergeSegments(dataRows, cols, dayOfCol);

    // 表头行保留（解析引擎靠它识别星期列，也便于用户核对）
    var headerLine = '';
    if (headerIdx >= 0) {
      var harr = [];
      for (var hi = 0; hi < cols.length; hi++) harr.push('');
      for (var hc = 0; hc < rowsOfCells[headerIdx].length; hc++) {
        var hci = columnIndex(cols, rowsOfCells[headerIdx][hc].x);
        harr[hci] = harr[hci] ? harr[hci] + ' ' + rowsOfCells[headerIdx][hc].text : rowsOfCells[headerIdx][hc].text;
      }
      headerLine = harr.filter(function (x) { return x; }).join('\t');
    }

    var lines = [];
    if (headerLine) lines.push(headerLine);
    for (var m = 0; m < merged.length; m++) {
      var rec = merged[m];
      // 不加节次前缀：解析引擎会优先把行首的纯数字当成课程名，
      // 节次信息已经由格内的「(1-2节)」这类文本承载，足够解析。
      var text = rec.text;
      // 补星期，让每行自带定位信息（解析引擎按行独立判断）
      if (rec.day && DAY_CN[rec.day]) {
        // 行内已有星期词就不重复补（避免「星期二 星期二 …」）
        if (!/(?:星期|周)\s*[一二三四五六日天]/.test(text)) {
          text = '星期' + DAY_CN[rec.day] + ' ' + text;
        }
      }
      lines.push(text);
    }

    return {
      text: lines.join('\n'),
      rows: lines.length,
      cols: cols.length,
      isTable: true
    };
  }

  return {
    layoutToText: layoutToText,
    // 导出内部件供测试直接验证各步骤
    normalizeItems: normalizeItems,
    groupRows: groupRows,
    splitCells: splitCells,
    findColumns: findColumns
  };
});
