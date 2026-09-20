import { describe, expect, it } from 'vitest';
import { mergeDocuments, type Resolution } from '../merge';
import {
  SAMPLE_FACTS_BASE,
  SAMPLE_FACTS_BRAND,
  SAMPLE_FACTS_LEGAL,
  SAMPLE_BASE,
  SAMPLE_BRAND,
  SAMPLE_LEGAL,
} from '../sample';
import { splitParagraphs } from '../text';
import {
  applyCandidateToDocs,
  effectiveAcks,
  verifyFacts,
  type Docs,
  type FactIssue,
} from '../verify';

const P = splitParagraphs;

function run(base: string, brand: string, legal: string, resolutions: Record<string, Resolution> = {}) {
  const paras = { base: P(base), brand: P(brand), legal: P(legal) };
  const entries = mergeDocuments(paras.base, paras.brand, paras.legal, resolutions);
  const report = verifyFacts(paras, entries);
  return { paras, entries, report };
}

const issuesOf = (report: ReturnType<typeof verifyFacts>, kind: FactIssue['kind']) =>
  report.issues.filter((i) => i.kind === kind);

describe('合计公式校核', () => {
  const base = ['项目预算：设计费 50 万元、开发费 40 万元、测试费 30 万元，费用合计 120 万元。'];

  it('合计正确时无问题', () => {
    const { report } = run(base[0], base[0], base[0]);
    expect(issuesOf(report, 'sum-mismatch')).toHaveLength(0);
  });

  it('删掉一项费用后合计未更新 → 合计不符，依赖链标出被删项', () => {
    const legal = '项目预算：设计费 50 万元、开发费 40 万元，费用合计 120 万元。';
    const { report } = run(base[0], base[0], legal);
    const issues = issuesOf(report, 'sum-mismatch');
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.message).toContain('测试费');
    // 依赖链：合计 + 存活费用项 + 被删费用项
    const deleted = issue.chain.filter((c) => c.deleted);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].raw).toBe('30 万元');
    expect(deleted[0].label).toBe('测试费');
    // 同步候选：合计改为 90 万元
    expect(issue.candidates).toHaveLength(1);
    expect(issue.candidates[0].newRaw).toBe('90 万元');
    expect(issue.candidates[0].locked).toBe(false);
  });

  it('单位换算后合计正确（50 万元 + 500000 元 = 100 万元）', () => {
    const doc = '项目预算：设计费 50 万元、其他费用 500000 元，费用合计 100 万元。';
    const { report } = run(doc, doc, doc);
    expect(issuesOf(report, 'sum-mismatch')).toHaveLength(0);
  });

  it('费用项与合计分段落时也能校验', () => {
    const multi = ['项目预算如下。', '设计费 50 万元。', '开发费 40 万元。', '三项费用合计 90 万元。'];
    const ok = run(multi.join('\n\n'), multi.join('\n\n'), multi.join('\n\n'));
    expect(issuesOf(ok.report, 'sum-mismatch')).toHaveLength(0);
    const badLegal = ['项目预算如下。', '设计费 50 万元。', '三项费用合计 90 万元。'];
    const bad = run(multi.join('\n\n'), multi.join('\n\n'), badLegal.join('\n\n'));
    // 法务删了一段费用 → 合计 90 万 ≠ 存活 50 万
    const issues = issuesOf(bad.report, 'sum-mismatch');
    expect(issues).toHaveLength(1);
    expect(issues[0].chain.some((c) => c.deleted && c.raw === '40 万元')).toBe(true);
  });
});

describe('口径一致（跨段落同一事实）', () => {
  const base = ['平台退款期限为 30 天（注1）。', '注1：退款期限 30 天，以合同约定为准。'].join('\n\n');

  it('同一事实口径一致时无问题', () => {
    const { report } = run(base, base, base);
    expect(issuesOf(report, 'value-mismatch')).toHaveLength(0);
  });

  it('正文改成 45 天、脚注仍是 30 天 → 口径不一致', () => {
    const brand = ['平台退款期限为 45 天（注1）。', '注1：退款期限 30 天，以合同约定为准。'].join('\n\n');
    const { report, entries } = run(base, brand, base);
    const issues = issuesOf(report, 'value-mismatch');
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.title).toContain('退款期限');
    // 来源：底稿 30 天 / 品牌 45 天 / 法务 30 天 / 合并当前 45 天
    expect(issue.values).toMatchObject({ base: '30 天', brand: '45 天', legal: '30 天', merged: '45 天' });
    // 候选：把脚注同步为 45 天
    expect(issue.candidates).toHaveLength(1);
    expect(issue.candidates[0].oldRaw).toBe('30 天');
    expect(issue.candidates[0].newRaw).toBe('45 天');
    // 采用候选后重新验证：问题消失
    const docs: Docs = { base, brand, legal: base };
    const next = applyCandidateToDocs(docs, entries, issue.candidates[0]);
    expect(next).not.toBeNull();
    const rerun = run(next!.base, next!.brand, next!.legal);
    expect(issuesOf(rerun.report, 'value-mismatch')).toHaveLength(0);
  });

  it('相同数字在不同承诺中不互相误配', () => {
    const baseDoc = '退款期限为 30 天，公测周期为 30 天。';
    const brandDoc = '退款期限为 45 天，公测周期为 30 天。';
    const { report } = run(baseDoc, brandDoc, baseDoc);
    // 两个「30 天」属于不同承诺；品牌只改了退款期限 → 合并稿内部口径一致
    expect(issuesOf(report, 'value-mismatch')).toHaveLength(0);
  });

  it('法务锁定段落只提示不自动改写', () => {
    const baseDoc = [
      '平台数据留存期为 5 年。',
      '前瞻性声明：前瞻性陈述存在不确定性；数据留存期 5 年的承诺可能随监管要求调整。',
    ].join('\n\n');
    const brandDoc = [
      '平台数据留存期为 8 年。',
      '前瞻性声明：前瞻性陈述存在不确定性；数据留存期 5 年的承诺可能随监管要求调整。',
    ].join('\n\n');
    const { report, entries } = run(baseDoc, brandDoc, baseDoc);
    const issues = issuesOf(report, 'value-mismatch');
    expect(issues).toHaveLength(1);
    const lockedCand = issueCandidatesFor(issues[0], '5 年');
    expect(lockedCand).toBeDefined();
    expect(lockedCand!.locked).toBe(true);
    // 锁定候选不可应用
    const docs: Docs = { base: baseDoc, brand: brandDoc, legal: baseDoc };
    expect(applyCandidateToDocs(docs, entries, lockedCand!)).toBeNull();
  });
});

function issueCandidatesFor(issue: FactIssue, oldRaw: string) {
  return issue.candidates.find((c) => c.oldRaw === oldRaw);
}

describe('日期先后校核', () => {
  it('范围起点晚于终点 → 日期顺序矛盾', () => {
    const bad = '公测期自 2026 年 12 月 1 日至 11 月 1 日。';
    const { report } = run(bad, bad, bad);
    const issues = issuesOf(report, 'date-order');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('2026 年 12 月 1 日');
  });

  it('正常范围无问题（缺年份终点继承起点年份）', () => {
    const ok = '公测期自 2026 年 10 月 1 日至 11 月 1 日。';
    const { report } = run(ok, ok, ok);
    expect(issuesOf(report, 'date-order')).toHaveLength(0);
  });

  it('同主题开始/结束日期倒置 → 日期顺序矛盾', () => {
    const doc = ['公测开始日期 2026 年 10 月 1 日。', '公测结束日期 2026 年 9 月 1 日。'].join('\n\n');
    const { report } = run(doc, doc, doc);
    const issues = issuesOf(report, 'date-order');
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toContain('公测');
  });
});

describe('比例范围校核', () => {
  it('占比超过 100% → 比例越界', () => {
    const doc = '分行覆盖率达 105%。';
    const { report } = run(doc, doc, doc);
    expect(issuesOf(report, 'ratio-range')).toHaveLength(1);
  });

  it('同段各项占比之和超过 100% → 比例越界', () => {
    const doc = '华东区占比 60%，华南区占比 50%。';
    const { report } = run(doc, doc, doc);
    const issues = issuesOf(report, 'ratio-range');
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toContain('占比之和');
  });

  it('增长率可以超过 100%（不误报）', () => {
    const doc = '用户量同比增长 130%。';
    const { report } = run(doc, doc, doc);
    expect(issuesOf(report, 'ratio-range')).toHaveLength(0);
  });
});

describe('引用迁移', () => {
  const clauses = [
    '第 1 条：双方按季度对账。',
    '第 2 条：数据仅用于约定用途。',
    '第 3 条：违约方需整改。',
    '第 4 条：争议提交仲裁。',
  ];
  const refPara = '其他未尽事宜，详见第 4 条。';
  const base = [...clauses, refPara].join('\n\n');

  it('段落重排后引用目标漂移 → 候选跟随目标条款', () => {
    // 品牌把「第 2 条」移到「第 4 条」之后：目标条款从第 4 位变第 3 位
    const brand = [clauses[0], clauses[2], clauses[3], clauses[1], refPara].join('\n\n');
    const { report, entries } = run(base, brand, base);
    const issues = issuesOf(report, 'ref-stale');
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.message).toContain('第 3 位');
    expect(issue.candidates).toHaveLength(1);
    expect(issue.candidates[0].newRaw).toBe('第 3 条');
    // 采用候选后重新验证：引用恢复一致
    const docs: Docs = { base, brand, legal: base };
    const next = applyCandidateToDocs(docs, entries, issue.candidates[0]);
    expect(next).not.toBeNull();
    const rerun = run(next!.base, next!.brand, next!.legal);
    expect(issuesOf(rerun.report, 'ref-stale')).toHaveLength(0);
  });

  it('中文序号引用同样跟随（第四条 → 第三条）', () => {
    const baseCn = [...clauses, '其他未尽事宜，详见第四条。'].join('\n\n');
    const brand = [clauses[0], clauses[2], clauses[3], clauses[1], '其他未尽事宜，详见第四条。'].join('\n\n');
    const { report } = run(baseCn, brand, baseCn);
    const issues = issuesOf(report, 'ref-stale');
    expect(issues).toHaveLength(1);
    expect(issues[0].candidates[0].newRaw).toBe('第三条');
  });

  it('重命名条款（新条款插入导致重新编号）→ 引用迁移', () => {
    // 法务在原第 4 条前插入新条款，原条款顺延为第 5 位
    const legal = [
      clauses[0],
      clauses[1],
      clauses[2],
      '第 4 条：保密义务。',
      clauses[3],
      refPara,
    ].join('\n\n');
    const { report } = run(base, base, legal);
    const issues = issuesOf(report, 'ref-stale');
    expect(issues).toHaveLength(1);
    expect(issues[0].candidates[0].newRaw).toBe('第 5 条');
  });

  it('删除目标条款 → 引用失效，且不悄悄绑定到同名新条款', () => {
    // 法务删除原第 4 条，同时新增一个同名「第 4 条」条款
    const legal = [
      clauses[0],
      clauses[1],
      clauses[2],
      '第 4 条：新增的全新条款，内容完全不同。',
      refPara,
    ].join('\n\n');
    const { report } = run(base, base, legal);
    const broken = issuesOf(report, 'ref-broken');
    expect(broken).toHaveLength(1);
    expect(broken[0].message).toContain('未自动改指');
    expect(broken[0].candidates).toHaveLength(0);
    // 不应误判为已解决
    expect(issuesOf(report, 'ref-stale')).toHaveLength(0);
  });

  it('新增引用：可解析则通过，无法解析则报告', () => {
    const brandOk = [...clauses, refPara, '补充：违约责任详见第 3 条。'].join('\n\n');
    const ok = run(base, brandOk, base);
    expect(issuesOf(ok.report, 'ref-unresolved')).toHaveLength(0);

    const brandBad = [...clauses, refPara, '补充：其他事项详见第 9 条。'].join('\n\n');
    const bad = run(base, brandBad, base);
    const issues = issuesOf(bad.report, 'ref-unresolved');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('第 9 条');
  });
});

describe('脚注校核', () => {
  it('正文标记缺少定义 → 脚注缺失', () => {
    const doc = '平台退款期限为 30 天（注2）。';
    const { report } = run(doc, doc, doc);
    const issues = issuesOf(report, 'footnote-dangling');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('注2');
  });

  it('定义与标记呼应时无问题', () => {
    const doc = ['平台退款期限为 30 天（注1）。', '注1：退款期限 30 天，以合同约定为准。'].join('\n\n');
    const { report } = run(doc, doc, doc);
    expect(issuesOf(report, 'footnote-dangling')).toHaveLength(0);
    expect(issuesOf(report, 'footnote-orphan')).toHaveLength(0);
  });
});

describe('确认（ack）记录', () => {
  it('指纹一致才有效，内容变化后自动失效', () => {
    const bad = '公测期自 2026 年 12 月 1 日至 11 月 1 日。';
    const { report } = run(bad, bad, bad);
    const issue = report.issues[0];
    const acks = { [issue.ackKey]: issue.signature };
    expect(Object.keys(effectiveAcks(acks, report.issues))).toHaveLength(1);
    // 内容变化后（用户改了日期），旧确认失效
    const changed = '公测期自 2026 年 11 月 1 日至 10 月 1 日。';
    const rerun = run(changed, changed, changed);
    expect(Object.keys(effectiveAcks(acks, rerun.report.issues))).toHaveLength(0);
  });
});

describe('内置示例', () => {
  it('事实校核示例：合并后报告 5 项事实完整性问题', () => {
    const { report } = run(SAMPLE_FACTS_BASE, SAMPLE_FACTS_BRAND, SAMPLE_FACTS_LEGAL);
    expect(issuesOf(report, 'value-mismatch')).toHaveLength(2); // 退款期限 + 数据留存期
    expect(issuesOf(report, 'date-order')).toHaveLength(1); // 公测期 12 月 → 11 月
    expect(issuesOf(report, 'sum-mismatch')).toHaveLength(1); // 合计 120 万 ≠ 90 万
    expect(issuesOf(report, 'ref-stale')).toHaveLength(1); // 详见第 4 条 → 第 3 条
    expect(report.issues).toHaveLength(5);
    // 锁定候选：前瞻性声明中的留存期不同步改写
    const retention = issuesOf(report, 'value-mismatch').find((i) => i.title.includes('留存期'))!;
    expect(retention.candidates.some((c) => c.locked)).toBe(true);
    // 未锁定候选：脚注退款期限可同步
    const refund = issuesOf(report, 'value-mismatch').find((i) => i.title.includes('退款'))!;
    expect(refund.candidates).toHaveLength(1);
    expect(refund.candidates[0].locked).toBe(false);
    expect(refund.candidates[0].newRaw).toBe('45 天');
  });

  it('第一份示例（文本合并）不产生事实问题', () => {
    const { report } = run(SAMPLE_BASE, SAMPLE_BRAND, SAMPLE_LEGAL);
    expect(report.issues).toHaveLength(0);
  });
});
