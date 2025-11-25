import { normalizeChatgptUrl, CHATGPT_URL } from '../browserMode.js';
import type { UserConfig } from '../config.js';

export interface BrowserDefaultsOptions {
  chatgptUrl?: string;
  browserUrl?: string;
  browserChromeProfile?: string;
  browserChromePath?: string;
  browserCookiePath?: string;
  browserTimeout?: string | number;
  browserInputTimeout?: string | number;
  browserPort?: number;
  browserHeadless?: boolean;
  browserHideWindow?: boolean;
  browserKeepBrowser?: boolean;
}

type SourceGetter = (key: keyof BrowserDefaultsOptions) => string | undefined;

export function applyBrowserDefaultsFromConfig(
  options: BrowserDefaultsOptions,
  config: UserConfig,
  getSource: SourceGetter,
): void {
  const browser = config.browser;
  if (!browser) return;

  const configuredChatgptUrl = browser.chatgptUrl ?? browser.url;
  const cliChatgptSet = options.chatgptUrl !== undefined || options.browserUrl !== undefined;
  if ((getSource('chatgptUrl') === 'default' || getSource('chatgptUrl') === undefined) && !cliChatgptSet && configuredChatgptUrl !== undefined) {
    options.chatgptUrl = normalizeChatgptUrl(configuredChatgptUrl ?? '', CHATGPT_URL);
  }

  if (getSource('browserChromeProfile') === 'default' && browser.chromeProfile !== undefined) {
    options.browserChromeProfile = browser.chromeProfile ?? undefined;
  }
  if (getSource('browserChromePath') === 'default' && browser.chromePath !== undefined) {
    options.browserChromePath = browser.chromePath ?? undefined;
  }
  if (getSource('browserCookiePath') === 'default' && browser.chromeCookiePath !== undefined) {
    options.browserCookiePath = browser.chromeCookiePath ?? undefined;
  }
  if ((getSource('browserUrl') === 'default' || getSource('browserUrl') === undefined) && options.browserUrl === undefined && browser.url !== undefined) {
    options.browserUrl = browser.url;
  }
  if (getSource('browserTimeout') === 'default' && typeof browser.timeoutMs === 'number') {
    options.browserTimeout = String(browser.timeoutMs);
  }
  if (getSource('browserPort') === 'default' && typeof browser.debugPort === 'number') {
    options.browserPort = browser.debugPort;
  }
  if (getSource('browserInputTimeout') === 'default' && typeof browser.inputTimeoutMs === 'number') {
    options.browserInputTimeout = String(browser.inputTimeoutMs);
  }
  if (getSource('browserHeadless') === 'default' && browser.headless !== undefined) {
    options.browserHeadless = browser.headless;
  }
  if (getSource('browserHideWindow') === 'default' && browser.hideWindow !== undefined) {
    options.browserHideWindow = browser.hideWindow;
  }
  if (getSource('browserKeepBrowser') === 'default' && browser.keepBrowser !== undefined) {
    options.browserKeepBrowser = browser.keepBrowser;
  }
}
