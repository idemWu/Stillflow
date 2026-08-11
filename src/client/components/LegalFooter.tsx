import { ArrowUp, Code2, ShieldCheck } from 'lucide-react';

export function LegalFooter(): React.JSX.Element {
  return (
    <footer className="site-footer" id="usage-boundary">
      <div className="footer-brand">
        <span className="footer-logo">净流</span>
        <p>把公开媒体，干净地带回创作流程。</p>
      </div>
      <div className="footer-boundary">
        <ShieldCheck size={18} />
        <p>
          仅用于你拥有或获授权处理的公开内容。净流不绕过 DRM、登录、付费墙或私密访问，
          也不会移除已烧录进画面的作者标识。
        </p>
      </div>
      <div className="footer-actions">
        <a href="https://github.com/yt-dlp/yt-dlp" target="_blank" rel="noreferrer">
          <Code2 size={15} />解析引擎
        </a>
        <a href="#top" aria-label="返回顶部"><ArrowUp size={16} />顶部</a>
      </div>
    </footer>
  );
}
