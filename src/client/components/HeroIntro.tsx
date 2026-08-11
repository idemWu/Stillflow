import { Check, Film, Sparkles, TimerReset } from 'lucide-react';

const PLATFORM_LABELS = ['YouTube', 'X / Twitter', 'TikTok', 'Instagram', 'Vimeo', 'Bilibili'];

export function HeroIntro(): React.JSX.Element {
  return (
    <section className="hero-intro" aria-labelledby="hero-title">
      <div className="eyebrow">
        <span className="eyebrow-dot" />
        授权内容 · 清晰导出
      </div>
      <h1 id="hero-title">
        一个链接，
        <br />
        取回<span className="accent-underline">原始清晰</span>视频
      </h1>
      <p className="hero-copy">
        粘贴你有权处理的视频链接，解析来源平台允许提供的清晰版本。
        净流不会为导出文件添加新水印。
      </p>

      <div className="capability-list" aria-label="产品能力">
        <div><Film size={18} /><span>多清晰度可选</span></div>
        <div><Sparkles size={18} /><span>原始媒体流</span></div>
        <div><TimerReset size={18} /><span>30 分钟自动清理</span></div>
      </div>

      <div className="platform-strip" id="platforms">
        <p>已适配主流公开链接</p>
        <div className="platform-pills">
          {PLATFORM_LABELS.map((label) => (
            <span key={label}><Check size={12} />{label}</span>
          ))}
          <span className="more-platforms">+ 抖音 / 快手</span>
        </div>
      </div>
    </section>
  );
}
