import { Clock3, FileVideo2, History, Trash2 } from 'lucide-react';
import type { IHistoryItem } from '../types';

interface IRecentJobsProps {
  items: IHistoryItem[];
  onClear: () => void;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '时长未知';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function RecentJobs({ items, onClear }: IRecentJobsProps): React.JSX.Element {
  return (
    <section className="recent-section" id="recent" aria-labelledby="recent-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">LOCAL HISTORY</span>
          <h2 id="recent-title">最近解析</h2>
          <p>只保存视频摘要，不保存原始链接。</p>
        </div>
        {items.length > 0 && (
          <button type="button" className="clear-history" onClick={onClear}>
            <Trash2 size={15} />清除记录
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="history-empty">
          <span><History size={25} /></span>
          <div><strong>还没有解析记录</strong><p>完成一次解析后，会显示在这里。</p></div>
        </div>
      ) : (
        <div className="history-grid">
          {items.map((item) => (
            <article className="history-card" key={`${item.platformId}-${item.id}`}>
              <div className="history-thumb">
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt="" referrerPolicy="no-referrer" loading="lazy" />
                ) : (
                  <FileVideo2 size={26} />
                )}
                <span>{item.platformLabel}</span>
              </div>
              <div className="history-copy">
                <h3 title={item.title}>{item.title}</h3>
                <p>{item.author ?? '作者信息未提供'}</p>
                <small><Clock3 size={12} />{formatDuration(item.durationSeconds)} · {new Date(item.createdAt).toLocaleDateString('zh-CN')}</small>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
