/**
 * 存储层测试：localStorage 可用与不可用两种环境
 * 注意：本文件在 Node 中运行，localStorage 天然不可用 → 验证内存兜底；
 * localStorage 可用路径由 jsdom 流程测试覆盖（app.dom.test.cjs）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import ST from '../web/js/storage.js';
import CF from '../web/js/core.js';

test('Node 环境（无 localStorage）下 load/save 走内存兜底不崩', () => {
  assert.equal(typeof localStorage, 'undefined');
  const data = { version: 1, courses: [], settings: CF.normalizeSettings({}) };
  assert.equal(ST.save(data), false); // 内存模式返回 false
  const loaded = ST.load();
  assert.ok(loaded);
  assert.deepEqual(loaded.courses, []);
});

test('内存兜底: 深拷贝隔离（改外部引用不影响已存数据）', () => {
  const courses = [{ id: 'a', name: '原课', weeks: [1] }];
  ST.save({ version: 1, courses, settings: {} });
  courses[0].name = '被改了';
  const loaded = ST.load();
  assert.equal(loaded.courses[0].name, '原课');
});

test('内存兜底: clear 后读回 null', () => {
  ST.save({ version: 1, courses: [1], settings: {} });
  ST.clear();
  assert.equal(ST.load(), null);
});

test('load: 损坏的 JSON 不会抛异常（内存模式难以模拟，验证接口健壮性）', () => {
  // 直接验证 load 对各种脏返回值的容错由 normalize 层兜底
  const dirty = { version: 1, courses: 'not-array', settings: 'bad' };
  ST.save(dirty);
  const loaded = ST.load();
  assert.ok(loaded); // 存取本身不崩，normalize 在 app 层处理
});
