import { useMemo } from 'react';
import { tokenDiff } from '../lib/tokenize';

/**
 * 词级（中文按字）差异展示：
 * 删除用 <del> 删除线、新增用 <ins> 下划线，配合文字说明，不只靠颜色区分。
 */
export function DiffText({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = useMemo(() => tokenDiff(oldText, newText), [oldText, newText]);
  return (
    <p className="diff-text">
      {parts.map((p, i) => {
        if (p.type === 'del') {
          return (
            <del key={i} className="tok-del" title="底稿中被删除的内容">
              {p.text}
            </del>
          );
        }
        if (p.type === 'ins') {
          return (
            <ins key={i} className="tok-ins" title="相对底稿新增的内容">
              {p.text}
            </ins>
          );
        }
        return <span key={i}>{p.text}</span>;
      })}
    </p>
  );
}
