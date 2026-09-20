import type { FactIssue } from '../lib/checks';
import { DOC_LABEL, ISSUE_TYPE_LABEL } from '../lib/checks';
import type { SyncCandidate } from '../lib/propagate';
import type { FactBaseline, FactResolution } from '../lib/storage';

const ISSUE_ICON: Record<FactIssue['type'], string> = {
  'sum-mismatch': '∑',
  'date-order': '⧗',
  'percent-range': '％',
  'value-inconsistent': '⚖',
  'ref-unresolved': '⌦',
  'ref-ambiguous': '⧉',
  'ref-stale': '⇢',
};

interface FactPanelProps {
  issues: FactIssue[];
  candidates: SyncCandidate[];
  resolutions: Record<string, FactResolution>;
  baseline: FactBaseline | null;
  /** 较基线有变化的事实身份数。 */
  baselineChanged: number;
  activeIssueId: string | null;
  onLocate: (issue: FactIssue) => void;
  onApplyCandidate: (candidate: SyncCandidate) => void;
  onAcknowledge: (issueId: string) => void;
  onSetBaseline: () => void;
  onClearBaseline: () => void;
}

/** 事实完整性校核面板：事实冲突列表 + 同步更新候选 + 比较基线。 */
export function FactPanel(props: FactPanelProps) {
  const { issues, resolutions, baseline, baselineChanged } = props;
  const pending = issues.filter((i) => !resolutions[i.id]);
  const acknowledged = issues.filter((i) => resolutions[i.id]);

  return (
    <div className="fact-panel" aria-label="事实完整性校核">
      <div className="fact-panel-head">
        <span className="fact-panel-title">
          ⚖ 事实完整性校核
          {pending.length > 0 ? (
            <span className="status-pill status-fact">待处理 {pending.length}</span>
          ) : (
            <span className="status-pill status-resolved">全部通过</span>
          )}
          {acknowledged.length > 0 && <span className="fact-ack-count">已确认 {acknowledged.length}</span>}
        </span>
        <span className="fact-panel-actions">
          {baseline ? (
            <>
              <span className="baseline-note" title={baseline.savedAt}>
                基线已设{baselineChanged > 0 ? ` · ${baselineChanged} 项已变更` : ' · 无变更'}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={props.onSetBaseline}>
                更新基线
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={props.onClearBaseline}>
                清除基线
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={props.onSetBaseline}>
              设为比较基线
            </button>
          )}
        </span>
      </div>

      {issues.length === 0 && (
        <p className="fact-empty">合并稿中的金额、日期、比例、脚注与引用关系均未发现矛盾。</p>
      )}

      {pending.map((issue) => (
        <FactIssueCard key={issue.id} issue={issue} {...props} acknowledged={false} />
      ))}
      {acknowledged.map((issue) => (
        <FactIssueCard key={issue.id} issue={issue} {...props} acknowledged />
      ))}
    </div>
  );
}

function FactIssueCard({
  issue,
  candidates,
  activeIssueId,
  acknowledged,
  onLocate,
  onApplyCandidate,
  onAcknowledge,
}: FactPanelProps & { issue: FactIssue; acknowledged: boolean }) {
  const issueCandidates = candidates.filter((c) => c.issueId === issue.id);
  const classes = [
    'fact-card',
    acknowledged ? 'fact-card-ack' : '',
    activeIssueId === issue.id ? 'nav-active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes} id={`fact-${issue.id}`} aria-label={issue.title}>
      <header className="entry-head">
        <span className="fact-flag" role="img" aria-label="事实冲突">
          {ISSUE_ICON[issue.type]}
        </span>
        <strong>{issue.title}</strong>
        <span className="badge tone-fact">{ISSUE_TYPE_LABEL[issue.type]}</span>
        {acknowledged && <span className="status-pill status-resolved">已确认</span>}
      </header>

      <p className="fact-detail">{issue.detail}</p>

      {/* 依赖链：定义值 → 派生值 / 引用 */}
      <ol className="fact-chain">
        {issue.chain.map((node, i) => (
          <li key={i} className={node.stale ? 'chain-stale' : ''}>
            <span className="chain-label">{node.label}</span>
            <code className="chain-raw">{node.raw}</code>
            <span className="chain-doc">{DOC_LABEL[node.doc]} §{node.paraIndex + 1}</span>
            {node.stale && <span className="chain-stale-tag">过期</span>}
          </li>
        ))}
      </ol>

      <div className="fact-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onLocate(issue)}>
          ⌖ 定位来源
        </button>
        {!acknowledged && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onAcknowledge(issue.id)}>
            标记已确认
          </button>
        )}
      </div>

      {/* 同步更新候选 */}
      {issueCandidates.length > 0 && (
        <div className="sync-candidates">
          <div className="sync-title">同步更新候选</div>
          {issueCandidates.map((c) => (
            <div key={c.id} className={`sync-candidate${c.locked ? ' sync-locked' : ''}`}>
              <div className="sync-reason">
                {c.reason}
                <span className="sync-doc">{DOC_LABEL[c.doc]} §{c.paraIndex + 1}</span>
              </div>
              <div className="sync-diff">
                {c.replacements.map((r, i) => (
                  <span key={i}>
                    <del className="tok-del">{r.oldFragment}</del>
                    <span className="sync-arrow">→</span>
                    <ins className="tok-ins">{r.newFragment}</ins>
                  </span>
                ))}
              </div>
              {c.locked ? (
                <span className="sync-lock-note" title="法务锁定段落，系统不会自动改写">
                  🔒 法务锁定 · 请人工处理
                </span>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onApplyCandidate(c)}>
                  采用候选
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
