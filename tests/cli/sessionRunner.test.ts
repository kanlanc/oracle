import { beforeAll, afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/oracle.ts', async () => {
  const actual = await vi.importActual<typeof import('../../src/oracle.ts')>('../../src/oracle.ts');
  return {
    ...actual,
    runOracle: vi.fn(),
  };
});

vi.mock('../../src/oracle/multiModelRunner.ts', () => ({
  runMultiModelApiSession: vi.fn(),
}));

vi.mock('../../src/browser/sessionRunner.ts', () => ({
  runBrowserSessionExecution: vi.fn(),
}));

vi.mock('../../src/cli/notifier.ts', () => ({
  sendSessionNotification: vi.fn(),
  deriveNotificationSettingsFromMetadata: vi.fn(() => ({ enabled: true, sound: false })),
}));

const sessionStoreMock = vi.hoisted(() => ({
  updateSession: vi.fn(),
  createLogWriter: vi.fn(),
  updateModelRun: vi.fn(),
  readLog: vi.fn(),
  readSession: vi.fn(),
  readRequest: vi.fn(),
  ensureStorage: vi.fn(),
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  getPaths: vi.fn(),
  readModelLog: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue('/tmp/.oracle/sessions'),
}));

vi.mock('../../src/sessionStore.ts', () => ({
  sessionStore: sessionStoreMock,
}));

import type { SessionMetadata, SessionModelRun } from '../../src/sessionManager.ts';
import type { ModelName } from '../../src/oracle.ts';
import { performSessionRun } from '../../src/cli/sessionRunner.ts';
import { BrowserAutomationError, FileValidationError, OracleResponseError, OracleTransportError, runOracle } from '../../src/oracle.ts';
import {
  runMultiModelApiSession,
  type ModelExecutionResult,
  type MultiModelRunSummary,
} from '../../src/oracle/multiModelRunner.ts';
import type { OracleResponse, RunOracleResult } from '../../src/oracle.ts';
import { runBrowserSessionExecution } from '../../src/browser/sessionRunner.ts';
import { sendSessionNotification } from '../../src/cli/notifier.ts';
import { getCliVersion } from '../../src/version.ts';

const baseSessionMeta: SessionMetadata = {
  id: 'sess-1',
  createdAt: '2025-01-01T00:00:00Z',
  status: 'pending',
  options: {},
};

const baseRunOptions = {
  prompt: 'Hello',
  model: 'gpt-5.1-pro' as const,
};

const log = vi.fn();
const write = vi.fn(() => true);
const cliVersion = getCliVersion();
const originalPlatform = process.platform;

beforeAll(() => {
  // Force macOS platform so browser-mode paths are reachable in Linux/Windows CI
  Object.defineProperty(process, 'platform', { value: 'darwin' });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(sessionStoreMock).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) {
      fn.mockReset();
    }
  });
  vi.mocked(runMultiModelApiSession).mockReset();
  vi.mocked(runMultiModelApiSession).mockResolvedValue({ fulfilled: [], rejected: [], elapsedMs: 0 });
  sessionStoreMock.createLogWriter.mockReturnValue({
    logLine: vi.fn(),
    writeChunk: vi.fn(),
    stream: { end: vi.fn() },
  });
});

describe('performSessionRun', () => {
  test('completes API sessions and records usage', async () => {
    const liveResult: RunOracleResult = {
      mode: 'live',
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30 },
      elapsedMs: 1234,
      response: { id: 'resp', usage: {}, output: [] },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: 'api',
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    expect(sessionStoreMock.updateSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runOracle)).toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'completed',
      usage: { totalTokens: 30 },
      response: expect.objectContaining({ responseId: expect.any(String) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.1-pro',
      expect.objectContaining({ status: 'running' }),
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.1-pro',
      expect.objectContaining({ status: 'completed' }),
    );
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
  });

  test('streams per-model output as each model finishes when TTY', async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: 'gpt-5.1', status: 'running' } as SessionModelRun,
        { model: 'gemini-3-pro', status: 'running' } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockImplementation(async (_sessionId: string, model: string) => `Answer:\nfrom ${model}`);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      const fulfilled: ModelExecutionResult[] = [
        {
          model: 'gemini-3-pro' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'gemini answer',
          logPath: 'log-gemini',
        },
        {
          model: 'gpt-5.1' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'gpt answer',
          logPath: 'log-gpt',
        },
      ];

      if (params.onModelDone) {
        for (const entry of fulfilled) {
          await params.onModelDone(entry);
        }
      }

      return {
        fulfilled,
        rejected: [],
        elapsedMs: 1000,
      } as MultiModelRunSummary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ['gpt-5.1', 'gemini-3-pro'] },
      mode: 'api',
      cwd: '/tmp',
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('from gemini-3-pro');
    expect(written).toContain('from gpt-5.1');
    const geminiIndex = written.indexOf('from gemini-3-pro');
    const gptIndex = written.indexOf('from gpt-5.1');
    expect(geminiIndex).toBeGreaterThan(-1);
    expect(gptIndex).toBeGreaterThan(-1);
    expect(geminiIndex).toBeLessThan(gptIndex);

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test('prints one aggregate header and colored summary for multi-model runs', async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: 'gpt-5.1', status: 'running' } as SessionModelRun,
        { model: 'gemini-3-pro', status: 'running' } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue('Answer:\nfrom model');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: 'gpt-5.1' as ModelName,
          usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30, cost: 0.01 },
          answerText: 'ans-gpt',
          logPath: 'log-gpt',
        },
        {
          model: 'gemini-3-pro' as ModelName,
          usage: { inputTokens: 5, outputTokens: 5, reasoningTokens: 0, totalTokens: 10, cost: 0.02 },
          answerText: 'ans-gemini',
          logPath: 'log-gemini',
        },
      ],
      rejected: [],
      elapsedMs: 1234,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ['gpt-5.1', 'gemini-3-pro'] },
      mode: 'api',
      cwd: '/tmp',
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logsCombined).toContain('Calling gpt-5.1, gemini-3-pro');
    expect((logsCombined.match(/Calling gpt-5.1/g) ?? []).length).toBe(1);
    expect(logsCombined).toMatch(/Finished in .*2\/2 models/);

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test('uses warning color when some models fail', async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: 'gpt-5.1', status: 'running' },
        { model: 'gemini-3-pro', status: 'running' },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue('Answer:\npartial');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: 'gpt-5.1' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'ok',
          logPath: 'log-ok',
        },
      ],
      rejected: [{ model: 'gemini-3-pro' as ModelName, reason: new Error('boom') }],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await expect(
      performSessionRun({
        sessionMeta,
        runOptions: { ...baseRunOptions, models: ['gpt-5.1', 'gemini-3-pro'] },
        mode: 'api',
        cwd: '/tmp',
        log: logSpy,
        write: writeSpy,
        version: cliVersion,
      }),
    ).rejects.toThrow('boom');

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logsCombined).toContain('Calling gpt-5.1, gemini-3-pro');
    expect(logsCombined).toContain('1/2 models');

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test('invokes browser runner when mode is browser', async () => {
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150 },
      elapsedMs: 2000,
      runtime: { chromePid: 123, chromePort: 9222, userDataDir: '/tmp/profile' },
      answerText: 'Answer',
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: 'browser',
      browserConfig: { chromePath: null },
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(runBrowserSessionExecution)).toHaveBeenCalled();
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'completed',
      browser: expect.objectContaining({ runtime: expect.objectContaining({ chromePid: 123 }) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.1-pro',
      expect.objectContaining({ status: 'running' }),
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.1-pro',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  test('records metadata when browser automation fails', async () => {
    const automationError = new BrowserAutomationError('automation failed', { stage: 'execute-browser' });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'browser',
        browserConfig: { chromePath: null },
        cwd: '/tmp',
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow('automation failed');

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'error',
      errorMessage: 'automation failed',
      browser: expect.objectContaining({ config: expect.any(Object) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.1-pro',
      expect.objectContaining({ status: 'error' }),
    );
  });

  test('records response metadata when runOracle throws OracleResponseError', async () => {
    const errorResponse: OracleResponse = { id: 'resp-error', output: [], usage: {} };
    vi.mocked(runOracle).mockRejectedValue(new OracleResponseError('boom', errorResponse));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'api',
        cwd: '/tmp',
        log,
        write,
      version: cliVersion,
      }),
    ).rejects.toThrow('boom');

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'error',
      response: expect.objectContaining({ responseId: 'resp-error' }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.1-pro',
      expect.objectContaining({ status: 'running' }),
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.1-pro',
      expect.objectContaining({ status: 'error' }),
    );
  });

  test('captures transport failures when OracleTransportError thrown', async () => {
    vi.mocked(runOracle).mockRejectedValue(new OracleTransportError('client-timeout', 'timeout'));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'api',
        cwd: '/tmp',
        log,
        write,
      version: cliVersion,
      }),
    ).rejects.toThrow('timeout');

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'error',
      transport: { reason: 'client-timeout' },
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.1-pro',
      expect.objectContaining({ status: 'error' }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Transport'));
  });

  test('captures user errors when OracleUserError thrown', async () => {
    vi.mocked(runOracle).mockRejectedValue(new FileValidationError('too large', { path: 'foo.txt' }));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'api',
        cwd: '/tmp',
        log,
        write,
      version: cliVersion,
      }),
    ).rejects.toThrow('too large');

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'error',
      error: expect.objectContaining({ category: 'file-validation', message: 'too large' }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.1-pro',
      expect.objectContaining({ status: 'error' }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('User error (file-validation)'));
  });
});
