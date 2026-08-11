# 净流

净流是一个本地运行的视频链接解析与清晰导出工具。它读取来源平台公开提供的媒体版本，支持选择清晰度、跟踪下载进度、自动合并音视频，并在到期后清理临时文件。

## 最快启动

直接双击 **`启动净流.cmd`**。首次运行会自动准备解析引擎，随后浏览器会打开：

```text
http://127.0.0.1:8787
```

> 不要直接双击 `index.html`。React 模块和后端 API 需要通过 HTTP 服务运行；使用 `file://` 打开会被浏览器的模块安全策略阻止。

关闭启动窗口或按 `Ctrl+C` 即可停止服务。

从 GitHub 克隆后，推荐使用 Yarn：

```powershell
corepack enable
npm ci
yarn run setup:engine
yarn run dev
```

开发页面会打开在 `http://127.0.0.1:5173`，API 服务运行在 `http://127.0.0.1:8787`。

## 支持范围

- YouTube
- X / Twitter
- TikTok
- Instagram
- Vimeo
- Bilibili
- 抖音
- 快手

具体链接能否解析，仍取决于来源平台当前公开提供的内容与接口状态。

净流只处理公开链接，不接受账号、Cookie、密码或自定义请求头，也不会绕过登录、付费墙、私密访问、地区限制或 DRM。所谓“无水印导出”是指获取平台提供的原始媒体流且不额外叠加水印；已经烧录进画面的作者标识、台标或字幕不会被移除。

## 手动运行

```powershell
npm ci
yarn run setup:engine
yarn run build
yarn run start
```

开发模式：

```powershell
yarn run dev
```

前端开发地址为 `http://127.0.0.1:5173`，API 服务地址为 `http://127.0.0.1:8787`。

## 验证

```powershell
yarn run test
yarn run build
```

当前测试覆盖：

- 非 HTTP 协议、登录信息、控制字符与非标准端口拦截
- 本机、内网、CGNAT、链路本地与保留地址拦截
- 平台域名识别及相似恶意域名防混淆
- DRM、故事板、纯音频与不安全协议格式过滤
- 清晰度去重、媒体元数据转换与稳定错误码映射

## 实现结构

```text
src/client/          React 界面、任务轮询与本机解析记录
src/server/          Express API、URL 安全校验、探测与下载队列
src/shared/          前后端共享类型
scripts/             项目内隔离解析引擎安装脚本
.engine/             本地 yt-dlp 与 FFmpeg（自动生成）
.downloads/          每个任务独立的临时目录（自动清理）
```

服务只监听 `127.0.0.1`。探测结果使用 10 分钟有效的随机 ID；客户端不会得到真实媒体 URL 或 yt-dlp 格式表达式。下载任务默认最多并发 2 个、单文件最大 2 GiB，成品默认保留 30 分钟。

这是本机单用户工具，请勿把端口转发到公网或直接改成 `0.0.0.0` 对外提供服务。若要改造成多人服务，必须额外使用容器/低权限 Worker 与出站防火墙，对重定向、DNS 重绑定、manifest 和分片请求逐次执行公网地址策略；仅校验用户最初提交的 URL 并不足以构成公网服务的完整 SSRF 防护。

## 常见问题

### 页面白屏，控制台显示 `file://` 或 CORS

这是直接打开了源码页面。关闭该标签页，双击 `启动净流.cmd`，再访问 `http://127.0.0.1:8787`。

### 显示“解析引擎待安装”

在项目目录运行：

```powershell
yarn run setup:engine
```

安装完成后重启服务。

### 某个平台突然无法解析

平台页面结构和访问策略会变化。可先更新项目内解析引擎：

```powershell
yarn run setup:engine
```

仍失败时，界面会返回稳定的错误类别与请求编号，便于排查，而不会把包含签名参数的原始上游日志暴露到浏览器。
