import { CheckCircle2, Download, Link2, ScanSearch } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IMediaInfo } from '../shared/types';
import { HeroIntro } from './components/HeroIntro';
import { LegalFooter } from './components/LegalFooter';
import { ParseWorkbench } from './components/ParseWorkbench';
import { RecentJobs } from './components/RecentJobs';
import { SiteHeader } from './components/SiteHeader';
import type { IHistoryItem } from './types';

const HISTORY_KEY = 'jingliu:recent-media:v1';

function loadHistory(): IHistoryItem[] {
  try {
    const value = window.localStorage.getItem(HISTORY_KEY);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 4) as IHistoryItem[] : [];
  } catch {
    return [];
  }
}

function ProcessSection(): React.JSX.Element {
  const steps = [
    { number: '01', icon: Link2, title: '粘贴公开链接', copy: '自动识别来源平台并进行安全校验。' },
    { number: '02', icon: ScanSearch, title: '读取可用版本', copy: '只展示平台当前允许提供的媒体流。' },
    { number: '03', icon: Download, title: '导出到本机', copy: '实时显示进度，到期自动清理临时文件。' },
  ];

  return (
    <section className="process-section" id="how-it-works" aria-labelledby="process-title">
      <div className="process-heading">
        <span>HOW IT WORKS</span>
        <h2 id="process-title">三步，保持简单</h2>
        <p><CheckCircle2 size={15} />整个流程不要求提供平台账号或 Cookie。</p>
      </div>
      <div className="process-grid">
        {steps.map(({ number, icon: Icon, title, copy }) => (
          <article key={number}>
            <span className="process-number">{number}</span>
            <span className="process-icon"><Icon size={23} /></span>
            <h3>{title}</h3>
            <p>{copy}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function App(): React.JSX.Element {
  const [history, setHistory] = useState<IHistoryItem[]>(loadHistory);

  useEffect(() => {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history]);

  const handleParsed = (media: IMediaInfo): void => {
    const item: IHistoryItem = {
      id: media.id,
      title: media.title,
      author: media.author,
      thumbnailUrl: media.thumbnailUrl,
      platformId: media.platform.id,
      platformLabel: media.platform.label,
      durationSeconds: media.durationSeconds,
      createdAt: new Date().toISOString(),
    };
    setHistory((current) => [
      item,
      ...current.filter((entry) => !(entry.id === item.id && entry.platformId === item.platformId)),
    ].slice(0, 4));
  };

  return (
    <div className="app-shell" id="top">
      <div className="background-grid" aria-hidden="true" />
      <SiteHeader />
      <main>
        <section className="hero-layout">
          <HeroIntro />
          <ParseWorkbench onParsed={handleParsed} />
        </section>
        <ProcessSection />
        <RecentJobs items={history} onClear={() => setHistory([])} />
      </main>
      <LegalFooter />
    </div>
  );
}
