import { afterEach, describe, expect, it, vi } from "vitest";
import { paginate } from "@/engine/paginator";
import { calculatePageLimits } from "@/engine/dom-utils";
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
});
