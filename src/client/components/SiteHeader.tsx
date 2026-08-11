import { ArrowUpRight, ShieldCheck } from 'lucide-react';

function BrandMark(): React.JSX.Element {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function SiteHeader(): React.JSX.Element {
  return (
    <header className="site-header">
      <a className="brand" href="#top" aria-label="净流首页">
        <BrandMark />
        <span className="brand-name">净流</span>
        <span className="brand-version">BETA</span>
      </a>

      <nav className="site-nav" aria-label="主导航">
        <a href="#platforms">支持平台</a>
        <a href="#how-it-works">工作方式</a>
        <a href="#recent">最近解析</a>
      </nav>

      <a className="rights-badge" href="#usage-boundary">
        <ShieldCheck size={16} />
        <span>仅限授权内容</span>
        <ArrowUpRight size={14} />
      </a>
    </header>
  );
}
