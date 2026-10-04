/**
 * @fileoverview Physical-to-screen metric conversions, geometric boundary computation, and DOM mutation stabilization.
 *
 * Bridges physical millimeter dimensions (ISO 216 / ANSI) with viewport pixel coordinates (px),
 * computes exact printable bounding limits for virtual pages, and provides an event-driven
 * stabilization barrier ({@link waitForDomSettled}) ensuring asynchronous web fonts, MathJax,
 * and external styling plugins conclude DOM mutations before pagination measurements begin.
 */

import type { PageDimensionsMm, PageMarginsMm } from "@/types";

/**
 * Computed physical page dimensions and printable content boundaries converted to screen pixels.
 *
 * Serves as the mathematical contract for the pagination engine to determine
 * page capacities, content areas, and overflow thresholds:
 * - Content boundaries are strictly non-negative.
 * - `maxContentBottomPx` marks the absolute coordinate threshold where page splitting triggers.
 */
export interface PageLimitsPx {
  /** Total physical sheet width in screen pixels. */
  readonly pageWidthPx: number;
  /** Total physical sheet height in screen pixels. */
  readonly pageHeightPx: number;
  /** Top non-printable margin clearance in pixels. */
  readonly marginTopPx: number;
  /** Bottom non-printable margin clearance in pixels. */
  readonly marginBottomPx: number;
  /** Left non-printable margin clearance in pixels. */
  readonly marginLeftPx: number;
  /** Right non-printable margin clearance in pixels. */
  readonly marginRightPx: number;
  /** Usable printable width in pixels: `pageWidthPx - marginLeftPx - marginRightPx`. */
  readonly contentWidthPx: number;
  /** Usable printable height in pixels: `pageHeightPx - marginTopPx - marginBottomPx`. */
  readonly contentHeightPx: number;
  /** Absolute bottom threshold in pixels for page content: `pageHeightPx - marginBottomPx`. */
  readonly maxContentBottomPx: number;
}

/**
 * Configuration options for DOM mutation stabilization and settle wait times.
 */
export interface DomSettleOptions {
  /**
   * Inactivity window in milliseconds required to declare the DOM quiescent after a mutation.
   * @default 40
   */
  quietMs?: number;

  /**
   * Hard safety ceiling in milliseconds to force resolution if third-party extensions mutate endlessly.
   * @default 600
   */
  maxWaitMs?: number;
}

/**
 * Measures the active display ratio of screen pixels per physical millimeter.
 *
 * Architecture and Performance:
 * Dynamically measures a single 100mm reference element in the target DOM rather than assuming
 * a static 96 DPI baseline. This accurately compensates for user interface scaling, OS display
 * fractional scaling, and Obsidian window zoom factors while confining layout reflow to a single probe.
 *
 * @param doc - Target Document context (supports main window and Obsidian popout windows).
 * @returns Ratio of screen pixels per millimeter.
 */
function getPixelsPerMm(
  doc: Document = typeof activeDocument !== "undefined"
    ? activeDocument
    : document,
): number {
  const tempEl = doc.createElement("div");

  tempEl.style.cssText = `
    height: 100mm;
    position: absolute;
    visibility: hidden;
    pointer-events: none;
    top: -9999px;
    left: -9999px;
  `;

  doc.body.appendChild(tempEl);
  const measured100mmPx = tempEl.offsetHeight;
  tempEl.remove();

  return measured100mmPx / 100;
}

/**
 * Computes exact pixel boundaries and printable limits for virtual pages
 * using dynamic metric measurement and pure in-memory geometry calculations.
 *
 * Preconditions:
 * - `dimensions.width > 0` and `dimensions.height > 0`.
 * - `margins` top, bottom, left, and right are >= 0.
 *
 * Postconditions:
 * - All returned pixel measurements are rounded integers.
 * - `contentWidthPx` and `contentHeightPx` are clamped to >= 0 to prevent negative bounding boxes.
 *
 * @param dimensions - Physical sheet dimensions in millimeters.
 * @param margins - Printable margins in millimeters.
 * @param doc - Optional Document context for metric probing.
 * @returns An immutable {@link PageLimitsPx} instance detailing all page boundaries.
 */
export function calculatePageLimits(
  dimensions: PageDimensionsMm,
  margins: PageMarginsMm,
  doc?: Document,
): PageLimitsPx {
  const pxPerMm = getPixelsPerMm(doc);

  const pageWidthPx = Math.round(dimensions.width * pxPerMm);
  const pageHeightPx = Math.round(dimensions.height * pxPerMm);
  const marginTopPx = Math.round(margins.top * pxPerMm);
  const marginBottomPx = Math.round(margins.bottom * pxPerMm);
  const marginLeftPx = Math.round(margins.left * pxPerMm);
  const marginRightPx = Math.round(margins.right * pxPerMm);

  const contentWidthPx = Math.max(
    0,
    pageWidthPx - marginLeftPx - marginRightPx,
  );
  const contentHeightPx = Math.max(
    0,
    pageHeightPx - marginTopPx - marginBottomPx,
  );
  const maxContentBottomPx = pageHeightPx - marginBottomPx;

  return {
    pageWidthPx,
    pageHeightPx,
    marginTopPx,
    marginBottomPx,
    marginLeftPx,
    marginRightPx,
    contentWidthPx,
    contentHeightPx,
    maxContentBottomPx,
  };
}

/**
 * Yields control until the browser's next animation frame dispatch.
 *
 * Ensures synchronous JavaScript loops pause long enough for the browser's layout engine
 * to perform a geometric reflow and style computation pass.
 *
 * @returns A promise resolving on the subsequent `requestAnimationFrame` callback.
 */
export function waitForNextFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => resolve());
  return promise;
}

/**
 * Halts pipeline execution until asynchronous DOM mutations, web font loading, and third-party
 * syntax engines settle on a rendered container.
 *
 * Three-Stage Stabilization Pipeline:
 * 1. **Font Readiness Gate:** Awaits `document.fonts.ready` to prevent font-swap layout shifts
 *    from altering measured text block heights.
 * 2. **Event-Driven Quiet Window:** Attaches a `MutationObserver` to `target`. Every DOM mutation
 *    resets a `quietMs` timer. The gate resolves only when the container remains completely
 *    mutation-free for `quietMs` milliseconds.
 * 3. **Safety Ceiling:** Enforces an absolute `maxWaitMs` timeout to guarantee pipeline progression
 *    even if external plugins cause continuous or runaway DOM mutations.
 * 4. **Layout Synchronization:** Executes a final `requestAnimationFrame` to ensure computed styles
 *    and geometry caches are flushed.
 *
 * @param target - Root HTMLElement containing the newly rendered Markdown subtree.
 * @param options - Custom configuration for quiet window duration and maximum timeout ceiling.
 * @returns A promise resolving when DOM geometry has settled and is safe for height measurement.
 */
export async function waitForDomSettled(
  target: HTMLElement,
  options: DomSettleOptions = {},
): Promise<void> {
  const quietMs = options.quietMs ?? 40;
  const maxWaitMs = options.maxWaitMs ?? 600;

  // 1. Ensure web/math fonts are loaded so text height measurements don't shift
  const doc = target.ownerDocument ?? document;
  if (doc.fonts && typeof doc.fonts.ready?.then === "function") {
    try {
      await doc.fonts.ready;
    } catch {
      // Fail-safe: continue even if font API rejects
    }
  }

  // 2. Event-driven mutation monitoring with safety ceiling
  const { promise, resolve } = Promise.withResolvers<void>();
  let quietTimer: number | null = null;
  let hardCeilingTimer: number | null = null;

  const cleanup = (): void => {
    clearTimeout(quietTimer ?? undefined);
    clearTimeout(hardCeilingTimer ?? undefined);
    observer.disconnect();
    resolve();
  };

  const resetQuietWindow = (): void => {
    clearTimeout(quietTimer ?? undefined);
    quietTimer = window.setTimeout(cleanup, quietMs);
  };
  const observer = new MutationObserver(() => {
    resetQuietWindow();
  });

  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  // Safety ceiling: force-resolve if external plugins never stop mutating
  hardCeilingTimer = window.setTimeout(cleanup, maxWaitMs);

  // Initial quiet window kickoff
  resetQuietWindow();

  await promise;

  // 3. Single frame to allow the browser to compute the final layout pass
  await waitForNextFrame();
}
