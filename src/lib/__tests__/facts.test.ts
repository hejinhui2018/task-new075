import { describe, expect, it } from 'vitest';
import { parseChineseNumber } from '../cnnum';
import {
  buildIdentities,
  extractFacts,
  valueKey,
  valuesEqual,
  type Alignment,
  type Fact,
} from '../facts';

const factsOf = (text: string) => extractFacts([text]);
const only = (text: string): Fact => {
  const facts = factsOf(text);
  expect(facts).toHaveLength(1);
  return facts[0];
};

describe('中文数字解析', () => {
  it('基本数词', () => {
    expect(parseChineseNumber('三')).toBe(3);
    expect(parseChineseNumber('十二')).toBe(12);
    expect(parseChineseNumber('二十')).toBe(20);
    expect(parseChineseNumber('二十五')).toBe(25);
    expect(parseChineseNumber('一百')).toBe(100);
    expect(parseChineseNumber('一百二十')).toBe(120);
    expect(parseChineseNumber('三千五')).toBe(3005);
    expect(parseChineseNumber('两')).toBe(2);
  });

  it('万 / 亿节权', () => {
    expect(parseChineseNumber('两万')).toBe(20000);
    expect(parseChineseNumber('五千')).toBe(5000);
    expect(parseChineseNumber('一百二十万')).toBe(1200000);
    expect(parseChineseNumber('一亿两千万')).toBe(120000000);
  });

  it('非数词返回 null', () => {
    expect(parseChineseNumber('')).toBeNull();
    expect(parseChineseNumber('第条')).toBeNull();
    expect(parseChineseNumber('abc')).toBeNull();
  });
});

describe('事实抽取：金额', () => {
  it('阿拉伯数字与中文数字，归一到元', () => {
    const a = factsOf('三项费用合计120万元，由双方分担。').find((f) => f.kind === 'amount')!;
    expect(a.value).toEqual({ kind: 'amount', yuan: 1200000 });
    const b = only('每年投入不少于五千万元。');
    expect(b.value).toEqual({ kind: 'amount', yuan: 50000000 });
    const c = only('违约金1.5亿元。');
    expect(c.value).toEqual({ kind: 'amount', yuan: 150000000 });
  });

  it('单位换算等价：120万元 与 1200000元 视为同一值', () => {
    const wan = only('合计120万元。');
    const yuan = only('合计1200000元。');
    expect(valuesEqual(wan.value, yuan.value)).toBe(true);
    expect(valueKey(wan.value)).toBe(valueKey(yuan.value));
  });

  it('单位换算不一致能被区分', () => {
    const a = only('合计120万元。');
    const b = only('合计150万元。');
    expect(valuesEqual(a.value, b.value)).toBe(false);
  });
});

describe('事实抽取：比例 / 日期 / 时长 / 数量', () => {
  it('比例归一到 0~1', () => {
    expect(only('覆盖率达到99.9%。').value).toEqual({ kind: 'percent', ratio: 0.999 });
    expect(only('占比百分之三十。').value).toEqual({ kind: 'percent', ratio: 0.3 });
  });

  it('日期：完整日期 / 季度 / 月份', () => {
    const d = only('发布会定于2026年9月10日举行。');
    expect(d.value).toMatchObject({ kind: 'date', year: 2026, month: 9, day: 10 });
    const q = only('平台将于2026年第四季度开放公测。');
    expect(q.value).toMatchObject({ kind: 'date', year: 2026, start: 20261001, end: 20261231 });
    const m = only('统计截至2026年9月。');
    expect(m.value).toMatchObject({ kind: 'date', year: 2026, month: 9, day: null });
  });

  it('时长归一到天', () => {
    expect(only('迁移窗口为30天。').value).toEqual({ kind: 'duration', days: 30 });
    expect(only('交付周期两周。').value).toEqual({ kind: 'duration', days: 14 });
    expect(only('未来三年持续投入。').value).toEqual({ kind: 'duration', days: 1095 });
    expect(only('五个工作日内响应。').value).toEqual({ kind: 'duration', days: 5 });
  });

  it('年份不是时长', () => {
    // 「2018年」是公司成立年份，不应被抽成 2018*365 天的时长
    const facts = factsOf('星澜科技成立于2018年，专注数据加密。');
    expect(facts.filter((f) => f.kind === 'duration')).toHaveLength(0);
  });

  it('数量保留单位', () => {
    expect(only('首批覆盖十二家分行。').value).toEqual({ kind: 'count', value: 12, unit: '家' });
    expect(only('预计覆盖一百家机构。').value).toEqual({ kind: 'count', value: 100, unit: '家' });
  });
});

describe('事实身份：语义槽位', () => {
  it('相同数字出现在不同承诺中 → 不同身份，不按文本值误配', () => {
    const facts = extractFacts(['平台将在30天内完成交付，退款也将在30天内到账。']);
    expect(facts).toHaveLength(2);
    const slots = facts.map((f) => f.slot);
    expect(slots[0]).not.toBe(slots[1]);
    // 一个属于「交付」承诺，一个属于「退款」承诺
    expect(slots.some((s) => s.startsWith('交付'))).toBe(true);
    expect(slots.some((s) => s.startsWith('退款'))).toBe(true);
  });

  it('同段多个同类事实按主题词消歧（平台开发费用 / 安全审计费用）', () => {
    const facts = factsOf('项目预算包括平台开发费用60万元、安全审计费用35万元与年度运维费用25万元。');
    expect(facts).toHaveLength(3);
    const bySlot = new Map(facts.map((f) => [f.slot, f]));
    expect(bySlot.get('平台开发费用:amount')?.raw).toBe('60万元');
    expect(bySlot.get('安全审计费用:amount')?.raw).toBe('35万元');
    expect(bySlot.get('年度运维费用:amount')?.raw).toBe('25万元');
  });

  it('删掉中间分项后，其余分项身份不变（不错位）', () => {
    const full = factsOf('项目预算包括平台开发费用60万元、安全审计费用35万元与年度运维费用25万元。');
    const reduced = factsOf('项目预算包括平台开发费用60万元与年度运维费用25万元。');
    const reducedSlots = new Set(reduced.map((f) => f.slot));
    expect(reducedSlots.has('平台开发费用:amount')).toBe(true);
    expect(reducedSlots.has('年度运维费用:amount')).toBe(true);
    expect(reducedSlots.has('安全审计费用:amount')).toBe(false);
    // 值也与完整版中的同 slot 事实一致
    for (const f of reduced) {
      const counterpart = full.find((g) => g.slot === f.slot);
      expect(counterpart).toBeDefined();
      expect(valuesEqual(f.value, counterpart!.value)).toBe(true);
    }
  });

  it('合计 / 脚注段落中的事实标记为派生值', () => {
    const total = factsOf('三项费用合计120万元。').find((f) => f.kind === 'amount')!;
    expect(total.role).toBe('derived');
    const note = extractFacts(['脚注1：迁移窗口按30天口径测算。'])[0];
    expect(note.role).toBe('derived');
    const body = only('迁移窗口为45天。');
    expect(body.role).toBe('def');
  });
});

describe('跨版本身份匹配', () => {
  const base = ['迁移窗口为30天。', '退款期限为30天。'];
  const brand = ['迁移窗口为45天。', '退款期限为30天。'];

  it('同一承诺在不同版本中是同一身份；值变化被跟踪', () => {
    const baseFacts = extractFacts(base);
    const brandFacts = extractFacts(brand);
    const align: Alignment = { paraToBase: [0, 1] };
    const identities = buildIdentities(baseFacts, [{ doc: 'brand', facts: brandFacts, align }]);
    expect(identities).toHaveLength(2);
    const delivery = identities.find((i) => i.slot.startsWith('交付') || i.slot.startsWith('迁移') || i.slot.startsWith('窗口'));
    expect(delivery).toBeDefined();
    expect(delivery!.occurrences.base?.raw).toBe('30天');
    expect(delivery!.occurrences.brand?.raw).toBe('45天');
    // 退款承诺身份独立，不受交付改值影响
    const refund = identities.find((i) => i.slot.startsWith('退款'));
    expect(refund!.occurrences.brand?.raw).toBe('30天');
  });

  it('身份与数值无关：同 slot 不同值仍是同一身份', () => {
    const a = extractFacts(['合计120万元。']);
    const b = extractFacts(['合计85万元。']);
    const identities = buildIdentities(a, [{ doc: 'brand', facts: b, align: { paraToBase: [0] } }]);
    expect(identities).toHaveLength(1);
    expect(identities[0].occurrences.base?.raw).toBe('120万元');
    expect(identities[0].occurrences.brand?.raw).toBe('85万元');
  });
});
