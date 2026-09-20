import { describe, expect, it } from 'vitest';
import { buildFactModel, validateFacts } from '../checks';
import { diffParagraphs } from '../diff';
import { mergeDocuments } from '../merge';
import {
  applyCandidate,
  buildSyncCandidates,
  formatAmountLike,
  isLockedParagraph,
  toChineseNumber,
} from '../propagate';
import { FACT_SAMPLE_BASE, FACT_SAMPLE_BRAND, FACT_SAMPLE_LEGAL } from '../sample';
import { splitParagraphs } from '../text';

/** 构造模型 + 问题 + 候选的便捷管线。 */
function pipeline(base: string[], brand: string[], legal: string[], resolutions: Record<string, { choice: 'brand' | 'legal' | 'base' | 'custom'; text?: string }> = {}) {
  const diffB = diffParagraphs(base, brand);
  const diffL = diffParagraphs(base, legal);
  const entries = mergeDocuments(base, brand, legal, resolutions);
  const model = buildFactModel(base, brand, legal, diffB, diffL, entries);
  const issues = validateFacts(model);
  const candidates = buildSyncCandidates(issues, model, { brand, legal });
  return { model, issues, candidates };
}

describe('数值格式化', () => {
  it('toChineseNumber：计数语境', () => {
    expect(toChineseNumber(2)).toBe('两');
    expect(toChineseNumber(3)).toBe('三');
    expect(toChineseNumber(10)).toBe('十');
    expect(toChineseNumber(12)).toBe('十二');
    expect(toChineseNumber(25)).toBe('二十五');
    expect(toChineseNumber(120)).toBe('一百二十');
  });

  it('formatAmountLike：沿用模板的单位与数制', () => {
    expect(formatAmountLike(850000, '120万元')).toBe('85万元');
    expect(formatAmountLike(1200000, '合计120万。'.slice(2, 6))).toBe('120万');
    expect(formatAmountLike(855000, '120万元')).toBe('85.5万元');
    expect(formatAmountLike(120000000, '1.5亿元')).toBe('1.2亿元');
    expect(formatAmountLike(850000, '一百二十万元')).toBe('八十五万元');
  });
});

describe('同步更新候选', () => {
  const base = splitParagraphs(FACT_SAMPLE_BASE);
  const brand = splitParagraphs(FACT_SAMPLE_BRAND);
  const legal = splitParagraphs(FACT_SAMPLE_LEGAL);

  it('合计不符 → 候选把合计改为分项之和，并把「三项」改为「两项」', () => {
    const { candidates } = pipeline(base, brand, legal);
    const sumCandidates = candidates.filter((c) => c.issueId.startsWith('sum:'));
    expect(sumCandidates.length).toBeGreaterThan(0);
    const reps = sumCandidates[0].replacements;
    expect(reps).toContainEqual({ oldFragment: '120万元', newFragment: '85万元' });
    expect(reps).toContainEqual({ oldFragment: '三项', newFragment: '两项' });
  });

  it('解决上游事实（交付冲突采用品牌版）→ 生成脚注口径同步候选', () => {
    const entries = mergeDocuments(base, brand, legal, {});
    const delivery = entries.find((e) => e.kind === 'conflict' && e.baseText.includes('迁移交付'))!;
    const { issues, candidates } = pipeline(base, brand, legal, { [delivery.id]: { choice: 'brand' } });
    expect(issues.some((i) => i.type === 'value-inconsistent')).toBe(true);
    const footnoteCandidates = candidates.filter((c) => c.issueId.startsWith('incons:'));
    expect(footnoteCandidates.length).toBeGreaterThan(0);
    expect(footnoteCandidates[0].replacements).toEqual([{ oldFragment: '30天', newFragment: '45天' }]);
  });

  it('条款重命名 → 引用迁移候选（改引用，不改条款）', () => {
    const { candidates } = pipeline(base, brand, legal);
    const refCandidates = candidates.filter((c) => c.issueId.startsWith('ref:clause'));
    expect(refCandidates).toHaveLength(1);
    expect(refCandidates[0].doc).toBe('legal');
    expect(refCandidates[0].replacements).toEqual([{ oldFragment: '第1条', newFragment: '第2条' }]);
  });

  it('候选只投向与合并稿文本一致的来源段落（不误改品牌版自洽的条款）', () => {
    const { candidates } = pipeline(base, brand, legal);
    const refCandidates = candidates.filter((c) => c.issueId.startsWith('ref:clause'));
    // 品牌版条款布局与底稿一致（第1条=保密），其「见第1条」并无问题，不应收到候选
    expect(refCandidates.every((c) => c.doc !== 'brand')).toBe(true);
  });

  it('采用合计候选后重新验证：合计问题消失', () => {
    const first = pipeline(base, brand, legal);
    const candidate = first.candidates.find((c) => c.issueId.startsWith('sum:') && c.doc === 'brand')!;
    const nextBrand = applyCandidate(FACT_SAMPLE_BRAND, candidate);
    expect(nextBrand).toContain('两项费用合计85万元');
    // 双方文档都应用候选
    const candidateL = first.candidates.find((c) => c.issueId.startsWith('sum:') && c.doc === 'legal')!;
    const nextLegal = applyCandidate(FACT_SAMPLE_LEGAL, candidateL);
    const second = pipeline(base, splitParagraphs(nextBrand), splitParagraphs(nextLegal));
    expect(second.issues.filter((i) => i.type === 'sum-mismatch')).toHaveLength(0);
  });

  it('采用脚注同步候选后重新验证：口径一致', () => {
    const entries = mergeDocuments(base, brand, legal, {});
    const delivery = entries.find((e) => e.kind === 'conflict' && e.baseText.includes('迁移交付'))!;
    const resolutions = { [delivery.id]: { choice: 'brand' as const } };
    const first = pipeline(base, brand, legal, resolutions);
    const candidate = first.candidates.find((c) => c.issueId.startsWith('incons:') && c.doc === 'brand')!;
    const nextBrand = applyCandidate(FACT_SAMPLE_BRAND, candidate);
    const candidateL = first.candidates.find((c) => c.issueId.startsWith('incons:') && c.doc === 'legal')!;
    const nextLegal = applyCandidate(FACT_SAMPLE_LEGAL, candidateL);
    const second = pipeline(base, splitParagraphs(nextBrand), splitParagraphs(nextLegal), resolutions);
    expect(second.issues.filter((i) => i.type === 'value-inconsistent')).toHaveLength(0);
  });
});

describe('法务锁定段落', () => {
  it('锁定关键词识别', () => {
    expect(isLockedParagraph('前瞻性声明：本新闻稿包含的前瞻性陈述存在不确定性。')).toBe(true);
    expect(isLockedParagraph('免责声明：本平台不对间接损失承担责任。')).toBe(true);
    expect(isLockedParagraph('平台将于2026年第四季度开放公测。')).toBe(false);
  });

  it('锁定段落中的派生值只提示、不生成可采用的候选，且拒绝自动改写', () => {
    const base = [
      '迁移窗口为30天（详见脚注1）。',
      '脚注1：迁移窗口按30天口径测算。',
      '免责声明：迁移窗口按30天口径测算，不构成任何承诺。',
    ];
    const brand = [
      '迁移窗口为45天（详见脚注1）。',
      '脚注1：迁移窗口按30天口径测算。',
      '免责声明：迁移窗口按30天口径测算，不构成任何承诺。',
    ];
    const { issues, candidates } = pipeline(base, brand, base);
    expect(issues.some((i) => i.type === 'value-inconsistent')).toBe(true);
    // 免责声明段落命中的候选被锁定
    const locked = candidates.filter((c) => c.locked);
    expect(locked.length).toBeGreaterThan(0);
    // 应用锁定候选 → 文档不变（系统不得自动改写法务锁定段落）
    for (const c of locked) {
      const docText = c.doc === 'brand' ? brand.join('\n\n') : base.join('\n\n');
      expect(applyCandidate(docText, c)).toBe(docText);
    }
    // 未锁定的脚注候选仍可正常应用
    const unlocked = candidates.find((c) => !c.locked && c.doc === 'brand')!;
    const next = applyCandidate(brand.join('\n\n'), unlocked);
    expect(next).toContain('45天口径');
  });
});

describe('候选应用的防御性', () => {
  it('目标片段已不存在 → 文档不变，不误改', () => {
    const text = '第一段。\n\n第二段没有目标片段。';
    const next = applyCandidate(text, {
      id: 'x',
      issueId: 'x',
      doc: 'brand',
      paraIndex: 1,
      reason: '测试',
      replacements: [{ oldFragment: '不存在的片段', newFragment: '新内容' }],
      locked: false,
    });
    expect(next).toBe(text);
  });
});
