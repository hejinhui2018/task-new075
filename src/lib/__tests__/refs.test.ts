import { describe, expect, it } from 'vitest';
import { analyzeRefs, parseClauses, parseFootnotes } from '../refs';

describe('条款解析', () => {
  it('条号后紧跟冒号 → 定义；否则为引用', () => {
    const { defs, refs } = parseClauses([
      '合作要点第1条：双方应对数据严格保密。',
      '合作要点第2条：平台数据仅用于约定场景，保密要求见第1条。',
    ]);
    expect(defs.map((d) => d.name)).toEqual(['第1条', '第2条']);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: '第1条', paraIndex: 1, raw: '第1条' });
  });

  it('中文数字条号规范化为阿拉伯数字', () => {
    const { defs } = parseClauses(['第四条 保密义务。', '第四条：数据应加密存储。']);
    // 无冒号 → 引用；有冒号 → 定义，且名称规范化
    expect(defs.map((d) => d.name)).toEqual(['第4条']);
  });

  it('脚注定义与引用', () => {
    const { defs, refs } = parseFootnotes([
      '迁移窗口为30天（详见脚注1）。',
      '脚注1：迁移窗口按30天口径测算。',
    ]);
    expect(defs.map((d) => d.name)).toEqual(['脚注1']);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: '脚注1', paraIndex: 0, raw: '脚注1' });
  });
});

describe('引用迁移：重命名条款', () => {
  const base = [
    '合作要点第1条：双方应对合作中知悉的数据严格保密。',
    '合作要点第2条：平台数据仅用于约定的风控场景，保密要求见第1条。',
  ];
  // 法务重排：新增第1条要约，保密条款更名第2条，数据条款更名第3条，但引用没改。
  const renamed = [
    '合作要点第1条：本新闻稿不构成任何要约或承诺。',
    '合作要点第2条：双方应对合作中知悉的数据严格保密。',
    '合作要点第3条：平台数据仅用于约定的风控场景，保密要求见第1条。',
  ];

  it('检测到条款重命名（按内容指纹跟踪）', () => {
    const analysis = analyzeRefs(base, renamed);
    expect(analysis.renames.get('第1条')).toBe('第2条');
    expect(analysis.renames.get('第2条')).toBe('第3条');
  });

  it('仍写旧名称的引用判为待迁移，不悄悄绑定到同名新条款', () => {
    const analysis = analyzeRefs(base, renamed);
    const ref = analysis.refs.find((r) => r.kind === 'clause')!;
    expect(ref.status).toBe('stale-rename');
    expect(ref.migrateTo).toBe('第2条');
    // 关键：引用没有被静默解析到现在叫「第1条」的要约条款上
    expect(analysis.refs.some((r) => r.status === 'resolved' && r.name === '第1条')).toBe(false);
  });

  it('引用同步改名后 → 解析通过', () => {
    const fixed = [
      renamed[0],
      renamed[1],
      '合作要点第3条：平台数据仅用于约定的风控场景，保密要求见第2条。',
    ];
    const analysis = analyzeRefs(base, fixed);
    const ref = analysis.refs.find((r) => r.kind === 'clause')!;
    expect(ref.status).toBe('resolved');
    expect(ref.targetParaIndex).toBe(1);
  });
});

describe('引用目标：删除 / 重排 / 新增 / 同名', () => {
  const base = [
    '合作要点第1条：双方应对合作中知悉的数据严格保密。',
    '合作要点第2条：平台数据仅用于约定的风控场景，保密要求见第1条。',
  ];

  it('删除目标条款 → 引用悬空', () => {
    const merged = ['合作要点第2条：平台数据仅用于约定的风控场景，保密要求见第1条。'];
    const analysis = analyzeRefs(base, merged);
    const ref = analysis.refs.find((r) => r.kind === 'clause')!;
    expect(ref.status).toBe('unresolved');
  });

  it('段落重排不影响引用（按名称与内容跟踪，而非位置）', () => {
    const reordered = [
      '合作要点第2条：平台数据仅用于约定的风控场景，保密要求见第1条。',
      '合作要点第1条：双方应对合作中知悉的数据严格保密。',
    ];
    const analysis = analyzeRefs(base, reordered);
    const ref = analysis.refs.find((r) => r.kind === 'clause')!;
    expect(ref.status).toBe('resolved');
    expect(ref.targetParaIndex).toBe(1); // 目标条款现在位于第 2 段
  });

  it('新增引用能解析到现有目标', () => {
    const withNewRef = [...base, '补充说明：数据保留期限依据第2条执行。'];
    const analysis = analyzeRefs(base, withNewRef);
    const newRef = analysis.refs.find((r) => r.paraIndex === 2)!;
    expect(newRef.status).toBe('resolved');
    expect(newRef.targetParaIndex).toBe(1);
  });

  it('同名目标不唯一 → 歧义，绝不静默绑定', () => {
    const duplicated = [
      '合作要点第1条：双方应对合作中知悉的数据严格保密。',
      '附件第1条：技术指标以验收报告为准。',
      '合作要点第2条：平台数据仅用于约定的风控场景，保密要求见第1条。',
    ];
    const analysis = analyzeRefs(base, duplicated);
    const ref = analysis.refs.find((r) => r.kind === 'clause')!;
    expect(ref.status).toBe('ambiguous');
    expect(ref.targetParaIndex).toBeUndefined();
  });

  it('脚注目标缺失 → 悬空', () => {
    const baseFn = ['迁移窗口为30天（详见脚注1）。', '脚注1：迁移窗口按30天口径测算。'];
    const merged = ['迁移窗口为45天（详见脚注1）。'];
    const analysis = analyzeRefs(baseFn, merged);
    const ref = analysis.refs.find((r) => r.kind === 'footnote')!;
    expect(ref.status).toBe('unresolved');
  });
});
