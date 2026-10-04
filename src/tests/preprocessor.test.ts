import { describe, expect, it } from "vitest";
import { preprocessMarkdown, transformPageBreaks } from "@/engine/preprocessor";

describe("Markdown Preprocessor", () => {
  it("transforms \\pagebreak directive into page break sentinel", () => {
    const md = "# Title\n\n\\pagebreak\n\n## Next Chapter";
    const processed = transformPageBreaks(md);
    expect(processed).toContain(
      '<div class="pdf-page-break" data-page-break="true"></div>',
    );
    expect(processed).toContain("## Next Chapter");
  });

  it("transforms <!-- pagebreak --> directive into sentinel", () => {
    const md = "Paragraph 1\n<!-- pagebreak -->\nParagraph 2";
    const processed = transformPageBreaks(md);
    expect(processed).toContain(
      '<div class="pdf-page-break" data-page-break="true"></div>',
    );
  });

  it("transforms //page shorthand directive into sentinel", () => {
    const md = "Section A\n//page\nSection B";
    const processed = transformPageBreaks(md);
    expect(processed).toContain(
      '<div class="pdf-page-break" data-page-break="true"></div>',
    );
  });

  it("does not transform pagebreak directives inside fenced code blocks", () => {
    const md =
      "```ts\nconst x = '\\pagebreak';\n//page\n```\nOutside\n\\pagebreak";
    const processed = transformPageBreaks(md);
    expect(processed).toContain("const x = '\\pagebreak';");
    expect(processed).toContain("//page");
    expect(processed.split('<div class="pdf-page-break"').length).toBe(2); // exactly 1 replacement
  });

  it("preprocessMarkdown applies registered transformers cleanly", () => {
    const md = "# Heading\n\\pagebreak\nContent";
    const result = preprocessMarkdown(md);
    expect(result).toContain("pdf-page-break");
  });
});
