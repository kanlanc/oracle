import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserRunOptions, BrowserRunResult, BrowserLogger } from '../browser/types.js';
import { getOracleHomeDir } from '../oracleHome.js';
import type { GeminiWebOptions, GeminiWebResponse, SpawnResult } from './types.js';

// biome-ignore lint/style/useNamingConvention: __dirname is standard Node.js ESM convention
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(__dirname, '../../vendor/gemini-webapi');
const WRAPPER_SCRIPT = path.join(VENDOR_DIR, 'wrapper.py');
const REQUIREMENTS_PATH = path.join(VENDOR_DIR, 'requirements.txt');
const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-2.5-pro';

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function resolveVenvDir(): string {
  return path.join(getOracleHomeDir(), 'gemini-webapi', '.venv');
}

function resolveInvocationPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

function resolveVenvPython(venvDir: string): string {
  if (process.platform === 'win32') {
    return path.join(venvDir, 'Scripts', 'python.exe');
  }
  return path.join(venvDir, 'bin', 'python');
}

function resolveVenvPip(venvDir: string): string {
  if (process.platform === 'win32') {
    return path.join(venvDir, 'Scripts', 'pip.exe');
  }
  return path.join(venvDir, 'bin', 'pip');
}

async function spawnPython(args: string[], log?: BrowserLogger, envOverrides?: Record<string, string>): Promise<SpawnResult> {
  const venvDir = resolveVenvDir();
  const venvPython = resolveVenvPython(venvDir);
  const pythonPath =
    existsSync(venvPython) ? venvPython : (process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'));

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, [WRAPPER_SCRIPT, ...args], {
      cwd: VENDOR_DIR,
      env: { ...process.env, ...(envOverrides ?? {}) },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (log) {
        for (const line of chunk.split('\n').filter(Boolean)) {
          log(`[gemini-web] ${line}`);
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

async function spawnCommand(command: string, args: string[], cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: cwd ?? VENDOR_DIR });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

async function ensureVenvSetup(log?: BrowserLogger): Promise<void> {
  if (!existsSync(WRAPPER_SCRIPT) || !existsSync(REQUIREMENTS_PATH)) {
    throw new Error(`Gemini WebAPI vendor bundle is missing. Expected ${WRAPPER_SCRIPT} and ${REQUIREMENTS_PATH}.`);
  }

  const venvPath = resolveVenvDir();
  const venvPython = resolveVenvPython(venvPath);

  if (existsSync(venvPython)) {
    return;
  }

  log?.('[gemini-web] First run: setting up Python environment...');

  await mkdir(path.dirname(venvPath), { recursive: true });

  const pythonCandidates = [
    process.env.PYTHON,
    process.platform === 'win32' ? 'python' : 'python3',
    'python',
  ].filter(Boolean) as string[];
  let createVenv: SpawnResult | null = null;
  for (const candidate of pythonCandidates) {
    try {
      const result = await spawnCommand(candidate, ['-m', 'venv', venvPath], undefined);
      if (result.exitCode === 0) {
        createVenv = result;
        break;
      }
      createVenv = result;
    } catch {
      // Try next candidate.
    }
  }
  if (!createVenv || createVenv.exitCode !== 0) {
    const stderr = createVenv?.stderr ? `\n${createVenv.stderr}` : '';
    throw new Error(`Failed to create venv at ${venvPath}.${stderr}`);
  }

  const pipPath = resolveVenvPip(venvPath);

  const installResult = await spawnCommand(pipPath, ['install', '-r', REQUIREMENTS_PATH]);
  if (installResult.exitCode !== 0) {
    throw new Error(`Failed to install dependencies: ${installResult.stderr}`);
  }

  log?.('[gemini-web] Python environment ready');
}

async function loadGeminiCookiesFromChrome(
  browserConfig: BrowserRunOptions['config'],
  log?: BrowserLogger,
): Promise<Record<string, string>> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: third-party module without types
    const mod: any = await import('chrome-cookies-secure');
    // biome-ignore lint/suspicious/noExplicitAny: third-party module without types
    const chromeCookies: any = mod.default ?? mod;

    const profile = typeof browserConfig?.chromeProfile === 'string' && browserConfig.chromeProfile.trim().length > 0
      ? browserConfig.chromeProfile.trim()
      : undefined;

    // browser-cookie3 (Python) can hang on macOS Keychain prompts; prefer Node extraction when possible.
    type PuppeteerCookie = { name: string; value: string; domain?: string; path?: string };
    const cookies = (await chromeCookies.getCookiesPromised(
      'https://gemini.google.com',
      'puppeteer',
      profile,
    )) as PuppeteerCookie[];

    const pickCookie = (name: string): string | undefined => {
      const candidates = cookies.filter((cookie) => cookie.name === name);
      if (candidates.length === 0) return undefined;
      const preferredDomain = candidates.find((cookie) => cookie.domain === '.google.com' && (cookie.path ?? '/') === '/');
      const googleDomain = candidates.find((cookie) => (cookie.domain ?? '').endsWith('google.com'));
      return (preferredDomain ?? googleDomain ?? candidates[0])?.value;
    };

    const secure1psid = pickCookie('__Secure-1PSID');
    const secure1psidts = pickCookie('__Secure-1PSIDTS');
    const nid = pickCookie('NID');

    if (!secure1psid || !secure1psidts) {
      return {};
    }

    log?.('[gemini-web] Loaded Gemini auth cookies from Chrome (node).');

    return {
      // Passed to vendor wrapper.py; do not log these values.
      // biome-ignore lint/style/useNamingConvention: env keys intentionally uppercase
      ORACLE_GEMINI_SECURE_1PSID: secure1psid,
      // biome-ignore lint/style/useNamingConvention: env keys intentionally uppercase
      ORACLE_GEMINI_SECURE_1PSIDTS: secure1psidts,
      ...(nid
        ? {
            // biome-ignore lint/style/useNamingConvention: env keys intentionally uppercase
            ORACLE_GEMINI_NID: nid,
          }
        : {}),
    };
  } catch (error) {
    log?.(
      `[gemini-web] Failed to load Chrome cookies via node (falling back to Python cookie loader): ${error instanceof Error ? error.message : String(error ?? '')}`,
    );
    return {};
  }
}

export function createGeminiWebExecutor(
  geminiOptions: GeminiWebOptions,
): (runOptions: BrowserRunOptions) => Promise<BrowserRunResult> {
  return async (runOptions: BrowserRunOptions): Promise<BrowserRunResult> => {
    const startTime = Date.now();
    const log = runOptions.log;

    log?.('[gemini-web] Starting Gemini WebAPI executor');

    await ensureVenvSetup(log);

    const args: string[] = [runOptions.prompt, '--json'];

    for (const attachment of runOptions.attachments ?? []) {
      args.push('--file', attachment.path);
    }

    if (geminiOptions.youtube) {
      args.push('--youtube', geminiOptions.youtube);
    }
    const generateImagePath = resolveInvocationPath(geminiOptions.generateImage);
    const editImagePath = resolveInvocationPath(geminiOptions.editImage);
    const outputPath = resolveInvocationPath(geminiOptions.outputPath);
    const isImageOperation = Boolean(generateImagePath || editImagePath);
    if (generateImagePath) {
      args.push('--generate-image', generateImagePath);
    }
    if (editImagePath) {
      args.push('--edit', editImagePath);
    }
    if (outputPath) {
      args.push('--output', outputPath);
    }
    if (geminiOptions.aspectRatio) {
      args.push('--aspect', geminiOptions.aspectRatio);
    }
    if (geminiOptions.showThoughts) {
      args.push('--show-thoughts');
    }
    if (isImageOperation) {
      args.push('--model', DEFAULT_GEMINI_IMAGE_MODEL);
    }

    log?.(`[gemini-web] Calling wrapper with ${args.length} args`);

    const cookieEnv = await loadGeminiCookiesFromChrome(runOptions.config, log);
    const geminiCookiePath = path.join(getOracleHomeDir(), 'gemini-webapi');
    const result = await spawnPython(args, log, {
      ...cookieEnv,
      // biome-ignore lint/style/useNamingConvention: env keys intentionally uppercase
      GEMINI_COOKIE_PATH: geminiCookiePath,
    });

    if (result.exitCode !== 0) {
      const errorMsg = [result.stderr, result.stdout].map((value) => value?.trim()).filter(Boolean).join('\n');
      throw new Error(`Gemini WebAPI failed: ${errorMsg}`);
    }

    let response: GeminiWebResponse;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      if (result.stdout.trim()) {
        response = { text: result.stdout.trim(), thoughts: null, has_images: false, image_count: 0 };
      } else {
        throw new Error(`Failed to parse Gemini response: ${result.stdout}`);
      }
    }

    if (response.error) {
      throw new Error(`Gemini error: ${response.error}`);
    }

    const answerText = response.text ?? '';
    let answerMarkdown = answerText;

    if (geminiOptions.showThoughts && response.thoughts) {
      answerMarkdown = `## Thinking\n\n${response.thoughts}\n\n## Response\n\n${answerText}`;
    }

    if (response.has_images && response.image_count > 0) {
      const imagePath = generateImagePath || outputPath || 'generated.png';
      answerMarkdown += `\n\n*Generated ${response.image_count} image(s). Saved to: ${imagePath}*`;
    }

    const tookMs = Date.now() - startTime;
    log?.(`[gemini-web] Completed in ${tookMs}ms`);

    return {
      answerText,
      answerMarkdown,
      tookMs,
      answerTokens: estimateTokenCount(answerText),
      answerChars: answerText.length,
    };
  };
}
