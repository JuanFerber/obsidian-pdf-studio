/**
 * @fileoverview Core data contracts, physical geometry invariants, and configuration interfaces for PDF Studio.
 *
 * Establishes the authoritative physical sheet dimensions conforming to ISO 216 (A-series)
 * and ANSI/ASME Y14.1 standards, margin boundary limits, runtime user preference models,
 * and dependency inversion contracts utilized across the pagination, rendering, and export pipelines.
 */

import { Plugin } from "obsidian";

/**
 * Standardized physical paper formats supported by the pagination and export engines.
 *
 * Conforms to:
 * - ISO 216: A4, A3, A5 (fixed aspect ratio of 1:sqrt(2))
 * - ANSI/ASME Y14.1: Letter, Legal (traditional North American stationary formats)
 */
export type PageFormat = "A4" | "Letter" | "Legal" | "A3" | "A5";

/**
 * Physical sheet dimensions represented in millimeters.
 *
 * Serves as the immutable geometric source of truth for DPI scaling and screen pixel conversions.
 * Values represent unclipped outer boundaries of the physical paper stock.
 */
export interface PageDimensionsMm {
  /** Physical paper width in millimeters. Invariant: width > 0. */
  readonly width: number;
  /** Physical paper height in millimeters. Invariant: height > 0. */
  readonly height: number;
}

/**
 * Canonical dimensions in millimeters for each supported standard paper format.
 *
 * Precise physical specifications:
 * - A4: 210 x 297 mm (ISO 216 baseline for academic and office documentation)
 * - Letter: 215.9 x 279.4 mm (ANSI A standard, 8.5 x 11 inches)
 * - Legal: 215.9 x 355.6 mm (ANSI stationary, 8.5 x 14 inches)
 * - A3: 297 x 420 mm (ISO 216 large format, double A4 area)
 * - A5: 148 x 210 mm (ISO 216 booklet format, half A4 area)
 */
export const PAGE_FORMATS_MM: Record<PageFormat, PageDimensionsMm> = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
  Legal: { width: 215.9, height: 355.6 },
  A3: { width: 297, height: 420 },
  A5: { width: 148, height: 210 },
};

/**
 * Per-page printable safety margins defined in millimeters.
 *
 * Establishes the non-printable gutter around the physical page boundaries to prevent
 * content clipping on hardware printers and display viewports.
 *
 * Invariants:
 * - Each margin must be non-negative: `top, bottom, left, right >= 0`.
 * - Horizontal sum must be strictly less than total page width: `left + right < pageWidthMm`.
 * - Vertical sum must be strictly less than total page height: `top + bottom < pageHeightMm`.
 * - Recommended operational range: 5 mm (minimal border) to 40 mm (wide editorial margin).
 */
export interface PageMarginsMm {
  /** Top margin clearance in millimeters. */
  top: number;
  /** Bottom margin clearance in millimeters. Sets the threshold for overflow pagination. */
  bottom: number;
  /** Left margin clearance in millimeters. */
  left: number;
  /** Right margin clearance in millimeters. */
  right: number;
}

/**
 * Persistent plugin configuration state managed by Obsidian's storage adapter.
 *
 * Controls layout geometry, debounced re-rendering intervals, zoom levels,
 * and export workflow options across the plugin lifecycle.
 *
 * Reactivity Semantics:
 * - Changes persisted via `saveData` propagate to all active `PDFStudioView` instances.
 * - Modifications to `pageFormat` or `margins` trigger an immediate layout recalculation.
 * - Modifications to `debounceDelayMs` adjust keystroke buffering behavior without redrawing.
 */
export interface PDFStudioSettings {
  /**
   * Selected physical page format.
   * @default "A4"
   */
  pageFormat: PageFormat;

  /**
   * Page printable margins in millimeters.
   * @default { top: 20, bottom: 20, left: 20, right: 20 }
   */
  margins: PageMarginsMm;

  /**
   * Debounce delay in milliseconds before triggering a preview re-render following vault edits.
   * Invariant: `debounceDelayMs >= 50` to prevent UI thread lockups during fast typing.
   * @default 200
   */
  debounceDelayMs: number;

  /**
   * Default preview zoom level percentage when manual zoom is active.
   * Invariant: Bounds are constrained between 20% and 500%.
   * @default 100
   */
  defaultZoom: number;

  /**
   * Whether to automatically scale virtual pages to fit the available preview panel width.
   * When enabled, manual zoom controls are hidden in the toolbar.
   * @default true
   */
  autoZoom: boolean;

  /**
   * Whether to automatically launch the generated PDF file in the operating system's default viewer.
   * @default false
   */
  openPdfAfterExport: boolean;

  /**
   * Saved preferred split pane width in pixels for workspace restoration.
   * Optional; undefined until the user resizes a split leaf.
   */
  savedSplitWidth?: number;
}

/**
 * Host plugin contract for dependency inversion and loose coupling.
 *
 * Decouples views, setting tabs, and export subroutines from the concrete
 * Obsidian Plugin implementation, enabling straightforward testing and modular composition.
 */
export interface IPDFStudioPlugin extends Plugin {
  /** Active persistent settings instance. */
  settings: PDFStudioSettings;

  /**
   * Persists the current settings state to Obsidian storage (`data.json`)
   * and notifies listening workspace views.
   *
   * @returns A promise that resolves once serialization and storage write succeed.
   */
  saveSettings(): Promise<void>;
}
