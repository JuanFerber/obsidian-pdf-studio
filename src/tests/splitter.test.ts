import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isCodeBlock,
  isUnsplittable,
  splitCodeBlock,
  splitTable,
  splitList,
} from "@/engine/splitter";
import { paginate } from "@/engine/paginator";
import type { PageLimitsPx } from "@/engine/dom-utils";

describe("Code Block Splitter & Pagination", () => {
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

  it("correctly identifies code blocks and wrappers", () => {
    const pre = document.createElement("pre");
    expect(isCodeBlock(pre)).toBe(true);

    const blockLang = document.createElement("div");
    blockLang.classList.add("block-language-python");
    expect(isCodeBlock(blockLang)).toBe(true);

    const containerWithPre = document.createElement("div");
    containerWithPre.appendChild(document.createElement("pre"));
    expect(isCodeBlock(containerWithPre)).toBe(true);

    const para = document.createElement("p");
    para.textContent = "Normal paragraph";
    expect(isCodeBlock(para)).toBe(false);

    const mixedContainer = document.createElement("div");
    mixedContainer.appendChild(document.createElement("p"));
    mixedContainer.appendChild(document.createElement("pre"));
    expect(isCodeBlock(mixedContainer)).toBe(false);
  });

  it("splits standard pre/code elements cleanly by line breaks", () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent =
      "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8";
    pre.appendChild(code);

    const copyBtn = document.createElement("button");
    copyBtn.classList.add("copy-code-button");
    pre.appendChild(copyBtn);

    vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 340,
      height: 240,
      width: 700,
      left: 0,
      right: 700,
      x: 0,
      y: 100,
      toJSON: () => {},
    });

    // 8 lines in 240px -> 30px per line.
    // maxBottomPx = 230 -> available height = 130px -> floor(130 / 30) = 4 lines.
    const result = splitCodeBlock(pre, 230, 0);
    expect(result).not.toBeNull();
    if (!result) return;

    // Head should contain lines 1..4 without trailing newline
    expect(result.head?.textContent).toBe("line 1\nline 2\nline 3\nline 4");
    // Head copy button stripped
    expect(result.head?.querySelector(".copy-code-button")).toBeNull();

    // Tail should contain lines 5..8 without leading newline
    expect(result.tail.textContent).toBe("line 5\nline 6\nline 7\nline 8");
    // Tail copy button stripped
    expect(result.tail.querySelector(".copy-code-button")).toBeNull();
    // Tail has continuation styling class
    expect(result.tail.classList.contains("pdf-split-continued")).toBe(true);
  });

  it("preserves syntax highlighting tokens when splitting across page boundaries", () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");

    for (let i = 1; i <= 6; i++) {
      const kw = document.createElement("span");
      kw.className = "token-keyword";
      kw.textContent = "const";
      code.appendChild(kw);
      code.appendChild(document.createTextNode(` x${i} = ${i};`));
      if (i < 6) {
        code.appendChild(document.createTextNode("\n"));
      }
    }
    pre.appendChild(code);

    vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 280,
      height: 180,
      width: 700,
      left: 0,
      right: 700,
      x: 0,
      y: 100,
      toJSON: () => {},
    });

    // 6 lines in 180px -> 30px per line.
    // maxBottomPx = 200 -> available height = 100px -> floor(100 / 30) = 3 lines.
    const result = splitCodeBlock(pre, 200, 0);
    expect(result).not.toBeNull();
    if (!result) return;

    // Head has 3 lines with spans intact
    expect(result.head?.querySelectorAll(".token-keyword").length).toBe(3);
    expect(result.head?.textContent).toBe(
      "const x1 = 1;\nconst x2 = 2;\nconst x3 = 3;",
    );

    // Tail has 3 lines with spans intact
    expect(result.tail.querySelectorAll(".token-keyword").length).toBe(3);
    expect(result.tail.textContent).toBe(
      "const x4 = 4;\nconst x5 = 5;\nconst x6 = 6;",
    );
  });

  it("does not split code block when fewer than 3 lines fit in head", () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6";
    pre.appendChild(code);

    vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 280,
      height: 180,
      width: 700,
      left: 0,
      right: 700,
      x: 0,
      y: 100,
      toJSON: () => {},
    });

    // maxBottomPx allows only 2 lines (available = 70px / 30 = 2)
    const result = splitCodeBlock(pre, 170, 0);
    expect(result).toBeNull();
  });

  it("does not split code block when fewer than 2 lines remain for tail", () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = "line 1\nline 2\nline 3\nline 4\nline 5";
    pre.appendChild(code);

    vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 250,
      height: 150,
      width: 700,
      left: 0,
      right: 700,
      x: 0,
      y: 100,
      toJSON: () => {},
    });

    // maxBottomPx allows 4 lines -> 1 line remaining for tail (< 2)
    const result = splitCodeBlock(pre, 230, 0);
    expect(result).toBeNull();
  });

  it("paginator moves overflowing code block intact to the next page when not first on page", () => {
    const source = document.createElement("div");

    // Paragraph at top of page 1
    const p1 = document.createElement("p");
    p1.textContent = "Introduction paragraph";
    source.appendChild(p1);

    // Heading preceding code block
    const h2 = document.createElement("h2");
    h2.textContent = "Code Section";
    source.appendChild(h2);

    // Code block that will overflow page 1
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = "console.log('hello');";
    pre.appendChild(code);
    source.appendChild(pre);

    vi.spyOn(
      window.HTMLElement.prototype,
      "getBoundingClientRect",
    ).mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "PRE") {
        return {
          top: 160,
          bottom: 980,
          height: 820,
          width: 700,
          left: 0,
          right: 700,
          x: 0,
          y: 160,
          toJSON: () => {},
        };
      }
      if (this.tagName === "H2") {
        return {
          top: 110,
          bottom: 150,
          height: 40,
          width: 700,
          left: 0,
          right: 700,
          x: 0,
          y: 110,
          toJSON: () => {},
        };
      }
      if (this.tagName === "P") {
        return {
          top: 40,
          bottom: 100,
          height: 60,
          width: 700,
          left: 0,
          right: 700,
          x: 0,
          y: 40,
          toJSON: () => {},
        };
      }
      return {
        top: 0,
        bottom: 0,
        height: 0,
        width: 0,
        left: 0,
        right: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      };
    });

    const result = paginate(source, dummyLimits);
    expect(result.totalPages).toBeGreaterThanOrEqual(2);

    // Page 1 should contain p1 (h2 was moved with pre as keep-with-next)
    const page1Content = result.pages[0]?.contentEl;
    expect(page1Content?.children.length).toBe(1);
    expect(page1Content?.firstElementChild?.tagName).toBe("P");

    // Page 2 should contain h2 and pre intact (not split)
    const page2Content = result.pages[1]?.contentEl;
    expect(page2Content?.children.length).toBe(2);
    expect(page2Content?.children[0]?.tagName).toBe("H2");
    expect(page2Content?.children[1]?.tagName).toBe("PRE");
  });

  it("paginator moves short lead-in paragraph together with overflowing code block", () => {
    const source = document.createElement("div");

    // Preceding paragraph (intro)
    const p1 = document.createElement("p");
    p1.textContent = "Introductory text on page 1";
    source.appendChild(p1);

    // Short lead-in paragraph (e.g. 'Me conecto al Wi-Fi')
    const leadIn = document.createElement("p");
    leadIn.textContent = "Me conecto al Wi-Fi";
    source.appendChild(leadIn);

    // Code block that overflows page 1
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = "iwctl";
    pre.appendChild(code);
    source.appendChild(pre);

    vi.spyOn(
      window.HTMLElement.prototype,
      "getBoundingClientRect",
    ).mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "PRE") {
        return {
          top: 200,
          bottom: 1100,
          height: 900,
          width: 700,
          left: 0,
          right: 700,
          x: 0,
          y: 200,
          toJSON: () => {},
        };
      }
      if (this.textContent === "Me conecto al Wi-Fi") {
        return {
          top: 150,
          bottom: 180,
          height: 30,
          width: 700,
          left: 0,
          right: 700,
          x: 0,
          y: 150,
          toJSON: () => {},
        };
      }
      if (this.textContent === "Introductory text on page 1") {
        return {
          top: 40,
          bottom: 120,
          height: 80,
          width: 700,
          left: 0,
          right: 700,
          x: 0,
          y: 40,
          toJSON: () => {},
        };
      }
      return {
        top: 0,
        bottom: 0,
        height: 0,
        width: 0,
        left: 0,
        right: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      };
    });

    const result = paginate(source, dummyLimits);
    expect(result.totalPages).toBeGreaterThanOrEqual(2);

    // Page 1 should only contain the introductory paragraph (leadIn was moved to keep-with-next)
    const page1Content = result.pages[0]?.contentEl;
    expect(page1Content?.children.length).toBe(1);
    expect(page1Content?.children[0]?.textContent).toBe(
      "Introductory text on page 1",
    );

    // Page 2 should contain the leadIn paragraph AND the code block intact
    const page2Content = result.pages[1]?.contentEl;
    expect(page2Content?.children.length).toBe(2);
    expect(page2Content?.children[0]?.textContent).toBe("Me conecto al Wi-Fi");
    expect(page2Content?.children[1]?.tagName).toBe("PRE");
  });

  it("splitTable preserves thead in continuation table", () => {
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = "Column Header";
    headerRow.appendChild(th);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (let i = 1; i <= 6; i++) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.textContent = `Row ${i}`;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const rows = tbody.querySelectorAll("tr");
    rows.forEach((row, idx) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: 100 + idx * 30,
        bottom: 100 + (idx + 1) * 30,
        height: 30,
        width: 700,
        left: 0,
        right: 700,
        x: 0,
        y: 100 + idx * 30,
        toJSON: () => {},
      });
    });

    // Split after 3 rows (available height = 100px -> top=100, row 3 ends at 190, maxBottomPx = 200)
    const result = splitTable(table, 200, 0);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.tail.querySelector("thead")).not.toBeNull();
    expect(result.tail.querySelectorAll("tbody tr").length).toBe(3);
    expect(result.tail.classList.contains("pdf-split-continued")).toBe(true);
  });

  it("splitList preserves numbering for ordered lists", () => {
    const ol = document.createElement("ol");
    for (let i = 1; i <= 6; i++) {
      const li = document.createElement("li");
      li.textContent = `Item ${i}`;
      ol.appendChild(li);
    }

    const items = ol.querySelectorAll("li");
    items.forEach((item, idx) => {
      vi.spyOn(item, "getBoundingClientRect").mockReturnValue({
        top: 100 + idx * 30,
        bottom: 100 + (idx + 1) * 30,
        height: 30,
        width: 700,
        left: 0,
        right: 700,
        x: 0,
        y: 100 + idx * 30,
        toJSON: () => {},
      });
    });

    // Split after 3 items
    const result = splitList(ol, 200, 0);
    expect(result).not.toBeNull();
    if (!result) return;

    expect((result.tail as HTMLOListElement).start).toBe(4);
    expect(result.tail.querySelectorAll("li").length).toBe(3);
    expect(result.tail.classList.contains("pdf-split-continued")).toBe(true);
  });

  it("correctly identifies unsplittable elements", () => {
    const h1 = document.createElement("h1");
    expect(isUnsplittable(h1)).toBe(true);

    const img = document.createElement("img");
    expect(isUnsplittable(img)).toBe(true);

    const math = document.createElement("div");
    math.classList.add("math-block");
    expect(isUnsplittable(math)).toBe(true);

    const frontmatter = document.createElement("div");
    frontmatter.classList.add("frontmatter");
    expect(isUnsplittable(frontmatter)).toBe(true);

    const p = document.createElement("p");
    expect(isUnsplittable(p)).toBe(false);
  });
});
