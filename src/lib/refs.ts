/**
 * 交叉引用解析与迁移。
 *
 * - 条款：「第N条」定义（条号后紧跟「：」）与「见第N条」等引用；
 * - 脚注：「脚注N：…」定义与「（详见脚注N）」引用；
 * - 引用目标按**内容指纹**跟踪，而不是按名称：
 *   重命名条款后，仍写着旧名称的引用会被判为「待迁移」，而不是悄悄绑定到同名新条款；
 *   删除目标 → 悬空；同名目标不唯一 → 歧义（绝不静默二选一）；段落重排不受影响。
 */

import { parseChineseNumber } from './cnnum';
import { normalizeText } from './text';

export interface ClauseDef {
  /** 规范化名称，如「第2条」（中文数字统一为阿拉伯）。 */
  name: string;
  paraIndex: number;
  /** 去掉条号后的内容指纹（规范化文本前 30 字），用于跨版本跟踪。 */
  fingerprint: string;
  text: string;
}

export interface RefSite {
  kind: 'clause' | 'footnote';
  /** 规范化名称，如「第1条」「脚注1」。 */
  name: string;
  paraIndex: number;
  start: number;
  end: number;
  /** 原文片段，如「第1条」。 */
  raw: string;
}

const CN_NUM = '零一二两三四五六七八九十百千万亿';
const NUM_TOKEN = `[0-9${CN_NUM}]+`;

/** 把条号/脚注号里的数字规范化为阿拉伯数字字符串。 */
function normalizeNum(raw: string): string {
  if (/^\d+$/.test(raw)) return String(Number(raw));
  const n = parseChineseNumber(raw);
  return n === null ? raw : String(n);
}

/** 内容指纹：去掉条号本身，压缩空白，取前 30 字。 */
function fingerprintOf(text: string, nameRaw: string): string {
  const stripped = text.replace(nameRaw, '');
  return normalizeText(stripped).slice(0, 30);
}

/** 解析段落中的条款定义与条款引用。 */
export function parseClauses(paragraphs: string[]): { defs: ClauseDef[]; refs: RefSite[] } {
  const defs: ClauseDef[] = [];
  const refs: RefSite[] = [];
  const re = new RegExp(`第\\s*(${NUM_TOKEN})\\s*条`, 'g');
  paragraphs.forEach((text, paraIndex) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = `第${normalizeNum(m[1])}条`;
      const after = text.slice(m.index + m[0].length);
      // 条号后紧跟冒号 → 定义；否则为引用。
      if (/^\s*[:：]/.test(after)) {
        defs.push({ name, paraIndex, fingerprint: fingerprintOf(text, m[0]), text });
      } else {
        refs.push({ kind: 'clause', name, paraIndex, start: m.index, end: m.index + m[0].length, raw: m[0] });
      }
    }
  });
  return { defs, refs };
}

export interface FootnoteDef {
  name: string;
  paraIndex: number;
  text: string;
}

/** 解析段落中的脚注定义（「脚注N：…」）与引用（「详见脚注N」「见脚注N」）。 */
export function parseFootnotes(paragraphs: string[]): { defs: FootnoteDef[]; refs: RefSite[] } {
  const defs: FootnoteDef[] = [];
  const refs: RefSite[] = [];
  const defRe = new RegExp(`^\\s*脚注\\s*(${NUM_TOKEN})\\s*[:：]`);
  const refRe = new RegExp(`(?:详见|参见|见)\\s*脚注\\s*(${NUM_TOKEN})`, 'g');
  paragraphs.forEach((text, paraIndex) => {
    const dm = defRe.exec(text);
    if (dm) {
      defs.push({ name: `脚注${normalizeNum(dm[1])}`, paraIndex, text });
      return; // 定义段不再扫描引用
    }
    refRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(text)) !== null) {
      const name = `脚注${normalizeNum(m[1])}`;
      // raw 只取「脚注N」部分，便于候选替换。
      const nameStart = m.index + m[0].length - m[1].length - '脚注'.length;
      refs.push({ kind: 'footnote', name, paraIndex, start: nameStart, end: m.index + m[0].length, raw: text.slice(nameStart, m.index + m[0].length) });
    }
  });
  return { defs, refs };
}

// ———————————————————— 引用分析 ————————————————————

export type RefStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'stale-rename';

export interface AnalyzedRef extends RefSite {
  status: RefStatus;
  /** resolved / stale-rename 的目标段落（合并稿坐标）。 */
  targetParaIndex?: number;
  /** stale-rename 时应迁移到的新名称。 */
  migrateTo?: string;
  /** 目标条款内容指纹。 */
  targetFingerprint?: string;
}

export interface RefAnalysis {
  refs: AnalyzedRef[];
  clauseDefs: ClauseDef[];
  footnoteDefs: FootnoteDef[];
  /** 检测到的条款重命名：旧名 → 新名。 */
  renames: Map<string, string>;
}

/**
 * 分析合并稿中的引用。
 *
 * 继承引用（底稿中已存在同名引用）：以底稿的名称→指纹绑定为准，
 * 若合并稿中该名称指向了**不同内容**，且原内容已更名为新名称 → stale-rename；
 * 这样「第1条」被重命名为「第2条」后，旧引用不会被静默绑定到新的「第1条」。
 *
 * 新增引用（底稿中没有同名引用）：直接按名称解析——
 * 无目标 → unresolved；多个同名目标 → ambiguous（不静默绑定）。
 */
export function analyzeRefs(baseParagraphs: string[], mergedParagraphs: string[]): RefAnalysis {
  const base = parseClauses(baseParagraphs);
  const merged = parseClauses(mergedParagraphs);
  const mergedFn = parseFootnotes(mergedParagraphs);

  // 底稿：名称 → 内容指纹（仅唯一名称可作为绑定依据）
  const baseClauseBinding = new Map<string, string>();
  {
    const byName = new Map<string, string[]>();
    for (const d of base.defs) {
      byName.set(d.name, [...(byName.get(d.name) ?? []), d.fingerprint]);
    }
    for (const [name, fps] of byName) {
      if (new Set(fps).size === 1) baseClauseBinding.set(name, fps[0]);
    }
  }
  const baseRefNames = new Set(base.refs.map((r) => r.name));

  // 重命名检测：同一内容指纹在底稿与合并稿中名称不同。
  const renames = new Map<string, string>();
  {
    const mergedFpToName = new Map<string, string>();
    for (const d of merged.defs) {
      if (!mergedFpToName.has(d.fingerprint)) mergedFpToName.set(d.fingerprint, d.name);
    }
    for (const d of base.defs) {
      const newName = mergedFpToName.get(d.fingerprint);
      if (newName && newName !== d.name) renames.set(d.name, newName);
    }
  }

  const mergedDefsByName = new Map<string, ClauseDef[]>();
  for (const d of merged.defs) {
    mergedDefsByName.set(d.name, [...(mergedDefsByName.get(d.name) ?? []), d]);
  }

  const refs: AnalyzedRef[] = [];
  for (const ref of merged.refs) {
    const candidates = mergedDefsByName.get(ref.name) ?? [];
    if (candidates.length === 0) {
      refs.push({ ...ref, status: 'unresolved' });
      continue;
    }
    if (candidates.length > 1) {
      refs.push({ ...ref, status: 'ambiguous' });
      continue;
    }
    const target = candidates[0];
    const inherited = baseRefNames.has(ref.name);
    const baseFp = baseClauseBinding.get(ref.name);
    if (inherited && baseFp && target.fingerprint !== baseFp) {
      // 同名但内容已变：原目标被重命名或删除。
      const migrateTo = renames.get(ref.name);
      if (migrateTo) {
        refs.push({ ...ref, status: 'stale-rename', targetParaIndex: target.paraIndex, migrateTo, targetFingerprint: target.fingerprint });
      } else {
        refs.push({ ...ref, status: 'unresolved', targetFingerprint: target.fingerprint });
      }
      continue;
    }
    refs.push({ ...ref, status: 'resolved', targetParaIndex: target.paraIndex, targetFingerprint: target.fingerprint });
  }

  // 脚注引用：按名称解析（脚注内容随正文滚动，不做指纹绑定）。
  const fnDefsByName = new Map<string, FootnoteDef[]>();
  for (const d of mergedFn.defs) {
    fnDefsByName.set(d.name, [...(fnDefsByName.get(d.name) ?? []), d]);
  }
  for (const ref of mergedFn.refs) {
    const candidates = fnDefsByName.get(ref.name) ?? [];
    if (candidates.length === 0) refs.push({ ...ref, status: 'unresolved' });
    else if (candidates.length > 1) refs.push({ ...ref, status: 'ambiguous' });
    else refs.push({ ...ref, status: 'resolved', targetParaIndex: candidates[0].paraIndex });
  }

  return {
    refs,
    clauseDefs: merged.defs,
    footnoteDefs: mergedFn.defs,
    renames,
  };
}
