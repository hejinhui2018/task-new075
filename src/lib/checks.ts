/**
 * 合并后的事实完整性验证。
 *
 * 输入是「事实模型」：合并稿事实 + 跨文档身份 + 引用分析；
 * 输出 FactIssue 列表（事实完整性冲突），每条带依赖链与四栏定位信息。
 *
 * 验证规则：
 * - 合计公式：合计类金额应等于其分项之和（分项数与「N项」声明一致）；
 * - 单位换算：金额/时长/比例归一化后比较，「120万元」与「1200000元」视为一致；
 * - 日期先后：交付/迁移类日期不应晚于宣布/发布类日期；
 * - 比例范围：覆盖率/占比类比例应在 0~100%（增长类除外）；
 * - 口径一致：派生值（脚注口径、合计）应与定义值一致，否则判为过期；
 * - 引用目标：悬空 / 歧义 / 重命名后待迁移。
 */

import {
  extractFacts,
  valueKey,
  valuesEqual,
  type Alignment,
  type Fact,
  type FactIdentity,
  buildIdentities,
} from './facts';
import type { ParaDiff } from './diff';
import type { MergeEntry, MergedItem } from './merge';
import { analyzeRefs, type RefAnalysis } from './refs';
import type { BaselineEntry, FactBaseline } from './storage';

export type DocName = 'base' | 'brand' | 'legal' | 'merged';

export const DOC_LABEL: Record<DocName, string> = {
  base: '底稿',
  brand: '品牌版',
  legal: '法务版',
  merged: '合并稿',
};

// ———————————————————— 事实模型 ————————————————————

export interface FactModel {
  mergedParagraphs: string[];
  mergedItems: MergedItem[];
  mergedFacts: Fact[];
  identities: FactIdentity[];
  refAnalysis: RefAnalysis;
}

function alignmentFromDiff(diff: ParaDiff): Alignment {
  const paraToBase: Array<number | undefined> = [];
  diff.ops.forEach((op, i) => {
    if (op.type !== 'delete' && 'modIndex' in op && op.modIndex !== undefined) {
      paraToBase[op.modIndex] = i;
    }
  });
  return { paraToBase };
}

/** 从三份文档 + 合并结果构建事实模型。 */
export function buildFactModel(
  base: string[],
  brand: string[],
  legal: string[],
  diffB: ParaDiff,
  diffL: ParaDiff,
  entries: MergeEntry[],
): FactModel {
  const mergedItems = entries.filter((e): e is MergedItem => e.kind === 'item');
  const mergedParagraphs = mergedItems.map((e) => e.text);

  const baseFacts = extractFacts(base);
  const brandFacts = extractFacts(brand);
  const legalFacts = extractFacts(legal);
  const mergedFacts = extractFacts(mergedParagraphs);

  const mergedAlign: Alignment = { paraToBase: mergedItems.map((e) => e.refs.base) };

  const identities = buildIdentities(baseFacts, [
    { doc: 'brand', facts: brandFacts, align: alignmentFromDiff(diffB) },
    { doc: 'legal', facts: legalFacts, align: alignmentFromDiff(diffL) },
    { doc: 'merged', facts: mergedFacts, align: mergedAlign },
  ]);

  const refAnalysis = analyzeRefs(base, mergedParagraphs);

  return { mergedParagraphs, mergedItems, mergedFacts, identities, refAnalysis };
}

// ———————————————————— 问题（事实完整性冲突） ————————————————————

export type FactIssueType =
  | 'sum-mismatch'
  | 'date-order'
  | 'percent-range'
  | 'value-inconsistent'
  | 'ref-unresolved'
  | 'ref-ambiguous'
  | 'ref-stale';

export interface IssueLocation {
  doc: DocName;
  paraIndex: number;
  /** 合并稿条目 id（doc 为 merged 时用于滚动定位）。 */
  entryId?: string;
}

export interface ChainNode {
  label: string;
  doc: DocName;
  paraIndex: number;
  raw: string;
  role: 'def' | 'derived' | 'ref';
  stale?: boolean;
  /** 引用迁移目标名称（ref-stale 时使用）。 */
  migrateTo?: string;
}

export interface FactIssue {
  id: string;
  type: FactIssueType;
  title: string;
  detail: string;
  /** 依赖链：定义值 → 派生值 / 引用。 */
  chain: ChainNode[];
  /** 受影响位置（四栏联动定位）。 */
  locations: IssueLocation[];
}

export const ISSUE_TYPE_LABEL: Record<FactIssueType, string> = {
  'sum-mismatch': '合计与分项不符',
  'date-order': '日期先后矛盾',
  'percent-range': '比例超出范围',
  'value-inconsistent': '口径不一致',
  'ref-unresolved': '引用目标缺失',
  'ref-ambiguous': '引用目标不唯一',
  'ref-stale': '引用待迁移',
};

// ———————————————————— 验证 ————————————————————

/** 合计类主题词。 */
const TOTAL_CONTEXT = /合计|总计|总额/;
/** 分项类主题词。 */
const PART_CONTEXT = /费用|预算|投入|成本/;
/** 分项与合计允许的最大段落距离（移动的段落可能插入其间）。 */
const SUM_PART_DISTANCE = 2;

const DATE_ORDER_RULES: Array<{ before: RegExp; after: RegExp; label: string }> = [
  { before: /交付|迁移|就绪/, after: /宣布|发布|上线|公测/, label: '交付/迁移应先于发布' },
];

function locationOf(model: FactModel, paraIndex: number): IssueLocation[] {
  const item = model.mergedItems[paraIndex];
  const locs: IssueLocation[] = [{ doc: 'merged', paraIndex, entryId: item?.id }];
  if (item) {
    if (item.refs.base !== undefined) locs.push({ doc: 'base', paraIndex: item.refs.base });
    if (item.refs.brand !== undefined) locs.push({ doc: 'brand', paraIndex: item.refs.brand });
    if (item.refs.legal !== undefined) locs.push({ doc: 'legal', paraIndex: item.refs.legal });
  }
  return locs;
}

/** 金额的可读格式化（元 → 万元 / 亿元）。 */
function formatYuan(yuan: number): string {
  if (yuan >= 1e8 && yuan % 1e8 === 0) return `${yuan / 1e8}亿元`;
  if (yuan >= 1e4 && yuan % 1e4 === 0) return `${yuan / 1e4}万元`;
  return `${yuan}元`;
}

function checkSums(model: FactModel): FactIssue[] {
  const issues: FactIssue[] = [];
  const facts = model.mergedFacts;
  const totals = facts.filter((f) => f.kind === 'amount' && TOTAL_CONTEXT.test(f.context));
  for (const total of totals) {
    const parts = facts.filter(
      (f) =>
        f.kind === 'amount' &&
        f !== total &&
        PART_CONTEXT.test(f.context) &&
        !TOTAL_CONTEXT.test(f.context) &&
        f.paraIndex >= total.paraIndex - SUM_PART_DISTANCE &&
        f.paraIndex <= total.paraIndex,
    );
    if (parts.length === 0) continue;
    const sum = parts.reduce((acc, f) => acc + (f.value as { yuan: number }).yuan, 0);
    const totalYuan = (total.value as { yuan: number }).yuan;
    // 「N项」声明的分项数量
    const declared = facts.find(
      (f) => f.kind === 'count' && f.paraIndex === total.paraIndex && (f.value as { unit: string }).unit === '项',
    );
    const declaredCount = declared ? (declared.value as { value: number }).value : undefined;
    const countMismatch = declaredCount !== undefined && declaredCount !== parts.length;
    if (sum === totalYuan && !countMismatch) continue;

    const detailParts = parts.map((p) => `${p.context} ${p.raw}`).join(' + ');
    issues.push({
      id: `sum:${total.paraIndex}:${total.slot}`,
      type: 'sum-mismatch',
      title: `「${total.context}」${total.raw} 与分项不符`,
      detail:
        `分项合计为 ${detailParts}（共 ${formatYuan(sum)}），与「${total.raw}」不一致。` +
        (countMismatch ? ` 分项数为 ${parts.length}，与「${declared!.raw}」不符。` : ''),
      chain: [
        ...parts.map((p): ChainNode => ({ label: `分项 · ${p.context}`, doc: 'merged', paraIndex: p.paraIndex, raw: p.raw, role: 'def' })),
        { label: `合计 · ${total.context}`, doc: 'merged', paraIndex: total.paraIndex, raw: total.raw, role: 'derived', stale: true },
      ],
      locations: locationOf(model, total.paraIndex),
    });
  }
  return issues;
}

function checkDateOrder(model: FactModel): FactIssue[] {
  const issues: FactIssue[] = [];
  const dates = model.mergedFacts.filter((f) => f.kind === 'date');
  for (const rule of DATE_ORDER_RULES) {
    const befores = dates.filter((f) => rule.before.test(f.context));
    const afters = dates.filter((f) => rule.after.test(f.context));
    for (const b of befores) {
      for (const a of afters) {
        const bv = b.value as { start: number };
        const av = a.value as { end: number };
        if (bv.start <= av.end) continue;
        issues.push({
          id: `date:${b.slot}:${a.slot}`,
          type: 'date-order',
          title: `「${b.context}」${b.raw} 晚于「${a.context}」${a.raw}`,
          detail: `${rule.label}，但当前「${b.context}」为 ${b.raw}，「${a.context}」为 ${a.raw}，先后矛盾。`,
          chain: [
            { label: `${b.context}（应在前）`, doc: 'merged', paraIndex: b.paraIndex, raw: b.raw, role: 'def', stale: true },
            { label: `${a.context}（应在后）`, doc: 'merged', paraIndex: a.paraIndex, raw: a.raw, role: 'def' },
          ],
          locations: [...locationOf(model, b.paraIndex), ...locationOf(model, a.paraIndex)],
        });
      }
    }
  }
  return issues;
}

function checkPercentRange(model: FactModel): FactIssue[] {
  const issues: FactIssue[] = [];
  for (const f of model.mergedFacts) {
    if (f.kind !== 'percent') continue;
    const ratio = (f.value as { ratio: number }).ratio;
    const isGrowth = /增长|提升|提高/.test(f.context);
    if (ratio <= 1 || isGrowth) continue;
    issues.push({
      id: `percent:${f.slot}:${f.paraIndex}`,
      type: 'percent-range',
      title: `「${f.context}」${f.raw} 超出合理范围`,
      detail: `「${f.context}」为 ${(ratio * 100).toFixed(1)}%，超过 100%，请核实是否笔误。`,
      chain: [{ label: f.context, doc: 'merged', paraIndex: f.paraIndex, raw: f.raw, role: 'def', stale: true }],
      locations: locationOf(model, f.paraIndex),
    });
  }
  return issues;
}

function checkConsistency(model: FactModel): FactIssue[] {
  const issues: FactIssue[] = [];
  // 同一 slot（同一承诺）在合并稿多处出现且取值不一 → 派生值过期。
  const bySlot = new Map<string, Fact[]>();
  for (const f of model.mergedFacts) {
    bySlot.set(f.slot, [...(bySlot.get(f.slot) ?? []), f]);
  }
  for (const [slot, group] of bySlot) {
    if (group.length < 2) continue;
    const defs = group.filter((f) => f.role === 'def');
    const derived = group.filter((f) => f.role === 'derived');
    if (defs.length === 0 || derived.length === 0) continue;
    const current = defs[0];
    const stale = derived.filter((f) => !valuesEqual(f.value, current.value));
    if (stale.length === 0) continue;
    issues.push({
      id: `incons:${slot}`,
      type: 'value-inconsistent',
      title: `「${current.context}」口径不一致：正文 ${current.raw} vs ${stale.map((s) => s.raw).join('、')}`,
      detail: `正文定义值已更新为 ${current.raw}，但派生表述（脚注/合计口径）仍为旧值，需要同步。`,
      chain: [
        { label: `正文定义 · ${current.context}`, doc: 'merged', paraIndex: current.paraIndex, raw: current.raw, role: 'def' },
        ...stale.map((s): ChainNode => ({ label: `派生表述 · ${s.context}`, doc: 'merged', paraIndex: s.paraIndex, raw: s.raw, role: 'derived', stale: true })),
      ],
      locations: [
        ...locationOf(model, current.paraIndex),
        ...stale.flatMap((s) => locationOf(model, s.paraIndex)),
      ],
    });
  }
  return issues;
}

function checkRefs(model: FactModel): FactIssue[] {
  const issues: FactIssue[] = [];
  for (const ref of model.refAnalysis.refs) {
    if (ref.status === 'resolved') continue;
    const base: Omit<FactIssue, 'type' | 'title' | 'detail'> = {
      id: `ref:${ref.kind}:${ref.name}:${ref.paraIndex}`,
      chain: [
        {
          label: `引用 · ${ref.name}`,
          doc: 'merged',
          paraIndex: ref.paraIndex,
          raw: ref.raw,
          role: 'ref',
          stale: true,
          migrateTo: ref.migrateTo,
        },
      ],
      locations: locationOf(model, ref.paraIndex),
    };
    if (ref.status === 'unresolved') {
      issues.push({
        ...base,
        type: 'ref-unresolved',
        title: `「${ref.raw}」指向的${ref.kind === 'clause' ? '条款' : '脚注'}不存在`,
        detail: `合并稿中引用了「${ref.name}」，但当前文档没有该${ref.kind === 'clause' ? '条款' : '脚注'}的定义（可能已被删除或改名）。`,
      });
    } else if (ref.status === 'ambiguous') {
      issues.push({
        ...base,
        type: 'ref-ambiguous',
        title: `「${ref.raw}」有多个同名目标`,
        detail: `文档中存在多个「${ref.name}」定义，引用不会自动绑定到其中任何一个，请消歧。`,
      });
    } else if (ref.status === 'stale-rename') {
      issues.push({
        ...base,
        type: 'ref-stale',
        title: `「${ref.raw}」应迁移为「${ref.migrateTo}」`,
        detail: `引用原指向的条款已更名为「${ref.migrateTo}」，而「${ref.name}」现在是另一份内容的名称；引用不会悄悄绑定到同名目标。`,
        chain: [
          ...base.chain,
          {
            label: `现目标 · ${ref.name}（内容已变）`,
            doc: 'merged',
            paraIndex: ref.targetParaIndex ?? ref.paraIndex,
            raw: ref.name,
            role: 'def',
          },
        ],
      });
    }
  }
  return issues;
}

/** 运行全部验证规则。 */
export function validateFacts(model: FactModel): FactIssue[] {
  return [
    ...checkSums(model),
    ...checkDateOrder(model),
    ...checkPercentRange(model),
    ...checkConsistency(model),
    ...checkRefs(model),
  ];
}

// ———————————————————— 比较基线 ————————————————————

/** 把当前合并稿中的事实值快照为比较基线。 */
export function snapshotBaseline(model: FactModel, savedAt: string): FactBaseline {
  const entries: BaselineEntry[] = [];
  for (const identity of model.identities) {
    const merged = identity.occurrences.merged;
    if (!merged) continue;
    entries.push({
      id: identity.id,
      slot: identity.slot,
      kind: identity.kind,
      raw: merged.raw,
      valueKey: valueKey(merged.value),
    });
  }
  return { savedAt, entries };
}

/** 当前合并稿事实值相对基线有变化的身份 id 集合。 */
export function diffBaseline(model: FactModel, baseline: FactBaseline): Set<string> {
  const baseById = new Map(baseline.entries.map((e) => [e.id, e]));
  const changed = new Set<string>();
  for (const identity of model.identities) {
    const merged = identity.occurrences.merged;
    const snap = baseById.get(identity.id);
    if (!snap || !merged) continue;
    if (valueKey(merged.value) !== snap.valueKey) changed.add(identity.id);
  }
  return changed;
}
