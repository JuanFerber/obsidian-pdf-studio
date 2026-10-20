import { afterEach, describe, expect, it, vi } from "vitest";
import { paginate } from "@/engine/paginator";
import {
  calculatePageLimits,
  fitElementsToPageBounds,
} from "@/engine/dom-utils";
import type { PageLimitsPx } from "@/engine/dom-utils";

describe("Paginator & DOM Metric Engine", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const dummyLimits: PageLimitsPx = {
    pageWidthPx: 800,
    pageHeightPx: 1000,
    marginTopPx: 40,
    marginBottomPx: 40,
    marginLeftPx: 40,
    marginRightPx: 40,
    contentWidthPx: 720,
    contentHeightPx: 920,
    maxContentBottomPx: 960,
  };

  it("falls back to standard CSS 96/25.4 ratio when offsetHeight is 0 without caching fallback", () => {
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(0);

    const limits = calculatePageLimits(
      { width: 210, height: 297 },
      { top: 20, bottom: 20, left: 20, right: 20 },
      document,
    );

    // 210mm * (96 / 25.4) px/mm = 793.7007... -> rounded to 794
    expect(limits.pageWidthPx).toBe(Math.round(210 * (96 / 25.4)));
    heightSpy.mockRestore();
  });

  it("calculates page limits and memoizes display ratio when offsetHeight > 0", () => {
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(400); // 400px / 100mm = 4.0 px/mm
    const appendSpy = vi.spyOn(document.body, "appendChild");

    const limits1 = calculatePageLimits(
      { width: 210, height: 297 },
      { top: 20, bottom: 20, left: 20, right: 20 },
      document,
    );
    expect(limits1.pageWidthPx).toBe(210 * 4);
    const callCountAfterFirst = appendSpy.mock.calls.length;

    // Second call with same DPR should use cached value without appending probe elements
    const limits2 = calculatePageLimits(
      { width: 210, height: 297 },
      { top: 20, bottom: 20, left: 20, right: 20 },
      document,
    );
    expect(limits2.pageWidthPx).toBe(limits1.pageWidthPx);
    expect(appendSpy.mock.calls.length).toBe(callCountAfterFirst);
    heightSpy.mockRestore();
  });

  it("consumes sourceContainer children directly to eliminate mass-cloning overhead", async () => {
    const container = document.createElement("div");
    for (let i = 0; i < 5; i++) {
      const p = document.createElement("p");
      p.textContent = `Paragraph ${i}`;
      container.appendChild(p);
    }

    expect(container.children.length).toBe(5);

    const result = await paginate(container, dummyLimits);
    expect(result.totalPages).toBeGreaterThanOrEqual(1);

    // Source container should be drained because elements were directly transferred
    expect(container.children.length).toBe(0);
    expect(result.pages[0]?.contentEl.children.length).toBe(5);
  });

  it("time-slices cooperative pagination across animation frames", async () => {
    const container = document.createElement("div");
    for (let i = 0; i < 30; i++) {
      const p = document.createElement("p");
      p.textContent = `Block ${i}`;
      container.appendChild(p);
    }

    // With a 0ms budget, each step yields to waitForNextFrame
    const result = await paginate(
      container,
      dummyLimits,
      undefined,
      document,
      0,
    );
    expect(result.totalPages).toBeGreaterThanOrEqual(1);
    expect(result.pages[0]?.contentEl.children.length).toBe(30);
  });

  it("aborts cooperative pagination immediately when shouldCancel returns true", async () => {
    const container = document.createElement("div");
    for (let i = 0; i < 40; i++) {
      const p = document.createElement("p");
      p.textContent = `Paragraph ${i}`;
      container.appendChild(p);
    }

    let cancelCheckCount = 0;
    const shouldCancel = () => {
      cancelCheckCount++;
      return true; // Cancel after first yield
    };

    const result = await paginate(
      container,
      dummyLimits,
      undefined,
      document,
      0, // Force yield on every step
      shouldCancel,
    );

    expect(cancelCheckCount).toBeGreaterThanOrEqual(1);
    // Paginator should have aborted before consuming all 40 elements
    expect(result.container.querySelectorAll("p").length).toBeLessThan(40);
  });

  it("paginates a large 500-element document cleanly without errors", async () => {
    const container = document.createElement("div");
    for (let i = 0; i < 500; i++) {
      const p = document.createElement("p");
      p.textContent = `Stress paragraph line ${i}`;
      container.appendChild(p);
    }

    const result = await paginate(
      container,
      dummyLimits,
      undefined,
      document,
      10,
    );
    expect(result.totalPages).toBeGreaterThanOrEqual(1);
    expect(result.container.querySelectorAll("p").length).toBe(500);
  });

  it("fitElementsToPageBounds scales down oversized SVGs and assigns missing viewBox", () => {
    const container = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    container.appendChild(svg);

    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      width: 1440,
      height: 900,
      top: 0,
      bottom: 900,
      left: 0,
      right: 1440,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fitElementsToPageBounds(container, dummyLimits);

    // viewBox established
    expect(svg.getAttribute("viewBox")).toBe("0 0 1440 900");
    // scaled down to contentWidthPx (720px)
    expect(svg.style.width).toBe("720px");
    expect(svg.style.maxWidth).toBe("100%");
  });

  it("fitElementsToPageBounds proportionally scales wide Mermaid diagrams based on intrinsic viewBox and maxWidth", () => {
    const container = document.createElement("div");
    const blockLang = document.createElement("div");
    blockLang.className = "block-language-mermaid";
    const mermaidWrap = document.createElement("div");
    mermaidWrap.className = "mermaid";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 1600 1200");
    svg.style.maxWidth = "1600px";

    mermaidWrap.appendChild(svg);
    blockLang.appendChild(mermaidWrap);
    container.appendChild(blockLang);

    // Bounding client rect width reports 720 due to page CSS, but viewBox is 1600x1200
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      width: 720,
      height: 540,
      top: 0,
      bottom: 540,
      left: 0,
      right: 720,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fitElementsToPageBounds(container, dummyLimits);

    expect(svg.style.width).toBe("720px");
    expect(svg.style.height).toBe("540px");
    expect(svg.style.maxWidth).toBe("100%");
    expect(svg.getAttribute("data-diagram-width")).toBe("720");
    expect(svg.getAttribute("data-full-height")).toBe("540");
    expect(blockLang.getAttribute("data-diagram-width")).toBe("720");
    expect(blockLang.getAttribute("data-full-height")).toBe("540");
  });

  it("fitElementsToPageBounds scales down wide MathJax equations", () => {
    const container = document.createElement("div");
    const mathBlock = document.createElement("div");
    mathBlock.classList.add("math-block");
    const mjxMath = document.createElement("mjx-math");
    mathBlock.appendChild(mjxMath);
    container.appendChild(mathBlock);

    // scrollWidth = 1440px (> 720px contentWidthPx)
    Object.defineProperty(mathBlock, "scrollWidth", {
      configurable: true,
      value: 1440,
    });

    fitElementsToPageBounds(container, dummyLimits);

    expect(mjxMath.style.transform).toBe("scale(0.5)");
    expect(mjxMath.style.transformOrigin).toBe("left center");
  });

  it("fitElementsToPageBounds proportionally scales wide table elements and compacts cell padding", () => {
    const container = document.createElement("div");
    const table = document.createElement("table");
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = "Header";
    const td = document.createElement("td");
    td.textContent = "Data";
    tr.appendChild(th);
    tr.appendChild(td);
    table.appendChild(tr);
    container.appendChild(table);

    // scrollWidth = 1200 (> 720px contentWidthPx)
    Object.defineProperty(table, "scrollWidth", {
      configurable: true,
      value: 1200,
    });
    vi.spyOn(table, "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 200,
      top: 0,
      bottom: 200,
      left: 0,
      right: 1200,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fitElementsToPageBounds(container, dummyLimits);

    expect(table.style.width).toBe("100%");
    expect(table.style.maxWidth).toBe("100%");
    expect(table.style.fontSize).toBe("60%");
    expect(th.style.padding).toBe("3px 6px");
    expect(td.style.padding).toBe("3px 6px");
    expect(th.style.overflowWrap).toBe("break-word");
    expect(td.style.wordBreak).toBe("break-word");
  });

  it("empty page prevention: binds [h2 + introP + overflowing block] together or bisects eagerly", async () => {
    const container = document.createElement("div");

    const p1 = document.createElement("p");
    p1.textContent = "Introductory preceding content on page 1.";
    container.appendChild(p1);

    const h2 = document.createElement("h2");
    h2.textContent = "Section Heading";
    container.appendChild(h2);

    const introP = document.createElement("p");
    introP.textContent = "A".repeat(180);
    container.appendChild(introP);

    const tallBlock = document.createElement("div");
    tallBlock.classList.add("math-block");
    tallBlock.textContent = "Tall atomic formula";
    container.appendChild(tallBlock);

    vi.spyOn(p1, "getBoundingClientRect").mockReturnValue({
      top: 40,
      bottom: 100,
      left: 40,
      right: 760,
      width: 720,
      height: 60,
      x: 40,
      y: 40,
      toJSON: () => {},
    });
    vi.spyOn(h2, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 150,
      left: 40,
      right: 760,
      width: 720,
      height: 50,
      x: 40,
      y: 100,
      toJSON: () => {},
    });
    vi.spyOn(introP, "getBoundingClientRect").mockReturnValue({
      top: 150,
      bottom: 250,
      left: 40,
      right: 760,
      width: 720,
      height: 100,
      x: 40,
      y: 150,
      toJSON: () => {},
    });
    vi.spyOn(tallBlock, "getBoundingClientRect").mockImplementation(() => {
      const isPage1 = tallBlock.parentElement?.contains(p1);
      const top = isPage1 ? 250 : 190;
      const height = isPage1 ? 800 : 500;
      return {
        top,
        bottom: top + height,
        left: 40,
        right: 760,
        width: 720,
        height,
        x: 40,
        y: top,
        toJSON: () => {},
      };
    });

    const result = await paginate(
      container,
      dummyLimits,
      undefined,
      document,
      100,
    );

    expect(result.pages[0]?.contentEl.contains(p1)).toBe(true);
    expect(result.pages[0]?.contentEl.contains(h2)).toBe(false);
    expect(result.pages[0]?.contentEl.contains(introP)).toBe(false);

    expect(result.pages[1]?.contentEl.contains(h2)).toBe(true);
    expect(result.pages[1]?.contentEl.contains(introP)).toBe(true);
    expect(result.pages[1]?.contentEl.contains(tallBlock)).toBe(true);
  });

  it("empty page prevention: bisects tall diagram eagerly below introP", async () => {
    const container = document.createElement("div");

    const p1 = document.createElement("p");
    p1.textContent = "Preceding content";
    container.appendChild(p1);

    const h2 = document.createElement("h2");
    h2.textContent = "Diagram Section";
    container.appendChild(h2);

    const introP = document.createElement("p");
    introP.textContent = "A".repeat(180);
    container.appendChild(introP);

    const mermaidWrapper = document.createElement("div");
    mermaidWrapper.classList.add("block-language-mermaid");
    const svg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    ) as unknown as SVGElement;
    mermaidWrapper.appendChild(svg);
    container.appendChild(mermaidWrapper);

    vi.spyOn(p1, "getBoundingClientRect").mockReturnValue({
      top: 40,
      bottom: 100,
      left: 40,
      right: 760,
      width: 720,
      height: 60,
      x: 40,
      y: 40,
      toJSON: () => {},
    });
    vi.spyOn(h2, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 150,
      left: 40,
      right: 760,
      width: 720,
      height: 50,
      x: 40,
      y: 100,
      toJSON: () => {},
    });
    vi.spyOn(introP, "getBoundingClientRect").mockReturnValue({
      top: 150,
      bottom: 250,
      left: 40,
      right: 760,
      width: 720,
      height: 100,
      x: 40,
      y: 150,
      toJSON: () => {},
    });
    vi.spyOn(mermaidWrapper, "getBoundingClientRect").mockReturnValue({
      top: 250,
      bottom: 1250,
      left: 40,
      right: 760,
      width: 720,
      height: 1000,
      x: 40,
      y: 250,
      toJSON: () => {},
    });
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      top: 250,
      bottom: 1250,
      left: 40,
      right: 760,
      width: 720,
      height: 1000,
      x: 40,
      y: 250,
      toJSON: () => {},
    });

    const result = await paginate(
      container,
      dummyLimits,
      undefined,
      document,
      100,
    );

    expect(result.pages[0]?.contentEl.contains(p1)).toBe(true);
    expect(result.pages[0]?.contentEl.contains(h2)).toBe(true);
    expect(result.pages[0]?.contentEl.contains(introP)).toBe(true);
    expect(
      result.pages[0]?.contentEl.querySelector(".pdf-diagram-slice"),
    ).not.toBeNull();
  });
});
