import { describe, expect, test } from 'vitest';
import { runBrowserMode } from '../../src/browser/index.js';
import type { BrowserLogger, ChromeCookiesSecureModule } from '../../src/browser/types.js';

const LIVE = process.env.ORACLE_LIVE_TEST === '1';

async function hasChatGptCookies(): Promise<boolean> {
  const mod = (await import('chrome-cookies-secure')) as unknown;
  const chromeCookies = (mod as { default?: unknown }).default ?? mod;
  const cookies = (await (chromeCookies as ChromeCookiesSecureModule).getCookiesPromised(
    'https://chatgpt.com',
    'puppeteer',
  )) as Array<{ name: string; value: string }>;
  const hasSession = cookies.some((cookie) => cookie.name.startsWith('__Secure-next-auth.session-token'));
  if (!hasSession) {
    console.warn(
      'Skipping ChatGPT browser live tests (missing __Secure-next-auth.session-token). Open chatgpt.com in Chrome and retry.',
    );
    return false;
  }
  return true;
}

function createLogCapture() {
  const lines: string[] = [];
  const log: BrowserLogger = (message: string) => {
    lines.push(message);
  };
  return { log, lines };
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

const CASES = [
  {
    name: 'auto',
    desiredModel: 'GPT-5.2',
    expected: ['5.2'],
  },
  {
    name: 'thinking',
    desiredModel: 'GPT-5.2 Thinking',
    expected: ['5.2', 'thinking'],
  },
  {
    name: 'instant',
    desiredModel: 'GPT-5.2 Instant',
    expected: ['5.2', 'instant'],
  },
];

(LIVE ? describe : describe.skip)('ChatGPT browser live model selection', () => {
  test(
    'selects GPT-5.2 variants reliably',
    async () => {
      if (!(await hasChatGptCookies())) return;

      for (const entry of CASES) {
        const { log, lines } = createLogCapture();
        try {
          const result = await runBrowserMode({
            prompt: `Reply with "live browser ${entry.name}" on one line.`,
            config: {
              chromeProfile: 'Default',
              desiredModel: entry.desiredModel,
              timeoutMs: 180_000,
            },
            log,
          });

          expect(result.answerText.toLowerCase()).toContain(`live browser ${entry.name}`);

          const modelLog = lines.find((line) => line.toLowerCase().startsWith('model picker:'));
          expect(modelLog).toBeTruthy();
          if (modelLog) {
            const label = normalizeLabel(modelLog.replace(/^model picker:\s*/i, ''));
            for (const token of entry.expected) {
              expect(label).toContain(token);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('Unable to find model option')) {
            console.warn(`Skipping ${entry.name} model selection (not available for this account): ${message}`);
            continue;
          }
          throw error;
        }
      }
    },
    15 * 60 * 1000,
  );
});
