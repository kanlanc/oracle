import { describe, expect, test } from 'vitest';
import { applyBrowserDefaultsFromConfig, type BrowserDefaultsOptions } from '../../src/cli/browserDefaults.js';
import type { UserConfig } from '../../src/config.js';

const source = (_key: keyof BrowserDefaultsOptions) => undefined;

describe('applyBrowserDefaultsFromConfig', () => {
  test('applies chatgptUrl from user config when flags are absent', () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        chatgptUrl: 'https://chatgpt.com/g/g-p-foo/project',
      },
    };

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.chatgptUrl).toBe('https://chatgpt.com/g/g-p-foo/project');
  });

  test('does not override when CLI provided chatgptUrl', () => {
    const options: BrowserDefaultsOptions = { chatgptUrl: 'https://override.example.com/' };
    const config: UserConfig = {
      browser: {
        chatgptUrl: 'https://chatgpt.com/g/g-p-foo/project',
      },
    };

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.chatgptUrl).toBe('https://override.example.com/');
  });

  test('falls back to browser.url when chatgptUrl missing', () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        url: 'https://chatgpt.com/g/g-p-bar/project',
      },
    };

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.chatgptUrl).toBe('https://chatgpt.com/g/g-p-bar/project');
  });
});
