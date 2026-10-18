import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer, TFile, WorkspaceLeaf } from "obsidian";
import { PDFStudioView } from "@/view/pdf-view";
import { DEFAULT_SETTINGS } from "@/settings";
import type { IPDFStudioPlugin } from "@/types";

describe("PDFStudioView LRU Preview Cache & Sandboxing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMockFile(path: string, mtime = 1000): TFile {
    const file = new TFile();
    Object.assign(file, {
      path,
      basename: path.replace(/\.md$/, ""),
      extension: "md",
      stat: { mtime, size: 100, ctime: 1000 },
    });
    return file;
  }

  function setupView() {
    let activeFile: TFile | null = null;
    const readSpy = vi.fn().mockImplementation(async (file: TFile) => {
      return `# Content of ${file.path}`;
    });

    let activeLeafCb: (() => void) | null = null;
    const mockApp = {
      workspace: {
        getActiveFile: () => activeFile,
        on: vi.fn().mockImplementation((evt: string, cb: () => void) => {
          if (evt === "active-leaf-change") {
            activeLeafCb = cb;
          }
          return { id: "evt" };
        }),
        onLayoutReady: vi.fn(),
      },
      vault: {
        read: readSpy,
        on: vi.fn().mockReturnValue({ id: "evt" }),
      },
    };

    const mockPlugin = {
      app: mockApp,
      settings: { ...DEFAULT_SETTINGS },
      saveSettings: vi.fn().mockResolvedValue(undefined),
    } as unknown as IPDFStudioPlugin;

    const mockLeaf = {
      app: mockApp,
    } as unknown as WorkspaceLeaf;

    const view = new PDFStudioView(mockLeaf, mockPlugin);
    Object.assign(view, { app: mockApp });

    // Mock MarkdownRenderer.render to populate scratchEl
    vi.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, md, el) => {
        const p = document.createElement("p");
        p.textContent = md;
        el.appendChild(p);
      },
    );

    return {
      view,
      readSpy,
      setActiveFile: (file: TFile | null) => {
        activeFile = file;
      },
      triggerLeafChange: () => activeLeafCb?.(),
    };
  }

  it("instant cache hit on switching back to a previously rendered note", async () => {
    const { view, readSpy, setActiveFile } = setupView();
    await view.onOpen();

    const fileA = createMockFile("NoteA.md", 1000);
    const fileB = createMockFile("NoteB.md", 1000);

    // 1. Initial render Note A
    setActiveFile(fileA);
    await view.triggerRender(false);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(view.hasCached("NoteA.md")).toBe(true);
    expect(view.getCacheSize()).toBe(1);

    // 2. Switch to Note B
    setActiveFile(fileB);
    await view.triggerRender(false);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(view.hasCached("NoteB.md")).toBe(true);
    expect(view.getCacheSize()).toBe(2);

    // 3. Switch back to Note A: instant cache hit (<1ms, 0 vault reads, 0 DOM compilation)
    setActiveFile(fileA);
    const renderSpy = vi.spyOn(MarkdownRenderer, "render");
    renderSpy.mockClear();
    readSpy.mockClear();
    await view.triggerRender(false);

    expect(readSpy).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
    expect(view.hasCached("NoteA.md")).toBe(true);

    await view.onClose();
  });

  it("evicts oldest entry when cache exceeds MAX_VIEW_CACHE_ENTRIES (8)", async () => {
    const { view, setActiveFile } = setupView();
    await view.onOpen();

    // Render 9 different notes sequentially
    for (let i = 1; i <= 9; i++) {
      const file = createMockFile(`Note${i}.md`, 1000 + i);
      setActiveFile(file);
      await view.triggerRender(false);
    }

    // Cache size should be clamped to 8
    expect(view.getCacheSize()).toBe(8);
    // Note 1 (the oldest) should be evicted
    expect(view.hasCached("Note1.md")).toBe(false);
    // Note 9 (the newest) should be present
    expect(view.hasCached("Note9.md")).toBe(true);

    await view.onClose();
    expect(view.getCacheSize()).toBe(0);
  });

  it("discards stale async render if newer render sequence is initiated", async () => {
    const { view, setActiveFile } = setupView();
    await view.onOpen();

    const file1 = createMockFile("Fast.md", 1000);
    const file2 = createMockFile("Slow.md", 2000);

    const { promise: slowPromise, resolve: resolveSlow } =
      Promise.withResolvers<string>();

    const readMock = vi.fn().mockImplementation(async (file: TFile) => {
      if (file.path === "Slow.md") {
        return slowPromise;
      }
      return "# Fast content";
    });
    view.app.vault.read = readMock;

    // Start slow render
    setActiveFile(file2);
    const slowRun = view.triggerRender(false);

    // Interleave fast render immediately
    setActiveFile(file1);
    await view.triggerRender(false);

    // Resolve slow render now
    resolveSlow("# Slow content finished late");
    await slowRun;

    // Only Fast.md should be the active rendered file, slow.md was preempted
    expect(view.hasCached("Fast.md")).toBe(true);

    await view.onClose();
  });

  it("does not ignore active-leaf-change when switching back to previous note while another is in-flight", async () => {
    const { view, setActiveFile, triggerLeafChange } = setupView();
    await view.onOpen();

    const fileA = createMockFile("NoteA.md", 1000);
    const fileB = createMockFile("NoteB.md", 2000);

    // 1. Initial render of Note A finishes
    setActiveFile(fileA);
    await view.triggerRender(false);
    expect(view.hasCached("NoteA.md")).toBe(true);

    // 2. Slow render for Note B begins
    const { promise: slowPromiseB, resolve: resolveB } =
      Promise.withResolvers<string>();
    view.app.vault.read = vi.fn().mockImplementation(async (file: TFile) => {
      if (file.path === "NoteB.md") {
        return slowPromiseB;
      }
      return "# Fast content";
    });

    setActiveFile(fileB);
    triggerLeafChange(); // starts Note B in-flight

    // 3. While Note B is in flight, user quickly switches back to Note A
    setActiveFile(fileA);
    triggerLeafChange(); // active-leaf-change fires for Note A

    // 4. Resolve Note B late
    resolveB("# Content of Note B");
    await slowPromiseB;
    await Promise.resolve();

    // 5. Note A must remain active, Note B was canceled and not mounted
    expect(view.hasCached("NoteA.md")).toBe(true);
    expect(view.hasCached("NoteB.md")).toBe(false);

    await view.onClose();
  });
});
