/**
 * 交叉引用抽取：条款（第 N 条）、条款引用（见第 N 条）与脚注（注 N）。
 *
 * 条款的「编号」按文档顺序位置计算（第 1 个条款段 = 第 1 条），
 * 标题里写的「第 N 条」只是名字——段落重排后编号随之变化，
 * 这正是「见第 4 条」在移动后指向另一件事的原因。
 *
 * 引用绑定按身份（条目 id）而非同名文本：
 * 底稿中「见第 4 条」绑定到底稿第 4 个条款所在条目；
 * 合并后即使出现同名的新条款，未确认的引用也不会悄悄绑定过去。
 */

import { parseChineseNumeral } from './facts';

export interface ClauseInfo {
  /** 所在条目 id（底稿为 b{i}，合并稿为条目 id）。 */
  entryId: string;
  /** 条款序号（1 起，按文档顺序）。 */
  position: number;
  /** 标题中的编号（第 N 条），无标题编号时为 null。 */
  titleNo: number | null;
  /** 条款开头片段（展示用）。 */
  heading: string;
}

export interface RefInfo {
  /** 引用键：条目 id + 条目内序号。 */
  key: string;
  entryId: string;
  occ: number;
  /** 引用的条款序号。 */
  no: number;
  /** 原文，如「第 4 条」。 */
  raw: string;
  /** raw 中的序号部分，如「4」或「四」。 */
  rawNumber: string;
}

const CLAUSE_RE = /^第\s*([0-9]+|[零〇一二两三四五六七八九十百千万]+)\s*条/;
const REF_RE = /第\s*([0-9]+|[零〇一二两三四五六七八九十百千万]+)\s*条/g;

/** 解析条款序号（阿拉伯或中文数字）。 */
export function parseOrdinal(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return parseChineseNumeral(s);
}

/** 抽取文档中的条款段（以「第 N 条」开头的段落），按顺序编号。 */
export function extractClauses(paras: Array<{ entryId: string; text: string }>): ClauseInfo[] {
  const out: ClauseInfo[] = [];
  for (const p of paras) {
    const m = p.text.match(CLAUSE_RE);
    if (!m) continue;
    out.push({
      entryId: p.entryId,
      position: out.length + 1,
      titleNo: parseOrdinal(m[1]),
      heading: p.text.slice(0, 18),
    });
  }
  return out;
}

/** 抽取一段文本中的条款引用（条款段自身的标题不算引用）。 */
export function extractRefs(entryId: string, text: string): RefInfo[] {
  const out: RefInfo[] = [];
  const isClause = CLAUSE_RE.test(text);
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let occ = 0;
  while ((m = REF_RE.exec(text))) {
    if (isClause && m.index === 0) continue;
    const no = parseOrdinal(m[1]);
    if (no === null) continue;
    out.push({ key: `${entryId}:${occ}`, entryId, occ, no, raw: m[0], rawNumber: m[1] });
    occ += 1;
  }
  return out;
}

// —— 脚注 ——

/** 脚注定义段：以「注 N：」开头。 */
export const FOOTNOTE_DEF_RE = /^注\s*([0-9]+)\s*[:：]/;
/** 正文脚注标记：（注 N）。 */
export const FOOTNOTE_MARK_RE = /[（(]\s*注\s*([0-9]+)\s*[）)]/g;

export function footnoteDefNo(text: string): number | null {
  const m = text.match(FOOTNOTE_DEF_RE);
  return m ? parseInt(m[1], 10) : null;
}

export interface FootnoteMark {
  entryId: string;
  no: number;
  raw: string;
}

export function extractFootnoteMarks(entryId: string, text: string): FootnoteMark[] {
  const out: FootnoteMark[] = [];
  FOOTNOTE_MARK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOOTNOTE_MARK_RE.exec(text))) {
    out.push({ entryId, no: parseInt(m[1], 10), raw: m[0] });
  }
  return out;
}

// —— 底稿引用绑定 ——

export interface RefBinding {
  refKey: string;
  /** 底稿中引用的序号。 */
  no: number;
  /** 绑定目标：底稿第 no 个条款所在条目 id。 */
  targetEntryId: string;
  targetHeading: string;
}

/**
 * 建立底稿的引用绑定：每条「见第 N 条」绑定到底稿中第 N 个条款的条目 id。
 * 合并后按条目 id 追踪目标的重命名、移动与删除。
 */
export function buildBaseBindings(baseParas: string[]): {
  clauses: ClauseInfo[];
  bindings: Map<string, RefBinding>;
} {
  const paras = baseParas.map((text, i) => ({ entryId: `b${i}`, text }));
  const clauses = extractClauses(paras);
  const bindings = new Map<string, RefBinding>();
  for (const p of paras) {
    for (const ref of extractRefs(p.entryId, p.text)) {
      const target = clauses.find((c) => c.position === ref.no);
      if (target) {
        bindings.set(ref.key, {
          refKey: ref.key,
          no: ref.no,
          targetEntryId: target.entryId,
          targetHeading: target.heading,
        });
      }
    }
  }
  return { clauses, bindings };
}
