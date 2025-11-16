import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

const renderer = new TerminalRenderer({
  reflowText: false,
  width: process.stdout.columns ? Math.max(20, process.stdout.columns - 2) : undefined,
  tab: 2,
});

/**
 * Render markdown to ANSI-colored text suitable for a TTY.
 */
export function renderMarkdownAnsi(markdown: string): string {
  return marked.parse(markdown, { renderer }) as string;
}

