import { useState } from 'react';
import type { FactIssue, FactReport, SyncCandidate } from '../lib/verify';
import { ISSUE_KIND_ICON, ISSUE_KIND_LABEL, SEVERITY_LABEL } from '../lib/viewmodel';

interface FactPanelProps {
  report: FactReport;
  /** 未确认的问题。 */
  pending: FactIssue[];
  /** 已确认忽略的问题。 */
  acked: FactIssue[];
  activeIssueId: string | null;
  /** 条目 id → 来源定位文字（如「底稿 §3 · 品牌 §3」）。 */
  entryLabel: (entryId: string) => string;
  onSelectIssue: (issue: FactIssue) => void;
  onLocateEntry: (entryId: string) => void;
  onApplyCandidate: (issue: FactIssue, cand: SyncCandidate) => void;
  onAck: (issue: FactIssue) => void;
  onUnack: (issue: FactIssue) => void;
}

/** 事实完整性校核面板：与文本合并冲突区分展示。 */
export function FactPanel(props: FactPanelProps) {
  const { report, pending, acked } = props;
  const [showAcked, setShowAcked] = useState(false);
  const ok = pending.length === 0;

  return (
    <section className="fact-panel" id="fact-panel" aria-label="事实完整性校核">
      <header className="fact-panel-head">
        <span className={`status-pill ${ok ? 'status-resolved' : 'status-fact'}`} aria-live="polite">
          {ok ? '✓ 事实校核通过' : `事实冲突 ${pending.length}`}
        </span>
        <span className="fact-panel-stats">
          抽取承诺事实 {report.factCount} 项 · 条款 {report.clauseCount} 条 · 引用 {report.refCount} 处
          {acked.length > 0 ? ` · 已确认 ${acked.length} 项` : ''}
        </span>
        {acked.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowAcked((v) => !v)}
          >
            {showAcked ? '收起已确认' : `查看已确认（${acked.length}）`}
          </button>
        )}
      </header>
      <div className="fact-issue-list">
        {pending.map((issue) => (
          <IssueCard key={issue.id} issue={issue} {...props} />
        ))}
        {showAcked &&
          acked.map((issue) => <IssueCard key={issue.id} issue={issue} ackedCard {...props} />)}
      </div>
    </section>
  );
}

function IssueCard({
  issue,
  ackedCard,
  activeIssueId,
  entryLabel,
  onSelectIssue,
  onLocateEntry,
  onApplyCandidate,
  onAck,
  onUnack,
}: FactPanelProps & { issue: FactIssue; ackedCard?: boolean }) {
  const active = activeIssueId === issue.id;
  const classes = [
    'fact-issue-card',
    `sev-${issue.severity}`,
    active ? 'active' : '',
    ackedCard ? 'acked' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={classes}
      id={`fact-${issue.id}`}
      onClick={() => onSelectIssue(issue)}
      aria-label={`事实冲突：${issue.title}`}
    >
      <header className="fact-issue-head">
        <span className="fact-issue-icon" aria-hidden="true">
          {ISSUE_KIND_ICON[issue.kind]}
        </span>
        <strong>
          {ISSUE_KIND_LABEL[issue.kind]} · {issue.title}
        </strong>
        <span className={`status-pill sev-pill-${issue.severity}`}>{SEVERITY_LABEL[issue.severity]}</span>
        {ackedCard && <span className="status-pill status-resolved">已确认</span>}
      </header>

      <p className="fact-message">{issue.message}</p>

      {issue.values && (
        <div className="fact-values">
          <span className="fact-values-label">来源 / 当前值：</span>
          底稿 {issue.values.base ?? '—'} · 品牌 {issue.values.brand ?? '—'} · 法务{' '}
          {issue.values.legal ?? '—'} ｜ <strong>合并当前值：{issue.values.merged}</strong>
        </div>
      )}

      {issue.chain.length > 0 && (
        <div className="fact-chain">
          <span className="fact-chain-label">依赖链：</span>
          <ul>
            {issue.chain.map((c, i) => (
              <li key={`${c.entryId}-${i}`} className={c.deleted ? 'chain-deleted' : ''}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onLocateEntry(c.entryId);
                  }}
                >
                  {c.label}：{c.raw}
                  {c.deleted ? '（已删除）' : ''}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="fact-affected">
        <span className="fact-affected-label">受影响表述：</span>
        {issue.entryIds.map((id) => (
          <button
            key={id}
            type="button"
            className="affected-chip"
            onClick={(e) => {
              e.stopPropagation();
              onLocateEntry(id);
            }}
          >
            {entryLabel(id) || id}
          </button>
        ))}
      </div>

      {(issue.candidates.length > 0 || !ackedCard) && (
        <div className="fact-actions" onClick={(e) => e.stopPropagation()}>
          {issue.candidates.map((cand) =>
            cand.locked ? (
              <span key={cand.id} className="locked-note" title="法务锁定段落，系统不自动改写">
                🔒 法务锁定，需手动修改（建议：{cand.description}）
              </span>
            ) : (
              <button
                key={cand.id}
                type="button"
                className="btn btn-fact btn-sm"
                onClick={() => onApplyCandidate(issue, cand)}
              >
                同步候选：{cand.description}
              </button>
            ),
          )}
          {ackedCard ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onUnack(issue)}>
              取消确认
            </button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onAck(issue)}>
              确认忽略
            </button>
          )}
        </div>
      )}
    </article>
  );
}
