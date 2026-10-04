/**
 * @fileoverview Floating quick-settings popover menu for the PDF Studio preview toolbar.
 *
 * Implements a lightweight, anchored dropdown menu allowing users to rapidly toggle
 * page formats (A4, Letter, Legal, A5), margin presets (Normal, Compact, Wide), and auto-zoom
 * directly within the live preview panel without navigating away from their note.
 */

import { setIcon } from "obsidian";
import type { PageFormat } from "@/types";
import type { PDFStudioView } from "@/view/pdf-view";

/**
 * Format entry model describing a selectable paper format option in the popover.
 */
interface FormatItem {
  readonly key: PageFormat;
  readonly title: string;
  readonly dim: string;
}

/**
 * Margin preset model describing a selectable symmetrical margin option in the popover.
 */
interface MarginItem {
  readonly title: string;
  readonly dim: string;
  readonly value: number;
}

/**
 * Supported page format options displayed in the quick selector.
 */
const FORMAT_ITEMS: FormatItem[] = [
  { key: "A4", title: "A4", dim: "210 × 297 mm" },
  { key: "Letter", title: "Carta", dim: "215.9 × 279.4 mm" },
  { key: "Legal", title: "Oficio", dim: "215.9 × 355.6 mm" },
  { key: "A5", title: "A5", dim: "148 × 210 mm" },
];

/**
 * Symmetrical margin presets in millimeters displayed in the quick selector.
 */
const MARGIN_ITEMS: MarginItem[] = [
  { title: "Normal", dim: "20 mm", value: 20 },
  { title: "Compacto", dim: "10 mm", value: 10 },
  { title: "Amplio", dim: "30 mm", value: 30 },
];

/**
 * Floating options dropdown menu for in-context page format and margin adjustments.
 *
 * Lifecycle & Event Management:
 * - Mounted directly under `document.body` to avoid container clipping.
 * - Positions itself below `triggerEl` aligned with the right viewport boundary.
 * - Binds global capture listeners for outside pointer clicks, Escape key dismissals,
 *   and window resizes, ensuring deterministic cleanup upon closure.
 * - Triggers immediate forced re-renders (`triggerRender(false, true)`) on parent view upon change.
 */
export class PDFStudioOptionsPopover {
  private view: PDFStudioView;
  private popoverEl: HTMLElement | null = null;
  private triggerEl: HTMLElement | null = null;
  private outsideClickHandler: ((e: PointerEvent) => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private resizeHandler: (() => void) | null = null;

  private formatRows: Map<
    PageFormat,
    { row: HTMLElement; checkSlot: HTMLElement }
  > = new Map();
  private marginRows: Map<
    number,
    { row: HTMLElement; checkSlot: HTMLElement }
  > = new Map();

  /**
   * Initializes the popover manager bound to an active PDFStudioView instance.
   *
   * @param view - Parent preview view controller.
   */
  constructor(view: PDFStudioView) {
    this.view = view;
  }

  /**
   * Checks whether the popover is currently mounted and visible.
   *
   * @returns True if the popover DOM element exists.
   */
  public isOpen(): boolean {
    return this.popoverEl !== null;
  }

  /**
   * Toggles popover visibility against a triggering button element.
   *
   * @param triggerEl - The toolbar button element triggering the popover.
   */
  public toggle(triggerEl: HTMLElement): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open(triggerEl);
    }
  }

  /**
   * Mounts and positions the floating popover relative to the triggering button.
   *
   * Attaches window-level event listeners for outside click and keyboard dismissal.
   *
   * @param triggerEl - Element serving as the geometric anchor.
   */
  public open(triggerEl: HTMLElement): void {
    if (this.isOpen()) return;
    this.triggerEl = triggerEl;

    const popover = document.body.createDiv({ cls: "pdf-options-popover" });
    this.popoverEl = popover;

    this.positionPopover();
    this.buildContent(popover);

    // Global outside click handler
    this.outsideClickHandler = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        this.popoverEl &&
        !this.popoverEl.contains(target) &&
        !this.triggerEl?.contains(target)
      ) {
        this.close();
      }
    };

    // Escape key handler
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.close();
      }
    };

    // Auto-close on window resize
    this.resizeHandler = () => {
      this.close();
    };

    window.addEventListener("pointerdown", this.outsideClickHandler, true);
    window.addEventListener("keydown", this.keydownHandler, true);
    window.addEventListener("resize", this.resizeHandler);
  }

  /**
   * Unmounts the popover DOM element and detaches all global event listeners.
   */
  public close(): void {
    if (this.outsideClickHandler) {
      window.removeEventListener("pointerdown", this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
    if (this.keydownHandler) {
      window.removeEventListener("keydown", this.keydownHandler, true);
      this.keydownHandler = null;
    }
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }
    this.triggerEl = null;
    this.formatRows.clear();
    this.marginRows.clear();
  }

  /**
   * Computes screen coordinates aligning popover directly below the trigger element.
   */
  private positionPopover(): void {
    if (!this.popoverEl || !this.triggerEl) return;
    const rect = this.triggerEl.getBoundingClientRect();
    const rightMargin = Math.max(10, window.innerWidth - rect.right);
    const top = rect.bottom + 6;
    this.popoverEl.style.top = `${top}px`;
    this.popoverEl.style.right = `${rightMargin}px`;
  }

  /**
   * Evaluates if all four margins currently match a uniform millimeter value.
   *
   * @param val - Millimeter margin value to test.
   * @returns True if top, bottom, left, and right all equal `val`.
   */
  private isCurrentMargin(val: number): boolean {
    const m = this.view.plugin.settings.margins;
    return (
      m.top === val && m.bottom === val && m.left === val && m.right === val
    );
  }

  /**
   * Synchronizes visual checkmark indicators across format selection rows.
   */
  private updateFormatSelection(): void {
    const current = this.view.plugin.settings.pageFormat;
    for (const [key, data] of this.formatRows.entries()) {
      const active = key === current;
      data.row.classList.toggle("is-active", active);
      data.checkSlot.empty();
      if (active) {
        setIcon(data.checkSlot, "check");
      }
    }
  }

  /**
   * Synchronizes visual checkmark indicators across margin selection rows.
   */
  private updateMarginSelection(): void {
    for (const [val, data] of this.marginRows.entries()) {
      const active = this.isCurrentMargin(val);
      data.row.classList.toggle("is-active", active);
      data.checkSlot.empty();
      if (active) {
        setIcon(data.checkSlot, "check");
      }
    }
  }

  /**
   * Assembles the interactive popover layout sections: AutoZoom, Formats, Margins, Preferences.
   *
   * @param popover - Container element created in document body.
   */
  private buildContent(popover: HTMLElement): void {
    // -------------------------------------------------------------
    // Section 1: VISTA Y AJUSTE
    // -------------------------------------------------------------
    popover.createDiv({
      cls: "pdf-popover-header",
      text: "VISTA Y AJUSTE",
    });

    const autoZoomRow = popover.createDiv({ cls: "pdf-popover-autozoom-row" });
    autoZoomRow.createDiv({
      cls: "pdf-popover-row-title",
      text: "Ajustar al ancho automático",
    });

    const autoZoomToggle = autoZoomRow.createDiv({
      cls: `pdf-popover-toggle ${this.view.plugin.settings.autoZoom ? "is-checked" : ""}`,
    });
    autoZoomToggle.createDiv({ cls: "pdf-popover-toggle-knob" });

    autoZoomRow.onclick = async () => {
      this.view.plugin.settings.autoZoom = !this.view.plugin.settings.autoZoom;
      await this.view.plugin.saveSettings();
      this.view.updateZoomControlsVisibility();
      this.view.applyZoom();
      autoZoomToggle.classList.toggle(
        "is-checked",
        this.view.plugin.settings.autoZoom,
      );
    };

    popover.createDiv({ cls: "pdf-popover-divider" });

    // -------------------------------------------------------------
    // Section 2: TAMAÑO DE PÁGINA
    // -------------------------------------------------------------
    popover.createDiv({
      cls: "pdf-popover-header",
      text: "TAMAÑO DE PÁGINA",
    });

    for (const item of FORMAT_ITEMS) {
      const isSelected = this.view.plugin.settings.pageFormat === item.key;
      const row = popover.createDiv({
        cls: `pdf-popover-option ${isSelected ? "is-active" : ""}`,
      });
      const left = row.createDiv({ cls: "pdf-popover-option-left" });
      const checkSlot = left.createDiv({ cls: "pdf-popover-check-slot" });
      if (isSelected) {
        setIcon(checkSlot, "check");
      }
      left.createDiv({
        cls: "pdf-popover-option-label",
        text: item.title,
      });
      row.createDiv({ cls: "pdf-popover-option-dim", text: item.dim });

      this.formatRows.set(item.key, { row, checkSlot });

      row.onclick = async () => {
        if (this.view.plugin.settings.pageFormat === item.key) return;
        this.view.plugin.settings.pageFormat = item.key;
        await this.view.plugin.saveSettings();
        this.updateFormatSelection();
        void this.view.triggerRender(false, true);
      };
    }

    popover.createDiv({ cls: "pdf-popover-divider" });

    // -------------------------------------------------------------
    // Section 3: MÁRGENES DE PÁGINA
    // -------------------------------------------------------------
    popover.createDiv({
      cls: "pdf-popover-header",
      text: "MÁRGENES DE PÁGINA",
    });

    for (const item of MARGIN_ITEMS) {
      const isSelected = this.isCurrentMargin(item.value);
      const row = popover.createDiv({
        cls: `pdf-popover-option ${isSelected ? "is-active" : ""}`,
      });
      const left = row.createDiv({ cls: "pdf-popover-option-left" });
      const checkSlot = left.createDiv({ cls: "pdf-popover-check-slot" });
      if (isSelected) {
        setIcon(checkSlot, "check");
      }
      left.createDiv({
        cls: "pdf-popover-option-label",
        text: item.title,
      });
      row.createDiv({ cls: "pdf-popover-option-dim", text: item.dim });

      this.marginRows.set(item.value, { row, checkSlot });

      row.onclick = async () => {
        if (this.isCurrentMargin(item.value)) return;
        this.view.plugin.settings.margins = {
          top: item.value,
          bottom: item.value,
          left: item.value,
          right: item.value,
        };
        await this.view.plugin.saveSettings();
        this.updateMarginSelection();
        void this.view.triggerRender(false, true);
      };
    }

    popover.createDiv({ cls: "pdf-popover-divider" });

    // -------------------------------------------------------------
    // Section 4: PREFERENCIAS
    // -------------------------------------------------------------
    popover.createDiv({
      cls: "pdf-popover-header",
      text: "PREFERENCIAS",
    });

    const settingsRow = popover.createDiv({
      cls: "pdf-popover-action-row is-clickable",
    });
    const settingsLeft = settingsRow.createDiv({
      cls: "pdf-popover-action-left",
    });
    const slidersIconEl = settingsLeft.createSpan({ cls: "pdf-popover-icon" });
    setIcon(slidersIconEl, "sliders");
    settingsLeft.createSpan({
      cls: "pdf-popover-action-label",
      text: "Configuración del plugin...",
    });

    const extIconEl = settingsRow.createSpan({
      cls: "pdf-popover-icon-right",
    });
    setIcon(extIconEl, "external-link");

    settingsRow.onclick = () => {
      this.close();
      const appWithSetting = this.view.app as unknown as {
        setting?: { open(): void; openTabById(id: string): void };
      };
      appWithSetting.setting?.open();
      appWithSetting.setting?.openTabById("pdf-studio");
    };
  }
}
