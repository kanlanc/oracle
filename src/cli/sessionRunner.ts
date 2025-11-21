import kleur from 'kleur';
import type { SessionMetadata, SessionMode, BrowserSessionConfig } from '../sessionStore.js';
import type { RunOracleOptions, UsageSummary } from '../oracle.js';
import {
  runOracle,
  OracleResponseError,
  OracleTransportError,
  extractResponseMetadata,
  asOracleUserError,
  extractTextOutput,
} from '../oracle.js';
import { runBrowserSessionExecution, type BrowserSessionRunnerDeps } from '../browser/sessionRunner.js';
import { renderMarkdownAnsi } from './markdownRenderer.js';
import { formatResponseMetadata, formatTransportMetadata } from './sessionDisplay.js';
import { markErrorLogged } from './errorUtils.js';
import {
  type NotificationSettings,
  sendSessionNotification,
  deriveNotificationSettingsFromMetadata,
} from './notifier.js';
import { sessionStore } from '../sessionStore.js';
import { runMultiModelApiSession } from '../oracle/multiModelRunner.js';
import { MODEL_CONFIGS, DEFAULT_SYSTEM_PROMPT } from '../oracle/config.js';
import { buildPrompt, buildRequestBody } from '../oracle/request.js';
import { estimateRequestTokens } from '../oracle/tokenEstimate.js';
import { formatTokenEstimate, formatTokenValue } from '../oracle/runUtils.js';
import { readFiles } from '../oracle/files.js';
import { formatUSD } from '../oracle/format.js';

const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);

export interface SessionRunParams {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  mode: SessionMode;
  browserConfig?: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
  write: (chunk: string) => boolean;
  version: string;
  notifications?: NotificationSettings;
  browserDeps?: BrowserSessionRunnerDeps;
}

export async function performSessionRun({
  sessionMeta,
  runOptions,
  mode,
  browserConfig,
  cwd,
  log,
  write,
  version,
  notifications,
  browserDeps,
}: SessionRunParams): Promise<void> {
  await sessionStore.updateSession(sessionMeta.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    mode,
    ...(browserConfig ? { browser: { config: browserConfig } } : {}),
  });
  const notificationSettings = notifications ?? deriveNotificationSettingsFromMetadata(sessionMeta, process.env);
  const modelForStatus = runOptions.model ?? sessionMeta.model;
  try {
    if (mode === 'browser') {
      if (runOptions.model.startsWith('gemini')) {
        throw new Error('Gemini models are not available in browser mode. Re-run with --engine api.');
      }
      if (!browserDeps?.executeBrowser && process.platform !== 'darwin') {
        throw new Error(
          'Browser engine is only supported on macOS today. Use --engine api instead, or run on macOS.',
        );
      }
      if (!browserConfig) {
        throw new Error('Missing browser configuration for session.');
      }
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: 'running',
          startedAt: new Date().toISOString(),
        });
      }
      const result = await runBrowserSessionExecution({ runOptions, browserConfig, cwd, log }, browserDeps);
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          usage: result.usage,
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        browser: {
          config: browserConfig,
          runtime: result.runtime,
        },
        response: undefined,
        transport: undefined,
        error: undefined,
      });
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: sessionMeta.model,
          usage: result.usage,
          characters: result.answerText?.length,
        },
        notificationSettings,
        log,
        result.answerText?.slice(0, 140),
      );
      return;
    }
    const multiModels = Array.isArray(runOptions.models) ? runOptions.models.filter(Boolean) : [];
    if (multiModels.length > 1) {
      const [primaryModel] = multiModels;
      if (!primaryModel) {
        throw new Error('Missing model name for multi-model run.');
      }
      const modelConfig = MODEL_CONFIGS[primaryModel];
      if (!modelConfig) {
        throw new Error(`Unsupported model "${primaryModel}".`);
      }
      const files = await readFiles(runOptions.file ?? [], { cwd });
      const promptWithFiles = buildPrompt(runOptions.prompt, files, cwd);
      const requestBody = buildRequestBody({
        modelConfig,
        systemPrompt: runOptions.system ?? DEFAULT_SYSTEM_PROMPT,
        userPrompt: promptWithFiles,
        searchEnabled: runOptions.search !== false,
        maxOutputTokens: runOptions.maxOutput,
        background: runOptions.background,
        storeResponse: runOptions.background,
      });
      const estimatedTokens = estimateRequestTokens(requestBody, modelConfig);
      const tokenLabel = formatTokenEstimate(estimatedTokens, (text) => (isTty ? kleur.green(text) : text));
      const filesPhrase = files.length === 0 ? 'no files' : `${files.length} files`;
      const modelsLabel = multiModels.join(', ');
      log(`Calling ${isTty ? kleur.cyan(modelsLabel) : modelsLabel} — ${tokenLabel} tokens, ${filesPhrase}.`);

      const shouldStreamInline = process.stdout.isTTY;
      const shouldRenderMarkdown = shouldStreamInline && runOptions.renderPlain !== true;
      const printedModels = new Set<string>();

      const printModelLog = async (model: string) => {
        if (printedModels.has(model)) return;
        printedModels.add(model);
        const body = await sessionStore.readModelLog(sessionMeta.id, model);
        if (printedModels.size > 1) {
          log('');
        }
        if (body.length === 0) {
          log(dim(`${model}: (no output recorded)`));
          return;
        }
        const heading = shouldStreamInline ? kleur.bold(model) : model;
        log(heading);
        const printable = shouldRenderMarkdown ? renderMarkdownAnsi(body) : body;
        write(printable);
        if (!printable.endsWith('\n')) {
          log('');
        }
      };

      const summary = await runMultiModelApiSession(
        {
          sessionMeta,
          runOptions,
          models: multiModels,
          cwd,
          version,
          onModelDone: shouldStreamInline
            ? async (result) => {
                await printModelLog(result.model);
              }
            : undefined,
        },
        undefined,
      );

      if (!shouldStreamInline) {
        // If we couldn't stream inline (e.g., non-TTY), print all logs after completion.
        for (const [index, result] of summary.fulfilled.entries()) {
          if (index > 0) {
            log('');
          }
          await printModelLog(result.model);
        }
      }
      const aggregateUsage = summary.fulfilled.reduce<UsageSummary>(
        (acc, entry) => ({
          inputTokens: acc.inputTokens + entry.usage.inputTokens,
          outputTokens: acc.outputTokens + entry.usage.outputTokens,
          reasoningTokens: acc.reasoningTokens + entry.usage.reasoningTokens,
          totalTokens: acc.totalTokens + entry.usage.totalTokens,
          cost: (acc.cost ?? 0) + (entry.usage.cost ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 },
      );
      const tokensDisplay = [
        aggregateUsage.inputTokens,
        aggregateUsage.outputTokens,
        aggregateUsage.reasoningTokens,
        aggregateUsage.totalTokens,
      ]
        .map((v, idx) =>
          formatTokenValue(
            v,
            {
              input_tokens: aggregateUsage.inputTokens,
              output_tokens: aggregateUsage.outputTokens,
              reasoning_tokens: aggregateUsage.reasoningTokens,
              total_tokens: aggregateUsage.totalTokens,
            },
            idx,
          ),
        )
        .join('/');
      const costLabel = aggregateUsage.cost != null ? formatUSD(aggregateUsage.cost) : 'cost=N/A';
      const statusColor = summary.rejected.length === 0 ? kleur.green : summary.fulfilled.length > 0 ? kleur.yellow : kleur.red;
      const overallText = `${summary.fulfilled.length}/${multiModels.length} models`;
      log(
        statusColor(
          `Finished in ${summary.elapsedMs.toLocaleString()}ms (${overallText} | ${costLabel} | tok(i/o/r/t)=${tokensDisplay})`,
        ),
      );

      const hasFailure = summary.rejected.length > 0;
      await sessionStore.updateSession(sessionMeta.id, {
        status: hasFailure ? 'error' : 'completed',
        completedAt: new Date().toISOString(),
        usage: aggregateUsage,
        elapsedMs: summary.elapsedMs,
        response: undefined,
        transport: undefined,
        error: undefined,
      });
      const totalCharacters = summary.fulfilled.reduce((sum, entry) => sum + entry.answerText.length, 0);
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: `${multiModels.length} models`,
          usage: aggregateUsage,
          characters: totalCharacters,
        },
        notificationSettings,
        log,
      );
      if (hasFailure) {
        throw summary.rejected[0].reason;
      }
      return;
    }
    const singleModelOverride = multiModels.length === 1 ? multiModels[0] : undefined;
    const apiRunOptions: RunOracleOptions = singleModelOverride
      ? { ...runOptions, model: singleModelOverride, models: undefined }
      : runOptions;
    if (modelForStatus && singleModelOverride == null) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    }
    const result = await runOracle(apiRunOptions, {
      cwd,
      log,
      write,
    });
    if (result.mode !== 'live') {
      throw new Error('Unexpected preview result while running a session.');
    }
    await sessionStore.updateSession(sessionMeta.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      response: extractResponseMetadata(result.response),
      transport: undefined,
      error: undefined,
    });
    if (modelForStatus && singleModelOverride == null) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        usage: result.usage,
      });
    }
    const answerText = extractTextOutput(result.response);
    await sendSessionNotification(
      {
        sessionId: sessionMeta.id,
        sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
        mode,
        model: sessionMeta.model ?? runOptions.model,
        usage: result.usage,
        characters: answerText.length,
      },
      notificationSettings,
      log,
      answerText.slice(0, 140),
    );
  } catch (error: unknown) {
    const message = formatError(error);
    log(`ERROR: ${message}`);
    markErrorLogged(error);
    const userError = asOracleUserError(error);
    if (userError) {
      log(dim(`User error (${userError.category}): ${userError.message}`));
    }
    const responseMetadata = error instanceof OracleResponseError ? error.metadata : undefined;
    const metadataLine = formatResponseMetadata(responseMetadata);
    if (metadataLine) {
      log(dim(`Response metadata: ${metadataLine}`));
    }
    const transportMetadata = error instanceof OracleTransportError ? { reason: error.reason } : undefined;
    const transportLine = formatTransportMetadata(transportMetadata);
    if (transportLine) {
      log(dim(`Transport: ${transportLine}`));
    }
    await sessionStore.updateSession(sessionMeta.id, {
      status: 'error',
      completedAt: new Date().toISOString(),
      errorMessage: message,
      mode,
      browser: browserConfig ? { config: browserConfig } : undefined,
      response: responseMetadata,
      transport: transportMetadata,
      error: userError
        ? {
            category: userError.category,
            message: userError.message,
            details: userError.details,
          }
        : undefined,
    });
    if (mode === 'browser') {
      log(dim('Next steps (browser fallback):')); // guides users when automation breaks
      log(dim('- Rerun with --engine api to bypass Chrome entirely.'));
      log(
        dim(
          '- Or rerun with --engine api --render-markdown [--file …] to generate a single markdown bundle you can paste into ChatGPT manually (add --browser-bundle-files if you still want attachments).',
        ),
      );
    }
    if (modelForStatus) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: 'error',
        completedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
