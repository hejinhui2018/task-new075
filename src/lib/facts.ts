/**
 * 承诺事实抽取与身份匹配。
 *
 * 从段落文本中识别带稳定身份的「承诺事实」：金额、比例、日期、时长、数量。
 * 每条事实的身份由**语义槽位**（slot）决定——即它所属的承诺主题（如「迁移窗口」「合计」），
 * 而不是数字文本本身。因此：
 * - 「交付 30 天」与「退款 30 天」是两条不同事实（slot 不同），不会按文本值误配；
 * - 品牌版把「迁移窗口 30 天」改成「45 天」后，slot 不变 → 同一身份、值发生变化。
 *
 * 身份匹配跨版本进行：同一底稿段落（经 diff 对应）+ 同一 slot → 同一事实身份。
 */

import { parseChineseNumber } from './cnnum';

export type FactKind = 'amount' | 'percent' | 'date' | 'duration' | 'count';

/** 归一化后的事实值（金额归一到元、时长归一到天、比例归一到 0~1）。 */
export type FactValue =
  | { kind: 'amount'; yuan: number }
  | { kind: 'percent'; ratio: number }
  | { kind: 'date'; year: number; month: number | null; day: number | null; start: number; end: number }
  | { kind: 'duration'; days: number }
  | { kind: 'count'; value: number; unit: string };

export interface Fact {
  /** 稳定身份：`${slot}`，同段同 slot 多条时带 `#n` 后缀。 */
  id: string;
  kind: FactKind;
  value: FactValue;
  /** 原文片段，如「120万元」「45天」。 */
  raw: string;
  /** 所在段落下标（0 起）。 */
  paraIndex: number;
  /** 在段落文本中的偏移（用于候选替换）。 */
  start: number;
  end: number;
  /** 语义槽位（身份核心），如「迁移窗口:duration」。 */
  slot: string;
  /** 主题词上下文，如「迁移窗口」。 */
  context: string;
  /** 角色：定义值 def / 派生值 derived（合计、脚注与口径表述）。 */
  role: 'def' | 'derived';
}

/** 值的可比较序列化（用于基线对比与一致性判断）。 */
export function valueKey(value: FactValue): string {
  switch (value.kind) {
    case 'amount':
      return `amount:${value.yuan}`;
    case 'percent':
      return `percent:${value.ratio}`;
    case 'date':
      return `date:${value.start}-${value.end}`;
    case 'duration':
      return `duration:${value.days}`;
    case 'count':
      return `count:${value.value}:${value.unit}`;
  }
}

/** 两个归一化值是否等价（单位换算后一致即等价）。 */
export function valuesEqual(a: FactValue, b: FactValue): boolean {
  return valueKey(a) === valueKey(b);
}

// ———————————————————— 数值解析 ————————————————————

const CN_NUM_CHARS = '零一二两三四五六七八九十百千万亿';
/** 数字主体：阿拉伯（可带小数）或中文数词。 */
const NUM = String.raw`(?:\d+(?:\.\d+)?|[${CN_NUM_CHARS}]+)`;

/** 把数字主体（阿拉伯 / 中文 / 混合「1.5万」的主体部分）解析为数值。 */
function parseNumber(raw: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return parseChineseNumber(raw);
}

const AMOUNT_UNIT_SCALE: Record<string, number> = {
  元: 1,
  万: 1e4,
  百万: 1e6,
  千万: 1e7,
  亿: 1e8,
};

const DURATION_UNIT_DAYS: Record<string, number> = {
  天: 1,
  日: 1,
  工作日: 1,
  周: 7,
  星期: 7,
  个月: 30,
  月: 30,
  年: 365,
};

// ———————————————————— 候选扫描 ————————————————————

interface Candidate {
  start: number;
  end: number;
  kind: FactKind;
  value: FactValue;
  raw: string;
}

/** 各类事实的正则。注意顺序即优先级（日期优先，避免「2026年」被当时长）。 */
const PATTERNS: Array<{ kind: FactKind; re: RegExp; build: (m: RegExpMatchArray) => FactValue | null }> = [
  {
    // 完整日期：2026年9月10日
    kind: 'date',
    re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
    build: (m) => {
      const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const key = year * 10000 + month * 100 + day;
      return { kind: 'date', year, month, day, start: key, end: key };
    },
  },
  {
    // 季度：2026年第四季度 / 2026年第4季度
    kind: 'date',
    re: /(\d{4})\s*年\s*第?\s*([一二三四1-4])\s*季度/g,
    build: (m) => {
      const year = Number(m[1]);
      const q = parseNumber(m[2]);
      if (q === null || q < 1 || q > 4) return null;
      const startMonth = (q - 1) * 3 + 1;
      return {
        kind: 'date',
        year,
        month: null,
        day: null,
        start: year * 10000 + startMonth * 100 + 1,
        end: year * 10000 + (startMonth + 2) * 100 + 31,
      };
    },
  },
  {
    // 月份：2026年9月（不带日）
    kind: 'date',
    re: /(\d{4})\s*年\s*(\d{1,2})\s*月(?!\s*\d)/g,
    build: (m) => {
      const [year, month] = [Number(m[1]), Number(m[2])];
      if (month < 1 || month > 12) return null;
      return {
        kind: 'date',
        year,
        month,
        day: null,
        start: year * 10000 + month * 100 + 1,
        end: year * 10000 + month * 100 + 31,
      };
    },
  },
  {
    // 金额：120万元 / 5000万 / 1.2亿元 / 六十万元
    kind: 'amount',
    re: new RegExp(String.raw`(${NUM})\s*(亿|千万|百万|万)?\s*元`, 'g'),
    build: (m) => {
      const n = parseNumber(m[1]);
      if (n === null) return null;
      const scale = m[2] ? AMOUNT_UNIT_SCALE[m[2]] : 1;
      return { kind: 'amount', yuan: n * scale };
    },
  },
  {
    // 比例：30% / 百分之三十（归一到 0~1，并消除浮点尾差）
    kind: 'percent',
    re: new RegExp(String.raw`(${NUM})\s*%|百分之(${NUM})`, 'g'),
    build: (m) => {
      const n = parseNumber(m[1] ?? m[2]);
      if (n === null) return null;
      return { kind: 'percent', ratio: Math.round(n * 10000) / 1000000 };
    },
  },
  {
    // 时长：30天 / 五个工作日 / 两周 / 三年 / 六个月
    kind: 'duration',
    re: new RegExp(String.raw`(${NUM})\s*(个)?(工作日|天|周|星期|个月|年)(?![月号日])`, 'g'),
    build: (m) => {
      const n = parseNumber(m[1]);
      if (n === null) return null;
      // 「成立于2018年」这类年份不是时长：年/月单位配大数值时排除。
      if ((m[3] === '年' || m[3] === '个月') && n >= 100) return null;
      const days = n * DURATION_UNIT_DAYS[m[3]];
      return { kind: 'duration', days };
    },
  },
  {
    // 数量：十二家 / 一百家 / 三项
    kind: 'count',
    re: new RegExp(String.raw`(${NUM})\s*(家|个|名|人|次|项|款)`, 'g'),
    build: (m) => {
      const n = parseNumber(m[1]);
      if (n === null) return null;
      return { kind: 'count', value: n, unit: m[2] };
    },
  },
];

/** 扫描一段文本，返回按位置排序、去重叠的事实候选。 */
function scanParagraph(text: string): Candidate[] {
  const all: Candidate[] = [];
  for (const { kind, re, build } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = build(m);
      if (!value) continue;
      all.push({ start: m.index, end: m.index + m[0].length, kind, value, raw: m[0] });
    }
  }
  // 按位置扫描去重叠：同起点时优先级（PATTERNS 顺序）高者、更长者胜；
  // 位置不重叠的候选互不干扰（「三项」与「120万元」可共存）。
  const priority = new Map(PATTERNS.map((p, i) => [p.kind, i]));
  const kept: Candidate[] = [];
  let occupiedUntil = -1;
  for (const c of all.sort((a, b) => a.start - b.start || priority.get(a.kind)! - priority.get(b.kind)! || b.end - a.end)) {
    if (c.start < occupiedUntil) continue;
    kept.push(c);
    occupiedUntil = c.end;
  }
  return kept;
}

// ———————————————————— 语义槽位（身份） ————————————————————

/**
 * 主题词表：数字前后窗口内出现的、能标识承诺主题的词。
 * 排序有意义：更具体的词优先被选中。
 */
export const TOPIC_WORDS = [
  '覆盖率', '增长率', '合计', '总计', '总额', '预算', '交付', '迁移', '发布', '宣布',
  '公测', '试点', '上线', '退款', '赔偿', '费用', '投入', '成本', '期限', '窗口', '工期', '占比',
];

/** 窗口半径：数字前 / 后各取多少字符找主题词。 */
const WINDOW_BEFORE = 14;
const WINDOW_AFTER = 12;

/** 修饰前缀最大长度（「平台开发费用」中的「平台开发」）。 */
const PREFIX_MAX = 4;

const CJK = /[一-鿿㐀-䶿]/;

/**
 * 为候选事实确定语义槽位上下文：
 * 1. 在数字前后窗口内找最近的主题词（前窗优先，同距取前）；
 * 2. 窗口内没有 → 在整个段落内找第一个主题词（段落级主题回退）；
 * 3. 仍没有 → 用段落开头片段作为上下文；
 * 4. 对「费用」等泛化主题词，向前吸收修饰语（遇到其他主题词停止），
 *    使「平台开发费用」「安全审计费用」获得不同身份。
 */
function resolveContext(text: string, start: number, end: number): string {
  const beforeStart = Math.max(0, start - WINDOW_BEFORE);
  const before = text.slice(beforeStart, start);
  const after = text.slice(end, Math.min(text.length, end + WINDOW_AFTER));

  let topic: string | null = null;
  let topicAbs = -1; // 主题词在全文中的绝对位置
  for (const w of TOPIC_WORDS) {
    const idx = before.lastIndexOf(w);
    // 选离数字最近（绝对下标最大）的主题词
    if (idx >= 0 && beforeStart + idx > topicAbs) {
      topic = w;
      topicAbs = beforeStart + idx;
    }
  }
  if (!topic) {
    let bestAfter = -1;
    for (const w of TOPIC_WORDS) {
      const idx = after.indexOf(w);
      if (idx >= 0 && (bestAfter < 0 || idx < bestAfter)) {
        topic = w;
        bestAfter = idx;
      }
    }
  }
  if (!topic) {
    for (const w of TOPIC_WORDS) {
      if (text.includes(w)) {
        topic = w;
        break;
      }
    }
  }
  if (!topic) {
    // 无主题词：用段落开头片段（去标点）作为上下文，保证同段同 kind 可区分。
    const head = text.slice(0, 8).replace(/[，。、：；「」【】（）()\s]/g, '');
    return head || '未命名';
  }

  // 泛化主题词向前吸收修饰语：「平台开发|费用」「安全审计|费用」；
  // 前缀触及另一个主题词时吸收该词后停止（「退款|期限」→「退款期限」）。
  if (topicAbs >= 0) {
    let i = topicAbs;
    let prefix = '';
    while (i > 0 && prefix.length < PREFIX_MAX) {
      const ch = text[i - 1];
      if (!CJK.test(ch) || ch === '的') break;
      prefix = ch + prefix;
      i -= 1;
      if (TOPIC_WORDS.some((w) => w !== topic && prefix.endsWith(w))) break;
    }
    if (prefix) return prefix + topic;
  }
  return topic;
}

/** 从单个文档的段落中抽取事实（slot 内同段重复时加 `#n` 消歧）。 */
export function extractFacts(paragraphs: string[]): Fact[] {
  const facts: Fact[] = [];
  paragraphs.forEach((text, paraIndex) => {
    const candidates = scanParagraph(text);
    const slotCount = new Map<string, number>();
    for (const c of candidates) {
      const context = resolveContext(text, c.start, c.end);
      const baseSlot = `${context}:${c.kind}`;
      const n = slotCount.get(baseSlot) ?? 0;
      slotCount.set(baseSlot, n + 1);
      const slot = n === 0 ? baseSlot : `${baseSlot}#${n + 1}`;
      const derived =
        /^(脚注|注[:：]|※)/.test(text) || // 脚注段
        /数据来源|口径/.test(text) || // 口径/来源说明段（含免责声明中的口径表述）
        /合计|总计/.test(context); // 合计类主题
      facts.push({
        id: slot,
        kind: c.kind,
        value: c.value,
        raw: c.raw,
        paraIndex,
        start: c.start,
        end: c.end,
        slot,
        context,
        role: derived ? 'derived' : 'def',
      });
    }
  });
  return facts;
}

// ———————————————————— 跨版本身份匹配 ————————————————————

export type DocName = 'base' | 'brand' | 'legal' | 'merged';

/**
 * 一条事实身份：同一承诺在不同文档中的取值。
 * 通过底稿段落坐标 + slot 对齐，与具体数值无关。
 */
export interface FactIdentity {
  /** 身份 id：`${baseAnchor}:${slot}`（新增段落用来源文档坐标）。 */
  id: string;
  slot: string;
  kind: FactKind;
  context: string;
  /** 各文档中出现的事实（按文档名）。 */
  occurrences: Partial<Record<DocName, Fact>>;
}

/**
 * 把某版本的事实挂到底稿坐标系上：
 * baseAnchor = 该事实段落在底稿中的对应段号（新增段落为 undefined）。
 */
export interface Alignment {
  /** 段落下标 → 底稿段落下标（新增段落为 undefined）。 */
  paraToBase: Array<number | undefined>;
}

/**
 * 建立事实身份表：以底稿事实为锚，把品牌版 / 法务版 / 合并稿中
 * 同段落（经对齐）且同 slot 的事实归入同一身份。
 */
export function buildIdentities(
  baseFacts: Fact[],
  sideFacts: Array<{ doc: DocName; facts: Fact[]; align: Alignment }>,
): FactIdentity[] {
  const map = new Map<string, FactIdentity>();
  const key = (anchor: string, slot: string) => `${anchor}::${slot}`;

  for (const f of baseFacts) {
    const id = key(`b${f.paraIndex}`, f.slot);
    map.set(id, { id, slot: f.slot, kind: f.kind, context: f.context, occurrences: { base: f } });
  }
  for (const { doc, facts, align } of sideFacts) {
    for (const f of facts) {
      const baseIdx = align.paraToBase[f.paraIndex];
      const anchor = baseIdx !== undefined ? `b${baseIdx}` : `${doc}-p${f.paraIndex}`;
      const id = key(anchor, f.slot);
      const existing = map.get(id);
      if (existing) {
        existing.occurrences[doc] = f;
      } else {
        map.set(id, { id, slot: f.slot, kind: f.kind, context: f.context, occurrences: { [doc]: f } });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
