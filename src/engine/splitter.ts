/**
 * @fileoverview Semantic DOM bisection algorithms for overflowing content across virtual page boundaries.
 *
 * Implements type-aware splitting strategies for elements exceeding physical page limits:
 * - Code blocks (`<pre><code>`): bisected along newline boundaries (`\n`) with syntax token preservation
 *   and minimum line threshold guards (3 lines head, 2 lines tail).
 * - Tables (`<table>`): split at whole row (`<tr>`) boundaries while duplicating `<thead>` on continuation pages.
 * - Lists (`<ol>` / `<ul>`): split between `<li>` items with sequential counter preservation (`start="N + 1"`).
 * - Paragraphs (`<p>`) & quotes (`<blockquote>`): split via logarithmic binary search with `Range` geometry.
 * - Atomic elements: headings, images, and embeds are strictly preserved intact and transferred to the next page.
 */

/**
 * Result contract produced when an overflowing DOM element is partitioned across a page boundary.
 */
export interface SplitResult {
  /**
   * Portion that fits on the current virtual page.
   * If `null`, the element cannot be meaningfully bisected and must move in its entirety to the next page.
   */
  head: HTMLElement | null;
  /**
   * Continuation portion positioned at the start of the subsequent virtual page.
   * Adorned with the CSS class `.pdf-split-continued`.
   */
  tail: HTMLElement;
}

/**
 * HTML tag names representing atomic, indivisible content that must never be fractured across pages.
 */
const UNSPLITTABLE_TAGS: Record<string, true> = {
  H1: true,
  H2: true,
  H3: true,
  H4: true,
  H5: true,
  H6: true,
  IMG: true,
  SVG: true,
  CANVAS: true,
  HR: true,
  VIDEO: true,
  AUDIO: true,
  IFRAME: true,
};

/**
 * Determines whether an element represents an atomic block that cannot be bisected.
 *
 * Invariants:
 * - All heading levels (H1-H6) are indivisible to uphold editorial hierarchy.
 * - Graphical media elements (IMG, SVG, CANVAS, VIDEO) are indivisible.
 * - Math blocks (`.math-block`) and Obsidian frontmatter metadata (`.frontmatter`) remain atomic.
 *
 * @param element - The candidate HTML element undergoing overflow evaluation.
 * @returns True if the element must remain undivided and transition intact to the next page.
 */
export function isUnsplittable(element: HTMLElement): boolean {
  if (UNSPLITTABLE_TAGS[element.tagName.toUpperCase()] === true) return true;
  if (element.classList.contains("math-block")) return true;
  if (element.classList.contains("frontmatter")) return true;
  return false;
}

/**
 * Checks whether an element represents a source code container or third-party code styling wrapper.
 *
 * Recognizes standard `<pre>` tags as well as Obsidian and Code-Styler class conventions
 * (e.g., `.block-language-*`).
 *
 * @param element - The candidate HTML element.
 * @returns True if the element is identified as a code block.
 */
export function isCodeBlock(element: HTMLElement): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "PRE") return true;
  if (
    Array.from(element.classList).some((c) => c.startsWith("block-language-"))
  ) {
    return true;
  }
  if (element.querySelector("pre") !== null) {
    // Avoid marking composite wrappers as code blocks if they contain diverse child tags
    return (
      element.querySelectorAll("p, h1, h2, h3, h4, h5, h6, table, ul, ol")
        .length === 0
    );
  }
  return false;
}

/**
 * Traverses a DOM subtree to find the specific Text node and local character offset
 * corresponding to an absolute cumulative character offset.
 *
 * @param root - Subtree root node.
 * @param targetOffset - Absolute character offset from root start.
 * @returns The resolved Text node and local index, or null if targetOffset exceeds text length.
 */
function findTextNodeAtOffset(
  root: Node,
  targetOffset: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentOffset = 0;
  let currentNode = walker.nextNode() as Text | null;

  while (currentNode) {
    const length = currentNode.nodeValue?.length ?? 0;
    if (currentOffset + length >= targetOffset) {
      return {
        node: currentNode,
        offset: targetOffset - currentOffset,
      };
    }
    currentOffset += length;
    currentNode = walker.nextNode() as Text | null;
  }

  return null;
}

/**
 * Bisects a preformatted code block element (`<pre><code>`) cleanly across a page boundary.
 *
 * Algorithmic Constraints and Invariants:
 * 1. **Newline Snapping:** Division occurs exclusively at line boundaries (`\n`). Syntax tokens
 *    and indentation are never severed mid-word.
 * 2. **Orphan / Widow Line Thresholds:** Requires at least 3 lines in `head` and at least 2 lines
 *    in `tail`. If either condition is violated, bisection aborts and returns `null`.
 * 3. **UI Sanitization:** Strips interactive code-copy buttons from both head and tail.
 * 4. **Visual Styling:** Adorns the tail code container with `.pdf-split-continued` and a subtle
 *    dashed top border indicating uninterrupted continuation.
 *
 * @param element - The code container element exceeding printable page height.
 * @param maxBottomPx - Printable threshold in viewport pixels (`pageHeight - marginBottom`).
 * @param pageTopPx - Bounding top coordinate of the current virtual page.
 * @returns {@link SplitResult} on successful bisection, or `null` if the block cannot be split cleanly.
 */
export function splitCodeBlock(
  element: HTMLElement,
  maxBottomPx: number,
  pageTopPx: number,
): SplitResult | null {
  const preEl =
    element.tagName === "PRE"
      ? element
      : (element.querySelector("pre") ?? element);
  const codeEl = preEl.querySelector("code") ?? preEl;

  const rawText = codeEl.textContent ?? "";
  const rawLines = rawText.split("\n");
  if (rawLines.length <= 4) {
    return null;
  }

  const preRect = preEl.getBoundingClientRect();
  const availableHeightPx = maxBottomPx - (preRect.top - pageTopPx);
  if (availableHeightPx <= 30) {
    return null;
  }

  const avgLineHeight = Math.max(
    14,
    preRect.height > 0 ? preRect.height / rawLines.length : 20,
  );
  let splitLine = Math.floor(availableHeightPx / avgLineHeight);
  splitLine = Math.max(0, Math.min(rawLines.length - 1, splitLine));

  if (splitLine < 3 || rawLines.length - splitLine < 2) {
    return null;
  }

  let headEndOffset = 0;
  for (let l = 0; l < splitLine; l++) {
    headEndOffset += rawLines[l]!.length;
    if (l < splitLine - 1) {
      headEndOffset += 1; // newline between lines in head
    }
  }
  const tailStartOffset = headEndOffset + 1; // skip newline separating head and tail

  const headTarget = findTextNodeAtOffset(element, headEndOffset);
  if (!headTarget) {
    return null;
  }

  const tail = element.cloneNode(true) as HTMLElement;
  tail.classList.add("pdf-split-continued");

  const tailTarget = findTextNodeAtOffset(tail, tailStartOffset);
  if (!tailTarget) {
    return null;
  }

  try {
    // Head: delete everything from headEndOffset to the end of element
    const headRange = document.createRange();
    headRange.setStart(headTarget.node, headTarget.offset);
    headRange.setEnd(element, element.childNodes.length);
    headRange.deleteContents();

    // Tail: delete everything from start of tail up to tailStartOffset
    const tailRange = document.createRange();
    tailRange.setStart(tail, 0);
    tailRange.setEnd(tailTarget.node, tailTarget.offset);
    tailRange.deleteContents();

    element
      .querySelectorAll<HTMLElement>(
        ".copy-code-button, button.copy-code-button",
      )
      .forEach((b) => b.remove());
    tail
      .querySelectorAll<HTMLElement>(
        ".copy-code-button, button.copy-code-button",
      )
      .forEach((b) => b.remove());

    tail.style.marginTop = "0px";
    tail.style.paddingTop = "0px";
    tail.style.borderTop = "none";

    const tailPre =
      tail.tagName === "PRE" ? tail : tail.querySelector<HTMLElement>("pre");
    if (tailPre) {
      tailPre.classList.add("pdf-split-continued");
      tailPre.style.marginTop = "0px";
      tailPre.style.paddingTop = "6px";
      tailPre.style.borderTop =
        "1px dashed var(--background-modifier-border, #d0d7de)";
      tailPre.style.borderTopLeftRadius = "0px";
      tailPre.style.borderTopRightRadius = "0px";
    }

    return {
      head: element,
      tail,
    };
  } catch {
    return null;
  }
}

/**
 * Splits an HTML table across a page boundary while safeguarding tabular structural integrity.
 *
 * Invariants:
 * - Table rows (`<tr>`) are atomic; individual table cells are never sliced horizontally.
 * - If the table contains a `<thead>`, it is automatically cloned into the continuation table
 *   on the subsequent page so column context remains clear to the reader.
 * - If only 1 body row exists or no rows fit on the current page, returns `null` to move the table intact.
 *
 * @param table - The HTMLTableElement overflowing the page boundary.
 * @param maxBottomPx - Printable threshold in viewport pixels.
 * @param pageTopPx - Bounding top coordinate of the current virtual page.
 * @returns {@link SplitResult} on successful bisection, or `null` if unable to split.
 */
export function splitTable(
  table: HTMLTableElement,
  maxBottomPx: number,
  pageTopPx: number,
): SplitResult | null {
  const rows = Array.from(table.querySelectorAll("tbody tr, tr"));
  if (rows.length <= 1) {
    return null; // A table with 1 or 0 body rows cannot be meaningfully split
  }

  const thead = table.querySelector("thead");
  let splitIndex = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const rect = row.getBoundingClientRect();
    const rowBottomRelative = rect.bottom - pageTopPx;

    if (rowBottomRelative > maxBottomPx) {
      splitIndex = i;
      break;
    }
  }

  if (splitIndex <= 0) {
    return null;
  }

  const tailTable = table.cloneNode(false) as HTMLTableElement;
  tailTable.classList.add("pdf-split-continued");

  // Re-inject cloned thead into tail table to preserve column headers across page breaks
  if (thead) {
    tailTable.appendChild(thead.cloneNode(true));
  }

  let tailTbody = tailTable.querySelector("tbody");
  if (!tailTbody) {
    tailTbody = document.createElement("tbody");
    tailTable.appendChild(tailTbody);
  }

  // Move remaining overflowing rows into tail table
  for (let i = splitIndex; i < rows.length; i++) {
    const row = rows[i];
    if (row) {
      tailTbody.appendChild(row);
    }
  }

  return {
    head: table,
    tail: tailTable,
  };
}

/**
 * Splits an ordered or unordered list across a page boundary between list item nodes (`<li>`).
 *
 * Invariants:
 * - Preserves correct numerical continuity on `<ol>` elements by configuring `start="N + 1"`
 *   on the continuation list, where `N` is the count of items retained in the head page.
 * - Does not fracture individual `<li>` bullets unless a single list item is larger than an entire page.
 *
 * @param list - Unordered (`<ul>`) or ordered (`<ol>`) list element.
 * @param maxBottomPx - Printable threshold in viewport pixels.
 * @param pageTopPx - Bounding top coordinate of the current virtual page.
 * @returns {@link SplitResult} on successful bisection, or `null` if the list must move intact.
 */
export function splitList(
  list: HTMLElement,
  maxBottomPx: number,
  pageTopPx: number,
): SplitResult | null {
  const items = Array.from(list.children).filter(
    (child): child is HTMLElement => child.tagName === "LI",
  );

  if (items.length <= 1) {
    return null;
  }

  let splitIndex = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const rect = item.getBoundingClientRect();
    const itemBottom = rect.bottom - pageTopPx;

    if (itemBottom > maxBottomPx) {
      splitIndex = i;
      break;
    }
  }

  if (splitIndex <= 0) {
    return null;
  }

  const tailList = list.cloneNode(false) as HTMLElement;
  tailList.classList.add("pdf-split-continued");

  // For ordered lists, maintain sequential numbering
  if (list.tagName === "OL") {
    const ol = list as HTMLOListElement;
    const originalStart = ol.start || 1;
    (tailList as HTMLOListElement).start = originalStart + splitIndex;
  }

  // Move remaining items to continuation list
  for (let i = splitIndex; i < items.length; i++) {
    const item = items[i];
    if (item) {
      tailList.appendChild(item);
    }
  }

  return {
    head: list,
    tail: tailList,
  };
}

/**
 * Bisects a text-oriented container (`<p>`, `<blockquote>`, inline text) using bounded binary search.
 *
 * Complexity and Safety Guarantees:
 * - Employs a DOM Range probe to find the optimal character cut point.
 * - Enforces an iteration limit of 15 ($\lceil\log_2(32768)\rceil = 15$) to prevent infinite search loops.
 * - For `<pre>` elements reaching this fallback, cuts are snapped backwards to the nearest newline (`\n`).
 *
 * @param element - Text container element exceeding printable limits.
 * @param maxBottomPx - Printable threshold in viewport pixels.
 * @param pageTopPx - Bounding top coordinate of the current virtual page.
 * @returns {@link SplitResult} containing partitioned head and tail, or `null` if no text fits.
 */
function splitTextElement(
  element: HTMLElement,
  maxBottomPx: number,
  pageTopPx: number,
): SplitResult | null {
  const text = element.textContent ?? "";
  if (text.trim().length === 0) {
    return null;
  }

  const isPre =
    element.tagName === "PRE" || element.querySelector("pre, code") !== null;

  // Collect all text nodes inside element
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let currentNode = walker.nextNode();
  while (currentNode) {
    textNodes.push(currentNode as Text);
    currentNode = walker.nextNode();
  }

  if (textNodes.length === 0) {
    return null;
  }

  const totalLength = text.length;
  let low = 0;
  let high = totalLength;
  let bestOffset = -1;
  const maxIterations = 15; // Log2(32768) = 15; prevents infinite loops mathematically
  let iterations = 0;

  const range = document.createRange();

  while (low <= high && iterations < maxIterations) {
    iterations++;
    const mid = Math.floor((low + high) / 2);

    // Find the text node corresponding to character offset `mid`
    let currentOffset = 0;
    let targetNode: Text | null = null;
    let offsetInNode = 0;

    for (const node of textNodes) {
      const len = node.nodeValue?.length ?? 0;
      if (currentOffset + len >= mid) {
        targetNode = node;
        offsetInNode = mid - currentOffset;
        break;
      }
      currentOffset += len;
    }

    if (!targetNode) break;

    try {
      range.setStart(element, 0);
      range.setEnd(targetNode, offsetInNode);
      const rect = range.getBoundingClientRect();
      const rangeBottom = rect.bottom - pageTopPx;

      if (rangeBottom <= maxBottomPx) {
        bestOffset = mid;
        low = mid + 1; // Try to include more text
      } else {
        high = mid - 1; // Overshot, reduce text
      }
    } catch {
      break;
    }
  }

  // Snap code blocks to the nearest preceding newline
  if (isPre && bestOffset > 0) {
    const lastNewline = text.lastIndexOf("\n", bestOffset);
    if (lastNewline !== -1 && lastNewline > 0) {
      bestOffset = lastNewline + 1;
    }
  }

  // If no meaningful text could fit on this page, move the whole element to next page
  if (bestOffset <= 0 || bestOffset >= totalLength) {
    return null;
  }

  // Create head and tail clones
  const tail = element.cloneNode(true) as HTMLElement;
  tail.classList.add("pdf-split-continued");

  // Cut head at bestOffset
  try {
    let currentOffset = 0;
    for (const node of textNodes) {
      const len = node.nodeValue?.length ?? 0;
      if (currentOffset + len <= bestOffset) {
        currentOffset += len;
      } else if (currentOffset < bestOffset) {
        const cutPoint = bestOffset - currentOffset;
        node.nodeValue = node.nodeValue?.slice(0, cutPoint) ?? "";
        currentOffset += cutPoint;
      } else {
        node.nodeValue = "";
      }
    }

    // Cut tail from start up to bestOffset
    const tailWalker = document.createTreeWalker(tail, NodeFilter.SHOW_TEXT);
    let tailNode = tailWalker.nextNode() as Text | null;
    let tailOffset = 0;

    while (tailNode) {
      const len = tailNode.nodeValue?.length ?? 0;
      if (tailOffset + len <= bestOffset) {
        tailNode.nodeValue = "";
        tailOffset += len;
      } else if (tailOffset < bestOffset) {
        const cutPoint = bestOffset - tailOffset;
        tailNode.nodeValue = tailNode.nodeValue?.slice(cutPoint) ?? "";
        tailOffset = bestOffset;
      }
      tailNode = tailWalker.nextNode() as Text | null;
    }

    return {
      head: element,
      tail: tail,
    };
  } catch {
    return null;
  }
}

/**
 * Universal dispatcher selecting and executing the optimal splitting strategy
 * for an overflowing element based on its DOM semantic tag.
 *
 * Preconditions:
 * - `element` must be attached to the active DOM or a staging measurement container.
 * - `maxBottomPx` and `pageTopPx` must represent valid pixel coordinates.
 *
 * Dispatch Strategy:
 * 1. Checks atomic types via {@link isUnsplittable} (returns `null` immediately).
 * 2. Routes preformatted code blocks to {@link splitCodeBlock}.
 * 3. Routes `<table>` elements to {@link splitTable}.
 * 4. Routes `<ul>` and `<ol>` lists to {@link splitList}.
 * 5. Falls back to logarithmic bisection via {@link splitTextElement}.
 *
 * @param element - The HTML element exceeding `maxContentBottomPx`.
 * @param maxBottomPx - Printable threshold coordinate in pixels.
 * @param pageTopPx - Absolute top coordinate of the current virtual page.
 * @returns {@link SplitResult} on successful bisection, or `null` if the element must advance undivided.
 */
export function splitElementAtOverflow(
  element: HTMLElement,
  maxBottomPx: number,
  pageTopPx: number,
): SplitResult | null {
  if (isUnsplittable(element)) {
    return null;
  }

  if (isCodeBlock(element)) {
    return splitCodeBlock(element, maxBottomPx, pageTopPx);
  }

  const tag = element.tagName.toUpperCase();

  if (tag === "TABLE") {
    return splitTable(element as HTMLTableElement, maxBottomPx, pageTopPx);
  }

  if (tag === "UL" || tag === "OL") {
    return splitList(element, maxBottomPx, pageTopPx);
  }

  return splitTextElement(element, maxBottomPx, pageTopPx);
}
