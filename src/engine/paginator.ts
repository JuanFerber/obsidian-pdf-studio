/**
 * @fileoverview Unidirectional pagination engine for assembling virtual printable sheets.
 *
 * Implements a strictly unidirectional, non-destructive pagination pipeline:
 * - Treats virtual pages (`.pdf-page`) as ephemeral, write-only rendering targets.
 * - Ingests clean DOM rendered from Markdown, cloning all nodes to preserve source immutability.
 * - Coordinates keep-with-next layout rules preventing orphan headings at page bottoms.
 * - Delegates overflowing nodes to {@link splitElementAtOverflow} for semantic bisection.
 */

import type { PageLimitsPx } from "@/engine/dom-utils";
import {
  isCodeBlock,
  isUnsplittable,
  splitElementAtOverflow,
} from "@/engine/splitter";

/**
 * Represents a single virtual paginated sheet with physical dimensions and printable margin gutters.
 */
export interface VirtualPage {
  /** 1-based sequential sheet index. */
  readonly pageNumber: number;
  /** Outer paper boundary container styled to exact physical page dimensions. */
  readonly pageEl: HTMLElement;
  /** Inner content canvas positioned within printable margins. */
  readonly contentEl: HTMLElement;
}

/**
 * Structured output produced by the pagination engine containing assembled virtual sheets and metrics.
 */
export interface PaginationResult {
  /** Ordered array of assembled virtual page models. */
  readonly pages: VirtualPage[];
  /** Total count of generated virtual sheets. */
  readonly totalPages: number;
  /** Root wrapper element holding all mounted virtual page DOM nodes. */
  readonly container: HTMLElement;
}

/**
 * Constructs a single virtual page DOM structure styled to target boundary dimensions.
 *
 * Geometry:
 * - Outer `.pdf-page` has fixed pixel width and height matching physical sheet specs.
 * - Inner `.pdf-page-content` is positioned with absolute offsets matching margins (`marginTop`, `marginLeft`)
 *   and dimensioned to `contentWidth` and `contentHeight`.
 *
 * @param pageNumber - 1-based sequential page number.
 * @param limits - Pixel boundary limits and margins for the active paper format.
 * @param doc - Target Document context for node instantiation.
 * @returns An initialized {@link VirtualPage} descriptor.
 */
function createVirtualPage(
  pageNumber: number,
  limits: PageLimitsPx,
  doc: Document = typeof activeDocument !== "undefined"
    ? activeDocument
    : document,
): VirtualPage {
  const pageEl = doc.createElement("div");
  pageEl.classList.add("pdf-page");
  pageEl.setAttribute("data-page-number", String(pageNumber));

  pageEl.style.width = `${limits.pageWidthPx}px`;
  pageEl.style.minHeight = `${limits.pageHeightPx}px`;
  pageEl.style.maxHeight = `${limits.pageHeightPx}px`;
  pageEl.style.position = "relative";
  pageEl.style.boxSizing = "border-box";
  pageEl.style.overflow = "hidden";

  const contentEl = doc.createElement("div");
  contentEl.classList.add("pdf-page-content");
  contentEl.style.position = "absolute";
  contentEl.style.top = `${limits.marginTopPx}px`;
  contentEl.style.left = `${limits.marginLeftPx}px`;
  contentEl.style.width = `${limits.contentWidthPx}px`;
  contentEl.style.height = `${limits.contentHeightPx}px`;
  contentEl.style.boxSizing = "border-box";
  contentEl.style.overflow = "hidden";

  pageEl.appendChild(contentEl);

  return {
    pageNumber,
    pageEl,
    contentEl,
  };
}

/**
 * Evaluates whether an element represents a heading or concise lead-in introductory paragraph
 * that must remain contiguous with the block immediately following it.
 *
 * Heuristics applied:
 * - Matches all heading levels `H1` through `H6`.
 * - Matches short paragraphs (`<p>`) with length under 120 characters devoid of embedded media/code.
 *
 * @param el - Candidate element to test.
 * @returns True if the element must be bound to its following sibling.
 */
function isLeadInElement(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (/^H[1-6]$/.test(el.tagName)) return true;
  if (el.tagName === "P") {
    const text = (el.textContent || "").trim();
    return (
      text.length > 0 &&
      text.length < 120 &&
      el.querySelectorAll("img, table, pre, code").length === 0
    );
  }
  return false;
}

/**
 * Distributes clean source DOM elements across virtual sheets in a strict unidirectional flow.
 *
 * Architectural Invariants:
 * 1. **Unidirectional Immutability:** Elements from `sourceContainer` are cloned. Nodos from prior
 *    pages are never recycled or extracted back into the Markdown source.
 * 2. **Measurement Staging:** Temporarily mounts the output tree to `hostContainer` so that
 *    browser layout APIs (`getBoundingClientRect`) return real rendered pixel values, detaching
 *    prior to return.
 * 3. **Keep-With-Next Enforcement:** Prevents orphan headings or introductory leads from resting
 *    at the very bottom of a page without trailing content.
 * 4. **Graceful Overflow Fallback:** Elements exceeding printable height are either bisected via
 *    {@link splitElementAtOverflow} or advanced intact to a fresh sheet.
 *
 * @param sourceContainer - Scratch container containing clean DOM nodes rendered from Markdown.
 * @param limits - Calculated pixel boundary limits and printable margins.
 * @param hostContainer - Optional staging DOM element enabling active viewport measurement.
 * @param doc - Document context supporting primary and popout Obsidian windows.
 * @returns Fully populated {@link PaginationResult} containing virtual page nodes and count.
 */
export function paginate(
  sourceContainer: HTMLElement,
  limits: PageLimitsPx,
  hostContainer?: HTMLElement,
  doc: Document = typeof activeDocument !== "undefined"
    ? activeDocument
    : document,
): PaginationResult {
  const pages: VirtualPage[] = [];
  const rootContainer = doc.createElement("div");
  rootContainer.classList.add("pdf-pages-container");

  // Temporarily attach to hostContainer (offscreen staging) so getBoundingClientRect() returns real geometry
  if (hostContainer) {
    hostContainer.appendChild(rootContainer);
  }

  let currentPageIndex = 1;
  let currentPage = createVirtualPage(currentPageIndex, limits, doc);
  pages.push(currentPage);
  rootContainer.appendChild(currentPage.pageEl);

  // Clone elements to maintain strict immutability of the source container
  const children = Array.from(sourceContainer.children).map((child) =>
    child.cloneNode(true),
  ) as HTMLElement[];

  let i = 0;
  while (i < children.length) {
    const element = children[i];
    if (!element) {
      i++;
      continue;
    }

    // Handle manual page breaks (e.g. \pagebreak, //page directives converted to sentinels)
    if (
      element.classList.contains("pdf-page-break") ||
      element.getAttribute("data-page-break") === "true"
    ) {
      currentPageIndex++;
      currentPage = createVirtualPage(currentPageIndex, limits, doc);
      pages.push(currentPage);
      rootContainer.appendChild(currentPage.pageEl);
      i++;
      continue;
    }

    // Tentatively append element to current page
    currentPage.contentEl.appendChild(element);

    // Calculate element bottom relative to current page content area
    const pageRect = currentPage.pageEl.getBoundingClientRect();
    const elRect = element.getBoundingClientRect();
    const relativeBottomPx = elRect.bottom - pageRect.top;

    // Case 1: Element fits within printable bounds
    if (relativeBottomPx <= limits.maxContentBottomPx) {
      i++;
      continue;
    }

    // Case 2: Element overflows printable boundary
    const isFirstOnPage = currentPage.contentEl.children.length === 1;
    const firstChild = currentPage.contentEl
      .firstElementChild as HTMLElement | null;
    const isTopBlockOnPage =
      isFirstOnPage ||
      (currentPage.contentEl.children.length === 2 &&
        firstChild !== null &&
        isLeadInElement(firstChild));

    // If NOT the top block on the page, check whether we should move the element to the next page intact:
    if (!isTopBlockOnPage) {
      const isBlock =
        isUnsplittable(element) ||
        isCodeBlock(element) ||
        element.tagName === "TABLE" ||
        element.classList.contains("callout") ||
        element.classList.contains("math-block");

      const canFitOnFreshPage = elRect.height <= limits.contentHeightPx;

      if (isBlock || canFitOnFreshPage) {
        // Keep-with-next: if the immediately preceding sibling is a heading or lead-in paragraph, move it together with this block
        const prevSibling =
          element.previousElementSibling as HTMLElement | null;
        const isPrevLeadIn = isLeadInElement(prevSibling);
        const canMoveLeadIn =
          isPrevLeadIn && currentPage.contentEl.children.length > 2;

        element.remove();
        if (canMoveLeadIn && prevSibling) {
          prevSibling.remove();
        }

        currentPageIndex++;
        currentPage = createVirtualPage(currentPageIndex, limits, doc);
        pages.push(currentPage);
        rootContainer.appendChild(currentPage.pageEl);

        if (canMoveLeadIn && prevSibling) {
          currentPage.contentEl.appendChild(prevSibling);
        }

        // Do not increment i; next iteration will append element to the new page and evaluate it
        continue;
      }
    }

    // Element is the top block on the page and overflows (taller than printable area) -> bisect it
    const split = splitElementAtOverflow(
      element,
      limits.maxContentBottomPx,
      pageRect.top,
    );

    if (split && split.head) {
      // Head remains on current page; tail moves to start of next page
      currentPageIndex++;
      currentPage = createVirtualPage(currentPageIndex, limits, doc);
      pages.push(currentPage);
      rootContainer.appendChild(currentPage.pageEl);

      // Queue tail element as the next element to evaluate on new page
      children[i] = split.tail;
    } else {
      // Cannot split (or head was null).
      element.remove();

      // Avoid infinite loops if an indivisible element is taller than an entire page
      if (!isTopBlockOnPage) {
        currentPageIndex++;
        currentPage = createVirtualPage(currentPageIndex, limits, doc);
        pages.push(currentPage);
        rootContainer.appendChild(currentPage.pageEl);
        currentPage.contentEl.appendChild(element);
      } else {
        // Element is taller than an entire blank page: keep it clipped on this page
        currentPage.contentEl.appendChild(element);
      }
      i++;
    }
  }

  // Keep-with-next: prevent lonely heading or lead-in paragraph at the very bottom of a page
  for (let p = 0; p < pages.length - 1; p++) {
    const page = pages[p];
    if (!page) continue;
    const lastChild = page.contentEl.lastElementChild as HTMLElement | null;
    if (
      lastChild &&
      isLeadInElement(lastChild) &&
      page.contentEl.children.length > 1
    ) {
      const nextPage = pages[p + 1];
      if (nextPage) {
        lastChild.remove();
        nextPage.contentEl.insertBefore(
          lastChild,
          nextPage.contentEl.firstElementChild,
        );
      }
    }
  }

  // Detach from temporary host before returning to caller
  if (hostContainer && rootContainer.parentElement === hostContainer) {
    hostContainer.removeChild(rootContainer);
  }

  return {
    pages,
    totalPages: pages.length,
    container: rootContainer,
  };
}
