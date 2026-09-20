import { describe, expect, it } from 'vitest';
import { buildFactModel, diffBaseline, snapshotBaseline, validateFacts } from '../checks';
import { diffParagraphs } from '../diff';
import { mergeDocuments, type Resolution } from '../merge';
import { FACT_SAMPLE_BASE, FACT_SAMPLE_BRAND, FACT_SAMPLE_LEGAL } from '../sample';
import { splitParagraphs } from '../text';

/** 用三份文档直接构造事实模型（无冲突场景，合并稿 = 底稿）。 */
function modelOf(base: string[], brand = base, legal = base) {
  const diffB = diffParagraphs(base, brand);
  const diffL = diffParagraphs(base, legal);
  const entries = mergeDocuments(base, brand, legal, {});
  return buildFactModel(base, brand, legal, diffB, diffL, entries);
}

const issuesOf = (base: string[], brand = base, legal = base) => validateFacts(modelOf(base, brand, legal));

describe('合计公式验证', () => {
  const detail = '项目预算包括平台开发费用60万元、安全审计费用35万元与年度运维费用25万元。';

  it('合计 = 分项之和 → 通过', () => {
    const issues = issuesOf([detail, '三项费用合计120万元，由双方分担。']);
    expect(issues.filter((i) => i.type === 'sum-mismatch')).toHaveLength(0);
  });

  it('删掉一项费用后合计未更新 → 合计与分项不符', () => {
    const issues = issuesOf(['项目预算包括平台开发费用60万元与年度运维费用25万元。', '三项费用合计120万元，由双方分担。']);
    const sum = issues.find((i) => i.type === 'sum-mismatch');
    expect(sum).toBeDefined();
    expect(sum!.detail).toContain('85');
    // 依赖链：两个分项 + 过期的合计
    expect(sum!.chain.filter((n) => n.role === 'def')).toHaveLength(2);
    expect(sum!.chain.some((n) => n.role === 'derived' && n.stale)).toBe(true);
  });

  it('分项数与「N项」声明不符也会被指出', () => {
    const issues = issuesOf(['项目预算包括平台开发费用60万元与年度运维费用25万元。', '三项费用合计85万元，由双方分担。']);
    const sum = issues.find((i) => i.type === 'sum-mismatch');
    expect(sum).toBeDefined();
    expect(sum!.detail).toContain('三项');
  });

  it('单位换算一致：合计1200000元 = 分项120万元 → 通过', () => {
    const issues = issuesOf([detail, '三项费用合计1200000元，由双方分担。']);
    expect(issues.filter((i) => i.type === 'sum-mismatch')).toHaveLength(0);
  });

  it('合计与分项距离不超过两段（中间隔了移动来的段落也能验证）', () => {
    const issues = issuesOf([detail, '本段为插播的说明文字，不含金额。', '三项费用合计120万元，由双方分担。']);
    expect(issues.filter((i) => i.type === 'sum-mismatch')).toHaveLength(0);
  });
});

describe('日期先后验证', () => {
  it('交付日期晚于发布日期 → 矛盾', () => {
    const issues = issuesOf([
      '【2026年9月10日 · 上海】双方今日联合宣布平台正式上线。',
      '平台预计于2026年9月15日完成数据迁移交付。',
    ]);
    const issue = issues.find((i) => i.type === 'date-order');
    expect(issue).toBeDefined();
    expect(issue!.chain[0].raw).toBe('2026年9月15日');
  });

  it('交付先于发布 → 通过', () => {
    const issues = issuesOf([
      '【2026年9月10日 · 上海】双方今日联合宣布平台正式上线。',
      '平台预计于2026年9月5日完成数据迁移交付。',
    ]);
    expect(issues.filter((i) => i.type === 'date-order')).toHaveLength(0);
  });
});

describe('比例范围验证', () => {
  it('覆盖率超过 100% → 超出合理范围', () => {
    const issues = issuesOf(['平台核心链路加密覆盖率达到120%。']);
    expect(issues.some((i) => i.type === 'percent-range')).toBe(true);
  });

  it('99.9% 与增长类超 100% → 通过', () => {
    expect(issuesOf(['平台核心链路加密覆盖率达到99.9%。']).filter((i) => i.type === 'percent-range')).toHaveLength(0);
    expect(issuesOf(['用户增长率达到150%。']).filter((i) => i.type === 'percent-range')).toHaveLength(0);
  });
});

describe('口径一致性验证（脚注与正文）', () => {
  const body = '平台预计于2026年9月5日完成数据迁移交付，迁移窗口为45天（详见脚注1）。';
  const note30 = '脚注1：迁移窗口按30天口径测算，自交付启动日起算。';
  const note45 = '脚注1：迁移窗口按45天口径测算，自交付启动日起算。';

  it('正文改为 45 天、脚注仍是 30 天 → 派生值过期', () => {
    const issues = issuesOf([body, note30]);
    const issue = issues.find((i) => i.type === 'value-inconsistent');
    expect(issue).toBeDefined();
    // 依赖链：正文定义值 → 过期的脚注口径
    const def = issue!.chain.find((n) => n.role === 'def');
    const stale = issue!.chain.find((n) => n.stale);
    expect(def!.raw).toBe('45天');
    expect(stale!.raw).toBe('30天');
    // 定位信息覆盖两个段落
    const paras = new Set(issue!.locations.map((l) => l.paraIndex));
    expect(paras.size).toBe(2);
  });

  it('脚注同步更新后 → 通过', () => {
    const issues = issuesOf([body, note45]);
    expect(issues.filter((i) => i.type === 'value-inconsistent')).toHaveLength(0);
  });

  it('单位不同但换算后一致（30天 与 三十天）→ 通过', () => {
    const bodyCn = '平台完成数据迁移交付，迁移窗口为三十天（详见脚注1）。';
    const issues = issuesOf([bodyCn, note30]);
    expect(issues.filter((i) => i.type === 'value-inconsistent')).toHaveLength(0);
  });
});

describe('内置事实示例：端到端', () => {
  const base = splitParagraphs(FACT_SAMPLE_BASE);
  const brand = splitParagraphs(FACT_SAMPLE_BRAND);
  const legal = splitParagraphs(FACT_SAMPLE_LEGAL);
  const diffB = diffParagraphs(base, brand);
  const diffL = diffParagraphs(base, legal);

  function sampleModel(resolutions: Record<string, Resolution>) {
    const entries = mergeDocuments(base, brand, legal, resolutions);
    return { model: buildFactModel(base, brand, legal, diffB, diffL, entries), entries };
  }

  it('默认状态：合计不符 + 比例超界 + 引用待迁移', () => {
    const { model } = sampleModel({});
    const types = validateFacts(model).map((i) => i.type);
    expect(types).toContain('sum-mismatch');
    expect(types).toContain('percent-range');
    expect(types).toContain('ref-stale');
    // 交付段冲突未解决 → 尚无日期/口径问题
    expect(types).not.toContain('date-order');
    expect(types).not.toContain('value-inconsistent');
  });

  it('解决交付段冲突（采用品牌版）后：日期矛盾与脚注口径过期浮现', () => {
    const { entries } = sampleModel({});
    const delivery = entries.find((e) => e.kind === 'conflict' && e.baseText.includes('迁移交付'))!;
    const { model } = sampleModel({ [delivery.id]: { choice: 'brand' } });
    const types = validateFacts(model).map((i) => i.type);
    expect(types).toContain('date-order');
    expect(types).toContain('value-inconsistent');
  });

  it('解决交付段冲突（采用法务版）后：口径一致、无日期矛盾', () => {
    const { entries } = sampleModel({});
    const delivery = entries.find((e) => e.kind === 'conflict' && e.baseText.includes('迁移交付'))!;
    const { model } = sampleModel({ [delivery.id]: { choice: 'legal' } });
    const types = validateFacts(model).map((i) => i.type);
    expect(types).not.toContain('date-order');
    expect(types).not.toContain('value-inconsistent');
  });
});

describe('比较基线', () => {
  it('基线快照后，值变化的身份被标出', () => {
    const base = ['迁移窗口为30天。', '退款期限为30天。'];
    const model1 = modelOf(base);
    const baseline = snapshotBaseline(model1, '2026-09-20T00:00:00.000Z');
    expect(baseline.entries.length).toBeGreaterThan(0);

    // 品牌版把交付改为 45 天
    const brand = ['迁移窗口为45天。', '退款期限为30天。'];
    const model2 = modelOf(base, brand, base);
    const changed = diffBaseline(model2, baseline);
    expect(changed.size).toBe(1);
    const changedId = [...changed][0];
    const identity = model2.identities.find((i) => i.id === changedId)!;
    expect(identity.occurrences.merged?.raw).toBe('45天');
  });

  it('无变化时基线对比为空', () => {
    const model = modelOf(['迁移窗口为30天。']);
    const baseline = snapshotBaseline(model, '2026-09-20T00:00:00.000Z');
    expect(diffBaseline(model, baseline).size).toBe(0);
  });
});
