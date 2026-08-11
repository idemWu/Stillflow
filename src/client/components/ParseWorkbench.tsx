import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  Download,
  FileVideo2,
  Gauge,
  Info,
  Link2,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  IHealthResponse,
  IMediaFormat,
  IMediaInfo,
  IPlatform,
  IProbeResponse,
} from '../../shared/types';
import { extractVideoUrlFromText } from '../../shared/linkInput';
import { detectPlatform, PLATFORM_DEFINITIONS } from '../../shared/platforms';
import {
  ApiClientError,
  createProbe,
  getDownloadFileUrl,
  getHealth,
} from '../api';
import { createDownloadWithProbeRecovery } from '../downloadRecovery';
import { useDownloadJob } from '../hooks/useDownloadJob';

interface IParseWorkbenchProps {
  onParsed: (media: IMediaInfo) => void;
}

interface IPlatformHint extends IPlatform {
  glyph: string;
}

type WorkbenchStatus = 'idle' | 'probing' | 'ready' | 'error';

function detectPlatformHint(value: string): IPlatformHint | null {
  const platform = detectPlatform(value);
  if (platform.id === 'other') return null;
  const definition = PLATFORM_DEFINITIONS.find(({ id }) => id === platform.id);
  return definition ? { ...platform, glyph: definition.glyph } : null;
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds < 0) return '时长未知';
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '由来源决定';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length - 1);
  const value = bytes / 1_024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function formatSpeed(bytes: number | null): string {
  return bytes ? `${formatBytes(bytes)}/s` : '计算中';
}

function MediaThumbnail({ media }: { media: IMediaInfo }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  return (
    <div className="media-thumbnail">
      {media.thumbnailUrl && !failed ? (
        <img
          src={media.thumbnailUrl}
          alt={`视频《${media.title}》的预览图`}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="thumbnail-fallback" aria-label="预览图不可用">
          <FileVideo2 size={38} />
        </div>
      )}
      <span className="duration-badge"><Clock3 size={12} />{formatDuration(media.durationSeconds)}</span>
      <span className={`platform-glyph platform-${media.platform.id}`}>
        {PLATFORM_DEFINITIONS.find((rule) => rule.id === media.platform.id)?.glyph ?? 'WEB'}
      </span>
    </div>
  );
}

interface IParseProgressProps {
  step: number;
}

function ParseProgress({ step }: IParseProgressProps): React.JSX.Element {
  const steps = ['识别链接', '获取媒体信息', '准备可用版本'];
  return (
    <div className="parse-progress" role="status" aria-live="polite">
      <div className="progress-orbit" aria-hidden="true">
        <span />
        <Link2 size={23} />
      </div>
      <h3>{steps[step - 1]}</h3>
      <p>正在安全读取公开媒体信息，通常只需几秒。</p>
      <ol className="step-track" aria-label="解析进度">
        {steps.map((label, index) => {
          const number = index + 1;
          const state = number < step ? 'complete' : number === step ? 'active' : 'pending';
          return (
            <li key={label} className={state} aria-current={state === 'active' ? 'step' : undefined}>
              <span>{state === 'complete' ? <Check size={13} /> : number}</span>
              <small>{label}</small>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface IErrorPanelProps {
  error: ApiClientError;
  onRetry: () => void;
}

function ErrorPanel({ error, onRetry }: IErrorPanelProps): React.JSX.Element {
  const handleCopyId = async (): Promise<void> => {
    if (!error.requestId) return;
    await navigator.clipboard.writeText(error.requestId).catch(() => undefined);
  };

  return (
    <div className="error-panel" role="alert">
      <span className="error-icon"><AlertCircle size={22} /></span>
      <div>
        <strong>解析没有完成</strong>
        <p>{error.message}</p>
        <div className="error-actions">
          <button type="button" onClick={onRetry}><RotateCcw size={15} />重新尝试</button>
          {error.requestId && (
            <button type="button" className="quiet-button" onClick={handleCopyId}>复制错误编号</button>
          )}
        </div>
      </div>
    </div>
  );
}

interface IDownloadPanelProps {
  onCancel: () => Promise<void>;
  onClear: () => void;
  job: NonNullable<ReturnType<typeof useDownloadJob>['job']>;
}

function DownloadPanel({ job, onCancel, onClear }: IDownloadPanelProps): React.JSX.Element {
  const progress = job.progress.percent;
  const active = ['queued', 'downloading', 'processing'].includes(job.status);
  const statusCopy = {
    queued: ['任务已排队', '马上开始准备文件'],
    downloading: ['正在获取媒体流', progress === null ? '正在计算文件大小' : `已完成 ${Math.round(progress)}%`],
    processing: ['正在合并音视频', '正在封装为兼容的视频文件'],
    ready: ['文件已经准备好', '请在 30 分钟内保存到本机'],
    failed: ['导出没有完成', job.error?.message ?? '请重新解析后再试'],
    cancelled: ['导出已取消', '临时文件已清理'],
  } satisfies Record<string, [string, string]>;
  const copy = statusCopy[job.status];

  return (
    <section className={`download-panel is-${job.status}`} aria-live="polite">
      <div className="download-status-head">
        <span className="download-status-icon">
          {active && <LoaderCircle className="spin" size={23} />}
          {job.status === 'ready' && <CheckCircle2 size={23} />}
          {job.status === 'failed' && <AlertCircle size={23} />}
          {job.status === 'cancelled' && <Square size={20} />}
        </span>
        <div>
          <strong>{copy[0]}</strong>
          <p>{copy[1]}</p>
        </div>
        {active && (
          <button className="cancel-job" type="button" onClick={() => void onCancel()}>取消</button>
        )}
      </div>

      {active && (
        <>
          <div
            className={`download-progress-bar ${progress === null ? 'indeterminate' : ''}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
          >
            <span style={progress === null ? undefined : { width: `${Math.max(2, progress)}%` }} />
          </div>
          <div className="download-stats">
            <span><ArrowDownToLine size={14} />{formatBytes(job.progress.downloadedBytes)}</span>
            <span><Gauge size={14} />{formatSpeed(job.progress.speedBytesPerSecond)}</span>
            <span><Clock3 size={14} />{job.progress.etaSeconds ? `约 ${job.progress.etaSeconds} 秒` : '估算中'}</span>
          </div>
        </>
      )}

      {job.status === 'ready' && (
        <div className="ready-actions">
          <a className="save-file-button" href={getDownloadFileUrl(job.id)} download>
            <Download size={18} />保存视频<span>{formatBytes(job.fileBytes)}</span>
          </a>
          <p><ShieldCheck size={14} />文件仅临时保留，下载后可安全关闭页面。</p>
        </div>
      )}

      {(job.status === 'failed' || job.status === 'cancelled') && (
        <button className="retry-export" type="button" onClick={onClear}>返回导出选项</button>
      )}
    </section>
  );
}

interface IMediaResultProps {
  probe: IProbeResponse;
  selectedId: string;
  onSelect: (id: string) => void;
  onExport: () => Promise<void>;
  onReset: () => void;
  download: ReturnType<typeof useDownloadJob>;
  isCreating: boolean;
}

function MediaResult({ probe, selectedId, onSelect, onExport, onReset, download, isCreating }: IMediaResultProps): React.JSX.Element {
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const media = probe.media;
  const selected = media.formats.find((format) => format.id === selectedId) ?? media.formats[0];
  const exportActive = isCreating || Boolean(
    download.job && ['queued', 'downloading', 'processing'].includes(download.job.status),
  );

  useEffect(() => {
    resultHeadingRef.current?.focus();
  }, []);

  return (
    <div className="media-result" aria-busy={exportActive}>
      <div className="result-heading-row">
        <div>
          <span className="success-kicker"><CheckCircle2 size={15} />解析完成</span>
          <h2 ref={resultHeadingRef} tabIndex={-1}>选择导出版本</h2>
        </div>
        <button type="button" className="reset-link-button" onClick={onReset} disabled={exportActive}>
          <RotateCcw size={15} />解析其他链接
        </button>
      </div>

      <div className="media-summary">
        <MediaThumbnail media={media} />
        <div className="media-copy">
          <span>{media.platform.label}</span>
          <h3 title={media.title}>{media.title}</h3>
          <p>{media.author ?? '作者信息未提供'} · {formatDuration(media.durationSeconds)}</p>
          <div className="media-tags">
            <span><Sparkles size={12} />源画质</span>
            <span><ShieldCheck size={12} />无额外水印</span>
          </div>
        </div>
      </div>

      <fieldset className="quality-fieldset" disabled={exportActive}>
        <legend>
          <span>视频质量</span>
          <small>已找到 {media.formats.length} 个版本</small>
        </legend>
        <div className="quality-grid">
          {media.formats.map((format: IMediaFormat, index) => (
            <label key={format.id} className={format.id === selectedId ? 'selected' : ''}>
              <input
                type="radio"
                name="quality"
                value={format.id}
                checked={format.id === selectedId}
                onChange={() => onSelect(format.id)}
              />
              <span className="quality-main">
                <strong>{format.label}</strong>
                <small>{format.resolution}</small>
              </span>
              <span className="quality-meta">
                {index === 0 && <em>最佳</em>}
                <small>{formatBytes(format.estimatedBytes)}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="format-row">
        <div>
          <span className="format-icon"><FileVideo2 size={19} /></span>
          <div><strong>MP4 优先</strong><small>自动选择兼容封装</small></div>
        </div>
        <span className="format-fixed"><Check size={14} />推荐</span>
      </div>

      <div className="source-notice">
        <Info size={16} />
        <p>系统不会为视频添加新水印。若作者标识已写入画面，我们不会移除或篡改。</p>
      </div>

      {!download.job && (
        <button className="export-button" type="button" onClick={() => void onExport()} disabled={!selected || isCreating}>
          {isCreating ? <LoaderCircle className="spin" size={19} /> : <Download size={19} />}
          <span>{isCreating ? '正在创建导出任务…' : `导出视频 · ${selected?.label ?? '自动'}`}</span>
          <small>{formatBytes(selected?.estimatedBytes ?? null)}</small>
        </button>
      )}

      {download.job && (
        <DownloadPanel job={download.job} onCancel={download.cancel} onClear={download.clear} />
      )}
    </div>
  );
}

export function ParseWorkbench({ onParsed }: IParseWorkbenchProps): React.JSX.Element {
  const [url, setUrl] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [status, setStatus] = useState<WorkbenchStatus>('idle');
  const [probeStep, setProbeStep] = useState(1);
  const [probe, setProbe] = useState<IProbeResponse | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState<ApiClientError | null>(null);
  const [fieldError, setFieldError] = useState('');
  const [clipboardStatus, setClipboardStatus] = useState('');
  const [health, setHealth] = useState<IHealthResponse | null>(null);
  const [isCreatingDownload, setIsCreatingDownload] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const creatingDownloadRef = useRef(false);
  const download = useDownloadJob();
  const normalizedUrl = useMemo(() => extractVideoUrlFromText(url), [url]);
  const platformHint = useMemo(() => detectPlatformHint(normalizedUrl ?? ''), [normalizedUrl]);
  const canSubmit = Boolean(normalizedUrl && platformHint && rightsConfirmed && status !== 'probing');
  const hasActiveDownload = Boolean(
    download.job && ['queued', 'downloading', 'processing'].includes(download.job.status),
  );
  const interactionLocked = status === 'probing' || isCreatingDownload || hasActiveDownload;

  useEffect(() => {
    void getHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  const resetResult = (): void => {
    setProbe(null);
    setSelectedId('');
    setError(null);
    setStatus('idle');
    download.clear();
  };

  const handleUrlChange = (value: string): void => {
    if (interactionLocked) return;
    setUrl(value);
    setFieldError('');
    if (probe) resetResult();
  };

  const applyPastedText = (text: string): void => {
    const extractedUrl = extractVideoUrlFromText(text);
    if (!extractedUrl) {
      setClipboardStatus('剪贴板中没有找到有效的 http(s) 视频链接');
      inputRef.current?.focus();
      return;
    }
    handleUrlChange(extractedUrl);
    setClipboardStatus(text.trim() === extractedUrl ? '已从剪贴板粘贴' : '已从分享文案提取链接');
    window.setTimeout(() => setClipboardStatus(''), 1_500);
  };

  const handlePaste = async (): Promise<void> => {
    if (interactionLocked) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error('empty');
      applyPastedText(text);
    } catch {
      setClipboardStatus('无法读取剪贴板，请按 Ctrl+V 粘贴链接');
      inputRef.current?.focus();
    }
  };

  const handleClear = (): void => {
    if (interactionLocked) return;
    setUrl('');
    setFieldError('');
    resetResult();
    inputRef.current?.focus();
  };

  const handleSubmit = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault();
    const submittedUrl = extractVideoUrlFromText(url);
    if (!submittedUrl) {
      setFieldError('请先粘贴视频链接。');
      inputRef.current?.focus();
      return;
    }
    const submittedPlatform = detectPlatformHint(submittedUrl);
    if (!submittedPlatform) {
      setFieldError('暂不支持该平台，或链接格式不正确。');
      inputRef.current?.focus();
      return;
    }
    if (!rightsConfirmed) {
      setFieldError('请先确认你拥有下载与处理权限。');
      return;
    }

    setStatus('probing');
    if (submittedUrl !== url) setUrl(submittedUrl);
    setProbeStep(1);
    setError(null);
    setFieldError('');
    const stepTimer = window.setTimeout(() => setProbeStep(2), 250);
    try {
      const result = await createProbe(submittedUrl);
      window.clearTimeout(stepTimer);
      setProbeStep(3);
      setProbe(result);
      setSelectedId(result.media.formats[0]?.id ?? '');
      setStatus('ready');
      onParsed(result.media);
    } catch (caught) {
      window.clearTimeout(stepTimer);
      const apiError = caught instanceof ApiClientError
        ? caught
        : new ApiClientError('解析没有完成，请重新尝试。');
      setError(apiError);
      setStatus('error');
    }
  };

  const handleExport = async (): Promise<void> => {
    if (!probe || !selectedId || creatingDownloadRef.current || hasActiveDownload) return;
    creatingDownloadRef.current = true;
    setIsCreatingDownload(true);
    try {
      const recovered = await createDownloadWithProbeRecovery(probe, selectedId);
      if (recovered.refreshed) {
        setProbe(recovered.probe);
        setSelectedId(recovered.optionId);
        onParsed(recovered.probe.media);
      }
      download.begin(recovered.response.job);
    } catch (caught) {
      const apiError = caught instanceof ApiClientError
        ? caught
        : new ApiClientError('无法创建导出任务。');
      setError(apiError);
      setStatus('error');
    } finally {
      creatingDownloadRef.current = false;
      setIsCreatingDownload(false);
    }
  };

  const handleReset = (): void => {
    setUrl('');
    setRightsConfirmed(false);
    resetResult();
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <section className="workbench-shell" id="workbench" aria-labelledby="workbench-title">
      <div className="workbench-accent" />
      <div className="workbench-heading">
        <div>
          <span className="step-number">01</span>
          <div>
            <h2 id="workbench-title">粘贴视频链接</h2>
            <p>公开链接，无需登录</p>
          </div>
        </div>
        <span className="privacy-pill"><Zap size={13} />不保存链接历史</span>
      </div>

      {health && !health.engine.available && (
        <div className="engine-warning" role="status">
          <WandSparkles size={18} />
          <p><strong>解析引擎待安装</strong><span>在项目目录运行 <code>yarn run setup:engine</code></span></p>
        </div>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <label className="url-label" htmlFor="video-url">视频链接</label>
        <div className={`url-control ${fieldError ? 'has-error' : ''} ${platformHint ? 'has-platform' : ''}`}>
          <span className="input-leading" aria-hidden="true">
            {platformHint ? (
              <span className={`detected-platform platform-${platformHint.id}`}>{platformHint.glyph}</span>
            ) : (
              <Link2 size={20} />
            )}
          </span>
          <input
            ref={inputRef}
            id="video-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            value={url}
            onChange={(event) => handleUrlChange(event.target.value)}
            onPaste={(event) => {
              event.preventDefault();
              applyPastedText(event.clipboardData.getData('text'));
            }}
            placeholder="粘贴抖音、快手、X、YouTube 等链接或分享文案"
            aria-describedby="url-help url-feedback"
            aria-invalid={Boolean(fieldError)}
            disabled={interactionLocked}
          />
          {url && (
            <button type="button" className="clear-input" onClick={handleClear} aria-label="清空视频链接" disabled={interactionLocked}>
              <X size={17} />
            </button>
          )}
          <button type="button" className="paste-button" onClick={() => void handlePaste()} disabled={interactionLocked}>
            <Clipboard size={16} />{clipboardStatus.startsWith('已') ? '已粘贴' : '粘贴'}
          </button>
        </div>
        <div className="field-feedback" id="url-feedback" aria-live="polite">
          {fieldError ? (
            <span className="field-error"><AlertCircle size={13} />{fieldError}</span>
          ) : platformHint ? (
            <span className="detected-copy"><CheckCircle2 size={13} />已识别：{platformHint.label}</span>
          ) : clipboardStatus ? (
            <span>{clipboardStatus}</span>
          ) : null}
        </div>
        <p className="url-help" id="url-help">
          可识别抖音、快手作品页、分享短链和整段分享文案；仅当平台向匿名访问提供公开源流时可下载。
        </p>

        <label className="rights-consent">
          <input
            type="checkbox"
            checked={rightsConfirmed}
            onChange={(event) => {
              setRightsConfirmed(event.target.checked);
              if (event.target.checked && fieldError.includes('权限')) setFieldError('');
            }}
            disabled={interactionLocked}
          />
          <span className="custom-checkbox"><Check size={14} /></span>
          <span>我确认拥有该内容，或已获得下载与处理授权，并同意遵守来源平台规则。</span>
        </label>

        {status !== 'ready' && (
          <button className="parse-button" type="submit" disabled={!canSubmit}>
            {status === 'probing' ? (
              <><LoaderCircle className="spin" size={19} />正在解析…</>
            ) : (
              <><Sparkles size={18} />开始解析<span>→</span></>
            )}
          </button>
        )}
      </form>

      {status === 'probing' && <ParseProgress step={probeStep} />}
      {status === 'error' && error && <ErrorPanel error={error} onRetry={() => void handleSubmit()} />}
      {status === 'ready' && probe && (
        <MediaResult
          probe={probe}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onExport={handleExport}
          onReset={handleReset}
          download={download}
          isCreating={isCreatingDownload}
        />
      )}

      <div className="workbench-footnote">
        <ShieldCheck size={14} />
        <span>链接仅用于本次解析，临时文件会在到期后自动删除。</span>
      </div>
    </section>
  );
}
