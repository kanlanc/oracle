import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  CLOUDFLARE_SCRIPT_SELECTOR,
  CLOUDFLARE_TITLE,
  INPUT_SELECTORS,
} from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';

export async function navigateToChatGPT(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  url: string,
  logger: BrowserLogger,
) {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

export async function ensureNotBlocked(Runtime: ChromeClient['Runtime'], headless: boolean, logger: BrowserLogger) {
  if (await isCloudflareInterstitial(Runtime)) {
    const message = headless
      ? 'Cloudflare challenge detected in headless mode. Re-run with --headful so you can solve the challenge.'
      : 'Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.';
    logger('Cloudflare anti-bot page detected');
    throw new Error(message);
  }
}

const LOGIN_CHECK_TIMEOUT_MS = 5_000;

export async function ensureLoggedIn(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
  options: { appliedCookies?: number | null; remoteSession?: boolean } = {},
) {
  const outcome = await Runtime.evaluate({
    expression: buildLoginProbeExpression(LOGIN_CHECK_TIMEOUT_MS),
    awaitPromise: true,
    returnByValue: true,
  });
  const probe = normalizeLoginProbe(outcome.result?.value);
  if (probe.ok && probe.status > 0 && probe.status < 400 && !probe.domLoginCta && !probe.onAuthPage) {
    const urlLabel = probe.url ?? '/backend-api/me';
    logger(`Login check passed (HTTP ${probe.status} from ${urlLabel})`);
    return;
  }

  const statusLabel = probe.status ? ` (HTTP ${probe.status})` : '';
  const errorLabel = probe.error ? ` (${probe.error})` : '';
  const domLabel = probe.domLoginCta ? ' Login UI detected on page.' : '';
  const cookieHint = options.remoteSession
    ? 'The remote Chrome session is not signed into ChatGPT. Sign in there, then rerun.'
    : (options.appliedCookies ?? 0) === 0
      ? 'No ChatGPT cookies were applied; sign in to chatgpt.com in Chrome or pass inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON).'
      : 'ChatGPT login appears missing; open chatgpt.com in Chrome to refresh the session or provide inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON).';

  throw new Error(`ChatGPT session not detected${statusLabel}. ${cookieHint}${domLabel}${errorLabel}`);
}

export async function ensurePromptReady(Runtime: ChromeClient['Runtime'], timeoutMs: number, logger: BrowserLogger) {
  const ready = await waitForPrompt(Runtime, timeoutMs);
  if (!ready) {
    await logDomFailure(Runtime, logger, 'prompt-textarea');
    throw new Error('Prompt textarea did not appear before timeout');
  }
  logger('Prompt textarea ready');
}

async function waitForDocumentReady(Runtime: ChromeClient['Runtime'], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `document.readyState`,
      returnByValue: true,
    });
    if (result?.value === 'complete' || result?.value === 'interactive') {
      return;
    }
    await delay(100);
  }
  throw new Error('Page did not reach ready state in time');
}

async function waitForPrompt(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const selectors = ${JSON.stringify(INPUT_SELECTORS)};
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && !node.hasAttribute('disabled')) {
            return true;
          }
        }
        return false;
      })()`,
      returnByValue: true,
    });
    if (result?.value) {
      return true;
    }
    await delay(200);
  }
  return false;
}

async function isCloudflareInterstitial(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const { result: titleResult } = await Runtime.evaluate({ expression: 'document.title', returnByValue: true });
  const title = typeof titleResult.value === 'string' ? titleResult.value : '';
  const challengeTitle = CLOUDFLARE_TITLE.toLowerCase();
  if (title.toLowerCase().includes(challengeTitle)) {
    return true;
  }

  const { result } = await Runtime.evaluate({
    expression: `Boolean(document.querySelector('${CLOUDFLARE_SCRIPT_SELECTOR}'))`,
    returnByValue: true,
  });
  return Boolean(result.value);
}

type LoginProbeResult = {
  ok: boolean;
  status: number;
  url?: string | null;
  redirected?: boolean;
  error?: string | null;
  pageUrl?: string | null;
  domLoginCta?: boolean;
  onAuthPage?: boolean;
};

function buildLoginProbeExpression(timeoutMs: number): string {
  return `(() => {
    const ENDPOINTS = ['/backend-api/me', '/backend-api/models'];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), ${timeoutMs});
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    const hasLoginCta = () => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    };

    const probeEndpoint = async (endpoint) => {
      try {
        const response = await fetch(endpoint, { credentials: 'include', signal: controller.signal });
        return {
          ok: response.ok,
          status: response.status,
          redirected: response.redirected,
          url: response.url || endpoint,
          pageUrl,
          domLoginCta: hasLoginCta(),
          onAuthPage,
        };
      } catch (error) {
        const message = error?.message ?? String(error);
        return { ok: false, status: 0, error: message, url: endpoint, pageUrl, domLoginCta: hasLoginCta(), onAuthPage };
      }
    };

    const run = async () => {
      let last = null;
      for (const endpoint of ENDPOINTS) {
        last = await probeEndpoint(endpoint);
        if (last.ok) {
          return last;
        }
        if (typeof last.status === 'number' && last.status !== 404 && last.status !== 0) {
          return last;
        }
      }
      return last ?? { ok: false, status: 0, url: ENDPOINTS[0], pageUrl };
    };

    return run().finally(() => clearTimeout(timer));
  })()`;
}

function normalizeLoginProbe(raw: unknown): LoginProbeResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 0 };
  }
  const value = raw as Record<string, unknown>;
  const statusRaw = value.status;
  const status =
    typeof statusRaw === 'number'
      ? statusRaw
      : typeof statusRaw === 'string' && !Number.isNaN(Number(statusRaw))
        ? Number(statusRaw)
        : 0;

  return {
    ok: Boolean(value.ok),
    status: Number.isFinite(status) ? (status as number) : 0,
    url: typeof value.url === 'string' ? value.url : null,
    redirected: Boolean(value.redirected),
    error: typeof value.error === 'string' ? value.error : null,
    pageUrl: typeof value.pageUrl === 'string' ? value.pageUrl : null,
    domLoginCta: Boolean(value.domLoginCta),
    onAuthPage: Boolean(value.onAuthPage),
  };
}
