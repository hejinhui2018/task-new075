/**
 * 段落级 diff（底稿 → 某一方的修改版）。
 *
 * 流程：
 * 1. 规范化后做 LCS，得到「完全未动」的段落锚点；
 * 2. 未匹配的底稿段落视为删除候选，未匹配的新版段落视为插入候选；
 * 3. 全局贪心配对删除/插入候选（按相似度从高到低）：
 *    - 配对成功且位置基本不变 → 原地修改（modify）；
 *    - 配对成功但跨了位置 → 移动（move，可同时带修改）；
 * 4. 剩余未配对的 → 纯删除 / 纯插入。
 *
 * 这样「移动 + 内容修改」会被识别为一次移动，而不会误判成删除加新增。
 */

import { lcsPairs, similarity } from './tokenize';
import { normalizeText } from './text';

export type BaseOp =
  | { type: 'keep'; modIndex: number }
  | { type: 'modify'; text: string; modIndex: number }
  | { type: 'delete' }
  | { type: 'move'; text: string; anchor: number; modIndex: number };

export interface InsertOp {
  text: string;
  modIndex: number;
}

export interface ParaDiff {
  /** 与底稿段落一一对应。 */
  ops: BaseOp[];
  /** inserts[i] = 应插入到底稿第 i 段之前的段落；inserts[base.length] = 文末。 */
  inserts: InsertOp[][];
}

/** 判定「修改/移动」配对的相似度下限。 */
export const PAIR_THRESHOLD = 0.5;

interface DeleteCandidate {
  baseIndex: number;
  text: string;
}

interface InsertCandidate {
  modIndex: number;
  anchor: number;
  text: string;
}

export function diffParagraphs(base: string[], modified: string[]): ParaDiff {
  const n = base.length;
  const normBase = base.map(normalizeText);
  const normMod = modified.map(normalizeText);

  const matches = lcsPairs(normBase, normMod);
  const matchedBase = new Set(matches.map(([i]) => i));
  const matchedMod = new Set(matches.map(([, j]) => j));

  // 空隙编号：第 k 对锚点之后的区域编号为 k。
  // 同一空隙内的删除/插入配对 = 原地修改；跨空隙 = 移动。
  const baseGap = new Array<number>(n).fill(0);
  {
    let mi = 0;
    for (let i = 0; i < n; i++) {
      while (mi < matches.length && matches[mi][0] < i) mi += 1;
      baseGap[i] = mi;
    }
  }
  const modGap = new Array<number>(modified.length).fill(0);
  {
    let mi = 0;
    for (let j = 0; j < modified.length; j++) {
      while (mi < matches.length && matches[mi][1] < j) mi += 1;
      modGap[j] = mi;
    }
  }

  const deletes: DeleteCandidate[] = [];
  for (let i = 0; i < n; i++) {
    if (!matchedBase.has(i)) deletes.push({ baseIndex: i, text: base[i] });
  }

  // 插入候选的锚点 = 新版中它后面最近的「未动段落」在底稿中的下标。
  const inserts: InsertCandidate[] = [];
  let mi = 0;
  for (let j = 0; j < modified.length; j++) {
    while (mi < matches.length && matches[mi][1] < j) mi += 1;
    if (matchedMod.has(j)) continue;
    const anchor = mi < matches.length ? matches[mi][0] : n;
    inserts.push({ modIndex: j, anchor, text: modified[j] });
  }

  // 全局贪心配对：相似度最高的先配，避免移动段落被同空隙的插入抢走。
  const scored: Array<{ d: number; ins: number; sim: number }> = [];
  for (let d = 0; d < deletes.length; d++) {
    for (let ins = 0; ins < inserts.length; ins++) {
      const sim = similarity(deletes[d].text, inserts[ins].text);
      if (sim >= PAIR_THRESHOLD) scored.push({ d, ins, sim });
    }
  }
  scored.sort((a, b) => b.sim - a.sim);

  const usedDelete = new Set<number>();
  const usedInsert = new Set<number>();
  const pairs: Array<{ del: DeleteCandidate; ins: InsertCandidate }> = [];
  for (const { d, ins } of scored) {
    if (usedDelete.has(d) || usedInsert.has(ins)) continue;
    usedDelete.add(d);
    usedInsert.add(ins);
    pairs.push({ del: deletes[d], ins: inserts[ins] });
  }

  const ops: BaseOp[] = new Array(n);
  for (const [i, j] of matches) {
    ops[i] = { type: 'keep', modIndex: j };
  }
  for (const { del, ins } of pairs) {
    const i = del.baseIndex;
    // 同一空隙内 → 原地修改；跨空隙 → 移动。
    if (baseGap[i] === modGap[ins.modIndex]) {
      ops[i] = { type: 'modify', text: modified[ins.modIndex], modIndex: ins.modIndex };
    } else {
      ops[i] = {
        type: 'move',
        text: modified[ins.modIndex],
        anchor: ins.anchor,
        modIndex: ins.modIndex,
      };
    }
  }
  for (let d = 0; d < deletes.length; d++) {
    if (!usedDelete.has(d)) ops[deletes[d].baseIndex] = { type: 'delete' };
  }

  const insertSlots: InsertOp[][] = Array.from({ length: n + 1 }, () => []);
  for (let ins = 0; ins < inserts.length; ins++) {
    if (usedInsert.has(ins)) continue;
    const c = inserts[ins];
    insertSlots[c.anchor].push({ text: c.text, modIndex: c.modIndex });
  }

  return { ops, inserts: insertSlots };
}
