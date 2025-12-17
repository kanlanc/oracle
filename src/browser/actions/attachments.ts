import path from 'node:path';
import type { ChromeClient, BrowserAttachment, BrowserLogger } from '../types.js';
import { CONVERSATION_TURN_SELECTOR, INPUT_SELECTORS, SEND_BUTTON_SELECTORS, UPLOAD_STATUS_SELECTORS } from '../constants.js';
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

  const isAttachmentPresent = async (name: string) => {
    const check = await runtime.evaluate({
      expression: `(() => {
        const expected = ${JSON.stringify(name.toLowerCase())};
        const selectors = [
          '[data-testid*="attachment"]',
          '[data-testid*="chip"]',
          '[data-testid*="upload"]'
        ];
        const chips = selectors.some((selector) =>
          Array.from(document.querySelectorAll(selector)).some((node) =>
            (node?.textContent || '').toLowerCase().includes(expected),
          ),
        );
        if (chips) return true;
        const cardTexts = Array.from(document.querySelectorAll('[aria-label*="Remove"],[aria-label*="remove"]')).map((btn) =>
          btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
        );
        if (cardTexts.some((text) => text.includes(expected))) return true;

        const inputs = Array.from(document.querySelectorAll('input[type="file"]')).some((el) =>
          Array.from(el.files || []).some((f) => f?.name?.toLowerCase?.().includes(expected)),
        );
        return inputs;
      })()`,
      returnByValue: true,
    });
    return Boolean(check?.result?.value);
  };

  // New ChatGPT UI hides the real file input behind a composer "+" menu; click it pre-emptively.
  await Promise.resolve(
    runtime.evaluate({
      expression: `(() => {
        const selectors = [
          '#composer-plus-btn',
          'button[data-testid="composer-plus-btn"]',
          '[data-testid*="plus"]',
          'button[aria-label*="add"]',
          'button[aria-label*="attachment"]',
          'button[aria-label*="file"]',
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
    }),
  ).catch(() => undefined);

  await delay(250);

  // Helper to click the upload menu item (if present) to reveal the real attachment input.
  await Promise.resolve(
    runtime.evaluate({
      expression: `(() => {
        const menuItems = Array.from(document.querySelectorAll('[data-testid*="upload"],[data-testid*="attachment"], [role="menuitem"], [data-radix-collection-item]'));
        for (const el of menuItems) {
          const text = (el.textContent || '').toLowerCase();
          const tid = el.getAttribute?.('data-testid')?.toLowerCase?.() || '';
          if (tid.includes('upload') || tid.includes('attachment') || text.includes('upload') || text.includes('file')) {
            if (el instanceof HTMLElement) { el.click(); return true; }
          }
        }
        return false;
      })()`,
      returnByValue: true,
    }),
  ).catch(() => undefined);

  const expectedName = path.basename(attachment.path);

  if (await isAttachmentPresent(expectedName)) {
    logger(`Attachment already present: ${path.basename(attachment.path)}`);
    return;
  }

  const documentNode = await dom.getDocument();
  const candidateSetup = await runtime.evaluate({
    expression: `(() => {
      const promptSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      const locateComposerRoot = () => {
        for (const selector of promptSelectors) {
          const node = document.querySelector(selector);
          if (!node) continue;
          return node.closest('form') ?? node.closest('[data-testid*="composer"]') ?? node.parentElement;
        }
        return document.querySelector('form') ?? document.body;
      };
      const root = locateComposerRoot();
      const localInputs = root ? Array.from(root.querySelectorAll('input[type="file"]')) : [];
      const inputs = localInputs.length > 0 ? localInputs : Array.from(document.querySelectorAll('input[type="file"]'));
      const acceptIsImageOnly = (accept) => {
        if (!accept) return false;
        const parts = String(accept)
          .split(',')
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);
        return parts.length > 0 && parts.every((p) => p.startsWith('image/'));
      };
      const chipContainer = root ?? document;
      const chipSelector = '[data-testid*="attachment"],[data-testid*="chip"],[data-testid*="upload"],[aria-label*="Remove"],[aria-label*="remove"]';
      const baselineChipCount = chipContainer.querySelectorAll(chipSelector).length;

      // Mark candidates with stable indices so we can select them via DOM.querySelector.
      let idx = 0;
      const candidates = inputs.map((el) => {
        const accept = el.getAttribute('accept') || '';
        const score = (el.hasAttribute('multiple') ? 100 : 0) + (!acceptIsImageOnly(accept) ? 10 : 0);
        el.setAttribute('data-oracle-upload-candidate', 'true');
        el.setAttribute('data-oracle-upload-idx', String(idx));
        return { idx: idx++, score };
      });

      // Prefer higher scores first.
      candidates.sort((a, b) => b.score - a.score);
      return { ok: candidates.length > 0, baselineChipCount, order: candidates.map((c) => c.idx) };
    })()`,
    returnByValue: true,
  });
  const candidateValue = candidateSetup?.result?.value as
    | { ok?: boolean; baselineChipCount?: number; order?: number[] }
    | undefined;
  const candidateOrder = Array.isArray(candidateValue?.order) ? candidateValue.order : [];
  const baselineChipCount = typeof candidateValue?.baselineChipCount === 'number' ? candidateValue.baselineChipCount : 0;
  if (!candidateValue?.ok || candidateOrder.length === 0) {
    await logDomFailure(runtime, logger, 'file-input-missing');
    throw new Error('Unable to locate ChatGPT file attachment input.');
  }

  const dispatchEventsFor = (idx: number) => `(() => {
    const el = document.querySelector('input[type="file"][data-oracle-upload-idx="${idx}"]');
    if (el instanceof HTMLInputElement) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`;

  const composerSnapshotFor = (idx: number) => `(() => {
    const promptSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const locateComposerRoot = () => {
      for (const selector of promptSelectors) {
        const node = document.querySelector(selector);
        if (!node) continue;
        return node.closest('form') ?? node.closest('[data-testid*="composer"]') ?? node.parentElement;
      }
      return document.querySelector('form') ?? document.body;
    };
    const root = locateComposerRoot();
    const chipContainer = root ?? document;
    const chipSelector = '[data-testid*="attachment"],[data-testid*="chip"],[data-testid*="upload"],[aria-label*="Remove"],[aria-label*="remove"]';
    const chips = Array.from(chipContainer.querySelectorAll(chipSelector))
      .slice(0, 20)
      .map((node) => ({
        text: (node.textContent || '').trim(),
        aria: node.getAttribute?.('aria-label') ?? '',
        title: node.getAttribute?.('title') ?? '',
        testid: node.getAttribute?.('data-testid') ?? '',
      }));
    const input = document.querySelector('input[type="file"][data-oracle-upload-idx="${idx}"]');
    const inputNames =
      input instanceof HTMLInputElement
        ? Array.from(input.files || []).map((f) => f?.name ?? '').filter(Boolean)
        : [];
    const composerText = (chipContainer.innerText || '').toLowerCase();
    return { chipCount: chipContainer.querySelectorAll(chipSelector).length, chips, inputNames, composerText };
  })()`;

  let finalSnapshot:
    | { chipCount: number; chips: Array<Record<string, string>>; inputNames: string[]; composerText: string }
    | null = null;
  for (const idx of candidateOrder) {
    const resultNode = await dom.querySelector({
      nodeId: documentNode.root.nodeId,
      selector: `input[type="file"][data-oracle-upload-idx="${idx}"]`,
    });
    if (!resultNode?.nodeId) {
      continue;
    }
    await dom.setFileInputFiles({ nodeId: resultNode.nodeId, files: [attachment.path] });
    await runtime.evaluate({ expression: dispatchEventsFor(idx), returnByValue: true }).catch(() => undefined);

    const probeDeadline = Date.now() + 4000;
    let lastPoke = 0;
    while (Date.now() < probeDeadline) {
      // ChatGPT's composer can take a moment to hydrate the file-input onChange handler after navigation/model switches.
      // If the UI hasn't reacted yet, poke the input a few times to ensure the handler fires once it's mounted.
      if (Date.now() - lastPoke > 650) {
        lastPoke = Date.now();
        await runtime.evaluate({ expression: dispatchEventsFor(idx), returnByValue: true }).catch(() => undefined);
      }
      const snapshot = await runtime
        .evaluate({ expression: composerSnapshotFor(idx), returnByValue: true })
        .then(
          (res) =>
            res?.result?.value as {
              chipCount?: number;
              chips?: Array<Record<string, string>>;
              inputNames?: string[];
              composerText?: string;
            },
        )
        .catch(() => undefined);
      if (snapshot) {
        finalSnapshot = {
          chipCount: Number(snapshot.chipCount ?? 0),
          chips: Array.isArray(snapshot.chips) ? snapshot.chips : [],
          inputNames: Array.isArray(snapshot.inputNames) ? snapshot.inputNames : [],
          composerText: typeof snapshot.composerText === 'string' ? snapshot.composerText : '',
        };
        const inputHasFile = finalSnapshot.inputNames.some((name) =>
          name.toLowerCase().includes(expectedName.toLowerCase()),
        );
        const expectedLower = expectedName.toLowerCase();
        const expectedNoExt = expectedLower.replace(/\.[a-z0-9]{1,10}$/i, '');
        const uiAcknowledged =
          finalSnapshot.chipCount > baselineChipCount ||
          (expectedNoExt.length >= 6
            ? finalSnapshot.composerText.includes(expectedNoExt)
            : finalSnapshot.composerText.includes(expectedLower));
        if (inputHasFile && uiAcknowledged) {
          logger?.(
            `Attachment snapshot after setFileInputFiles: chips=${JSON.stringify(finalSnapshot.chips)} input=${JSON.stringify(finalSnapshot.inputNames)}`,
          );
          break;
        }
      }
      await delay(200);
    }
    const inputHasFile =
      finalSnapshot?.inputNames?.some((name) => name.toLowerCase().includes(expectedName.toLowerCase())) ?? false;
    const uiAcknowledged = (finalSnapshot?.chipCount ?? 0) > baselineChipCount;
    if (inputHasFile && uiAcknowledged) {
      break;
    }
  }

  const inputHasFile =
    finalSnapshot?.inputNames?.some((name) => name.toLowerCase().includes(expectedName.toLowerCase())) ?? false;

  const attachmentUiTimeoutMs = 25_000;
  if (await waitForAttachmentAnchored(runtime, expectedName, attachmentUiTimeoutMs)) {
    await waitForAttachmentVisible(runtime, expectedName, attachmentUiTimeoutMs, logger);
    logger(inputHasFile ? 'Attachment queued (UI anchored, file input confirmed)' : 'Attachment queued (UI anchored)');
    return;
  }

  // If ChatGPT never reflects an attachment UI chip/remove control, the file input may be the wrong target:
  // sending in this state often drops the attachment silently.
  if (inputHasFile) {
    await logDomFailure(runtime, logger, 'file-upload-missing');
    throw new Error('Attachment input accepted the file but ChatGPT did not acknowledge it in the composer UI.');
  }

  await logDomFailure(runtime, logger, 'file-upload-missing');
  throw new Error('Attachment did not register with the ChatGPT composer in time.');
}

export async function waitForAttachmentCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  expectedNames: string[] = [],
  logger?: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const expectedNormalized = expectedNames.map((name) => name.toLowerCase());
  let inputMatchSince: number | null = null;
  let attachmentMatchSince: number | null = null;
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
        // Avoid false positives from user prompts ("upload:") or generic UI copy; only treat explicit progress strings as uploading.
        const text = node.textContent?.toLowerCase?.() ?? '';
        return /\buploading\b/.test(text) || /\bprocessing\b/.test(text);
      });
    });
    const attachmentSelectors = ['[data-testid*="chip"]', '[data-testid*="attachment"]', '[data-testid*="upload"]'];
    const attachedNames = [];
    for (const selector of attachmentSelectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const text = node?.textContent?.toLowerCase?.();
        if (text) attachedNames.push(text);
      }
    }
    const cardTexts = Array.from(document.querySelectorAll('[aria-label*="Remove"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    attachedNames.push(...cardTexts.filter(Boolean));

    const inputNames = [];
    for (const input of Array.from(document.querySelectorAll('input[type="file"]'))) {
      if (!(input instanceof HTMLInputElement) || !input.files?.length) continue;
      for (const file of Array.from(input.files)) {
        if (file?.name) inputNames.push(file.name.toLowerCase());
      }
    }
    const filesAttached = attachedNames.length > 0;
    return { state: button ? (disabled ? 'disabled' : 'ready') : 'missing', uploading, filesAttached, attachedNames, inputNames };
  })()`;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = result?.value as {
      state?: string;
      uploading?: boolean;
      filesAttached?: boolean;
      attachedNames?: string[];
      inputNames?: string[];
    } | undefined;
    if (value) {
      const attachedNames = (value.attachedNames ?? [])
        .map((name) => name.toLowerCase().replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const inputNames = (value.inputNames ?? [])
        .map((name) => name.toLowerCase().replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const matchesExpected = (expected: string): boolean => {
        const baseName = expected.split('/').pop()?.split('\\').pop() ?? expected;
        const normalizedExpected = baseName.toLowerCase().replace(/\s+/g, ' ').trim();
        const expectedNoExt = normalizedExpected.replace(/\.[a-z0-9]{1,10}$/i, '');
        return attachedNames.some((raw) => {
          if (raw.includes(normalizedExpected)) return true;
          if (expectedNoExt.length >= 6 && raw.includes(expectedNoExt)) return true;
          if (raw.includes('…') || raw.includes('...')) {
            const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = escaped.replace(/\\…|\\\.\\\.\\\./g, '.*');
            try {
              const re = new RegExp(pattern);
              return re.test(normalizedExpected) || (expectedNoExt.length >= 6 && re.test(expectedNoExt));
            } catch {
              return false;
            }
          }
          return false;
        });
      };
      const missing = expectedNormalized.filter((expected) => !matchesExpected(expected));
      if (missing.length === 0) {
        const stableThresholdMs = value.uploading ? 3000 : 1500;
        if (value.state === 'ready') {
          if (attachmentMatchSince === null) {
            attachmentMatchSince = Date.now();
          }
          if (Date.now() - attachmentMatchSince > stableThresholdMs) {
            return;
          }
        } else {
          attachmentMatchSince = null;
        }
        if (value.state === 'missing' && value.filesAttached) {
          return;
        }
        // If files are attached but button isn't ready yet, give it more time but don't fail immediately.
        if (value.filesAttached) {
          await delay(500);
          continue;
        }
      } else {
        attachmentMatchSince = null;
      }

      // Fallback: if the file input has the expected names, allow progress once that condition is stable.
      // Some ChatGPT surfaces only render the filename after sending the message.
      const inputMissing = expectedNormalized.filter((expected) => {
        const baseName = expected.split('/').pop()?.split('\\').pop() ?? expected;
        const normalizedExpected = baseName.toLowerCase().replace(/\s+/g, ' ').trim();
        const expectedNoExt = normalizedExpected.replace(/\.[a-z0-9]{1,10}$/i, '');
        return !inputNames.some(
          (raw) => raw.includes(normalizedExpected) || (expectedNoExt.length >= 6 && raw.includes(expectedNoExt)),
        );
      });
      if (inputMissing.length === 0 && (value.state === 'ready' || value.state === 'missing')) {
        const stableThresholdMs = value.uploading ? 3000 : 1500;
        if (inputMatchSince === null) {
          inputMatchSince = Date.now();
        }
        if (Date.now() - inputMatchSince > stableThresholdMs) {
          return;
        }
      } else {
        inputMatchSince = null;
      }
    }
    await delay(250);
  }
  logger?.('Attachment upload timed out while waiting for ChatGPT composer to become ready.');
  await logDomFailure(Runtime, logger ?? (() => {}), 'file-upload-timeout');
  throw new Error('Attachments did not finish uploading before timeout.');
}

export async function waitForUserTurnAttachments(
  Runtime: ChromeClient['Runtime'],
  expectedNames: string[],
  timeoutMs: number,
  logger?: BrowserLogger,
): Promise<void> {
  if (!expectedNames || expectedNames.length === 0) {
    return;
  }

  const expectedNormalized = expectedNames.map((name) => name.toLowerCase());
  const conversationSelectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const expression = `(() => {
    const CONVERSATION_SELECTOR = ${conversationSelectorLiteral};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    const userTurns = turns.filter((node) => {
      const attr = (node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (attr === 'user') return true;
      return Boolean(node.querySelector('[data-message-author-role="user"]'));
    });
    const lastUser = userTurns[userTurns.length - 1];
    if (!lastUser) return { ok: false };
    const text = (lastUser.innerText || '').toLowerCase();
    const attrs = Array.from(lastUser.querySelectorAll('[aria-label],[title]')).map((el) => {
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      return (aria + ' ' + title).trim().toLowerCase();
    }).filter(Boolean);
    return { ok: true, text, attrs };
  })()`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = result?.value as { ok?: boolean; text?: string; attrs?: string[] } | undefined;
    if (!value?.ok) {
      await delay(200);
      continue;
    }
    const haystack = [value.text ?? '', ...(value.attrs ?? [])].join('\n');
    const missing = expectedNormalized.filter((expected) => {
      const baseName = expected.split('/').pop()?.split('\\').pop() ?? expected;
      const normalizedExpected = baseName.toLowerCase().replace(/\s+/g, ' ').trim();
      const expectedNoExt = normalizedExpected.replace(/\.[a-z0-9]{1,10}$/i, '');
      if (haystack.includes(normalizedExpected)) return false;
      if (expectedNoExt.length >= 6 && haystack.includes(expectedNoExt)) return false;
      return true;
    });
    if (missing.length === 0) {
      return;
    }
    await delay(250);
  }

  logger?.('Sent user message did not show expected attachment names in time.');
  await logDomFailure(Runtime, logger ?? (() => {}), 'attachment-missing-user-turn');
  throw new Error('Attachment was not present on the sent user message.');
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
    const normalizedNoExt = normalized.replace(/\\.[a-z0-9]{1,10}$/i, '');
    const matchNode = (node) => {
      if (!node) return false;
      const text = (node.textContent || '').toLowerCase();
      const aria = node.getAttribute?.('aria-label')?.toLowerCase?.() ?? '';
      const title = node.getAttribute?.('title')?.toLowerCase?.() ?? '';
      const testId = node.getAttribute?.('data-testid')?.toLowerCase?.() ?? '';
      const alt = node.getAttribute?.('alt')?.toLowerCase?.() ?? '';
      const candidates = [text, aria, title, testId, alt].filter(Boolean);
      return candidates.some((value) => value.includes(normalized) || (normalizedNoExt.length >= 6 && value.includes(normalizedNoExt)));
    };

    const attachmentSelectors = ['[data-testid*="attachment"]','[data-testid*="chip"]','[data-testid*="upload"]'];
    const attachmentMatch = attachmentSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some(matchNode),
    );
    if (attachmentMatch) {
      return { found: true, source: 'attachments' };
    }

    const cardTexts = Array.from(document.querySelectorAll('[aria-label*="Remove"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    if (cardTexts.some((text) => text.includes(normalized) || (normalizedNoExt.length >= 6 && text.includes(normalizedNoExt)))) {
      return { found: true, source: 'attachment-cards' };
    }

    return { found: false };
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

async function waitForAttachmentAnchored(
  Runtime: ChromeClient['Runtime'],
  expectedName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const expression = `(() => {
    const normalized = ${JSON.stringify(expectedName.toLowerCase())};
    const normalizedNoExt = normalized.replace(/\\.[a-z0-9]{1,10}$/i, '');
    const matchesExpected = (value) => {
      const text = (value ?? '').toLowerCase();
      if (!text) return false;
      if (text.includes(normalized)) return true;
      if (normalizedNoExt.length >= 6 && text.includes(normalizedNoExt)) return true;
      if (text.includes('…') || text.includes('...')) {
        const escaped = text.replace(/[.*+?^$\\{\\}()|[\\]\\\\]/g, '\\\\$&');
        const pattern = escaped.replaceAll('…', '.*').replaceAll('...', '.*');
        try {
          const re = new RegExp(pattern);
          return re.test(normalized) || (normalizedNoExt.length >= 6 && re.test(normalizedNoExt));
        } catch {
          return false;
        }
      }
      return false;
    };

    const selectors = [
      '[data-testid*="attachment"]',
      '[data-testid*="chip"]',
      '[data-testid*="upload"]',
      '[aria-label*="Remove"]',
      'button[aria-label*="Remove"]',
    ];
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const text = node?.textContent || '';
        const aria = node?.getAttribute?.('aria-label') || '';
        const title = node?.getAttribute?.('title') || '';
        if ([text, aria, title].some(matchesExpected)) {
          return { found: true, text: (text || aria || title).toLowerCase() };
        }
      }
    }
    const cards = Array.from(document.querySelectorAll('[aria-label*="Remove"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    if (cards.some(matchesExpected)) {
      return { found: true, text: cards.find(matchesExpected) };
    }
    return { found: false };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    if (result?.value?.found) {
      return true;
    }
    await delay(200);
  }
  return false;
}
