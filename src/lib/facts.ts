/**
 * 承诺事实抽取与身份匹配。
 *
 * 从段落文本中识别五类承诺事实：金额、比例、日期、时长、数量，
 * 解析为规范化数值（金额→元、时长→天、比例→%、日期→可比序数、数量→个），
 * 并从数字左侧的上下文提取语义标签（如「退款期限」「费用合计」）。
 *
 * 事实身份 = 所在条目 + 类别 + 语义标签，与数值无关：
 * 同一个「30 天」出现在不同承诺中不会被按文本值误配；
 * 跨版本（底稿/品牌/法务/合并）匹配同一事实时只看标签与类别，不看数值。
 */

import { similarity } from './tokenize';

export type FactKind = 'amount' | 'ratio' | 'date' | 'duration' | 'quantity';

export const KIND_LABEL: Record<FactKind, string> = {
  amount: '金额',
  ratio: '比例',
  date: '日期',
  duration: '时长',
  quantity: '数量',
};

export interface Fact {
  /** 稳定身份：条目 id + 类别 + 标签 + 同类序号。 */
  id: string;
  kind: FactKind;
  /** 语义标签（从数字左侧上下文提取）。 */
  label: string;
  /** 匹配用规范化标签。 */
  labelKey: string;
  /**
   * 规范化数值：金额→元；比例→%；时长→天；数量→个；
   * 日期→ y*10000+m*100+d（缺年份时→ m*100+d 且 yearless=true；
   * 季度→ 该季末月 28 日）。
   */
  value: number;
  /** 规范化单位：CNY / percent / day / count / date。 */
  unit: string;
  /** 原文片段，如「120 万元」。 */
  raw: string;
  /** raw 中的数字部分，如「120」或「一百二十」。 */
  rawNumber: string;
  /** 原文单位，如「万元」「个月」「%」「家分行」。 */
  unitRaw: string;
  /** 数量类的名词（分行/机构…），用于区分「12 家分行」与「12 名员工」。 */
  noun?: string;
  /** 日期缺年份（需在同式范围内继承）。 */
  yearless?: boolean;
  /** 派生值（合计/总计/共计/总额/小计）。 */
  derived: boolean;
  /** 在段落文本中的偏移。 */
  start: number;
  end: number;
  /** 所在条目 id（合并条目 id 或 b{i} 等）。 */
  entryId: string;
}

// —— 中文数字 ——

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_SMALL: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_BIG: Record<string, number> = { 万: 1e4, 亿: 1e8 };

/** 解析中文整数（如 十二→12、一百二十→120、五千→5000），无法解析返回 null。 */
export function parseChineseNumeral(s: string): number | null {
  if (!s) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      number = CN_DIGIT[ch];
    } else if (ch in CN_SMALL) {
      section += (number === 0 ? 1 : number) * CN_SMALL[ch];
      number = 0;
    } else if (ch in CN_BIG) {
      section = (section + number) * CN_BIG[ch];
      total += section;
      section = 0;
      number = 0;
    } else {
      return null;
    }
  }
  return total + section + number;
}

/** 把 0~99999999 的整数写成中文数字（90→九十、120→一百二十），超出范围返回 null。 */
export function numberToChinese(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 99_999_999) return null;
  if (n === 0) return '零';
  const digits = '零一二三四五六七八九';
  const small = ['', '十', '百', '千'];
  const four = (x: number): string => {
    let s = '';
    let zero = false;
    const str = String(x);
    for (let i = 0; i < str.length; i++) {
      const d = +str[i];
      const pos = str.length - 1 - i;
      if (d === 0) {
        zero = true;
        continue;
      }
      if (zero && s) s += '零';
      zero = false;
      s += digits[d] + small[pos];
    }
    return s;
  };
  const yi = Math.floor(n / 1e8);
  const wan = Math.floor((n % 1e8) / 1e4);
  const rest = n % 1e4;
  let out = '';
  if (yi) out += `${four(yi)}亿`;
  if (wan) out += `${four(wan)}万`;
  if (rest) {
    if (wan && rest < 1000) out += '零';
    out += four(rest);
  }
  return out.replace(/^一十/, '十');
}

/** 解析数字原文（阿拉伯数字含千分位/小数，或中文整数）。 */
export function parseNumber(raw: string): number | null {
  if (/^[零〇一二两三四五六七八九十百千万亿]+$/.test(raw)) return parseChineseNumeral(raw);
  const n = parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const NUM = '(?:\\d+(?:,\\d{3})*(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万亿]+)';

// —— 语义标签提取 ——

/** 数字左侧的虚词前缀（标签剥离用）。 */
const FN_PREFIX = /^(?:为|是|约|共|计|达|近|超过|超|不少于|不低于|不超过|不足|至多|至少|降至|提升至|提高到|提高|人民币|每|年均|预计|将|在|需|自|从)+/;
/** 数字左侧的虚词后缀（如「对账周期不超过 10 天」中的「不超过」）。 */
const FN_SUFFIX = /(?:为|是|在|需|不超过|不少于|不低于|不足|超过|超|约|达|近|至|到)+$/;
/** 派生值（合计类）关键词。 */
const DERIVED_RE = /(合计|总计|共计|总额|小计)/;

const countCjk = (s: string): number => (s.match(/[一-鿿]/g) ?? []).length;

/**
 * 从数字左侧 16 字窗口提取语义标签：
 * 从右往左取标点分隔的片段，剥掉虚词，第一个含 ≥2 个汉字的片段即标签。
 * 同时识别「合计/总计」等派生关键词。
 */
export function extractLabel(text: string, start: number): { label: string; derived: boolean } {
  const window = text.slice(Math.max(0, start - 16), start);
  const segments = window.split(/[，。、；：：（）()【】「」“”‘’\s·]/).filter(Boolean);
  let derived = false;
  for (let i = segments.length - 1; i >= 0; i--) {
    let seg = segments[i];
    if (DERIVED_RE.test(seg)) derived = true;
    seg = seg.replace(DERIVED_RE, '');
    seg = seg.replace(FN_PREFIX, '').replace(FN_SUFFIX, '');
    if (countCjk(seg) >= 2) return { label: seg.slice(-12), derived };
  }
  return { label: '', derived };
}

/** 段落主题兜底标签（取首个分句，去掉脚注号/书名号等前缀）。 */
function paragraphTopic(text: string): string {
  const first = text.split(/[，。、；：：（）()【】「」“”‘’\s·]/).filter(Boolean)[0] ?? '';
  const cleaned = first.replace(/^注\s*\d+/, '').replace(FN_PREFIX, '');
  return cleaned.slice(0, 12);
}

// —— 各类事实的正则 ——

/** 日期：2026年9月10日 / 9月10日 / 2026年9月 / 9月。 */
const DATE_RE = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(?:(\d{1,2})\s*日)?/g;
/** 季度：2026年第四季度 / 第2季度。 */
const QUARTER_RE = /(?:(\d{4})\s*年\s*)?第?([一二三四1-4])\s*季度/g;
/** 时长：30天 / 3个月 / 两年 / 1.5个月 / 三星期。 */
const DURATION_RE = /([零〇一二两三四五六七八九十百千万]+|\d+(?:\.\d+)?)\s*(个)?\s*(星期|周|天|日|月|年)/g;
/** 金额：120万元 / 合计 120 万（需金额语境）/ ¥100 / 人民币5000元 / 1.5亿元。 */
const AMOUNT_RE = new RegExp(`(人民币|¥|￥)?\\s*(${NUM})\\s*(亿|万)?\\s*(元)?`, 'g');
/** 比例：30% / 105％ / 百分之三十 / 百分之三点五。 */
const RATIO_RE = /(\d+(?:\.\d+)?)\s*[％%]|百分之([零〇一二两三四五六七八九十百千万]+(?:点[零〇一二三四五六七八九]+)?)/g;
/** 数量：十二家分行 / 一百家机构 / 3 款产品。 */
const QUANTITY_RE = /([零〇一二两三四五六七八九十百千万]+|\d+(?:\.\d+)?)\s*(家|个|名|位|项|次|款|所|批|类)(分行|机构|企业|客户|用户|员工|产品|国家|城市|医院|学校)?/g;

/** 金额语境词：「5000 万」只有带这些语境才按金额抽取。 */
const MONEY_CUE_RE = /(费|预算|投入|资金|成本|合计|总计|共计|总额|报价|售价|金额|价款|元|人民币|¥|￥)/;

const DURATION_SCALE: Record<string, number> = {
  天: 1, 日: 1, 周: 7, 星期: 7, 月: 30, 个月: 30, 年: 365,
};

/** 百分比中的中文小数（三点五 → 3.5）。 */
function parseCnPercent(s: string): number | null {
  const [intPart, fracPart] = s.split('点');
  const int = parseChineseNumeral(intPart);
  if (int === null) return null;
  if (!fracPart) return int;
  let frac = 0;
  for (let i = 0; i < fracPart.length; i++) {
    const d = CN_DIGIT[fracPart[i]];
    if (d === undefined) return null;
    frac += d * 10 ** -(i + 1);
  }
  return int + frac;
}

interface Span {
  start: number;
  end: number;
}

const overlaps = (spans: Span[], s: number, e: number): boolean =>
  spans.some((p) => s < p.end && e > p.start);

/**
 * 抽取一段文本中的全部承诺事实。
 * 顺序：日期 → 季度 → 时长 → 金额 → 比例 → 数量；先抽取的类别占用其字符区间，
 * 后续类别跳过重叠部分（避免「2026 年」被当时长、「3 个月」被当数量）。
 */
export function extractFacts(text: string, entryId: string): Fact[] {
  const facts: Fact[] = [];
  const occupied: Span[] = [];
  const labelCache = new Map<number, { label: string; derived: boolean }>();
  const labelAt = (pos: number) => {
    let hit = labelCache.get(pos);
    if (!hit) {
      hit = extractLabel(text, pos);
      labelCache.set(pos, hit);
    }
    return hit;
  };

  const push = (f: Omit<Fact, 'id' | 'label' | 'labelKey' | 'derived' | 'entryId'>, start: number) => {
    const { label, derived } = labelAt(start);
    const finalLabel = label || paragraphTopic(text) || KIND_LABEL[f.kind];
    facts.push({
      ...f,
      id: '', // 排序后统一编号
      label: finalLabel,
      labelKey: finalLabel,
      derived: f.kind === 'amount' || f.kind === 'quantity' ? derived : false,
      entryId,
    });
    occupied.push({ start: f.start, end: f.end });
  };

  // 日期（含缺年份）
  for (const m of text.matchAll(DATE_RE)) {
    const [raw, y, mo, d] = m;
    const start = m.index;
    push(
      {
        kind: 'date',
        value: (y ? +y * 10000 : 0) + +mo * 100 + (d ? +d : 0),
        unit: 'date',
        raw,
        rawNumber: raw.replace(/[年月日\s]/g, '-'),
        unitRaw: 'date',
        yearless: !y,
        start,
        end: start + raw.length,
      },
      start,
    );
  }
  // 季度
  for (const m of text.matchAll(QUARTER_RE)) {
    const [raw, y, q] = m;
    if (overlaps(occupied, m.index, m.index + raw.length)) continue;
    const qn = parseNumber(q);
    if (qn === null || qn < 1 || qn > 4) continue;
    push(
      {
        kind: 'date',
        value: (y ? +y * 10000 : 0) + qn * 3 * 100 + 28,
        unit: 'date',
        raw,
        rawNumber: q,
        unitRaw: '季度',
        yearless: !y,
        start: m.index,
        end: m.index + raw.length,
      },
      m.index,
    );
  }
  // 时长
  for (const m of text.matchAll(DURATION_RE)) {
    const [raw, numRaw, ge, unitRaw] = m;
    if (overlaps(occupied, m.index, m.index + raw.length)) continue;
    // 「2026 年」是年份不是时长
    if (unitRaw === '年' && /^\d{4}$/.test(numRaw)) continue;
    const num = parseNumber(numRaw);
    if (num === null) continue;
    const unit = ge && unitRaw === '月' ? '个月' : unitRaw;
    const scale = DURATION_SCALE[unit];
    if (!scale) continue;
    push(
      {
        kind: 'duration',
        value: num * scale,
        unit: 'day',
        raw,
        rawNumber: numRaw,
        unitRaw: unit,
        start: m.index,
        end: m.index + raw.length,
      },
      m.index,
    );
  }
  // 金额
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [rawFull, ccy, numRaw, big, yuan] = m;
    // 货币符号后的空白会被并进匹配，剥掉前导空白
    const raw = rawFull.replace(/^\s+/, '');
    const start = m.index + (rawFull.length - raw.length);
    if (overlaps(occupied, start, start + raw.length)) continue;
    if (!yuan && !ccy) {
      // 没有「元」或货币符号时，需要 万/亿 + 金额语境
      if (!big) continue;
      const ctx = text.slice(Math.max(0, start - 16), Math.min(text.length, start + raw.length + 4));
      if (!MONEY_CUE_RE.test(ctx)) continue;
    }
    const num = parseNumber(numRaw);
    if (num === null) continue;
    const scale = big === '亿' ? 1e8 : big === '万' ? 1e4 : 1;
    push(
      {
        kind: 'amount',
        value: num * scale,
        unit: 'CNY',
        raw,
        rawNumber: numRaw,
        unitRaw: `${big ?? ''}元`,
        start,
        end: start + raw.length,
      },
      start,
    );
  }
  // 比例
  for (const m of text.matchAll(RATIO_RE)) {
    const [raw, pct, cn] = m;
    if (overlaps(occupied, m.index, m.index + raw.length)) continue;
    const value = pct !== undefined ? parseFloat(pct) : parseCnPercent(cn);
    if (value === null || Number.isNaN(value)) continue;
    push(
      {
        kind: 'ratio',
        value,
        unit: 'percent',
        raw,
        rawNumber: pct ?? cn,
        unitRaw: '%',
        start: m.index,
        end: m.index + raw.length,
      },
      m.index,
    );
  }
  // 数量
  for (const m of text.matchAll(QUANTITY_RE)) {
    const [raw, numRaw, measure, noun] = m;
    if (overlaps(occupied, m.index, m.index + raw.length)) continue;
    const num = parseNumber(numRaw);
    if (num === null) continue;
    push(
      {
        kind: 'quantity',
        value: num,
        unit: 'count',
        raw,
        rawNumber: numRaw,
        unitRaw: `${measure}${noun ?? ''}`,
        noun,
        start: m.index,
        end: m.index + raw.length,
      },
      m.index,
    );
  }

  facts.sort((a, b) => a.start - b.start);
  // 稳定身份：条目 + 类别 + 标签 + 同类序号（与数值无关）
  const occ = new Map<string, number>();
  for (const f of facts) {
    const key = `${f.kind}:${f.labelKey}`;
    const n = occ.get(key) ?? 0;
    occ.set(key, n + 1);
    f.id = `${f.entryId}#${key}#${n}`;
  }
  return facts;
}

// —— 单位与数值比较 ——

const EPS = 1e-6;

/** 规范化数值是否相等（单位已在抽取时换算，故直接比较）。 */
export function valuesEqual(a: Fact, b: Fact): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'date') {
    if (a.yearless !== b.yearless) return false; // 缺年份的日期不与完整日期比较
    return a.value === b.value;
  }
  const scale = Math.max(1, Math.abs(a.value), Math.abs(b.value));
  return Math.abs(a.value - b.value) <= EPS * scale;
}

/** 两个事实是否单位兼容（同类；数量类还要求名词一致或其一缺省）。 */
export function unitsCompatible(a: Fact, b: Fact): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'quantity') return !a.noun || !b.noun || a.noun === b.noun;
  return true;
}

/** 标签相似度阈值：跨版本匹配同一事实。 */
export const LABEL_MATCH_THRESHOLD = 0.6;
/** 标签相似度阈值：合并稿内归并同一事实（跨段落口径检查）。 */
export const LABEL_GROUP_THRESHOLD = 0.75;

/**
 * 身份匹配：把两段文本（通常是同一条目的两个版本）抽出的事实配对。
 * 只看类别 + 单位兼容 + 标签相似度，绝不看数值——
 * 「退款期限 30 天」与「退款期限 45 天」是同一事实的新旧值；
 * 「退款期限 30 天」与「公测周期 30 天」是两个不同事实。
 */
export function matchFacts(a: Fact[], b: Fact[]): Array<[Fact | undefined, Fact | undefined]> {
  const scored: Array<{ i: number; j: number; s: number }> = [];
  a.forEach((fa, i) =>
    b.forEach((fb, j) => {
      if (!unitsCompatible(fa, fb)) return;
      const s = fa.labelKey === fb.labelKey ? 1 : similarity(fa.labelKey, fb.labelKey);
      if (s >= LABEL_MATCH_THRESHOLD) scored.push({ i, j, s });
    }),
  );
  scored.sort((x, y) => y.s - x.s);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: Array<[Fact | undefined, Fact | undefined]> = [];
  for (const { i, j } of scored) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    pairs.push([a[i], b[j]]);
  }
  a.forEach((fa, i) => {
    if (!usedA.has(i)) pairs.push([fa, undefined]);
  });
  b.forEach((fb, j) => {
    if (!usedB.has(j)) pairs.push([undefined, fb]);
  });
  return pairs;
}

/**
 * 把新数值按原文的单位和数字风格格式化（用于同步更新候选）。
 * 如「120 万元」→ 900000 元 →「90 万元」；「三十 天」→ 45 天 →「四十五 天」。
 * 无法格式化（如中文数字带小数）返回 null。
 */
export function formatValueForRaw(fact: Fact, newValue: number): string | null {
  const oldNum = parseNumber(fact.rawNumber);
  if (oldNum === null || oldNum === 0 || fact.value === 0) return null;
  const scale = fact.value / oldNum; // 原文单位的换算比例
  const scaled = newValue / scale;
  let numStr: string | null;
  if (/^\d/.test(fact.rawNumber)) {
    numStr = Number.isInteger(scaled) ? String(scaled) : String(+scaled.toFixed(2));
  } else {
    numStr = Number.isInteger(scaled) ? numberToChinese(scaled) : null;
    if (numStr === null) return null;
  }
  return fact.raw.replace(fact.rawNumber, numStr);
}

// —— 法务锁定段落 ——

/** 法务锁定：含声明/免责/合规/法规引用等内容的段落，系统不得自动改写。 */
export const LEGAL_LOCK_RE = /(声明|免责|合规|依法|监管|法律|司法|《[^》]*》)/;

export function isLegalLocked(text: string): boolean {
  return LEGAL_LOCK_RE.test(text);
}
