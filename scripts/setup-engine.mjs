import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const ENGINE_ROOT = path.join(PROJECT_ROOT, '.engine');
const MODULE_PATH = path.join(ENGINE_ROOT, 'python');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

async function findPython() {
  const candidates = process.platform === 'win32'
    ? [{ command: 'py', prefixArgs: [] }, { command: 'python', prefixArgs: [] }]
    : [{ command: 'python3', prefixArgs: [] }, { command: 'python', prefixArgs: [] }];

  for (const candidate of candidates) {
    try {
      await run(candidate.command, [...candidate.prefixArgs, '--version'], { capture: true });
      return candidate;
    } catch {
      // Try the next executable.
    }
  }

  throw new Error('没有找到 Python 3。请先安装 Python，再重新运行此命令。');
}

async function main() {
  const python = await findPython();
  await mkdir(ENGINE_ROOT, { recursive: true });
  await rm(path.join(ENGINE_ROOT, 'engine.json'), { force: true });
  await rm(MODULE_PATH, { recursive: true, force: true });
  await mkdir(MODULE_PATH, { recursive: true });

  console.log('正在安装项目内隔离的 yt-dlp 与 FFmpeg…');
  await run(python.command, [
    ...python.prefixArgs,
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-warn-script-location',
    '--upgrade',
    '--target',
    MODULE_PATH,
    'yt-dlp',
    'imageio-ffmpeg',
  ]);

  const environment = {
    ...process.env,
    PYTHONPATH: [MODULE_PATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  const ffmpegResult = await run(
    python.command,
    [
      ...python.prefixArgs,
      '-c',
      'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())',
    ],
    { capture: true, env: environment },
  );
  const versionResult = await run(
    python.command,
    [...python.prefixArgs, '-m', 'yt_dlp', '--version'],
    { capture: true, env: environment },
  );

  const config = {
    pythonCommand: python.command,
    pythonPrefixArgs: python.prefixArgs,
    modulePath: MODULE_PATH,
    ffmpegPath: ffmpegResult.stdout.split(/\r?\n/).at(-1),
  };
  await writeFile(path.join(ENGINE_ROOT, 'engine.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`解析引擎已就绪：yt-dlp ${versionResult.stdout}`);
  console.log(`FFmpeg：${config.ffmpegPath}`);
}

main().catch((error) => {
  console.error(`安装失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
