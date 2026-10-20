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
  CANVAS: true,
  HR: true,
  VIDEO: true,
  AUDIO: true,
  IFRAME: true,
};

/**
 * Determines whether an element represents a table or a container wrapping exclusively a table.
 *
 * @param element - The candidate HTML element.
 * @returns True if the element represents a standalone or wrapped table.
 */
export function isTableElement(element: HTMLElement): boolean {
  if (element.tagName.toUpperCase() === "TABLE") return true;
  if (
    element.querySelector("table") !== null &&
    element.querySelectorAll("p, h1, h2, h3, h4, h5, h6, pre, ul, ol")
      .length === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Determines whether an element represents a Mermaid diagram, SVG graphic, or diagram slice.
 *
 * Excludes LaTeX math blocks, images, and embedded interactive media.
 *
 * @param element - The candidate HTML element.
 * @returns True if the element is identified as a splittable diagram container.
 */
export function isDiagramElement(element: HTMLElement): boolean {
  const tag = element.tagName.toUpperCase();
  if (
    element.classList.contains("math-block") ||
    element.classList.contains("frontmatter") ||
    element.querySelector(
      ".math-block, mjx-container, img, canvas, video, iframe",
    ) !== null
  ) {
    return false;
  }
  if (
    element.classList.contains("mermaid") ||
    element.classList.contains("block-language-mermaid") ||
    element.classList.contains("pdf-diagram-slice")
  ) {
    return true;
  }
  if (tag === "SVG" && !element.classList.contains("svg-icon")) {
    return true;
  }
  if (
    tag === "TABLE" ||
    tag === "UL" ||
    tag === "OL" ||
    isCodeBlock(element) ||
    isTableElement(element)
  ) {
    return false;
  }
  return element.querySelector("svg:not(.svg-icon)") !== null;
}

/**
 * Determines whether an element represents an atomic block that cannot be bisected.
 *
 * Invariants:
 * - All heading levels (H1-H6) are indivisible to uphold editorial hierarchy.
 * - Graphical media elements (IMG, CANVAS, VIDEO) and math blocks remain atomic.
 * - Diagrams, code blocks, tables, and lists are explicitly splittable.
 *
 * @param element - The candidate HTML element undergoing overflow evaluation.
 * @returns True if the element must remain undivided and transition intact to the next page.
 */
export function isUnsplittable(element: HTMLElement): boolean {
  if (
    isDiagramElement(element) ||
    isTableElement(element) ||
    isCodeBlock(element)
  ) {
    return false;
  }
  const tag = element.tagName.toUpperCase();
  if (tag === "UL" || tag === "OL") {
    return false;
  }
  if (UNSPLITTABLE_TAGS[tag] === true) return true;
  if (element.classList.contains("math-block")) return true;
  if (element.classList.contains("frontmatter")) return true;
  if (
    element.querySelector(
      "img, canvas, video, iframe, .math-block, mjx-container[display='true']",
    ) !== null
  ) {
    return true;
  }
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
    element.classList.contains("mermaid") ||
    element.classList.contains("block-language-mermaid")
  ) {
    return false;
  }
  if (
    Array.from(element.classList).some((c) => c.startsWith("block-language-"))
  ) {
    return element.querySelector("pre") !== null;
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

  let headTarget: { node: Text; offset: number } | null = null;
  let headEndOffset = 0;

  while (splitLine >= 3) {
    headEndOffset = 0;
    for (let l = 0; l < splitLine; l++) {
      headEndOffset += rawLines[l]!.length;
      if (l < splitLine - 1) {
        headEndOffset += 1; // newline between lines in head
      }
    }

    headTarget = findTextNodeAtOffset(element, headEndOffset);
    if (!headTarget) return null;

    const probeRange = document.createRange();
    probeRange.setStart(codeEl, 0);
    probeRange.setEnd(headTarget.node, headTarget.offset);
    let probeBottom = 0;
    if (typeof probeRange.getBoundingClientRect === "function") {
      try {
        const rect = probeRange.getBoundingClientRect();
        if (rect && rect.height > 0) {
          probeBottom = rect.bottom - pageTopPx;
        }
      } catch {
        probeBottom = 0;
      }
    }

    if (probeBottom === 0 || probeBottom <= maxBottomPx) {
      break;
    }
    splitLine--;
  }

  if (splitLine < 3 || rawLines.length - splitLine < 2 || !headTarget) {
    return null;
  }

  const tailStartOffset = headEndOffset + 1; // skip newline separating head and tail
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
 * Splits an overflowing Mermaid or SVG diagram across page breaks using semantic height window slicing.
 *
 * Preserves natural diagram dimensions without downscaling by creating upper and lower slices
 * adorned with dashed boundary cut lines (`#9ca3af`).
 *
 * @param element - Diagram container or root SVG element.
 * @param maxBottomPx - Printable threshold in viewport pixels (`pageHeight - marginBottom`).
 * @param pageTopPx - Bounding top coordinate of the current virtual page.
 * @returns {@link SplitResult} on successful bisection, or `null` if unable to slice.
 */
export function splitDiagram(
  element: HTMLElement,
  maxBottomPx: number,
  pageTopPx: number,
): SplitResult | null {
  const isRootSvg = element.tagName.toUpperCase() === "SVG";
  const svgEl = isRootSvg
    ? (element as unknown as SVGElement)
    : element.querySelector<SVGElement>("svg:not(.svg-icon)");

  const elRect = element.getBoundingClientRect();
  const svgRect = svgEl ? svgEl.getBoundingClientRect() : elRect;

  const prevOffsetPx = Number(element.getAttribute("data-slice-offset") || "0");
  const attrFullHeight = Number(
    element.getAttribute("data-full-height") ||
      svgEl?.getAttribute("data-full-height") ||
      "0",
  );
  const attrDiagramWidth = Number(
    element.getAttribute("data-diagram-width") ||
      svgEl?.getAttribute("data-diagram-width") ||
      "0",
  );

  const rawHeight = Math.max(svgRect.height, elRect.height);
  let fullHeightPx =
    attrFullHeight > 0
      ? Math.max(attrFullHeight, prevOffsetPx === 0 ? Math.ceil(rawHeight) : 0)
      : Math.ceil(rawHeight);
  let diagramWidthPx =
    attrDiagramWidth > 0
      ? attrDiagramWidth
      : Math.ceil(svgRect.width > 0 ? svgRect.width : elRect.width);

  const parentWidthPx = parseFloat(element.parentElement?.style.width || "0");
  if (
    !isNaN(parentWidthPx) &&
    parentWidthPx > 0 &&
    diagramWidthPx > parentWidthPx
  ) {
    const scaleFactor = parentWidthPx / diagramWidthPx;
    diagramWidthPx = Math.floor(parentWidthPx);
    if (prevOffsetPx === 0 && fullHeightPx > 0) {
      fullHeightPx = Math.max(1, Math.floor(fullHeightPx * scaleFactor));
    }
  }

  let remainingHeightPx =
    prevOffsetPx > 0 && fullHeightPx > prevOffsetPx
      ? fullHeightPx - prevOffsetPx
      : Math.ceil(elRect.height > 0 ? elRect.height : rawHeight);

  // Reserve 4px safety clearance at bottom so .pdf-page-content overflow:hidden never clips the dashed border
  const SAFETY_BOTTOM_GAP_PX = 4;
  const rawAvailablePx = Math.floor(maxBottomPx - (elRect.top - pageTopPx));
  const availableHeightPx =
    rawAvailablePx >= 80 + SAFETY_BOTTOM_GAP_PX
      ? rawAvailablePx - SAFETY_BOTTOM_GAP_PX
      : rawAvailablePx;

  if (remainingHeightPx <= 0 || availableHeightPx < 80) {
    return null;
  }

  // If element overflowed maxBottomPx in paginator, ensure remainingHeightPx reflects the overflow
  const measuredOverflowPx = Math.ceil(elRect.bottom - pageTopPx - maxBottomPx);
  if (remainingHeightPx <= availableHeightPx) {
    if (measuredOverflowPx > 0) {
      remainingHeightPx = rawAvailablePx + measuredOverflowPx;
      if (prevOffsetPx + remainingHeightPx > fullHeightPx) {
        fullHeightPx = prevOffsetPx + remainingHeightPx;
      }
    } else {
      return null;
    }
  }

  const minTailPx = Math.min(32, Math.floor(remainingHeightPx * 0.2));
  let sliceHeightPx = availableHeightPx;
  if (remainingHeightPx - sliceHeightPx < minTailPx) {
    sliceHeightPx = remainingHeightPx - minTailPx;
  }
  if (sliceHeightPx < 60) {
    return null;
  }

  const nextOffsetPx = prevOffsetPx + sliceHeightPx;
  const tailHeightPx = remainingHeightPx - sliceHeightPx;
  if (tailHeightPx <= 0) {
    return null;
  }

  let hostHead: HTMLElement;
  if (isRootSvg) {
    const headWrapper = document.createElement("div");
    headWrapper.className = "pdf-diagram-slice";
    if (element.parentNode) {
      element.parentNode.replaceChild(headWrapper, element);
    }
    headWrapper.appendChild(element);
    hostHead = headWrapper;
  } else {
    hostHead = element;
  }

  const hostTail = hostHead.cloneNode(true) as HTMLElement;

  // Configure head slice: full page content width (100%) so dashed line spans entire printable width
  hostHead.classList.add("pdf-diagram-slice");
  hostHead.setAttribute("data-slice-offset", String(prevOffsetPx));
  hostHead.setAttribute("data-full-height", String(fullHeightPx));
  hostHead.setAttribute("data-diagram-width", String(diagramWidthPx));
  hostHead.style.height = `${sliceHeightPx}px`;
  hostHead.style.maxHeight = `${sliceHeightPx}px`;
  hostHead.style.width = "100%";
  hostHead.style.maxWidth = "100%";
  hostHead.style.overflow = "hidden";
  hostHead.style.boxSizing = "border-box";
  hostHead.style.marginBottom = "0px";
  hostHead.style.paddingBottom = "0px";

  if (prevOffsetPx > 0) {
    hostHead.classList.add("pdf-diagram-cut-top");
    hostHead.style.borderTop = "1.5px dashed #9ca3af";
    hostHead.style.marginTop = "0px";
    hostHead.style.paddingTop = "0px";
  }
  hostHead.classList.add("pdf-diagram-cut-bottom");
  hostHead.style.borderBottom = "1.5px dashed #9ca3af";

  const headSvg = isRootSvg
    ? hostHead.querySelector<SVGElement>("svg")
    : hostHead.tagName.toUpperCase() === "SVG"
      ? (hostHead as unknown as SVGElement)
      : hostHead.querySelector<SVGElement>("svg:not(.svg-icon)");
  if (headSvg) {
    headSvg.classList.add("pdf-svg-sliced");
    headSvg.style.setProperty("height", `${fullHeightPx}px`, "important");
    if (diagramWidthPx > 0) {
      headSvg.style.setProperty("width", `${diagramWidthPx}px`, "important");
    }
    headSvg.style.setProperty("max-width", "100%", "important");
    headSvg.style.display = "block";
    headSvg.style.marginLeft = "auto";
    headSvg.style.marginRight = "auto";
    if (prevOffsetPx > 0) {
      headSvg.style.marginTop = `-${prevOffsetPx}px`;
    }
  }

  // Configure tail slice: full page content width (100%) so dashed line spans entire printable width
  hostTail.classList.add("pdf-diagram-slice", "pdf-split-continued");
  hostTail.setAttribute("data-slice-offset", String(nextOffsetPx));
  hostTail.setAttribute("data-full-height", String(fullHeightPx));
  hostTail.setAttribute("data-diagram-width", String(diagramWidthPx));
  hostTail.style.height = `${tailHeightPx}px`;
  hostTail.style.maxHeight = `${tailHeightPx}px`;
  hostTail.style.width = "100%";
  hostTail.style.maxWidth = "100%";
  hostTail.style.overflow = "hidden";
  hostTail.style.boxSizing = "border-box";
  hostTail.style.marginTop = "0px";
  hostTail.style.paddingTop = "0px";

  hostTail.classList.add("pdf-diagram-cut-top");
  hostTail.style.borderTop = "1.5px dashed #9ca3af";
  hostTail.classList.remove("pdf-diagram-cut-bottom");
  hostTail.style.borderBottom = "none";

  for (const host of [hostHead, hostTail]) {
    const innerMermaids = host.querySelectorAll<HTMLElement>(".mermaid");
    for (const inner of Array.from(innerMermaids)) {
      if (inner !== host) {
        inner.style.margin = "0";
        inner.style.padding = "0";
        inner.style.width = "100%";
        inner.style.maxWidth = "100%";
        inner.style.display = "block";
        inner.style.overflow = "visible";
      }
    }
  }

  const tailSvg = isRootSvg
    ? hostTail.querySelector<SVGElement>("svg")
    : hostTail.tagName.toUpperCase() === "SVG"
      ? (hostTail as unknown as SVGElement)
      : hostTail.querySelector<SVGElement>("svg:not(.svg-icon)");
  if (tailSvg) {
    tailSvg.classList.add("pdf-svg-sliced");
    tailSvg.style.setProperty("height", `${fullHeightPx}px`, "important");
    if (diagramWidthPx > 0) {
      tailSvg.style.setProperty("width", `${diagramWidthPx}px`, "important");
    }
    tailSvg.style.setProperty("max-width", "100%", "important");
    tailSvg.style.display = "block";
    tailSvg.style.marginLeft = "auto";
    tailSvg.style.marginRight = "auto";
    tailSvg.style.marginTop = `-${nextOffsetPx}px`;
  }

  return {
    head: hostHead,
    tail: hostTail,
  };
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
  element: HTMLElement,
  maxBottomPx: number,
  pageTopPx: number,
): SplitResult | null {
  const isDirectTable = element.tagName.toUpperCase() === "TABLE";
  const table = isDirectTable
    ? (element as HTMLTableElement)
    : element.querySelector<HTMLTableElement>("table");

  if (!table) {
    return null;
  }

  const tbodyRows = Array.from(table.querySelectorAll("tbody > tr"));
  const rows =
    tbodyRows.length > 0
      ? tbodyRows
      : Array.from(table.querySelectorAll("tr")).filter(
          (tr) => !tr.closest("thead, tfoot"),
        );
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

  if (!isDirectTable) {
    const tailWrapper = element.cloneNode(false) as HTMLElement;
    tailWrapper.classList.add("pdf-split-continued");
    tailWrapper.appendChild(tailTable);
    return {
      head: element,
      tail: tailWrapper,
    };
  }

  return {
    head: element,
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
 * - For prose elements (`<p>`), cuts are snapped backwards to the nearest whitespace to avoid mid-word truncation.
 *
 * @param element - Text container element exceeding printable limits.
 * @param maxBottomPx - Printable threshold in viewport pixels.
 * @param pageTopPx - Bounding top coordinate of the current virtual page.
 * @returns {@link SplitResult} containing partitioned head and tail, or `null` if no text fits.
 */
export function splitTextElement(
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
  } else if (!isPre && bestOffset > 0 && bestOffset < totalLength) {
    // Snap prose text to whitespace to prevent bisecting mid-word
    const lastSpace = text.slice(0, bestOffset).search(/\s\S*$/);
    if (lastSpace > 0) {
      bestOffset = lastSpace + 1;
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

  if (isDiagramElement(element)) {
    return splitDiagram(element, maxBottomPx, pageTopPx);
  }

  if (isCodeBlock(element)) {
    return splitCodeBlock(element, maxBottomPx, pageTopPx);
  }

  if (isTableElement(element)) {
    return splitTable(element, maxBottomPx, pageTopPx);
  }

  const tag = element.tagName.toUpperCase();

  if (tag === "UL" || tag === "OL") {
    return splitList(element, maxBottomPx, pageTopPx);
  }

  return splitTextElement(element, maxBottomPx, pageTopPx);
}
