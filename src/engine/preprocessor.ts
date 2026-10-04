/**
 * @fileoverview Pure functional Markdown preprocessing pipeline for authoring directives.
 *
 * Intercepts raw Markdown source text prior to Obsidian DOM rendering to detect and convert
 * explicit authoring directives into DOM sentinel elements. Operates strictly in memory
 * without altering the user's source note files on disk.
 */

/**
 * Contextual metadata provided to Markdown preprocessors.
 */
export interface PreprocessContext {
  /** Vault-relative file path of the Markdown note currently undergoing processing. */
  readonly sourcePath?: string;
  /** Parsed frontmatter key-value record extracted from the note header. */
  readonly frontmatter?: Record<string, unknown>;
}

/**
 * Functional contract for a pure, side-effect-free Markdown transformation step.
 *
 * @param markdown - Input Markdown string.
 * @param context - Optional execution metadata for path resolution or frontmatter access.
 * @returns Transformed Markdown string ready for subsequent middleware stages.
 */
export type MarkdownTransformer = (
  markdown: string,
  context?: PreprocessContext,
) => string;

/**
 * HTML sentinel element inserted into the Markdown stream to demarcate an explicit page break.
 *
 * Recognized downstream by {@link paginate} to force an immediate page boundary advance.
 */
const PAGE_BREAK_HTML =
  '<div class="pdf-page-break" data-page-break="true"></div>\n\n';

/**
 * Regular expression matching manual page break directives on standalone lines:
 * - `\pagebreak` (LaTeX / Pandoc standard delimiter)
 * - `<!-- pagebreak -->` (Standard HTML comment delimiter)
 * - `//page` (Concise inline shorthand directive)
 */
const PAGE_BREAK_REGEX =
  /^\s*(\\pagebreak|<!--\s*pagebreak\s*-->|\/\/page)\s*$/im;

/**
 * Transforms manual page break directives outside code blocks into HTML page-break sentinels.
 *
 * Safety Invariant:
 * Strictly shields fenced code blocks (```` or `~~~`). Directives occurring within code snippets,
 * script strings, or configuration examples are preserved verbatim without translation.
 *
 * @param markdown - Raw Markdown source string.
 * @returns Transformed Markdown with matching directives converted into HTML sentinels.
 */
export function transformPageBreaks(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const outputLines: string[] = [];
  let insideCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Toggle fence state upon encountering standard Markdown code fences (``` or ~~~)
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      insideCodeFence = !insideCodeFence;
      outputLines.push(line);
      continue;
    }

    // Only convert directives outside active code fences
    if (!insideCodeFence && PAGE_BREAK_REGEX.test(line)) {
      outputLines.push(PAGE_BREAK_HTML);
    } else {
      outputLines.push(line);
    }
  }

  return outputLines.join("\n");
}

/**
 * Master preprocessor pipeline orchestrating Markdown source transformation prior to DOM rendering.
 *
 * Execution Guarantees:
 * - Pure and idempotent: does not write to disk or mutate external application state.
 * - Sanitized sentinels: downstream {@link MarkdownRenderer.render} preserves data attributes
 *   on sentinel `div` tags for consumption by the pagination engine.
 *
 * @param markdown - Raw Markdown source string extracted from the vault.
 * @param _context - Execution metadata (source path and frontmatter).
 * @returns Transformed Markdown string ready for Obsidian DOM compilation.
 */
export function preprocessMarkdown(
  markdown: string,
  _context: PreprocessContext = {},
): string {
  let processed = markdown;

  // Transform core manual page break directives (\pagebreak, <!-- pagebreak -->, //page)
  processed = transformPageBreaks(processed);

  return processed;
}
