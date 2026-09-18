/**
 * 文本工具：段落切分、规范化。
 *
 * 约定：文档以「空行」分段；若整篇没有任何空行但存在单行换行，
 * 则退化为按单行分段（兼容直接从微信/邮件里粘贴的文本）。
 */

/** 把原始文本切分为段落数组（去掉空白段）。 */
export function splitParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  let parts = normalized.split(/\n\s*\n+/);
  if (parts.length === 1 && normalized.includes('\n')) {
    parts = normalized.split('\n');
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** 段落数组还原为文本（空行分隔）。 */
export function joinParagraphs(paragraphs: string[]): string {
  return paragraphs.join('\n\n');
}

/** 比较用规范化：压缩所有空白。显示时仍使用原文。 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
