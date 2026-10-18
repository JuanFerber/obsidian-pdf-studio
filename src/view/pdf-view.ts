/**
 * @fileoverview Live paginated preview view for Obsidian.
 *
 * Implements an Obsidian ItemView presenting real-time rendered virtual pages,
 * synchronized editor scrolling, reactive debounced re-renders, zoom scaling,
 * double-buffered twin-container DOM swapping, and direct PDF export triggers.
 */

import {
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type { IPDFStudioPlugin } from "@/types";
import { PAGE_FORMATS_MM } from "@/types";
import { calculatePageLimits, waitForDomSettled } from "@/engine/dom-utils";
import { paginate, type PaginationResult } from "@/engine/paginator";
import { preprocessMarkdown } from "@/engine/preprocessor";
import { exportToPdf } from "@/export/pdf-export";
import { PDFStudioOptionsPopover } from "@/view/options-popover";

/** Unique identifier for the PDF Studio preview workspace leaf. */
export const PDF_VIEW_TYPE = "pdf-studio-preview";

const MAX_VIEW_CACHE_ENTRIES = 8;

interface CachedPreviewState {
  filePath: string;
  mtime: number;
  rawMarkdown: string;
  configSignature: string;
  pagesFragment: DocumentFragment;
  totalPages: number;
  currentPageNumber: number;
  scrollTop: number;
  scrollLeft: number;
  component: Component;
}

/**
 * Interactive preview pane managing real-time virtual page rendering and zoom controls.
 */
export class PDFStudioView extends ItemView {
  public readonly plugin: IPDFStudioPlugin;
  private optionsPopover: PDFStudioOptionsPopover;
  private lastRenderedText = "";
  private lastRenderedFilePath = "";
  private pendingFilePath = "";
  private lastRenderedConfigSignature = "";
  private currentManualZoom = 100;
  private debounceTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeAnimFrameId: number | null = null;
  private viewCache = new Map<string, CachedPreviewState>();
  private currentRenderComponent: Component | null = null;
  private renderSeq = 0;
  private totalPagesCount = 1;
  private currentPageNumber = 1;

  private toolbarEl!: HTMLElement;
  private scrollContainerEl!: HTMLElement;
  private pagesWrapperEl!: HTMLElement;
  private pagesContainerEl!: HTMLElement;
  private stagingContainerEl!: HTMLElement;
  private pageNumberInputEl!: HTMLInputElement;
  private pageTotalEl!: HTMLElement;
  private manualZoomContainerEl!: HTMLElement;
  private zoomInputEl!: HTMLInputElement;

  constructor(leaf: WorkspaceLeaf, plugin: IPDFStudioPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentManualZoom = this.plugin.settings.defaultZoom ?? 100;
    this.optionsPopover = new PDFStudioOptionsPopover(this);
  }

  getViewType(): string {
    return PDF_VIEW_TYPE;
  }

  getDisplayText(): string {
    const activeFile = this.getActiveFile();
    return activeFile ? `PDF: ${activeFile.basename}` : "PDF Studio Preview";
  }

  getIcon(): string {
    return "file-text";
  }

  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      savedSplitWidth: this.plugin.settings.savedSplitWidth,
    };
  }

  async setState(
    state: Record<string, unknown>,
    result: ViewStateResult,
  ): Promise<void> {
    await super.setState(state, result);
    if (
      typeof state.savedSplitWidth === "number" &&
      state.savedSplitWidth > 0
    ) {
      this.plugin.settings.savedSplitWidth = state.savedSplitWidth;
    }
  }

  async onOpen(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.classList.add("pdf-studio-view");

    this.buildToolbar();

    // Scrollable viewport container strictly below the toolbar
    this.scrollContainerEl = containerEl.createDiv({
      cls: "pdf-scroll-container",
    });

    // Sizing wrapper inside scroll container
    this.pagesWrapperEl = this.scrollContainerEl.createDiv({
      cls: "pdf-pages-wrapper",
    });

    // Visible container for mounted virtual pages
    this.pagesContainerEl = this.pagesWrapperEl.createDiv({
      cls: "pdf-pages-container",
    });
    this.applyZoom();

    // Hidden offscreen staging container for rendering and measuring
    this.stagingContainerEl = containerEl.createDiv({
      cls: "pdf-staging-container",
    });

    // Observe scroll container width changes for smooth auto-zoom & centering
    this.resizeObserver = new ResizeObserver(() => {
      this.applyZoom();
    });
    this.resizeObserver.observe(this.scrollContainerEl);

    // Register workspace listeners for live reactivity
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const activePath = this.getActiveFile()?.path ?? "";
        if (
          activePath === this.lastRenderedFilePath &&
          activePath === this.pendingFilePath
        ) {
          return;
        }
        void this.triggerRender(false);
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file === this.getActiveFile()) {
          void this.triggerRender(true);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && this.viewCache.has(file.path)) {
          const entry = this.viewCache.get(file.path);
          if (entry) {
            entry.component.unload();
            this.removeChild(entry.component);
          }
          this.viewCache.delete(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && this.viewCache.has(oldPath)) {
          const entry = this.viewCache.get(oldPath);
          if (entry) {
            this.viewCache.delete(oldPath);
            entry.filePath = file.path;
            this.viewCache.set(file.path, entry);
          }
        }
      }),
    );
    // Observe scroll container scroll to update active page number automatically
    this.scrollContainerEl.addEventListener("scroll", this.onContainerScroll, {
      passive: true,
    });

    // Initial render
    await this.triggerRender(false);

    // Restore or set preferred width when layout is ready without race-condition timeouts
    this.app.workspace.onLayoutReady(() => {
      this.restoreOrSetPreferredWidth();
    });
  }

  private restoreOrSetPreferredWidth(): void {
    const root = (this.leaf as unknown as { getRoot?(): unknown }).getRoot?.();
    const isRight = root === this.app.workspace.rightSplit;
    const isLeft = root === this.app.workspace.leftSplit;
    if (isRight || isLeft) {
      const sidedock = (isRight
        ? this.app.workspace.rightSplit
        : this.app.workspace.leftSplit) as unknown as {
        width?: number;
        size?: number;
        containerEl?: HTMLElement;
      };
      const currentW =
        sidedock.width ||
        sidedock.size ||
        sidedock.containerEl?.clientWidth ||
        0;
      if (currentW < 350) {
        this.adjustToHalfWidth(false);
      }
    }
  }

  async onClose(): Promise<void> {
    if (this.resizeAnimFrameId !== null) {
      cancelAnimationFrame(this.resizeAnimFrameId);
      this.resizeAnimFrameId = null;
    }
    if (this.scrollContainerEl) {
      this.scrollContainerEl.removeEventListener(
        "scroll",
        this.onContainerScroll,
      );
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.optionsPopover.close();
    this.clearCache();
    this.containerEl.empty();
  }

  /**
   * Builds the top toolbar: Left page navigation, Right actions & settings gear.
   */
  private buildToolbar(): void {
    this.toolbarEl = this.containerEl.createDiv({ cls: "pdf-studio-toolbar" });

    // Left Controls: [< 1 / N >] grouped in a unified pill
    const leftControls = this.toolbarEl.createDiv({ cls: "pdf-toolbar-left" });
    const pagePill = leftControls.createDiv({ cls: "pdf-toolbar-pill" });

    // Previous Page Button
    const prevBtn = pagePill.createEl("button", { cls: "clickable-icon" });
    setIcon(prevBtn, "chevron-left");
    prevBtn.setAttribute("aria-label", "Previous Page");
    prevBtn.onclick = () => this.scrollToPage(this.currentPageNumber - 1);

    // Page Counter wrapper (strictly centered with symmetric gap)
    const counterWrapper = pagePill.createDiv({ cls: "pdf-pill-page-counter" });

    // Editable Page Number Input
    this.pageNumberInputEl = counterWrapper.createEl("input", {
      cls: "pdf-pill-input pdf-page-input",
      type: "text",
    });
    this.pageNumberInputEl.value = String(this.currentPageNumber);
    this.pageNumberInputEl.setAttribute("aria-label", "Current Page Number");

    const updatePageInputWidth = () => {
      const val = this.pageNumberInputEl.value.trim() || "1";
      this.pageNumberInputEl.style.width = `${Math.max(14, val.length * 8 + 4)}px`;
    };
    updatePageInputWidth();

    this.pageNumberInputEl.addEventListener("focus", () => {
      this.pageNumberInputEl.select();
    });

    this.pageNumberInputEl.addEventListener("input", () => {
      updatePageInputWidth();
    });

    const commitPageInput = () => {
      const target = parseInt(this.pageNumberInputEl.value.trim(), 10);
      if (!isNaN(target) && target >= 1 && target <= this.totalPagesCount) {
        this.scrollToPage(target);
      } else {
        this.pageNumberInputEl.value = String(this.currentPageNumber);
      }
      updatePageInputWidth();
    };

    this.pageNumberInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitPageInput();
        this.pageNumberInputEl.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.pageNumberInputEl.value = String(this.currentPageNumber);
        updatePageInputWidth();
        this.pageNumberInputEl.blur();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.scrollToPage(this.currentPageNumber - 1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.scrollToPage(this.currentPageNumber + 1);
      }
    });

    this.pageNumberInputEl.addEventListener("blur", () => {
      commitPageInput();
    });

    // Separator "/"
    counterWrapper.createSpan({
      cls: "pdf-pill-separator",
      text: "/",
    });

    // Total Pages Indicator
    this.pageTotalEl = counterWrapper.createSpan({
      cls: "pdf-pill-total",
      text: String(this.totalPagesCount),
    });

    // Next Page Button
    const nextBtn = pagePill.createEl("button", { cls: "clickable-icon" });
    setIcon(nextBtn, "chevron-right");
    nextBtn.setAttribute("aria-label", "Next Page");
    nextBtn.onclick = () => this.scrollToPage(this.currentPageNumber + 1);

    // Right Controls: [Manual Zoom] [Reload] [Export] [Gear Options]
    const rightControls = this.toolbarEl.createDiv({
      cls: "pdf-toolbar-right",
    });

    // Manual Zoom Sub-container (revealed when autoZoom is disabled)
    this.manualZoomContainerEl = rightControls.createDiv({
      cls: "pdf-manual-zoom-controls",
    });
    this.manualZoomContainerEl.style.display = this.plugin.settings.autoZoom
      ? "none"
      : "flex";

    const zoomPill = this.manualZoomContainerEl.createDiv({
      cls: "pdf-toolbar-pill",
    });

    // Zoom Out [-]
    const zoomOutBtn = zoomPill.createEl("button", {
      cls: "clickable-icon",
    });
    setIcon(zoomOutBtn, "minus");
    zoomOutBtn.setAttribute("aria-label", "Zoom Out (Alejar)");
    zoomOutBtn.onclick = () => this.adjustManualZoom(-10);

    // Editable Zoom Input [ 100% ]
    this.zoomInputEl = zoomPill.createEl("input", {
      cls: "pdf-pill-input pdf-zoom-input",
      type: "text",
    });
    this.zoomInputEl.value = `${this.currentManualZoom}%`;
    this.zoomInputEl.setAttribute(
      "aria-label",
      "Zoom Percentage (Type value and press Enter)",
    );

    this.zoomInputEl.addEventListener("focus", () => {
      this.zoomInputEl.select();
    });

    const commitZoomInput = () => {
      const raw = this.zoomInputEl.value.replace(/[^0-9]/g, "");
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed >= 20 && parsed <= 500) {
        this.currentManualZoom = parsed;
        this.applyZoom();
      }
      this.zoomInputEl.value = `${this.currentManualZoom}%`;
    };

    this.zoomInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitZoomInput();
        this.zoomInputEl.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.zoomInputEl.value = `${this.currentManualZoom}%`;
        this.zoomInputEl.blur();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.adjustManualZoom(10);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.adjustManualZoom(-10);
      }
    });

    this.zoomInputEl.addEventListener("blur", () => {
      commitZoomInput();
    });

    this.zoomInputEl.addEventListener("dblclick", () => {
      this.resetManualZoom();
      this.zoomInputEl.blur();
    });

    // Zoom In [+]
    const zoomInBtn = zoomPill.createEl("button", {
      cls: "clickable-icon",
    });
    setIcon(zoomInBtn, "plus");
    zoomInBtn.setAttribute("aria-label", "Zoom In (Acercar)");
    zoomInBtn.onclick = () => this.adjustManualZoom(10);

    // Half Width Split Button
    const halfSplitBtn = rightControls.createEl("button", {
      cls: "clickable-icon",
    });
    setIcon(halfSplitBtn, "columns-2");
    halfSplitBtn.setAttribute(
      "aria-label",
      "Toggle Half Width (Ajustar / Alternar al 50%)",
    );
    halfSplitBtn.onclick = () => {
      this.adjustToHalfWidth(true);
    };

    // Reload Button
    const reloadBtn = rightControls.createEl("button", {
      cls: "clickable-icon pdf-reload-btn",
    });
    setIcon(reloadBtn, "rotate-cw");
    reloadBtn.setAttribute("aria-label", "Reload Preview");
    reloadBtn.onclick = () => {
      if (reloadBtn.hasClass("is-spinning")) return;
      reloadBtn.addClass("is-spinning");
      setTimeout(() => reloadBtn.removeClass("is-spinning"), 650);

      // Yield to browser compositor thread so GPU rotation starts fluidly
      requestAnimationFrame(() => {
        setTimeout(() => {
          void this.triggerRender(false, true);
        }, 40);
      });
    };

    // Export PDF Button
    const exportBtn = rightControls.createEl("button", {
      cls: "clickable-icon",
    });
    setIcon(exportBtn, "download");
    exportBtn.setAttribute("aria-label", "Export to PDF");
    exportBtn.onclick = () => {
      const activeFile = this.getActiveFile();
      if (!activeFile) {
        new Notice("No active note found to export.");
        return;
      }
      void exportToPdf({
        file: activeFile,
        pagesContainerEl: this.pagesContainerEl,
        pageFormat: this.plugin.settings.pageFormat,
        openAfterSave: this.plugin.settings.openPdfAfterExport,
      });
    };

    // Options Popover Button (Settings Gear)
    const gearBtn = rightControls.createEl("button", { cls: "clickable-icon" });
    setIcon(gearBtn, "settings");
    gearBtn.setAttribute("aria-label", "View Options");
    gearBtn.onclick = () => {
      this.optionsPopover.toggle(gearBtn);
    };
  }

  /**
   * Adjusts the view layout to take half (50%) of Obsidian's width, or toggles back to compact width.
   * Smoothly animates expanding or contracting from its current position.
   *
   * @param animate - Whether to animate the transition smoothly. Defaults to true.
   */
  public adjustToHalfWidth(animate = true): void {
    if (this.resizeAnimFrameId !== null) {
      cancelAnimationFrame(this.resizeAnimFrameId);
      this.resizeAnimFrameId = null;
    }

    const workspace = this.app.workspace;
    const wsAny = workspace as unknown as {
      requestSaveLayout?(): void;
      requestResize?(): void;
      onResize?(): void;
      rightSplit?: {
        width?: number;
        size?: number;
        setSize?(size: number): void;
        containerEl?: HTMLElement;
      };
      leftSplit?: {
        width?: number;
        size?: number;
        setSize?(size: number): void;
        containerEl?: HTMLElement;
      };
    };

    const totalWidth = workspace.containerEl.clientWidth || window.innerWidth;
    if (totalWidth <= 0) return;
    const halfWidth = Math.round(totalWidth / 2);

    const root = (this.leaf as unknown as { getRoot?(): unknown }).getRoot?.();
    const isRightSidebar = root === workspace.rightSplit;
    const isLeftSidebar = root === workspace.leftSplit;

    const sidedock = isRightSidebar
      ? wsAny.rightSplit
      : isLeftSidebar
        ? wsAny.leftSplit
        : null;

    if (sidedock) {
      const currentWidth = Math.round(
        sidedock.containerEl?.getBoundingClientRect().width ||
          sidedock.size ||
          sidedock.width ||
          0,
      );

      // If already at 50% (within 8px tolerance), do nothing
      if (Math.abs(currentWidth - halfWidth) <= 8) {
        return;
      }

      const targetWidth = halfWidth;

      // Measure the difference between sidedock container width and inner scroll container width
      const innerScrollWidth =
        this.scrollContainerEl?.clientWidth || currentWidth;
      const containerPadding = Math.max(0, currentWidth - innerScrollWidth);

      const applyWidth = (w: number) => {
        sidedock.width = w;
        sidedock.size = w;
        if (sidedock.containerEl) {
          sidedock.containerEl.style.width = `${w}px`;
        }
        // Immediately sync preview sheet zoom to this exact frame width
        const effectiveInnerWidth = Math.max(100, w - containerPadding);
        this.applyZoom(effectiveInnerWidth);
      };

      const finalize = () => {
        applyWidth(targetWidth);
        if (typeof sidedock.setSize === "function") {
          sidedock.setSize(targetWidth);
        }
        this.plugin.settings.savedSplitWidth = targetWidth;
        void this.plugin.saveSettings();

        wsAny.requestSaveLayout?.();
        if (typeof wsAny.requestResize === "function") {
          wsAny.requestResize();
        } else if (typeof wsAny.onResize === "function") {
          wsAny.onResize();
        }
        this.applyZoom();
      };

      if (!animate || currentWidth <= 0) {
        finalize();
        return;
      }

      // Smooth animation using cubic ease-out
      const startWidth = currentWidth;
      const widthDiff = targetWidth - startWidth;
      const durationMs = 280;
      const startTime = performance.now();
      const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

      const animateStep = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / durationMs);
        const interpolated = Math.round(
          startWidth + widthDiff * easeOutCubic(progress),
        );

        applyWidth(interpolated);

        if (progress < 1) {
          this.resizeAnimFrameId = requestAnimationFrame(animateStep);
        } else {
          this.resizeAnimFrameId = null;
          finalize();
        }
      };

      this.resizeAnimFrameId = requestAnimationFrame(animateStep);
      return;
    }

    // If inside main workspace split (rootSplit)
    const leafAny = this.leaf as unknown as {
      parentSplit?: {
        children: Array<{
          dimension?: number;
          setDimension?(d: number | null): void;
          containerEl?: HTMLElement;
        }>;
      };
      parent?: {
        parent?: {
          children: Array<{
            dimension?: number;
            setDimension?(d: number | null): void;
            containerEl?: HTMLElement;
          }>;
        };
      };
    };

    const parentSplit = leafAny.parentSplit ?? leafAny.parent?.parent;

    if (
      parentSplit &&
      Array.isArray(parentSplit.children) &&
      parentSplit.children.length > 1
    ) {
      const equalShare = 100 / parentSplit.children.length;
      const firstChild = parentSplit.children[0];
      const currentDim = firstChild?.dimension ?? 50;

      // If already at equal share (within 1.5% tolerance), do nothing
      if (Math.abs(currentDim - equalShare) < 1.5) {
        return;
      }

      const targetShare = equalShare;

      const notifyMainResize = (finalWidth: number) => {
        this.plugin.settings.savedSplitWidth = finalWidth;
        void this.plugin.saveSettings();
        wsAny.requestSaveLayout?.();
        if (typeof wsAny.requestResize === "function") {
          wsAny.requestResize();
        } else if (typeof wsAny.onResize === "function") {
          wsAny.onResize();
        }
        this.applyZoom();
      };

      const applyShare = (share: number) => {
        for (let idx = 0; idx < parentSplit.children.length; idx++) {
          const child = parentSplit.children[idx]!;
          const childShare =
            idx === 0
              ? share
              : (100 - share) / (parentSplit.children.length - 1);
          child.dimension = childShare;
          child.setDimension?.(childShare);
          if (child.containerEl) {
            child.containerEl.style.flex = `1 1 ${childShare}%`;
            child.containerEl.style.flexGrow = "1";
            child.containerEl.style.width = "";
          }
        }
        this.applyZoom();
      };

      if (!animate || Math.abs(currentDim - targetShare) < 1) {
        applyShare(targetShare);
        notifyMainResize(halfWidth);
        return;
      }

      const startShare = currentDim;
      const shareDiff = targetShare - startShare;
      const durationMs = 280;
      const startTime = performance.now();
      const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

      const animateFlexStep = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / durationMs);
        const currentInterp = startShare + shareDiff * easeOutCubic(progress);

        applyShare(currentInterp);

        if (progress < 1) {
          this.resizeAnimFrameId = requestAnimationFrame(animateFlexStep);
        } else {
          this.resizeAnimFrameId = null;
          notifyMainResize(halfWidth);
        }
      };

      this.resizeAnimFrameId = requestAnimationFrame(animateFlexStep);
      return;
    }

    // Fallback: apply 50% dimension directly
    const leafWithSetDimension = this.leaf as unknown as {
      dimension?: number;
      setDimension?(d: number | null): void;
    };
    leafWithSetDimension.dimension = 50;
    if (typeof leafWithSetDimension.setDimension === "function") {
      leafWithSetDimension.setDimension(50);
    }
    this.plugin.settings.savedSplitWidth = halfWidth;
    void this.plugin.saveSettings();
    wsAny.requestSaveLayout?.();
    if (typeof wsAny.requestResize === "function") {
      wsAny.requestResize();
    } else if (typeof wsAny.onResize === "function") {
      wsAny.onResize();
    }
    this.applyZoom();
  }

  /**
   * Scrolls smoothly to a target page index.
   */
  private scrollToPage(targetPage: number): void {
    if (targetPage < 1 || targetPage > this.totalPagesCount) return;
    const pages =
      this.pagesContainerEl.querySelectorAll<HTMLElement>(".pdf-page");
    const targetEl = pages[targetPage - 1];
    if (targetEl && this.scrollContainerEl) {
      const pageRect = targetEl.getBoundingClientRect();
      const containerRect = this.scrollContainerEl.getBoundingClientRect();
      const targetScrollTop =
        this.scrollContainerEl.scrollTop +
        (pageRect.top - containerRect.top) -
        16;
      this.scrollContainerEl.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: "smooth",
      });
      this.currentPageNumber = targetPage;
      this.updatePageIndicator();
    }
  }

  private updatePageIndicator(): void {
    if (
      this.pageNumberInputEl &&
      document.activeElement !== this.pageNumberInputEl
    ) {
      this.pageNumberInputEl.value = String(this.currentPageNumber);
      const val = this.pageNumberInputEl.value.trim() || "1";
      this.pageNumberInputEl.style.width = `${Math.max(14, val.length * 8 + 4)}px`;
    }
    if (this.pageTotalEl) {
      this.pageTotalEl.setText(String(this.totalPagesCount));
    }
  }

  private onContainerScroll = (): void => {
    if (!this.pagesContainerEl || !this.scrollContainerEl) return;
    const pages =
      this.pagesContainerEl.querySelectorAll<HTMLElement>(".pdf-page");
    if (pages.length === 0) return;

    const containerRect = this.scrollContainerEl.getBoundingClientRect();
    const triggerY = containerRect.top + 140;

    let activePage = 1;
    for (let i = 0; i < pages.length; i++) {
      const pageEl = pages[i];
      if (!pageEl) continue;
      const rect = pageEl.getBoundingClientRect();
      if (rect.top <= triggerY && rect.bottom >= triggerY) {
        activePage = i + 1;
        break;
      } else if (rect.top > triggerY) {
        break;
      } else {
        activePage = i + 1;
      }
    }

    if (activePage !== this.currentPageNumber) {
      this.currentPageNumber = activePage;
      if (
        this.pageNumberInputEl &&
        document.activeElement !== this.pageNumberInputEl
      ) {
        this.pageNumberInputEl.value = String(this.currentPageNumber);
        const val = this.pageNumberInputEl.value.trim() || "1";
        this.pageNumberInputEl.style.width = `${Math.max(14, val.length * 8 + 4)}px`;
      }
    }
  };

  private adjustManualZoom(delta: number): void {
    this.currentManualZoom = Math.max(
      20,
      Math.min(500, this.currentManualZoom + delta),
    );
    if (this.zoomInputEl) {
      this.zoomInputEl.value = `${this.currentManualZoom}%`;
    }
    this.applyZoom();
  }

  private resetManualZoom(): void {
    this.currentManualZoom = this.plugin.settings.defaultZoom ?? 100;
    if (this.zoomInputEl) {
      this.zoomInputEl.value = `${this.currentManualZoom}%`;
    }
    this.applyZoom();
  }

  public updateZoomControlsVisibility(): void {
    if (this.manualZoomContainerEl) {
      this.manualZoomContainerEl.style.display = this.plugin.settings.autoZoom
        ? "none"
        : "flex";
    }
  }

  private getConfigSignature(): string {
    const s = this.plugin.settings;
    return `${s.pageFormat}:${s.margins.top},${s.margins.bottom},${s.margins.left},${s.margins.right}`;
  }

  /**
   * Computes and applies scale (either auto-fit to panel width or user manual scale)
   * while ensuring the content is centered when narrower than the container and
   * never clipped on the left when wider.
   */
  public applyZoom(forcedContainerWidth?: number): void {
    if (
      !this.pagesContainerEl ||
      !this.scrollContainerEl ||
      !this.pagesWrapperEl
    ) {
      return;
    }

    const containerWidth =
      forcedContainerWidth !== undefined
        ? forcedContainerWidth
        : this.scrollContainerEl.clientWidth;
    if (containerWidth <= 0) return;

    const dimensions = PAGE_FORMATS_MM[this.plugin.settings.pageFormat];
    const limits = calculatePageLimits(
      dimensions,
      this.plugin.settings.margins,
      this.containerEl.ownerDocument,
    );

    let scale: number;
    if (this.plugin.settings.autoZoom) {
      const padding = 48; // 24px left + 24px right breathing room
      const availableWidth = Math.max(100, containerWidth - padding);
      scale = Math.min(2.0, Math.max(0.2, availableWidth / limits.pageWidthPx));
    } else {
      scale = this.currentManualZoom / 100;
    }

    const pageCount = Math.max(1, this.totalPagesCount);
    const unscaledHeight =
      pageCount * limits.pageHeightPx + Math.max(0, pageCount - 1) * 28;

    const scaledWidth = Math.ceil(limits.pageWidthPx * scale);
    const scaledHeight = Math.ceil(unscaledHeight * scale);

    // Apply exact dimensions and scale to pages container
    this.pagesContainerEl.style.width = `${limits.pageWidthPx}px`;
    this.pagesContainerEl.style.height = `${unscaledHeight}px`;
    this.pagesContainerEl.style.transform = `scale(${scale})`;
    this.pagesContainerEl.style.transformOrigin = "top left";

    // Size wrapper to occupy physical layout space for proper scroll bounds
    this.pagesWrapperEl.style.width = `${scaledWidth}px`;
    this.pagesWrapperEl.style.height = `${scaledHeight + 96}px`;

    const horizontalPadding = 24;
    if (scaledWidth + horizontalPadding * 2 < containerWidth) {
      // Center horizontally when page fits comfortably in container
      const sideMargin = Math.floor((containerWidth - scaledWidth) / 2);
      this.pagesWrapperEl.style.marginLeft = `${sideMargin}px`;
      this.pagesWrapperEl.style.marginRight = `${sideMargin}px`;
    } else {
      // Pin with minimum 24px left and right margins to avoid clipping
      this.pagesWrapperEl.style.marginLeft = `${horizontalPadding}px`;
      this.pagesWrapperEl.style.marginRight = `${horizontalPadding}px`;
    }
  }

  private getActiveFile(): TFile | null {
    return this.app.workspace.getActiveFile();
  }

  /**
   * Triggers a preview re-render, optionally coalescing rapid keystrokes via debouncing.
   *
   * @param isDebounced - When true, delays rendering by `plugin.settings.debounceDelayMs`.
   *                      When false (e.g., active leaf switch), executes immediately.
   * @param force - Bypasses the `lastRenderedText` change detection gate when true.
   */
  public async triggerRender(isDebounced = true, force = false): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (isDebounced) {
      this.debounceTimer = window.setTimeout(() => {
        void this.renderPipeline(force);
      }, this.plugin.settings.debounceDelayMs);
    } else {
      await this.renderPipeline(force);
    }
  }

  /**
   * Core 8-stage unidirectional rendering pipeline for PDF Studio preview.
   *
   * Execution Stages:
   * 1. **LRU Cache Hit Gate:** Checks `viewCache` for matching file path, mtime, and geometry signature.
   *    On hit, performs instant (<1ms) DOM fragment swap with 0 disk reads and 0 re-renders.
   * 2. **Disk Ingestion & Change Detection Gate:** Ingests raw Markdown via `vault.read`. Aborts if
   *    both text and geometric configuration match the active display (0% CPU idle).
   * 3. **Markdown Preprocessing:** Converts authoring break directives into sentinels while shielding code fences.
   * 4. **Early Metric Boundary Computation:** Calculates printable limits early to configure scratch container width.
   * 5. **Sandboxed Clean DOM Compilation:** Compiles Markdown into an isolated staging container with an ephemeral
   *    {@link Component} lifecycle boundary.
   * 6. **Mutation Stabilization:** Awaits {@link waitForDomSettled} for external plugins, web fonts, and MathJax to rest.
   * 7. **Cooperative Time-Sliced Pagination:** Assembles virtual sheets yielding control every 10ms with sequence cancellation.
   * 8. **Atomic Twin-Container Swap & Cache Registration:** Mounts pages into viewport, updates scroll indicators,
   *    and stores state in `viewCache`.
   *
   * @param force - When true, re-executes pipeline even if source text matches cache.
   */
  private async renderPipeline(force = false): Promise<void> {
    const seq = ++this.renderSeq;
    const file = this.getActiveFile();
    this.pendingFilePath = file?.path ?? "";
    if (!file || file.extension !== "md") {
      this.detachCurrentViewToCache();
      this.pagesContainerEl.empty();
      this.pendingFilePath = "";
      this.lastRenderedFilePath = "";
      this.lastRenderedText = "";
      this.lastRenderedConfigSignature = "";
      this.totalPagesCount = 0;
      this.currentPageNumber = 0;
      this.updatePageIndicator();
      return;
    }

    const currentConfig = this.getConfigSignature();

    // LRU Cache Check: Instant hit on tab switch if mtime & config match
    const cached = this.viewCache.get(file.path);
    if (
      !force &&
      cached &&
      cached.mtime === file.stat.mtime &&
      cached.configSignature === currentConfig
    ) {
      // Refresh LRU order
      this.viewCache.delete(file.path);
      this.viewCache.set(file.path, cached);

      if (this.lastRenderedFilePath !== file.path) {
        this.detachCurrentViewToCache();
        this.pagesContainerEl.empty();
        this.pagesContainerEl.appendChild(cached.pagesFragment);
      }

      this.pendingFilePath = file.path;
      this.lastRenderedFilePath = file.path;
      this.lastRenderedConfigSignature = cached.configSignature;
      this.totalPagesCount = cached.totalPages;
      this.currentPageNumber = cached.currentPageNumber;
      this.currentRenderComponent = cached.component;

      this.updatePageIndicator();
      this.applyZoom();

      if (this.scrollContainerEl) {
        this.scrollContainerEl.scrollTop = cached.scrollTop;
        this.scrollContainerEl.scrollLeft = cached.scrollLeft;
      }
      this.onContainerScroll();
      return;
    }

    const rawMarkdown = await this.app.vault.read(file);
    if (seq !== this.renderSeq) return;

    // Change gate: abort if neither markdown nor page config changed
    if (
      !force &&
      rawMarkdown === this.lastRenderedText &&
      currentConfig === this.lastRenderedConfigSignature &&
      this.pagesContainerEl.children.length > 0
    ) {
      return;
    }

    // 1. Preprocess raw markdown
    const processedMarkdown = preprocessMarkdown(rawMarkdown, {
      sourcePath: file.path,
    });

    // 2. Calculate page limits early for batched layout read
    const dimensions = PAGE_FORMATS_MM[this.plugin.settings.pageFormat];
    const limits = calculatePageLimits(
      dimensions,
      this.plugin.settings.margins,
      this.containerEl.ownerDocument,
    );

    // 3. Isolated ephemeral render component
    const renderComponent = new Component();
    this.addChild(renderComponent);

    // 4. Render into isolated staging container per pipeline pass
    const runStagingEl = this.stagingContainerEl.createDiv();
    try {
      const scratchEl = runStagingEl.createDiv();
      scratchEl.style.width = `${limits.contentWidthPx}px`;
      scratchEl.style.boxSizing = "border-box";

      await MarkdownRenderer.render(
        this.app,
        processedMarkdown,
        scratchEl,
        file.path,
        renderComponent,
      );
      if (seq !== this.renderSeq) {
        renderComponent.unload();
        this.removeChild(renderComponent);
        return;
      }

      // 5. Wait for math, fonts, and third-party plugins to settle
      await waitForDomSettled(scratchEl);
      if (seq !== this.renderSeq) {
        renderComponent.unload();
        this.removeChild(renderComponent);
        return;
      }

      // 6. Run virtual pagination engine with time-slicing and cancellation token
      const paginationResult: PaginationResult = await paginate(
        scratchEl,
        limits,
        runStagingEl,
        this.containerEl.ownerDocument,
        10,
        () => seq !== this.renderSeq,
      );
      if (seq !== this.renderSeq) {
        renderComponent.unload();
        this.removeChild(renderComponent);
        return;
      }

      // 7. Atomic twin-container swap and cache state update
      const isSameFile = file.path === this.lastRenderedFilePath;
      const previousScrollTop =
        isSameFile && this.scrollContainerEl
          ? this.scrollContainerEl.scrollTop
          : 0;
      const previousScrollLeft =
        isSameFile && this.scrollContainerEl
          ? this.scrollContainerEl.scrollLeft
          : 0;

      if (!isSameFile) {
        this.detachCurrentViewToCache();
      } else if (this.currentRenderComponent) {
        this.currentRenderComponent.unload();
        this.removeChild(this.currentRenderComponent);
      }

      const staleEntry = this.viewCache.get(file.path);
      if (staleEntry && staleEntry.component !== renderComponent) {
        staleEntry.component.unload();
        this.removeChild(staleEntry.component);
      }

      this.pagesContainerEl.empty();
      while (paginationResult.container.firstChild) {
        this.pagesContainerEl.appendChild(
          paginationResult.container.firstChild,
        );
      }

      this.currentRenderComponent = renderComponent;
      this.pendingFilePath = file.path;
      this.lastRenderedFilePath = file.path;
      this.lastRenderedText = rawMarkdown;
      this.lastRenderedConfigSignature = currentConfig;
      this.totalPagesCount = paginationResult.totalPages;
      this.currentPageNumber = 1;

      const cacheEntry: CachedPreviewState = {
        filePath: file.path,
        mtime: file.stat.mtime,
        rawMarkdown,
        configSignature: currentConfig,
        pagesFragment: this.containerEl.ownerDocument.createDocumentFragment(),
        totalPages: paginationResult.totalPages,
        currentPageNumber: 1,
        scrollTop: previousScrollTop,
        scrollLeft: previousScrollLeft,
        component: renderComponent,
      };
      this.setCacheEntry(file.path, cacheEntry);

      this.updatePageIndicator();
      this.applyZoom();

      if (this.scrollContainerEl) {
        this.scrollContainerEl.scrollTop = previousScrollTop;
        this.scrollContainerEl.scrollLeft = previousScrollLeft;
      }
      this.onContainerScroll();
    } finally {
      runStagingEl.remove();
    }
  }

  /**
   * Detaches the currently rendered visible page nodes from `pagesContainerEl` into their
   * designated LRU cache entry's `pagesFragment`, preserving user scroll offsets and page counts.
   */
  private detachCurrentViewToCache(): void {
    if (!this.lastRenderedFilePath) return;
    const cached = this.viewCache.get(this.lastRenderedFilePath);
    if (!cached) return;

    while (this.pagesContainerEl.firstChild) {
      cached.pagesFragment.appendChild(this.pagesContainerEl.firstChild);
    }
    cached.scrollTop = this.scrollContainerEl
      ? this.scrollContainerEl.scrollTop
      : 0;
    cached.scrollLeft = this.scrollContainerEl
      ? this.scrollContainerEl.scrollLeft
      : 0;
    cached.currentPageNumber = this.currentPageNumber;
    cached.totalPages = this.totalPagesCount;
  }

  /**
   * Inserts or updates an entry in the LRU preview cache, enforcing the maximum capacity ceiling.
   * Evicted entries automatically unload their isolated child component to prevent memory leaks.
   *
   * @param key - Vault-relative file path of the note.
   * @param state - Complete snapshot of the rendered virtual pages and viewport geometry.
   */
  private setCacheEntry(key: string, state: CachedPreviewState): void {
    if (this.viewCache.has(key)) {
      this.viewCache.delete(key);
    }
    this.viewCache.set(key, state);

    if (this.viewCache.size > MAX_VIEW_CACHE_ENTRIES) {
      const oldestKey = this.viewCache.keys().next().value;
      if (oldestKey) {
        const oldestEntry = this.viewCache.get(oldestKey);
        if (oldestEntry) {
          oldestEntry.component.unload();
          this.removeChild(oldestEntry.component);
        }
        this.viewCache.delete(oldestKey);
      }
    }
  }

  /**
   * Completely purges the LRU preview cache, deterministically unloading all cached child components.
   */
  public clearCache(): void {
    for (const entry of this.viewCache.values()) {
      entry.component.unload();
      this.removeChild(entry.component);
    }
    this.viewCache.clear();
    this.currentRenderComponent = null;
    this.pendingFilePath = "";
    this.lastRenderedFilePath = "";
    this.lastRenderedText = "";
    this.lastRenderedConfigSignature = "";
  }

  /**
   * Returns the current number of active cached note entries in the preview cache.
   */
  public getCacheSize(): number {
    return this.viewCache.size;
  }

  /**
   * Checks whether a specific note file path is currently cached in memory.
   *
   * @param filePath - Vault-relative file path to query.
   */
  public hasCached(filePath: string): boolean {
    return this.viewCache.has(filePath);
  }
}
