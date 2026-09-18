import { describe, expect, it } from 'vitest';
import {
  finalText,
  mergeDocuments,
  sanitizeResolutions,
  summarize,
  type ConflictItem,
  type DeletedItem,
  type MergedItem,
} from '../merge';
import { SAMPLE_BASE, SAMPLE_BRAND, SAMPLE_LEGAL } from '../sample';
import { splitParagraphs } from '../text';

const conflicts = (entries: ReturnType<typeof mergeDocuments>) =>
  entries.filter((e): e is ConflictItem => e.kind === 'conflict');
const items = (entries: ReturnType<typeof mergeDocuments>) =>
  entries.filter((e): e is MergedItem => e.kind === 'item');
const deleteds = (entries: ReturnType<typeof mergeDocuments>) =>
  entries.filter((e): e is DeletedItem => e.kind === 'deleted');

describe('三方合并：自动采用', () => {
  const base = ['第一段保持不变。', '第二段等待修改。', '第三段也等待修改。', '第四段保持不变。'];

  it('只有品牌修改 → 采用品牌版', () => {
    const brand = [base[0], '第二段经过品牌改写。', base[2], base[3]];
    const entries = mergeDocuments(base, brand, base);
    expect(conflicts(entries)).toHaveLength(0);
    expect(items(entries).map((e) => e.text)).toEqual(brand);
    const edited = items(entries)[1];
    expect(edited.origin).toEqual({ kind: 'edit', by: 'brand' });
    expect(edited.baseText).toBe(base[1]);
  });

  it('只有法务修改 → 采用法务版', () => {
    const legal = [base[0], base[1], '第三段经过法务改写。', base[3]];
    const entries = mergeDocuments(base, base, legal);
    const edited = items(entries)[2];
    expect(edited.text).toBe('第三段经过法务改写。');
    expect(edited.origin).toEqual({ kind: 'edit', by: 'legal' });
  });

  it('双方改不同的段落 → 各自自动采用，无冲突', () => {
    const brand = [base[0], '第二段品牌改写。', base[2], base[3]];
    const legal = [base[0], base[1], '第三段法务改写。', base[3]];
    const entries = mergeDocuments(base, brand, legal);
    expect(conflicts(entries)).toHaveLength(0);
    expect(items(entries).map((e) => e.text)).toEqual([
      base[0],
      '第二段品牌改写。',
      '第三段法务改写。',
      base[3],
    ]);
  });

  it('双方改成一样 → 自动采用，标记双方一致', () => {
    const same = [base[0], '双方改成完全一致的内容。', base[2], base[3]];
    const entries = mergeDocuments(base, same, same);
    expect(conflicts(entries)).toHaveLength(0);
    expect(items(entries)[1].origin).toEqual({ kind: 'edit', by: 'both' });
  });

  it('一方删除、另一方未动 → 自动删除（保留痕迹）', () => {
    const brand = [base[0], base[2], base[3]];
    const entries = mergeDocuments(base, brand, base);
    expect(conflicts(entries)).toHaveLength(0);
    const del = deleteds(entries);
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ text: base[1], by: 'brand' });
    // 最终稿不包含被删段落
    expect(finalText(entries)).toBe([base[0], base[2], base[3]].join('\n\n'));
  });

  it('双方都删除 → 自动删除', () => {
    const shorter = [base[0], base[2], base[3]];
    const entries = mergeDocuments(base, shorter, shorter);
    expect(deleteds(entries)[0]).toMatchObject({ by: 'both' });
  });

  it('一方新增 → 自动采用并放在正确位置', () => {
    const brand = [base[0], '品牌新插入的一段。', base[1], base[2], base[3]];
    const entries = mergeDocuments(base, brand, base);
    const texts = items(entries).map((e) => e.text);
    expect(texts).toEqual(brand);
    expect(items(entries)[1].origin).toEqual({ kind: 'insert', by: 'brand' });
  });

  it('双方新增相同内容 → 自动去重为一条', () => {
    const withIns = [base[0], '双方不约而同加的免责声明。', base[1], base[2], base[3]];
    const entries = mergeDocuments(base, withIns, withIns);
    const ins = items(entries).filter((e) => e.origin.kind === 'insert');
    expect(ins).toHaveLength(1);
    expect(ins[0].origin).toEqual({ kind: 'insert', by: 'both' });
  });

  it('双方在同一位置新增不同内容 → 两条都保留', () => {
    const brand = [base[0], '品牌补充的一段。', base[1], base[2], base[3]];
    const legal = [base[0], '法务补充的另一段。', base[1], base[2], base[3]];
    const entries = mergeDocuments(base, brand, legal);
    expect(conflicts(entries)).toHaveLength(0);
    const texts = items(entries).map((e) => e.text);
    expect(texts).toContain('品牌补充的一段。');
    expect(texts).toContain('法务补充的另一段。');
  });
});

describe('三方合并：冲突分类', () => {
  const base = ['开头段。', '双方都想改的段落。', '结尾段。'];

  it('双方改同一段且不同 → edit-edit 冲突', () => {
    const brand = [base[0], '品牌的改法。', base[2]];
    const legal = [base[0], '法务的改法。', base[2]];
    const entries = mergeDocuments(base, brand, legal);
    const cs = conflicts(entries);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      type: 'edit-edit',
      baseIndex: 1,
      baseText: base[1],
      brandText: '品牌的改法。',
      legalText: '法务的改法。',
    });
  });

  it('品牌删除 + 法务修改 → delete-edit 冲突', () => {
    const brand = [base[0], base[2]];
    const legal = [base[0], '法务修改后的段落。', base[2]];
    const entries = mergeDocuments(base, brand, legal);
    const cs = conflicts(entries);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      type: 'delete-edit',
      brandText: undefined,
      legalText: '法务修改后的段落。',
    });
  });

  it('品牌修改 + 法务删除 → edit-delete 冲突', () => {
    const brand = [base[0], '品牌修改后的段落。', base[2]];
    const legal = [base[0], base[2]];
    const entries = mergeDocuments(base, brand, legal);
    const cs = conflicts(entries);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      type: 'edit-delete',
      brandText: '品牌修改后的段落。',
      legalText: undefined,
    });
  });

  it('双方各自整段重写同一段 → edit-edit 冲突，而非删除加新增', () => {
    const base = ['开头段。', '原来的段落会被彻底重写，几乎没有保留的字句。', '结尾段。'];
    const brand = [base[0], '品牌方完全重写的全新表述，强调传播亮点。', base[2]];
    const legal = [base[0], '法务方谨慎合规的另一套全新表述。', base[2]];
    const entries = mergeDocuments(base, brand, legal);
    const cs = conflicts(entries);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      type: 'edit-edit',
      baseIndex: 1,
      brandText: brand[1],
      legalText: legal[1],
    });
    // 不应出现删除记录或额外的新增条目
    expect(deleteds(entries)).toHaveLength(0);
    expect(items(entries)).toHaveLength(2);
  });

  it('一方整段重写 + 另一方删除 → delete-edit 冲突，而非静默保留', () => {
    const base = ['开头段。', '原来的段落会被彻底重写，几乎没有保留的字句。', '结尾段。'];
    const brand = [base[0], base[2]]; // 品牌删除
    const legal = [base[0], '法务方谨慎合规的另一套全新表述。', base[2]]; // 法务重写
    const entries = mergeDocuments(base, brand, legal);
    const cs = conflicts(entries);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      type: 'delete-edit',
      baseIndex: 1,
      brandText: undefined,
      legalText: legal[1],
    });
    expect(deleteds(entries)).toHaveLength(0);
  });

  it('双方整段重写成相同内容 → 自动采用，标记双方一致', () => {
    const base = ['开头段。', '原来的段落会被彻底重写，几乎没有保留的字句。', '结尾段。'];
    const same = [base[0], '双方不约而同写出的相同新段落。', base[2]];
    const entries = mergeDocuments(base, same, same);
    expect(conflicts(entries)).toHaveLength(0);
    expect(deleteds(entries)).toHaveLength(0);
    expect(items(entries)[1]).toMatchObject({
      text: same[1],
      origin: { kind: 'edit', by: 'both' },
    });
  });

  it('双方移动到不同位置 → move-move 冲突', () => {
    const base6 = ['甲段。', '乙段。', '丙段。', '丁段。', '戊段。', '己段。'];
    // 品牌把乙段移到文末；法务把乙段移到丁段之后
    const brand = [base6[0], base6[2], base6[3], base6[4], base6[5], base6[1]];
    const legal = [base6[0], base6[2], base6[3], base6[1], base6[4], base6[5]];
    const entries = mergeDocuments(base6, brand, legal);
    const cs = conflicts(entries);
    expect(cs).toHaveLength(1);
    expect(cs[0].type).toBe('move-move');
    expect(cs[0].move).toMatchObject({ fromBase: 1, brandAnchor: 6, legalAnchor: 4 });
  });
});

describe('三方合并：段落移动', () => {
  it('一方移动、另一方未动 → 保留新位置', () => {
    const base = ['甲段。', '乙段。', '丙段。', '丁段。'];
    const brand = [base[0], base[2], base[3], base[1]]; // 乙段移到文末
    const entries = mergeDocuments(base, brand, base);
    expect(conflicts(entries)).toHaveLength(0);
    const its = items(entries);
    expect(its.map((e) => e.text)).toEqual(brand);
    const moved = its[3];
    expect(moved.origin).toEqual({ kind: 'move', by: 'brand' });
    expect(moved.move).toMatchObject({ by: 'brand', fromBase: 1, anchor: 4 });
  });

  it('一方移动 + 另一方修改内容 → 新位置 + 新内容，不判删除加新增', () => {
    const base = ['甲段。', '关于公司：成立于2018年，服务两百家客户。', '丙段。', '丁段。'];
    // 品牌把「关于公司」移到文末（内容不动）
    const brand = [base[0], base[2], base[3], base[1]];
    // 法务在原地修改了「关于公司」的内容
    const legal = [base[0], '关于公司：成立于2018年，服务两百家客户（经审计）。', base[2], base[3]];
    const entries = mergeDocuments(base, brand, legal);

    // 不应产生冲突，也不应产生删除记录
    expect(conflicts(entries)).toHaveLength(0);
    expect(deleteds(entries)).toHaveLength(0);

    const its = items(entries);
    expect(its).toHaveLength(4);
    // 最后一条：法务的新内容 + 品牌的新位置
    const last = its[3];
    expect(last.text).toBe('关于公司：成立于2018年，服务两百家客户（经审计）。');
    expect(last.origin).toEqual({ kind: 'move-edit', movedBy: 'brand', editedBy: 'legal' });
    expect(last.move).toMatchObject({ by: 'brand', fromBase: 1, anchor: 4 });
    // 来源引用三方齐全，便于界面联动
    expect(last.refs.base).toBe(1);
    expect(last.refs.brand).toBe(3);
    expect(last.refs.legal).toBe(1);
  });

  it('一方移动 + 另一方删除 → 冲突', () => {
    const base = ['甲段。', '乙段。', '丙段。', '丁段。'];
    const brand = [base[0], base[2], base[3], base[1]]; // 品牌移动乙段
    const legal = [base[0], base[2], base[3]]; // 法务删除乙段
    const entries = mergeDocuments(base, brand, legal);
    const cs = conflicts(entries);
    expect(cs).toHaveLength(1);
    // 品牌移动（视为修改） vs 法务删除
    expect(cs[0].type).toBe('edit-delete');
    expect(cs[0].brandText).toBe('乙段。');
    expect(cs[0].legalText).toBeUndefined();
  });

  it('双方移动到同一位置且内容一致 → 自动合并为一次移动', () => {
    const base = ['甲段。', '乙段。', '丙段。', '丁段。'];
    const moved = [base[0], base[2], base[3], base[1]];
    const entries = mergeDocuments(base, moved, moved);
    expect(conflicts(entries)).toHaveLength(0);
    const its = items(entries);
    expect(its).toHaveLength(4);
    expect(its[3].origin).toEqual({ kind: 'move', by: 'both' });
  });
});

describe('人工解决冲突', () => {
  const base = ['开头段。', '有争议的段落。', '结尾段。'];
  const brand = [base[0], '品牌的改法。', base[2]];
  const legal = [base[0], '法务的改法。', base[2]];

  it('采用品牌版', () => {
    const entries = mergeDocuments(base, brand, legal, { b1: { choice: 'brand' } });
    expect(conflicts(entries)).toHaveLength(0);
    const resolved = items(entries)[1];
    expect(resolved.text).toBe('品牌的改法。');
    expect(resolved.origin).toEqual({ kind: 'resolved', choice: 'brand' });
    expect(resolved.resolution).toEqual({ choice: 'brand' });
  });

  it('采用法务版', () => {
    const entries = mergeDocuments(base, brand, legal, { b1: { choice: 'legal' } });
    expect(items(entries)[1].text).toBe('法务的改法。');
  });

  it('采用底稿原文', () => {
    const entries = mergeDocuments(base, brand, legal, { b1: { choice: 'base' } });
    expect(items(entries)[1].text).toBe(base[1]);
  });

  it('手动填写', () => {
    const entries = mergeDocuments(base, brand, legal, {
      b1: { choice: 'custom', text: '双方磋商后的最终措辞。' },
    });
    const resolved = items(entries)[1];
    expect(resolved.text).toBe('双方磋商后的最终措辞。');
    expect(resolved.origin).toEqual({ kind: 'resolved', choice: 'custom' });
  });

  it('删除-修改冲突：选择删除方 → 该段标记删除', () => {
    const brandDel = [base[0], base[2]];
    const legalEdit = [base[0], '法务修改后的段落。', base[2]];
    const entries = mergeDocuments(base, brandDel, legalEdit, { b1: { choice: 'brand' } });
    expect(conflicts(entries)).toHaveLength(0);
    const del = deleteds(entries);
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ by: 'brand', text: base[1] });
    expect(del[0].resolution).toEqual({ choice: 'brand' });
  });

  it('删除-修改冲突：选择修改方 → 保留修改内容', () => {
    const brandDel = [base[0], base[2]];
    const legalEdit = [base[0], '法务修改后的段落。', base[2]];
    const entries = mergeDocuments(base, brandDel, legalEdit, { b1: { choice: 'legal' } });
    expect(deleteds(entries)).toHaveLength(0);
    expect(items(entries)[1].text).toBe('法务修改后的段落。');
  });

  it('sanitizeResolutions 清理已不存在冲突的记录', () => {
    const withConflict = mergeDocuments(base, brand, legal);
    const cleaned = sanitizeResolutions(withConflict, {
      b1: { choice: 'brand' },
      b99: { choice: 'legal' },
    });
    expect(Object.keys(cleaned)).toEqual(['b1']);
  });
});

describe('内置示例：端到端合并', () => {
  const base = splitParagraphs(SAMPLE_BASE);
  const brand = splitParagraphs(SAMPLE_BRAND);
  const legal = splitParagraphs(SAMPLE_LEGAL);
  const entries = mergeDocuments(base, brand, legal);

  it('示例规模符合设计（10 / 9 / 11 段）', () => {
    expect(base).toHaveLength(10);
    expect(brand).toHaveLength(9);
    expect(legal).toHaveLength(11);
  });

  it('产生且仅产生 3 处冲突，类型正确', () => {
    const cs = conflicts(entries);
    expect(cs).toHaveLength(3);
    const byBase = new Map(cs.map((c) => [c.baseIndex, c]));
    // 第 4 段 CEO 引言：双方改法不同
    expect(byBase.get(3)?.type).toBe('edit-edit');
    // 第 6 段公测信息：品牌删除 vs 法务修改
    expect(byBase.get(5)?.type).toBe('delete-edit');
    expect(byBase.get(5)?.brandText).toBeUndefined();
    expect(byBase.get(5)?.legalText).toContain('小范围试点');
    // 第 8 段联合实验室：双方改法不同
    expect(byBase.get(7)?.type).toBe('edit-edit');
  });

  it('互不冲突的修改被自动采用', () => {
    const its = items(entries);
    expect(its.some((e) => e.origin.kind === 'edit' && 'by' in e.origin && e.origin.by === 'brand' && e.text.includes('旗舰级'))).toBe(true);
    expect(its.some((e) => e.origin.kind === 'edit' && 'by' in e.origin && e.origin.by === 'legal' && e.text.includes('数据安全法'))).toBe(true);
  });

  it('双方新增段落各自自动进入结果', () => {
    const its = items(entries);
    expect(its.some((e) => e.origin.kind === 'insert' && 'by' in e.origin && e.origin.by === 'brand' && e.text.includes('坚如磐石'))).toBe(true);
    expect(its.some((e) => e.origin.kind === 'insert' && 'by' in e.origin && e.origin.by === 'legal' && e.text.includes('前瞻性声明'))).toBe(true);
  });

  it('仅品牌删除的段落自动标记删除', () => {
    const del = deleteds(entries);
    expect(del).toHaveLength(1);
    expect(del[0].text).toContain('媒体沟通会');
    expect(del[0].by).toBe('brand');
  });

  it('移动 + 另一方修改：保留新位置与新内容，不错判删除加新增', () => {
    const its = items(entries);
    const moved = its.find((e) => e.origin.kind === 'move-edit');
    expect(moved).toBeDefined();
    // 新内容来自法务（带数据来源标注）
    expect(moved!.text).toContain('数据来源：公司2025年年度报告');
    expect(moved!.origin).toEqual({ kind: 'move-edit', movedBy: 'brand', editedBy: 'legal' });
    // 新位置：在结果末尾（媒体垂询之后）
    const idx = its.indexOf(moved!);
    const contactIdx = its.findIndex((e) => e.text.includes('媒体垂询'));
    expect(idx).toBeGreaterThan(contactIdx);
    // 不错判：该段没有对应的删除记录或冲突
    expect(deleteds(entries).some((e) => e.text.includes('关于星澜科技'))).toBe(false);
    expect(conflicts(entries).some((e) => e.baseText.includes('关于星澜科技'))).toBe(false);
  });

  it('条目顺序：底稿结构为主，移动与新增落位正确', () => {
    const kinds = entries.map((e) => (e.kind === 'conflict' ? `C${e.baseIndex}` : e.kind));
    expect(kinds).toEqual([
      'item', // §1 标题
      'item', // §2 品牌修改
      'item', // §3 法务修改
      'C3', // §4 冲突
      'item', // 品牌新增释义段
      'item', // §5
      'C5', // §6 冲突
      'deleted', // §7 品牌删除
      'C7', // §8 冲突
      'item', // §10 媒体垂询
      'item', // §9 移动+法务修改
      'item', // 法务新增免责声明
    ]);
  });

  it('全部解决后导出最终稿', () => {
    const resolved = mergeDocuments(base, brand, legal, {
      b3: { choice: 'legal' },
      b5: { choice: 'legal' },
      b7: { choice: 'brand' },
    });
    expect(conflicts(resolved)).toHaveLength(0);
    const summary = summarize(resolved);
    expect(summary.unresolved).toBe(0);
    expect(summary.resolved).toBe(3);

    const text = finalText(resolved);
    const finalParas = text.split('\n\n');
    expect(finalParas).toHaveLength(11); // 12 条结果 - 1 条已删除
    expect(finalParas[3]).toContain('应用于金融场景'); // CEO 引言采用法务版
    expect(finalParas[6]).toContain('小范围试点'); // 公测信息采用法务版
    expect(finalParas[7]).toContain('五千万元'); // 实验室采用品牌版
    expect(text).not.toContain('媒体沟通会'); // 已删除
    expect(text).not.toContain('开放公测，预计覆盖一百家机构'); // 底稿措辞未被采用
  });
});
