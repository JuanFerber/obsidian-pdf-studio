/**
 * @fileoverview Live paginated preview view for Obsidian.
 *
 * Implements an Obsidian ItemView presenting real-time rendered virtual pages,
 * synchronized editor scrolling, reactive debounced re-renders, zoom scaling,
 * double-buffered twin-container DOM swapping, and direct PDF export triggers.
 */

import {
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

/**
 * Interactive preview pane managing real-time virtual page rendering and zoom controls.
 */
export class PDFStudioView extends ItemView {
  public readonly plugin: IPDFStudioPlugin;
  private optionsPopover: PDFStudioOptionsPopover;
  private lastRenderedText = "";
  private lastRenderedFilePath = "";
  private lastRenderedConfigSignature = "";
  private currentManualZoom = 100;
  private debounceTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeAnimFrameId: number | null = null;

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
    this.containerEl.empty();
  }

  /**
   * Builds the top toolbar: Left page navigation, Right actions & settings gear.
   */
  private buildToolbar(): void {
    this.toolbarEl = this.containerEl.createDiv({ cls: "pdf-studio-toolbar" });
    this.toolbarEl.style.cssText = `
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 4px 12px;
			border-bottom: 1px solid var(--background-modifier-border);
			background-color: var(--background-primary);
			flex: 0 0 auto;
			width: 100%;
			box-sizing: border-box;
			position: relative;
			z-index: 100;
			min-height: 36px;
		`;

    // Left Controls: [< 1 / N >] grouped in a unified pill
    const leftControls = this.toolbarEl.createDiv({ cls: "pdf-toolbar-left" });
    leftControls.style.display = "flex";
    leftControls.style.alignItems = "center";

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
    rightControls.style.display = "flex";
    rightControls.style.alignItems = "center";
    rightControls.style.gap = "6px";

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
   * Core 7-stage unidirectional rendering pipeline for PDF Studio preview.
   *
   * Lifecycle Execution Stages:
   * 1. **Change Gate:** Compares current raw Markdown and geometric configuration with cached
   *    values. Aborts immediately if no changes are detected (0% CPU at idle).
   * 2. **Markdown Preprocessing:** Directives (\pagebreak, //page) are translated into HTML sentinels
   *    while fenced code blocks remain shielded.
   * 3. **Clean DOM Compilation:** Compiles Markdown into an off-screen staging scratch container.
   * 4. **Mutation Stabilization:** Awaits {@link waitForDomSettled} for fonts, MathJax, and styling to finish.
   * 5. **Metric Calculation:** Translates paper format and margins into exact screen pixel limits.
   * 6. **Unidirectional Pagination:** Assembles virtual sheets and bisects overflowing content.
   * 7. **Atomic Twin-Container Swap:** Replaces visible `.pdf-pages-container` child nodes in a single
   *    pass, eliminating flicker and deterministically preserving user scroll positions.
   *
   * @param force - When true, re-executes pipeline even if source text matches cache.
   */
  private async renderPipeline(force = false): Promise<void> {
    const file = this.getActiveFile();
    if (!file || file.extension !== "md") {
      this.pagesContainerEl.empty();
      this.totalPagesCount = 0;
      this.currentPageNumber = 0;
      this.updatePageIndicator();
      return;
    }

    const rawMarkdown = await this.app.vault.read(file);
    const currentConfig = this.getConfigSignature();

    // Change gate: abort immediately if neither markdown nor page config changed (0% CPU)
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

    // 2. Render fresh clean DOM into offscreen staging scratch container
    this.stagingContainerEl.empty();
    const scratchEl = this.stagingContainerEl.createDiv();

    await MarkdownRenderer.render(
      this.app,
      processedMarkdown,
      scratchEl,
      file.path,
      this,
    );

    // 3. Wait for math, fonts, and third-party plugins to settle
    await waitForDomSettled(scratchEl);

    // 4. Calculate page boundaries based on settings
    const dimensions = PAGE_FORMATS_MM[this.plugin.settings.pageFormat];
    const limits = calculatePageLimits(
      dimensions,
      this.plugin.settings.margins,
      this.containerEl.ownerDocument,
    );

    // 5. Run virtual pagination engine connected to staging DOM for accurate measurement
    const paginationResult: PaginationResult = paginate(
      scratchEl,
      limits,
      this.stagingContainerEl,
      this.containerEl.ownerDocument,
    );

    // 6. Atomic twin-container swap: replace visible pages while preserving scroll position
    const isSameFile = file.path === this.lastRenderedFilePath;
    const previousScrollTop =
      isSameFile && this.scrollContainerEl
        ? this.scrollContainerEl.scrollTop
        : 0;
    const previousScrollLeft =
      isSameFile && this.scrollContainerEl
        ? this.scrollContainerEl.scrollLeft
        : 0;
    this.pagesContainerEl.empty();

    while (paginationResult.container.firstChild) {
      this.pagesContainerEl.appendChild(paginationResult.container.firstChild);
    }

    this.lastRenderedFilePath = file.path;

    // 7. Update state, indicator and zoom
    this.lastRenderedText = rawMarkdown;
    this.lastRenderedConfigSignature = currentConfig;
    this.totalPagesCount = paginationResult.totalPages;
    this.currentPageNumber = 1;
    this.updatePageIndicator();
    this.applyZoom();

    if (this.scrollContainerEl) {
      this.scrollContainerEl.scrollTop = previousScrollTop;
      this.scrollContainerEl.scrollLeft = previousScrollLeft;
    }
  }
}
