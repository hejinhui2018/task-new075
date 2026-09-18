/**
 * 分词、相似度与词级（字级）差异。
 *
 * 中文按单字切分，英文/数字按单词切分，标点与空白各自成词，
 * 这样长段落差异既能精确到字，又不会把英文单词拆碎。
 */

export type Token = string;

/** 把文本切成比较用 token：英文数字成词、CJK 单字、单个标点、空白成串。 */
export function tokenize(text: string): Token[] {
  return (
    text.match(
      /[A-Za-z0-9]+|[一-鿿㐀-䶿]|\s+|[^\sA-Za-z0-9一-鿿㐀-䶿]/g,
    ) ?? []
  );
}

/** 去掉纯空白 token（相似度计算不看空白）。 */
function contentTokens(text: string): Token[] {
  return tokenize(text).filter((t) => !/^\s+$/.test(t));
}

/** Dice 系数（基于 token 多重集），0~1，1 表示完全一致。 */
export function similarity(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts = new Map<Token, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let intersection = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      intersection += 1;
      counts.set(t, c - 1);
    }
  }
  return (2 * intersection) / (ta.length + tb.length);
}

/**
 * 通用 LCS：返回两组下标对（递增序列）。
 * 平局时优先「跳过右侧元素」，使移动识别更稳定
 * （倾向于把靠后的相同段落判为被移动的一方）。
 */
export function lcsPairs<T>(a: T[], b: T[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  pairs.reverse();
  return pairs;
}

export interface DiffPart {
  type: 'same' | 'del' | 'ins';
  text: string;
}

/** LCS 规模上限，超出则退化为「整段替换」，避免超长段落卡顿。 */
const TOKEN_DIFF_CELL_LIMIT = 4_000_000;

/**
 * 词级差异：先剥掉公共前后缀，再对中间部分做 LCS。
 * 返回的片段按顺序拼接即还原新文本。
 */
export function tokenDiff(oldText: string, newText: string): DiffPart[] {
  const ta = tokenize(oldText);
  const tb = tokenize(newText);

  let start = 0;
  while (start < ta.length && start < tb.length && ta[start] === tb[start]) start += 1;
  let endA = ta.length;
  let endB = tb.length;
  while (endA > start && endB > start && ta[endA - 1] === tb[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const parts: DiffPart[] = [];
  const push = (type: DiffPart['type'], tokens: Token[]) => {
    if (tokens.length === 0) return;
    const text = tokens.join('');
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };

  push('same', ta.slice(0, start));
  const midA = ta.slice(start, endA);
  const midB = tb.slice(start, endB);

  if (midA.length * midB.length > TOKEN_DIFF_CELL_LIMIT) {
    push('del', midA);
    push('ins', midB);
  } else {
    const pairs = lcsPairs(midA, midB);
    let pa = 0;
    let pb = 0;
    for (const [ia, ib] of pairs) {
      push('del', midA.slice(pa, ia));
      push('ins', midB.slice(pb, ib));
      push('same', [midA[ia]]);
      pa = ia + 1;
      pb = ib + 1;
    }
    push('del', midA.slice(pa));
    push('ins', midB.slice(pb));
  }

  push('same', ta.slice(endA));
  return parts;
}
