import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ChromeClient, BrowserAttachment, BrowserLogger } from '../types.js';
import { FILE_INPUT_SELECTORS, SEND_BUTTON_SELECTORS, UPLOAD_STATUS_SELECTORS } from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';

export async function uploadAttachmentFile(
  deps: { runtime: ChromeClient['Runtime']; dom?: ChromeClient['DOM'] },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
) {
  const { runtime, dom } = deps;
  if (!dom) {
    throw new Error('DOM domain unavailable while uploading attachments.');
  }

  // New ChatGPT UI hides the real file input behind a composer "+" menu; click it pre-emptively.
  await runtime
    .evaluate({
      expression: `(() => {
        const selectors = [
          '#composer-plus-btn',
          'button[data-testid="composer-plus-btn"]',
          '[data-testid*="plus"]',
          'button[aria-label*="add"]',
          'button[aria-label*="attachment"]',
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el instanceof HTMLElement) {
            el.click();
            return true;
          }
        }
        return false;
      })()`,
      returnByValue: true,
    })
    .catch(() => undefined);

  const documentNode = await dom.getDocument();
  const selectors = FILE_INPUT_SELECTORS;
  let targetNodeId: number | undefined;
  for (const selector of selectors) {
    const result = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector });
    if (result.nodeId) {
      targetNodeId = result.nodeId;
      break;
    }
  }
  if (!targetNodeId) {
    await logDomFailure(runtime, logger, 'file-input');
    throw new Error('Unable to locate ChatGPT file attachment input.');
  }

  // Skip re-uploads if the file is already attached.
  const alreadyAttached = await runtime.evaluate({
    expression: `(() => {
      const expected = ${JSON.stringify(path.basename(attachment.path).toLowerCase())};
      const inputs = Array.from(document.querySelectorAll('input[type="file"]')).some((el) =>
        Array.from(el.files || []).some((f) => f?.name?.toLowerCase?.() === expected),
      );
      const chips = Array.from(document.querySelectorAll('[data-testid*="chip"],[data-testid*="attachment"],a,div,span')).some((n) =>
        (n?.textContent || '').toLowerCase().includes(expected),
      );
      return inputs || chips;
    })()`,
    returnByValue: true,
  });
  if (alreadyAttached?.result?.value === true) {
    logger(`Attachment already present: ${path.basename(attachment.path)}`);
    return;
  }

  await dom.setFileInputFiles({ nodeId: targetNodeId, files: [attachment.path] });
  // Some ChatGPT composers expect an explicit change/input event after programmatic file selection.
  const dispatchEvents = selectors
    .map((selector) => `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el instanceof HTMLInputElement) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })();
    `)
    .join('\n');
  await runtime.evaluate({ expression: `(function(){${dispatchEvents} return true;})()`, returnByValue: true });
  const expectedName = path.basename(attachment.path);
  const ready = await waitForAttachmentSelection(runtime, expectedName, 10_000);
  if (!ready) {
    // Fallback: inject via DataTransfer/File for UIs that ignore setFileInputFiles on hidden inputs.
    const fileBuffer = await readFile(attachment.path);
    const base64 = fileBuffer.toString('base64');
    const injectResult = await runtime.evaluate({
      expression: `(() => {
        const selectors = ${JSON.stringify(selectors)};
        const binary = atob(${JSON.stringify(base64)});
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], ${JSON.stringify(expectedName)}, { type: 'application/octet-stream' });
        let attached = false;
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el instanceof HTMLInputElement) {
            const dt = new DataTransfer();
            dt.items.add(file);
            el.files = dt.files;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            attached = attached || el.files?.length > 0;
          }
        }
        return attached;
      })()`,
      returnByValue: true,
    });
    const injected = Boolean(injectResult?.result?.value);
    if (!injected) {
      // Final fallback: simulate a drag/drop onto the composer container with a DataTransfer File.
      const dropResult = await runtime.evaluate({
        expression: `(() => {
          const containers = [
            '[data-testid*="composer"]',
            'form',
            'main'
          ];
          const target = containers
            .map((sel) => document.querySelector(sel))
            .find((el) => el instanceof HTMLElement) as HTMLElement | undefined;
          if (!target) return false;
          const binary = atob(${JSON.stringify(base64)});
          const len = binary.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
          const file = new File([bytes], ${JSON.stringify(expectedName)}, { type: 'application/octet-stream' });
          const dt = new DataTransfer();
          dt.items.add(file);
          const fire = (type) => target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true }));
          fire('dragenter');
          fire('dragover');
          fire('drop');
          return true;
        })()`,
        returnByValue: true,
      });
      const dropped = Boolean(dropResult?.result?.value);
      if (!dropped) {
        await logDomFailure(runtime, logger, 'file-upload');
        throw new Error('Attachment did not register with the ChatGPT composer in time.');
      }
    }
  }
  await waitForAttachmentVisible(runtime, expectedName, 10_000, logger);
  logger('Attachment queued');
}

export async function waitForAttachmentCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger?: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const expression = `(() => {
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    let button = null;
    for (const selector of sendSelectors) {
      button = document.querySelector(selector);
      if (button) break;
    }
    const disabled = button
      ? button.hasAttribute('disabled') ||
        button.getAttribute('aria-disabled') === 'true' ||
        button.getAttribute('data-disabled') === 'true' ||
        window.getComputedStyle(button).pointerEvents === 'none'
      : null;
    const uploadingSelectors = ${JSON.stringify(UPLOAD_STATUS_SELECTORS)};
    const uploading = uploadingSelectors.some((selector) => {
      return Array.from(document.querySelectorAll(selector)).some((node) => {
        const ariaBusy = node.getAttribute?.('aria-busy');
        const dataState = node.getAttribute?.('data-state');
        if (ariaBusy === 'true' || dataState === 'loading' || dataState === 'uploading' || dataState === 'pending') {
          return true;
        }
        const text = node.textContent?.toLowerCase?.() ?? '';
        return text.includes('upload') || text.includes('processing') || text.includes('uploading');
      });
    });
    const fileSelectors = ${JSON.stringify(FILE_INPUT_SELECTORS)};
    const filesAttached = fileSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some((node) => {
        const el = node instanceof HTMLInputElement ? node : null;
        return Boolean(el?.files?.length);
      }),
    );
    return { state: button ? (disabled ? 'disabled' : 'ready') : 'missing', uploading, filesAttached };
  })()`;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = result?.value as { state?: string; uploading?: boolean; filesAttached?: boolean } | undefined;
    if (value && !value.uploading) {
      if (value.state === 'ready') {
        return;
      }
      if (value.state === 'missing' && value.filesAttached) {
        return;
      }
    }
    await delay(250);
  }
  logger?.('Attachment upload timed out while waiting for ChatGPT composer to become ready.');
  await logDomFailure(Runtime, logger ?? (() => {}), 'file-upload-timeout');
  throw new Error('Attachments did not finish uploading before timeout.');
}

export async function waitForAttachmentVisible(
  Runtime: ChromeClient['Runtime'],
  expectedName: string,
  timeoutMs: number,
  logger?: BrowserLogger,
): Promise<void> {
  // Attachments can take a few seconds to render in the composer (headless/remote Chrome is slower),
  // so respect the caller-provided timeout instead of capping at 2s.
  const deadline = Date.now() + timeoutMs;
  const expression = `(() => {
    const expected = ${JSON.stringify(expectedName)};
    const normalized = expected.toLowerCase();
    const matchNode = (node) => {
      if (!node) return false;
      const text = (node.textContent || '').toLowerCase();
      const aria = node.getAttribute?.('aria-label')?.toLowerCase?.() ?? '';
      const title = node.getAttribute?.('title')?.toLowerCase?.() ?? '';
      const testId = node.getAttribute?.('data-testid')?.toLowerCase?.() ?? '';
      const alt = node.getAttribute?.('alt')?.toLowerCase?.() ?? '';
      return [text, aria, title, testId, alt].some((value) => value.includes(normalized));
    };

    const turns = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
    const userTurns = turns.filter((node) => node.querySelector('[data-message-author-role="user"]'));
    const lastUser = userTurns[userTurns.length - 1];
    if (lastUser) {
      const turnMatch = Array.from(lastUser.querySelectorAll('*')).some(matchNode);
      if (turnMatch) return { found: true, userTurns: userTurns.length, source: 'turn' };
    }

    const composerSelectors = [
      '[data-testid*="composer"]',
      'form textarea',
      'form [data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="chip"]',
      'form',
      'button',
      'label',
      'input[type="file"]',
    ];
    const composerMatch = composerSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some(matchNode),
    );
    if (composerMatch) {
      return { found: true, userTurns: userTurns.length, source: 'composer' };
    }

    const attrMatch = Array.from(document.querySelectorAll('[aria-label], [title], [data-testid]')).some(matchNode);
    if (attrMatch) {
      return { found: true, userTurns: userTurns.length, source: 'attrs' };
    }

    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).some((node) => {
      const el = node instanceof HTMLInputElement ? node : null;
      if (!el?.files?.length) return false;
      return Array.from(el.files).some((file) => file?.name?.toLowerCase?.().includes(normalized));
    });
    if (fileInputs) {
      return { found: true, userTurns: userTurns.length, source: 'input' };
    }

    const bodyMatch = (document.body?.innerText || '').toLowerCase().includes(normalized);
    return { found: bodyMatch, userTurns: userTurns.length, source: bodyMatch ? 'body' : undefined };
  })()`;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = result?.value as { found?: boolean } | undefined;
    if (value?.found) {
      return;
    }
    await delay(200);
  }
  logger?.('Attachment not visible in composer; giving up.');
  await logDomFailure(Runtime, logger ?? (() => {}), 'attachment-visible');
  throw new Error('Attachment did not appear in ChatGPT composer.');
}

async function waitForAttachmentSelection(
  Runtime: ChromeClient['Runtime'],
  expectedName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const expression = `(() => {
    const selectors = ${JSON.stringify(FILE_INPUT_SELECTORS)};
    for (const selector of selectors) {
      const inputs = Array.from(document.querySelectorAll(selector));
      for (const input of inputs) {
        if (!(input instanceof HTMLInputElement) || !input.files) {
          continue;
        }
        const names = Array.from(input.files ?? []).map((file) => file?.name ?? '');
        if (names.some((name) => name === ${JSON.stringify(expectedName)})) {
          return { matched: true, names };
        }
      }
    }
    return { matched: false, names: [] };
  })()`;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const matched = Boolean(result?.value?.matched);
    if (matched) {
      return true;
    }
    await delay(150);
  }
  return false;
}
