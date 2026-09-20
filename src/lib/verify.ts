/**
 * 事实完整性校核：在合并结果上验证承诺事实与交叉引用。
 *
 * 检查项：
 * - 口径一致（value-mismatch）：同一事实（同标签同类别）在正文/脚注等不同段落
 *   出现不同数值——如正文改成「45 天」而脚注仍是「30 天」；比较前先做单位换算。
 * - 合计公式（sum-mismatch）：「合计/总计」类派生值必须等于各费用项之和；
 *   费用项被删除而合计未更新时，依赖链会标出被删项。
 * - 日期先后（date-order）：「自 A 至 B」范围内 A 不得晚于 B；
 *   同主题的「开始/结束」日期不得倒置。
 * - 比例范围（ratio-range）：占比/覆盖率等不得超过 100%；
 *   同段各项「占比」之和不得超过 100%。
 * - 引用目标（ref-stale / ref-broken / ref-unresolved）：条款引用按底稿身份绑定，
 *   重命名、删除、段落重排后校验目标；未解析引用不会悄悄绑定到同名目标。
 * - 脚注（footnote-dangling / footnote-orphan）：标记与定义互相呼应。
 *
 * 每个问题携带：来源（底稿/品牌/法务/合并各版本值）、当前值、依赖链、
 * 受影响表述与同步更新候选。候选不会自动改写法务锁定段落；
 * 候选采用后（通过 applyCandidateToDocs 写回来源文档）全部关系自动重新验证。
 */

import {
  extractFacts,
  formatValueForRaw,
  isLegalLocked,
  matchFacts,
  numberToChinese,
  unitsCompatible,
  valuesEqual,
  LABEL_GROUP_THRESHOLD,
  type Fact,
} from './facts';
import { similarity } from './tokenize';
import {
  buildBaseBindings,
  extractClauses,
  extractFootnoteMarks,
  extractRefs,
  footnoteDefNo,
  type ClauseInfo,
  type RefInfo,
} from './refs';
import type { DeletedItem, MergeEntry, MergedItem } from './merge';
import { joinParagraphs, splitParagraphs } from './text';

export type IssueKind =
  | 'value-mismatch'
  | 'sum-mismatch'
  | 'date-order'
  | 'ratio-range'
  | 'ref-stale'
  | 'ref-broken'
  | 'ref-unresolved'
  | 'footnote-dangling'
  | 'footnote-orphan';

export type Severity = 'error' | 'warn' | 'info';

export interface ChainItem {
  entryId: string;
  label: string;
  raw: string;
  deleted?: boolean;
}

/** 来源各版本的表述（undefined 表示该版本无此段或无此事实）。 */
export interface VersionValues {
  base?: string;
  brand?: string;
  legal?: string;
  merged: string;
}

export interface SyncCandidate {
  id: string;
  entryId: string;
  /** 展示用描述，如「脚注『30 天』→『45 天』」。 */
  description: string;
  oldRaw: string;
  newRaw: string;
  /** 法务锁定段落：只提示，不自动改写。 */
  locked: boolean;
}

export interface FactIssue {
  id: string;
  kind: IssueKind;
  severity: Severity;
  title: string;
  message: string;
  /** 受影响条目（四栏联动高亮用）。 */
  entryIds: string[];
  primaryEntryId: string;
  /** 依赖链（合计 ← 费用项；引用 → 目标条款；正文 ↔ 脚注）。 */
  chain: ChainItem[];
  values?: VersionValues;
  candidates: SyncCandidate[];
  /** 确认（ack）用稳定键与内容指纹：内容变化后确认自动失效。 */
  ackKey: string;
  signature: string;
}

export interface FactReport {
  issues: FactIssue[];
  /** 合并稿中抽取到的事实数。 */
  factCount: number;
  clauseCount: number;
  refCount: number;
}

export interface VerifyInput {
  base: string[];
  brand: string[];
  legal: string[];
}

const SEVERITY: Record<IssueKind, Severity> = {
  'value-mismatch': 'error',
  'sum-mismatch': 'error',
  'ref-broken': 'error',
  'date-order': 'warn',
  'ratio-range': 'warn',
  'ref-stale': 'warn',
  'ref-unresolved': 'warn',
  'footnote-dangling': 'warn',
  'footnote-orphan': 'info',
};

const numEq = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/** 条目被修改过（非底稿原文直接保留）的来源类型。 */
const MODIFIED_ORIGINS = new Set(['edit', 'move-edit', 'resolved', 'insert']);

export function verifyFacts(paras: VerifyInput, entries: MergeEntry[]): FactReport {
  const issues: FactIssue[] = [];
  const counters = new Map<string, number>();
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const itemEntries = entries.filter((e): e is MergedItem => e.kind === 'item');
  const deletedEntries = entries.filter((e): e is DeletedItem => e.kind === 'deleted');

  const entryLocked = (entryId: string): boolean => {
    const entry = entryById.get(entryId);
    if (!entry || entry.refs.legal === undefined) return false;
    const text = paras.legal[entry.refs.legal];
    return text !== undefined && isLegalLocked(text);
  };

  const mkIssue = (partial: Omit<FactIssue, 'id' | 'severity'>): FactIssue => {
    const n = (counters.get(partial.kind) ?? 0) + 1;
    counters.set(partial.kind, n);
    return { ...partial, id: `fi-${partial.kind}-${n}`, severity: SEVERITY[partial.kind] };
  };

  const mkCandidate = (
    issueKind: IssueKind,
    entryId: string,
    oldRaw: string,
    newRaw: string,
    description: string,
  ): SyncCandidate => ({
    id: `cand-${issueKind}-${entryId}-${oldRaw}->${newRaw}`,
    entryId,
    description,
    oldRaw,
    newRaw,
    locked: entryLocked(entryId),
  });

  // —— 合并稿事实（仅正式条目；未解决冲突不参与，已删除条目只用于依赖链） ——
  const factsByEntry = new Map<string, Fact[]>();
  const mergedFacts: Fact[] = [];
  for (const e of itemEntries) {
    const fs = extractFacts(e.text, e.id);
    factsByEntry.set(e.id, fs);
    mergedFacts.push(...fs);
  }
  const deletedFacts: Fact[] = [];
  for (const e of deletedEntries) {
    const fs = extractFacts(e.text, e.id);
    factsByEntry.set(e.id, fs);
    deletedFacts.push(...fs);
  }

  const versionRaw = (side: keyof VerifyInput, idx: number | undefined, like: Fact): string | undefined => {
    if (idx === undefined) return undefined;
    const text = paras[side][idx];
    if (text === undefined) return undefined;
    const found = matchFacts([like], extractFacts(text, `tmp-${side}`)).find(([a]) => a !== undefined);
    return found?.[1]?.raw;
  };

  const versionValues = (fact: Fact): VersionValues => {
    const entry = entryById.get(fact.entryId);
    return {
      base: versionRaw('base', entry?.refs.base, fact),
      brand: versionRaw('brand', entry?.refs.brand, fact),
      legal: versionRaw('legal', entry?.refs.legal, fact),
      merged: fact.raw,
    };
  };

  // —— 1. 口径一致：同标签同类事实归并（并查集），组内数值必须一致 ——
  {
    const parent = mergedFacts.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let i = 0; i < mergedFacts.length; i++) {
      for (let j = i + 1; j < mergedFacts.length; j++) {
        const a = mergedFacts[i];
        const b = mergedFacts[j];
        if (!unitsCompatible(a, b)) continue;
        if (a.kind === 'date' && (a.yearless || b.yearless)) continue; // 缺年份日期不参与跨段比较
        const sim = a.labelKey === b.labelKey ? 1 : similarity(a.labelKey, b.labelKey);
        if (sim >= LABEL_GROUP_THRESHOLD) {
          const ra = find(i);
          const rb = find(j);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }
    const groups = new Map<number, Fact[]>();
    mergedFacts.forEach((f, i) => {
      const r = find(i);
      const arr = groups.get(r) ?? [];
      arr.push(f);
      groups.set(r, arr);
    });

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // 按数值聚类
      const clusters: Fact[][] = [];
      for (const f of group) {
        const hit = clusters.find((c) => valuesEqual(c[0], f));
        if (hit) hit.push(f);
        else clusters.push([f]);
      }
      if (clusters.length < 2) continue;

      // 上游值：优先取「本轮被修改过」的条目中的值；否则取首个非脚注段落
      const modifiedClusters = clusters.filter((c) =>
        c.some((f) => {
          const e = entryById.get(f.entryId);
          return e && e.kind === 'item' && MODIFIED_ORIGINS.has(e.origin.kind);
        }),
      );
      const firstNonFootnote = group.find((f) => {
        const e = entryById.get(f.entryId);
        return e && e.kind === 'item' && footnoteDefNo(e.text) === null;
      });
      const upstreamFacts =
        modifiedClusters.length === 1
          ? modifiedClusters[0]
          : clusters.find((c) => firstNonFootnote && c.includes(firstNonFootnote)) ?? clusters[0];
      const upstream = upstreamFacts[0];
      const ambiguous = modifiedClusters.length > 1;
      const stale = group.filter((f) => !upstreamFacts.includes(f));

      const label = upstream.label;
      const entryIds = [...new Set(group.map((f) => f.entryId))];
      const chain: ChainItem[] = group.map((f) => ({ entryId: f.entryId, label: f.label, raw: f.raw }));
      const candidates: SyncCandidate[] = [];
      if (!ambiguous && upstream.kind !== 'date') {
        for (const f of stale) {
          const newRaw = formatValueForRaw(f, upstream.value);
          if (newRaw === null || newRaw === f.raw) continue;
          candidates.push(
            mkCandidate('value-mismatch', f.entryId, f.raw, newRaw, `「${f.raw}」→「${newRaw}」（对齐「${label}」）`),
          );
        }
      }
      const details = group.map((f) => f.raw).join(' / ');
      issues.push(
        mkIssue({
          kind: 'value-mismatch',
          title: `「${label}」口径不一致`,
          message: `同一事实「${label}」在合并稿中出现 ${clusters.length} 种口径：${details}。`,
          entryIds,
          primaryEntryId: upstream.entryId,
          chain,
          values: versionValues(upstream),
          candidates,
          ackKey: `value-mismatch|${upstream.labelKey}`,
          signature: JSON.stringify(group.map((f) => `${f.entryId}:${f.raw}`).sort()),
        }),
      );
    }
  }

  // —— 2. 合计公式 ——
  {
    const isDerivedAmount = (f: Fact) => f.kind === 'amount' && f.derived;
    const isPlainAmount = (f: Fact) => f.kind === 'amount' && !f.derived;
    for (const e of itemEntries) {
      const totals = (factsByEntry.get(e.id) ?? []).filter(isDerivedAmount);
      for (const total of totals) {
        // 组成项：优先同段落的其他金额；否则向上扫描连续的费用段落
        const alive: Array<{ fact: Fact; deleted: boolean }> = [];
        const samePara = (factsByEntry.get(e.id) ?? []).filter((f) => isPlainAmount(f) && f.id !== total.id);
        if (samePara.length > 0) {
          alive.push(...samePara.map((fact) => ({ fact, deleted: false })));
        } else {
          const pos = entries.findIndex((x) => x.id === e.id);
          for (let k = pos - 1; k >= 0; k--) {
            const prev = entries[k];
            if (prev.kind === 'conflict') break;
            const fs = (factsByEntry.get(prev.id) ?? []).filter((f) => f.kind === 'amount');
            if (prev.kind === 'item') {
              if (fs.some(isDerivedAmount) || fs.length === 0) break;
              alive.unshift(...fs.filter(isPlainAmount).map((fact) => ({ fact, deleted: false })));
            } else {
              // 已删除条目：只进依赖链，不计入合计
              if (fs.length === 0) break;
              alive.unshift(...fs.filter(isPlainAmount).map((fact) => ({ fact, deleted: true })));
            }
          }
        }
        const components = alive.filter((c) => !c.deleted);
        if (components.length === 0) continue;
        const sum = components.reduce((acc, c) => acc + c.fact.value, 0);
        if (numEq(sum, total.value)) continue;

        // 依赖链：存活组成项 + 底稿中被删掉的原组成项
        const chain: ChainItem[] = [{ entryId: e.id, label: total.label, raw: total.raw }];
        for (const c of alive) {
          chain.push({ entryId: c.fact.entryId, label: c.fact.label, raw: c.fact.raw, deleted: c.deleted });
        }
        if (e.refs.base !== undefined) {
          const baseFacts = extractFacts(paras.base[e.refs.base], 'tmp-base').filter(isPlainAmount);
          for (const bf of baseFacts) {
            const stillThere = components.some((c) =>
              unitsCompatible(c.fact, bf) &&
              (c.fact.labelKey === bf.labelKey || similarity(c.fact.labelKey, bf.labelKey) >= LABEL_GROUP_THRESHOLD),
            );
            if (!stillThere) {
              chain.push({ entryId: e.id, label: bf.label, raw: bf.raw, deleted: true });
            }
          }
        }
        const deletedNote = chain.filter((c) => c.deleted).map((c) => `${c.label} ${c.raw}`);
        const newRaw = formatValueForRaw(total, sum);
        const candidates: SyncCandidate[] = [];
        if (newRaw !== null && newRaw !== total.raw) {
          candidates.push(
            mkCandidate('sum-mismatch', e.id, total.raw, newRaw, `「${total.raw}」→「${newRaw}」（按现有费用项重算）`),
          );
        }
        issues.push(
          mkIssue({
            kind: 'sum-mismatch',
            title: `「${total.label}」合计不符`,
            message:
              `「${total.label}」为 ${total.raw}，但现有费用项合计 ${components.map((c) => c.fact.raw).join(' + ')}` +
              (deletedNote.length > 0 ? `；已删除：${deletedNote.join('、')}，合计未同步更新` : '') +
              '。',
            entryIds: [...new Set(chain.map((c) => c.entryId))],
            primaryEntryId: e.id,
            chain,
            values: versionValues(total),
            candidates,
            ackKey: `sum-mismatch|${e.id}|${total.labelKey}`,
            signature: JSON.stringify([total.raw, ...chain.map((c) => `${c.raw}${c.deleted ? '!' : ''}`)]),
          }),
        );
      }
    }
  }

  // —— 3. 日期先后 ——
  {
    for (const e of itemEntries) {
      const dates = (factsByEntry.get(e.id) ?? []).filter((f) => f.kind === 'date');
      // 3a. 「自 A 至 B」范围
      for (let i = 0; i + 1 < dates.length; i++) {
        const d1 = dates[i];
        const d2 = dates[i + 1];
        const between = e.text.slice(d1.end, d2.start);
        if (!/^\s*(至|到|—|–|－|-)\s*$/.test(between)) continue;
        const v1 = d1.value;
        const v2 = d2.yearless && !d1.yearless ? d2.value + Math.floor(d1.value / 10000) * 10000 : d2.value;
        if (v1 <= v2) continue;
        issues.push(
          mkIssue({
            kind: 'date-order',
            title: '日期范围矛盾',
            message: `日期范围「${d1.raw} ${between.trim()} ${d2.raw}」起点晚于终点。`,
            entryIds: [e.id],
            primaryEntryId: e.id,
            chain: [
              { entryId: e.id, label: d1.label, raw: d1.raw },
              { entryId: e.id, label: d2.label, raw: d2.raw },
            ],
            candidates: [],
            ackKey: `date-order|${e.id}|range`,
            signature: JSON.stringify([d1.raw, d2.raw]),
          }),
        );
      }
    }
    // 3b. 同主题「开始/结束」日期
    const stemOf = (f: Fact): { stem: string; role: 'start' | 'end' } | null => {
      const m = f.labelKey.match(/^(.*?)(开始|启动|结束|截止)(?:日期|时间)?$/);
      if (!m || !m[1]) return null;
      return { stem: m[1], role: m[2] === '开始' || m[2] === '启动' ? 'start' : 'end' };
    };
    const byStem = new Map<string, { start?: Fact; end?: Fact }>();
    for (const f of mergedFacts) {
      if (f.kind !== 'date' || f.yearless) continue;
      const hit = stemOf(f);
      if (!hit) continue;
      const rec = byStem.get(hit.stem) ?? {};
      rec[hit.role] = f;
      byStem.set(hit.stem, rec);
    }
    for (const [stem, rec] of byStem) {
      if (!rec.start || !rec.end) continue;
      if (rec.start.value <= rec.end.value) continue;
      const entryIds = [...new Set([rec.start.entryId, rec.end.entryId])];
      issues.push(
        mkIssue({
          kind: 'date-order',
          title: `「${stem}」开始晚于结束`,
          message: `「${stem}」开始日期 ${rec.start.raw} 晚于结束日期 ${rec.end.raw}。`,
          entryIds,
          primaryEntryId: rec.start.entryId,
          chain: [
            { entryId: rec.start.entryId, label: rec.start.label, raw: rec.start.raw },
            { entryId: rec.end.entryId, label: rec.end.label, raw: rec.end.raw },
          ],
          candidates: [],
          ackKey: `date-order|stem|${stem}`,
          signature: JSON.stringify([rec.start.raw, rec.end.raw]),
        }),
      );
    }
  }

  // —— 4. 比例范围 ——
  {
    const RANGE_LABEL_RE = /(占比|比例|份额|覆盖率|留存率|转化率|完成率)/;
    for (const f of mergedFacts) {
      if (f.kind !== 'ratio') continue;
      if (!RANGE_LABEL_RE.test(f.label)) continue;
      if (f.value >= 0 && f.value <= 100) continue;
      issues.push(
        mkIssue({
          kind: 'ratio-range',
          title: `「${f.label}」超出 0–100%`,
          message: `「${f.label}」为 ${f.raw}，超出合理范围 0–100%。`,
          entryIds: [f.entryId],
          primaryEntryId: f.entryId,
          chain: [{ entryId: f.entryId, label: f.label, raw: f.raw }],
          values: versionValues(f),
          candidates: [],
          ackKey: `ratio-range|${f.entryId}|${f.labelKey}`,
          signature: f.raw,
        }),
      );
    }
    // 同段各项「占比」之和不得超过 100%
    for (const e of itemEntries) {
      const shares = (factsByEntry.get(e.id) ?? []).filter(
        (f) => f.kind === 'ratio' && f.labelKey.endsWith('占比'),
      );
      if (shares.length < 2) continue;
      const sum = shares.reduce((acc, f) => acc + f.value, 0);
      if (sum <= 100 + 1e-6) continue;
      issues.push(
        mkIssue({
          kind: 'ratio-range',
          title: '各项占比之和超过 100%',
          message: `同段各项占比之和为 ${+sum.toFixed(2)}%（${shares.map((f) => f.raw).join(' + ')}），超过 100%。`,
          entryIds: [e.id],
          primaryEntryId: e.id,
          chain: shares.map((f) => ({ entryId: e.id, label: f.label, raw: f.raw })),
          candidates: [],
          ackKey: `ratio-range|${e.id}|shares`,
          signature: JSON.stringify(shares.map((f) => f.raw)),
        }),
      );
    }
  }

  // —— 5. 条款引用 ——
  const { bindings } = buildBaseBindings(paras.base);
  const mergedClauses = extractClauses(itemEntries.map((e) => ({ entryId: e.id, text: e.text })));
  const allRefs: RefInfo[] = [];
  {
    const clauseAt = (pos: number): ClauseInfo | undefined => mergedClauses.find((c) => c.position === pos);
    const formatRef = (ref: RefInfo, newNo: number): string | null => {
      const numStr = /^\d+$/.test(ref.rawNumber) ? String(newNo) : numberToChinese(newNo);
      if (!numStr) return null;
      return ref.raw.replace(ref.rawNumber, numStr);
    };
    for (const e of itemEntries) {
      for (const ref of extractRefs(e.id, e.text)) {
        allRefs.push(ref);
        const binding = bindings.get(ref.key);
        if (binding) {
          const target = mergedClauses.find((c) => c.entryId === binding.targetEntryId);
          if (target) {
            if (target.position === ref.no) continue; // 目标位置未变
            const occupant = clauseAt(ref.no);
            const newRaw = formatRef(ref, target.position);
            const candidates: SyncCandidate[] = [];
            if (newRaw !== null) {
              candidates.push(
                mkCandidate('ref-stale', e.id, ref.raw, newRaw, `「${ref.raw}」→「${newRaw}」（跟随目标条款）`),
              );
            }
            issues.push(
              mkIssue({
                kind: 'ref-stale',
                title: `「${ref.raw}」目标已移动`,
                message:
                  `「${ref.raw}」在底稿中指向「${binding.targetHeading}…」，该条款现位于第 ${target.position} 位` +
                  (occupant ? `，第 ${ref.no} 位现为「${occupant.heading}…」` : '') +
                  '。',
                entryIds: [...new Set([e.id, target.entryId, occupant?.entryId].filter((x): x is string => !!x))],
                primaryEntryId: e.id,
                chain: [
                  { entryId: e.id, label: '引用', raw: ref.raw },
                  { entryId: target.entryId, label: `目标条款（现第 ${target.position} 位）`, raw: target.heading },
                  ...(occupant && occupant.entryId !== target.entryId
                    ? [{ entryId: occupant.entryId, label: `现第 ${ref.no} 位`, raw: occupant.heading }]
                    : []),
                ],
                candidates,
                ackKey: `ref-stale|${ref.key}`,
                signature: JSON.stringify([ref.raw, target.position, binding.targetEntryId]),
              }),
            );
          } else {
            // 目标已删除（或不再是条款）：即使同位置出现同名新条款也不悄悄改指
            const occupant = clauseAt(ref.no);
            issues.push(
              mkIssue({
                kind: 'ref-broken',
                title: `「${ref.raw}」目标已删除`,
                message:
                  `「${ref.raw}」在底稿中指向「${binding.targetHeading}…」，该条款已不在合并稿中` +
                  (occupant ? `；第 ${ref.no} 位现为「${occupant.heading}…」，未自动改指，请人工确认` : '') +
                  '。',
                entryIds: [...new Set([e.id, occupant?.entryId].filter((x): x is string => !!x))],
                primaryEntryId: e.id,
                chain: [
                  { entryId: e.id, label: '引用', raw: ref.raw },
                  { entryId: binding.targetEntryId, label: '目标条款（已删除）', raw: binding.targetHeading, deleted: true },
                  ...(occupant
                    ? [{ entryId: occupant.entryId, label: `现第 ${ref.no} 位`, raw: occupant.heading }]
                    : []),
                ],
                candidates: [],
                ackKey: `ref-broken|${ref.key}`,
                signature: JSON.stringify([ref.raw, binding.targetEntryId, occupant?.entryId ?? '']),
              }),
            );
          }
        } else {
          // 新增引用：能解析到条款即可；无法解析则报告，不猜测绑定
          const target = clauseAt(ref.no);
          if (target) continue;
          issues.push(
            mkIssue({
              kind: 'ref-unresolved',
              title: `「${ref.raw}」无法解析`,
              message: `新增引用「${ref.raw}」找不到目标条款：合并稿共 ${mergedClauses.length} 条。`,
              entryIds: [e.id],
              primaryEntryId: e.id,
              chain: [{ entryId: e.id, label: '引用', raw: ref.raw }],
              candidates: [],
              ackKey: `ref-unresolved|${ref.key}`,
              signature: JSON.stringify([ref.raw, mergedClauses.length]),
            }),
          );
        }
      }
    }
  }

  // —— 6. 脚注 ——
  {
    const defs = new Map<number, string>();
    const marks: Array<{ entryId: string; no: number; raw: string }> = [];
    for (const e of itemEntries) {
      const defNo = footnoteDefNo(e.text);
      if (defNo !== null) {
        defs.set(defNo, e.id);
        continue;
      }
      marks.push(...extractFootnoteMarks(e.id, e.text));
    }
    for (const mark of marks) {
      if (defs.has(mark.no)) continue;
      issues.push(
        mkIssue({
          kind: 'footnote-dangling',
          title: `脚注（注${mark.no}）缺少定义`,
          message: `正文引用了脚注（注${mark.no}），但合并稿中没有对应的「注${mark.no}：」定义段。`,
          entryIds: [mark.entryId],
          primaryEntryId: mark.entryId,
          chain: [{ entryId: mark.entryId, label: '脚注标记', raw: mark.raw }],
          candidates: [],
          ackKey: `footnote-dangling|${mark.entryId}|${mark.no}`,
          signature: mark.raw,
        }),
      );
    }
    for (const [no, entryId] of defs) {
      if (marks.some((m) => m.no === no)) continue;
      issues.push(
        mkIssue({
          kind: 'footnote-orphan',
          title: `脚注「注${no}」未被正文引用`,
          message: `脚注定义「注${no}」存在，但正文中没有对应的（注${no}）标记。`,
          entryIds: [entryId],
          primaryEntryId: entryId,
          chain: [{ entryId, label: '脚注定义', raw: `注${no}` }],
          candidates: [],
          ackKey: `footnote-orphan|${entryId}|${no}`,
          signature: `注${no}`,
        }),
      );
    }
  }

  return {
    issues,
    factCount: mergedFacts.length,
    clauseCount: mergedClauses.length,
    refCount: allRefs.length,
  };
}

// —— 同步更新候选的应用 ——

export interface Docs {
  base: string;
  brand: string;
  legal: string;
}

/**
 * 应用同步更新候选：把 oldRaw 替换为 newRaw。
 *
 * 改写规则（保证不制造新冲突、不破坏引用绑定）：
 * - 共同底稿是比较基线，永不改写；
 * - 只改写与合并文本一致的来源版本（品牌/法务）——即当前合并措辞的贡献方；
 *   与合并文本不一致的版本保持原样（它的差异本就在合并中落选了）。
 * - 法务锁定段落返回 null（不得自动改写）。
 *
 * 返回 null 表示没有任何来源段落被修改。
 */
export function applyCandidateToDocs(
  docs: Docs,
  entries: MergeEntry[],
  cand: SyncCandidate,
): Docs | null {
  if (cand.locked) return null;
  const entry = entries.find((e) => e.id === cand.entryId);
  if (!entry || entry.kind !== 'item') return null;
  const out: Docs = { ...docs };
  let changed = false;
  for (const side of ['brand', 'legal'] as const) {
    const idx = entry.refs[side];
    if (idx === undefined) continue;
    const ps = splitParagraphs(out[side]);
    // 只改与合并文本一致的版本，避免把落选版本改出新的文本冲突
    if (idx >= ps.length || ps[idx] !== entry.text || !ps[idx].includes(cand.oldRaw)) continue;
    ps[idx] = ps[idx].replace(cand.oldRaw, cand.newRaw);
    out[side] = joinParagraphs(ps);
    changed = true;
  }
  return changed ? out : null;
}

/**
 * 有效确认：只保留「键存在且指纹一致」的确认记录。
 * 事实内容变化后，旧确认自动失效（不会掩盖新问题）。
 */
export function effectiveAcks(
  acks: Record<string, string>,
  issues: FactIssue[],
): Record<string, string> {
  const valid = new Map(issues.map((i) => [i.ackKey, i.signature]));
  const out: Record<string, string> = {};
  for (const [key, sig] of Object.entries(acks)) {
    if (valid.get(key) === sig) out[key] = sig;
  }
  return out;
}
