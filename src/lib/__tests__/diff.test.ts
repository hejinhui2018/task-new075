import { describe, expect, it } from 'vitest';
import { diffParagraphs } from '../diff';

const paras = (n: number, prefix = '段落') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}的内容`);

describe('diffParagraphs 基础操作', () => {
  it('完全一致 → 全部 keep', () => {
    const base = paras(3);
    const diff = diffParagraphs(base, [...base]);
    expect(diff.ops.map((o) => o.type)).toEqual(['keep', 'keep', 'keep']);
    expect(diff.inserts.every((s) => s.length === 0)).toBe(true);
  });

  it('原地修改 → modify', () => {
    const base = paras(3);
    const modified = [base[0], '段落2的内容，但经过改写调整。', base[2]];
    const diff = diffParagraphs(base, modified);
    expect(diff.ops[1]).toMatchObject({ type: 'modify', modIndex: 1 });
  });

  it('纯插入 → 落到正确的锚点槽位', () => {
    const base = paras(3);
    const modified = [base[0], '全新插入的一段。', base[1], base[2]];
    const diff = diffParagraphs(base, modified);
    expect(diff.ops.every((o) => o.type === 'keep')).toBe(true);
    expect(diff.inserts[1]).toHaveLength(1);
    expect(diff.inserts[1][0].text).toBe('全新插入的一段。');
  });

  it('纯删除 → delete', () => {
    const base = paras(3);
    const modified = [base[0], base[2]];
    const diff = diffParagraphs(base, modified);
    expect(diff.ops[1].type).toBe('delete');
  });

  it('文末插入 → 锚点为段落总数', () => {
    const base = paras(2);
    const modified = [...base, '结尾新增的一段。'];
    const diff = diffParagraphs(base, modified);
    expect(diff.inserts[2]).toHaveLength(1);
  });
});

describe('diffParagraphs 移动识别', () => {
  it('段落移到文末 → move，而不是 delete + insert', () => {
    const base = paras(4);
    const modified = [base[0], base[2], base[3], base[1]];
    const diff = diffParagraphs(base, modified);
    expect(diff.ops[1]).toMatchObject({ type: 'move', anchor: 4, modIndex: 3 });
    expect(diff.ops.filter((o) => o.type === 'delete')).toHaveLength(0);
    expect(diff.inserts.every((s) => s.length === 0)).toBe(true);
  });

  it('段落移到开头 → move，锚点为 0', () => {
    const base = paras(4);
    const modified = [base[3], base[0], base[1], base[2]];
    const diff = diffParagraphs(base, modified);
    expect(diff.ops[3]).toMatchObject({ type: 'move', anchor: 0 });
  });

  it('移动的同时修改内容 → 仍是 move（携带新文本）', () => {
    const base = paras(4);
    const moved = `${base[1]}，并补充了新的说明。`;
    const modified = [base[0], base[2], base[3], moved];
    const diff = diffParagraphs(base, modified);
    const op = diff.ops[1];
    expect(op.type).toBe('move');
    if (op.type === 'move') {
      expect(op.text).toBe(moved);
      expect(op.anchor).toBe(4);
    }
  });

  it('相邻两段互换 → 识别为移动而非全删全增', () => {
    const base = ['甲段落：关于公司介绍。', '乙段落：关于产品发布。', '丙段落：媒体联系方式。'];
    const modified = [base[0], base[2], base[1]];
    const diff = diffParagraphs(base, modified);
    const moveCount = diff.ops.filter((o) => o.type === 'move').length;
    const deleteCount = diff.ops.filter((o) => o.type === 'delete').length;
    expect(deleteCount).toBe(0);
    expect(moveCount).toBeGreaterThanOrEqual(1);
  });

  it('新闻稿式结尾互换：未动的联系方式段不应被误判为移动', () => {
    // 底稿 10 段，品牌版把第 9 段移到文末（第 10 段保持不动）。
    const base = paras(10, '第段');
    const modified = [
      base[0],
      '第段2的内容，经过品牌改写。',
      base[2],
      '第段4的内容，经过品牌改写。',
      '全新插入的释义段。',
      base[4],
      '第段8的内容，经过品牌改写。',
      base[9],
      base[8],
    ];
    const diff = diffParagraphs(base, modified);
    // 第 9 段（下标 8）应识别为移动到文末
    expect(diff.ops[8]).toMatchObject({ type: 'move', anchor: 10 });
    // 第 10 段（下标 9）应保持 keep
    expect(diff.ops[9].type).toBe('keep');
    // 删除的段落：第 6、7 段（下标 5、6）未配对 → delete
    expect(diff.ops[4].type).toBe('keep');
    expect(diff.ops[5].type).toBe('delete');
    expect(diff.ops[6].type).toBe('delete');
  });
});
