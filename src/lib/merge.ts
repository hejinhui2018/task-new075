/**
 * 三方段落合并：共同底稿 + 品牌版 + 法务版 → 合并结果。
 *
 * 规则：
 * - 只有一方修改/删除/新增 → 自动采用；
 * - 双方改了同一段且结果不同 → 待处理冲突（edit-edit）；
 * - 一方删除、另一方修改 → 待处理冲突（delete-edit / edit-delete）；
 * - 一方移动、另一方修改内容 → 自动合并：保留新位置 + 新内容（move-edit）；
 * - 双方移动到不同位置 → 待处理冲突（move-move）；
 * - 双方插入相同内容 → 自动去重。
 *
 * 冲突由人工解决（resolutions），解决后重新合并即得最终稿。
 */

import { diffParagraphs, type BaseOp, type InsertOp } from './diff';
import { normalizeText } from './text';

export type Side = 'brand' | 'legal';

export interface Resolution {
  choice: 'brand' | 'legal' | 'base' | 'custom';
  /** choice 为 custom 时的手工文本。 */
  text?: string;
}

export type Origin =
  | { kind: 'base' }
  | { kind: 'edit'; by: Side | 'both' }
  | { kind: 'insert'; by: Side | 'both' }
  | { kind: 'move'; by: Side | 'both' }
  | { kind: 'move-edit'; movedBy: Side; editedBy: Side }
  | { kind: 'resolved'; choice: Resolution['choice'] };

/** 各版本中的段落下标（0 起），用于界面联动定位。 */
export interface Refs {
  base?: number;
  brand?: number;
  legal?: number;
}

export interface MoveInfo {
  by: Side | 'both';
  /** 在底稿中的原始下标。 */
  fromBase: number;
  /** 移动目标锚点（底稿坐标，= 插入到该底稿段落之前；= 底稿长度表示文末）。 */
  anchor: number;
}

export interface MergedItem {
  kind: 'item';
  id: string;
  text: string;
  /** 相对底稿有改动时携带底稿原文，用于展示差异。 */
  baseText?: string;
  origin: Origin;
  refs: Refs;
  move?: MoveInfo;
  resolution?: Resolution;
}

export interface DeletedItem {
  kind: 'deleted';
  id: string;
  text: string;
  by: Side | 'both';
  refs: Refs;
  resolution?: Resolution;
}

export type ConflictType = 'edit-edit' | 'delete-edit' | 'edit-delete' | 'move-move';

export interface ConflictItem {
  kind: 'conflict';
  id: string;
  type: ConflictType;
  baseIndex: number;
  baseText: string;
  /** undefined 表示该方删除了这一段。 */
  brandText?: string;
  legalText?: string;
  refs: Refs;
  move?: { fromBase: number; brandAnchor?: number; legalAnchor?: number };
}

export type MergeEntry = MergedItem | DeletedItem | ConflictItem;

const other = (s: Side): Side => (s === 'brand' ? 'legal' : 'brand');

function modIndexOf(op: BaseOp): number | undefined {
  return op.type === 'delete' ? undefined : op.modIndex;
}

/** 应用人工解决结果，把冲突替换为正式条目。 */
export function applyResolution(conflict: ConflictItem, res: Resolution): MergedItem | DeletedItem {
  const { id, refs, baseText } = conflict;
  const move: MoveInfo | undefined = conflict.move
    ? {
        by:
          res.choice === 'legal' && conflict.move.legalAnchor !== undefined
            ? 'legal'
            : res.choice === 'brand' && conflict.move.brandAnchor !== undefined
              ? 'brand'
              : conflict.move.brandAnchor !== undefined && conflict.move.legalAnchor !== undefined
                ? 'both'
                : conflict.move.brandAnchor !== undefined
                  ? 'brand'
                  : 'legal',
        fromBase: conflict.move.fromBase,
        anchor:
          (res.choice === 'legal' ? conflict.move.legalAnchor : conflict.move.brandAnchor) ??
          conflict.move.brandAnchor ??
          conflict.move.legalAnchor ??
          conflict.baseIndex,
      }
    : undefined;

  const chosen = (text: string, choice: Resolution['choice']): MergedItem => ({
    kind: 'item',
    id,
    text,
    baseText,
    origin: { kind: 'resolved', choice },
    refs,
    move,
    resolution: res,
  });

  switch (res.choice) {
    case 'brand':
      if (conflict.brandText === undefined) {
        return { kind: 'deleted', id, text: baseText, by: 'brand', refs, resolution: res };
      }
      return chosen(conflict.brandText, 'brand');
    case 'legal':
      if (conflict.legalText === undefined) {
        return { kind: 'deleted', id, text: baseText, by: 'legal', refs, resolution: res };
      }
      return chosen(conflict.legalText, 'legal');
    case 'base':
      return chosen(baseText, 'base');
    case 'custom':
      return chosen(res.text ?? '', 'custom');
  }
}



interface Placed {
  slot: number;
  /** 同一槽位内的排序：移动来的段落 → 新增段落 → 底稿本段。 */
  cat: number;
  seq: number;
  entry: MergeEntry;
}

export function mergeDocuments(
  base: string[],
  brand: string[],
  legal: string[],
  resolutions: Record<string, Resolution> = {},
): MergeEntry[] {
  const diffB = diffParagraphs(base, brand);
  const diffL = diffParagraphs(base, legal);
  const n = base.length;

  // —— 整段重写调和 ——
  // 当某段被双方同时删除、且删除位置附近双方又各自插入了新段落，
  // 说明这不是「删除 + 新增」，而是双方各自整段重写了同一段：
  // 应配对为修改（一致则自动采用，不同则 edit-edit 冲突）；
  // 只有一方插入的，则是「一方重写 vs 另一方删除」的冲突。
  const rewriteOf = new Map<number, { b?: InsertOp; l?: InsertOp }>();
  const consumedB = diffB.inserts.map(() => new Set<number>());
  const consumedL = diffL.inserts.map(() => new Set<number>());
  {
    let i = 0;
    while (i < n) {
      if (diffB.ops[i].type === 'delete' && diffL.ops[i].type === 'delete') {
        let j = i;
        while (
          j + 1 < n &&
          diffB.ops[j + 1].type === 'delete' &&
          diffL.ops[j + 1].type === 'delete'
        ) {
          j += 1;
        }
        const slot = j + 1;
        const insB = diffB.inserts[slot];
        const insL = diffL.inserts[slot];
        for (let k = 0; k <= j - i; k++) {
          const b = insB[k];
          const l = insL[k];
          if (!b && !l) continue;
          rewriteOf.set(i + k, { b, l });
          if (b) consumedB[slot].add(k);
          if (l) consumedL[slot].add(k);
        }
        i = j + 1;
      } else {
        i += 1;
      }
    }
  }

  const placed: Placed[] = [];
  let seq = 0;
  const put = (slot: number, cat: number, entry: MergeEntry) => {
    placed.push({ slot, cat, seq: seq++, entry });
  };
  const putConflict = (slot: number, cat: number, conflict: ConflictItem) => {
    const res = resolutions[conflict.id];
    put(slot, cat, res ? applyResolution(conflict, res) : conflict);
  };

  for (let i = 0; i < n; i++) {
    const b = diffB.ops[i];
    const l = diffL.ops[i];
    const baseText = base[i];
    const id = `b${i}`;
    let refs: Refs = { base: i, brand: modIndexOf(b), legal: modIndexOf(l) };

    const item = (text: string, origin: Origin, extra?: Partial<MergedItem>): MergedItem => ({
      kind: 'item',
      id,
      text,
      origin,
      refs,
      ...(extra ?? {}),
    });
    const deleted = (by: Side | 'both'): DeletedItem => ({
      kind: 'deleted',
      id,
      text: baseText,
      by,
      refs,
    });
    const conflict = (
      type: ConflictType,
      brandText: string | undefined,
      legalText: string | undefined,
      move?: ConflictItem['move'],
    ): ConflictItem => ({ kind: 'conflict', id, type, baseIndex: i, baseText, brandText, legalText, refs, move });

    const bIsMove = b.type === 'move';
    const lIsMove = l.type === 'move';

    // —— 涉及移动的组合 ——
    if (bIsMove || lIsMove) {
      const movers: Array<{ side: Side; op: Extract<BaseOp, { type: 'move' }> }> = [];
      if (bIsMove) movers.push({ side: 'brand', op: b as Extract<BaseOp, { type: 'move' }> });
      if (lIsMove) movers.push({ side: 'legal', op: l as Extract<BaseOp, { type: 'move' }> });

      if (movers.length === 2) {
        const [mb, ml] = [movers[0].op, movers[1].op];
        const samePlace = mb.anchor === ml.anchor;
        const sameText = normalizeText(mb.text) === normalizeText(ml.text);
        if (samePlace && sameText) {
          put(mb.anchor, 0, item(mb.text, { kind: 'move', by: 'both' }, {
            baseText: normalizeText(mb.text) === normalizeText(baseText) ? undefined : baseText,
            move: { by: 'both', fromBase: i, anchor: mb.anchor },
          }));
        } else if (samePlace) {
          putConflict(mb.anchor, 0, conflict('edit-edit', mb.text, ml.text, {
            fromBase: i, brandAnchor: mb.anchor, legalAnchor: ml.anchor,
          }));
        } else {
          putConflict(Math.min(mb.anchor, ml.anchor), 0, conflict('move-move', mb.text, ml.text, {
            fromBase: i, brandAnchor: mb.anchor, legalAnchor: ml.anchor,
          }));
        }
        continue;
      }

      const { side, op: mv } = movers[0];
      const otherOp = side === 'brand' ? l : b;
      const moverChangedText = normalizeText(mv.text) !== normalizeText(baseText);
      const moveInfo: MoveInfo = { by: side, fromBase: i, anchor: mv.anchor };
      const conflictMove = { fromBase: i, [`${side}Anchor`]: mv.anchor } as ConflictItem['move'];

      if (otherOp.type === 'keep') {
        put(mv.anchor, 0, item(mv.text, { kind: 'move', by: side }, {
          baseText: moverChangedText ? baseText : undefined,
          move: moveInfo,
        }));
      } else if (otherOp.type === 'modify') {
        if (!moverChangedText) {
          // 关键场景：一方只移动、另一方只改内容 → 新位置 + 新内容，自动合并。
          put(mv.anchor, 0, item(otherOp.text, { kind: 'move-edit', movedBy: side, editedBy: other(side) }, {
            baseText,
            move: moveInfo,
          }));
        } else if (normalizeText(mv.text) === normalizeText(otherOp.text)) {
          put(mv.anchor, 0, item(mv.text, { kind: 'edit', by: 'both' }, { baseText, move: moveInfo }));
        } else {
          putConflict(mv.anchor, 0, conflict('edit-edit',
            side === 'brand' ? mv.text : otherOp.text,
            side === 'legal' ? mv.text : otherOp.text,
            conflictMove));
        }
      } else if (otherOp.type === 'delete') {
        // 一方想搬走、一方想删掉 → 冲突。
        putConflict(mv.anchor, 0, conflict(
          side === 'brand' ? 'edit-delete' : 'delete-edit',
          side === 'brand' ? mv.text : undefined,
          side === 'legal' ? mv.text : undefined,
          conflictMove));
      }
      continue;
    }

    // —— 不涉及移动的组合 ——
    if (b.type === 'keep' && l.type === 'keep') {
      put(i, 2, item(baseText, { kind: 'base' }));
    } else if (b.type === 'modify' && l.type === 'keep') {
      put(i, 2, item(b.text, { kind: 'edit', by: 'brand' }, { baseText }));
    } else if (b.type === 'keep' && l.type === 'modify') {
      put(i, 2, item(l.text, { kind: 'edit', by: 'legal' }, { baseText }));
    } else if (b.type === 'modify' && l.type === 'modify') {
      if (normalizeText(b.text) === normalizeText(l.text)) {
        put(i, 2, item(b.text, { kind: 'edit', by: 'both' }, { baseText }));
      } else {
        putConflict(i, 2, conflict('edit-edit', b.text, l.text));
      }
    } else if (b.type === 'delete' && l.type === 'keep') {
      put(i, 2, deleted('brand'));
    } else if (b.type === 'keep' && l.type === 'delete') {
      put(i, 2, deleted('legal'));
    } else if (b.type === 'delete' && l.type === 'delete') {
      const rw = rewriteOf.get(i);
      if (rw) refs = { base: i, brand: rw.b?.modIndex, legal: rw.l?.modIndex };
      if (rw?.b && rw.l) {
        // 双方各自整段重写：一致则自动采用，不同则冲突。
        if (normalizeText(rw.b.text) === normalizeText(rw.l.text)) {
          put(i, 2, item(rw.b.text, { kind: 'edit', by: 'both' }, { baseText }));
        } else {
          putConflict(i, 2, conflict('edit-edit', rw.b.text, rw.l.text));
        }
      } else if (rw?.b) {
        putConflict(i, 2, conflict('edit-delete', rw.b.text, undefined));
      } else if (rw?.l) {
        putConflict(i, 2, conflict('delete-edit', undefined, rw.l.text));
      } else {
        put(i, 2, deleted('both'));
      }
    } else if (b.type === 'delete' && l.type === 'modify') {
      putConflict(i, 2, conflict('delete-edit', undefined, l.text));
    } else if (b.type === 'modify' && l.type === 'delete') {
      putConflict(i, 2, conflict('edit-delete', b.text, undefined));
    }
  }

  // —— 双方的新增段落（相同内容自动去重；被重写调和消耗的跳过） ——
  for (let slot = 0; slot <= n; slot++) {
    const insB = diffB.inserts[slot];
    const insL = diffL.inserts[slot];
    const usedL = new Set<number>(consumedL[slot]);
    insB.forEach((ib, k) => {
      if (consumedB[slot].has(k)) return;
      const dupIdx = insL.findIndex(
        (il, idx) => !usedL.has(idx) && normalizeText(il.text) === normalizeText(ib.text),
      );
      if (dupIdx >= 0) {
        usedL.add(dupIdx);
        put(slot, 1, {
          kind: 'item',
          id: `ins-b${slot}-${k}`,
          text: ib.text,
          origin: { kind: 'insert', by: 'both' },
          refs: { brand: ib.modIndex, legal: insL[dupIdx].modIndex },
        });
      } else {
        put(slot, 1, {
          kind: 'item',
          id: `ins-b${slot}-${k}`,
          text: ib.text,
          origin: { kind: 'insert', by: 'brand' },
          refs: { brand: ib.modIndex },
        });
      }
    });
    insL.forEach((il, k) => {
      if (usedL.has(k)) return;
      put(slot, 1, {
        kind: 'item',
        id: `ins-l${slot}-${k}`,
        text: il.text,
        origin: { kind: 'insert', by: 'legal' },
        refs: { legal: il.modIndex },
      });
    });
  }

  placed.sort((a, b2) => a.slot - b2.slot || a.cat - b2.cat || a.seq - b2.seq);
  return placed.map((p) => p.entry);
}

/** 文档变化后清理失效的解决记录（冲突已不存在的键）。 */
export function sanitizeResolutions(
  entries: MergeEntry[],
  resolutions: Record<string, Resolution>,
): Record<string, Resolution> {
  const conflictIds = new Set(
    entries.filter((e): e is ConflictItem => e.kind === 'conflict').map((e) => e.id),
  );
  const out: Record<string, Resolution> = {};
  for (const [id, res] of Object.entries(resolutions)) {
    if (conflictIds.has(id)) out[id] = res;
  }
  return out;
}

export interface MergeSummary {
  total: number;
  unresolved: number;
  resolved: number;
  autoItems: number;
  deleted: number;
  moved: number;
}

export function summarize(entries: MergeEntry[]): MergeSummary {
  let unresolved = 0;
  let resolved = 0;
  let autoItems = 0;
  let deleted = 0;
  let moved = 0;
  for (const e of entries) {
    if (e.kind === 'conflict') unresolved += 1;
    else if (e.kind === 'deleted') {
      deleted += 1;
      if (e.resolution) resolved += 1;
    } else {
      if (e.resolution) resolved += 1;
      else autoItems += 1;
      if (e.move) moved += 1;
    }
  }
  return { total: entries.length, unresolved, resolved, autoItems, deleted, moved };
}

/** 导出最终稿文本：跳过未解决冲突与已删除段落。 */
export function finalText(entries: MergeEntry[]): string {
  return entries
    .filter((e): e is MergedItem => e.kind === 'item')
    .map((e) => e.text)
    .join('\n\n');
}
