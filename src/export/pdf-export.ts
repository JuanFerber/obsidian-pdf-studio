/**
 * @fileoverview Headless Chromium PDF export pipeline leveraging Electron's native printToPDF interface.
 *
 * Implements the vector PDF generation bridge:
 * 1. Clones the assembled virtual pages into an off-screen print staging area.
 * 2. Injects a temporary container satisfying Obsidian's global print CSS:
 *    `body > :not(.print) { display: none !important; }`.
 * 3. Strips interactive UI controls (e.g. copy buttons) and injects `@page` boundary rules.
 * 4. Dispatches the headless Chromium print job via Electron IPC (`print-to-pdf`).
 * 5. Deterministically tears down staging artifacts and restores the host editor theme in `finally`.
 */

import { Notice, TFile } from "obsidian";
import type { PageFormat } from "@/types";

/**
 * Configuration options parameterizing a PDF export operation.
 */
export interface ExportPdfOptions {
  /** The source Markdown file currently being exported. */
  file: TFile;
  /** Root DOM element containing assembled virtual pages (`.pdf-page`). */
  pagesContainerEl: HTMLElement;
  /** Physical target paper format (e.g., "A4", "Letter", "A5"). */
  pageFormat: PageFormat;
  /**
   * Whether to automatically launch the generated PDF in the system viewer upon completion.
   * @default true
   */
  openAfterSave?: boolean;
}

/**
 * Exports assembled virtual pages to a high-fidelity vector PDF file via Electron Chromium.
 *
 * Execution Pipeline:
 * 1. **Validation:** Aborts if `pagesContainerEl` holds zero pages.
 * 2. **Dialog Navigation:** Prompts the user with Electron's native OS file save dialog,
 *    falling back to vault root if running headless or without remote dialog access.
 * 3. **Print DOM Inversion:**
 *    - Injects a dynamic `<style>` tag declaring `@page { size: <format>; margin: 0; }`.
 *    - Temporarily transitions `document.body` to `.theme-light` so text prints in true black-on-white.
 *    - Mounts a direct child `<div class="print pdf-studio-print">` containing cloned pages.
 * 4. **Chromium Print Dispatch:** Awaits font readiness, then issues the `print-to-pdf` IPC call
 *    with a 30-second timeout.
 * 5. **Deterministic Teardown:** In `finally`, detaches `printEl`, removes the `@page` stylesheet,
 *    and restores the user's prior dark/light theme setting.
 *
 * @param options - Configuration options for the export job.
 * @returns A promise resolving upon successful disk write or graceful cancellation.
 */
export async function exportToPdf(options: ExportPdfOptions): Promise<void> {
  const { file, pagesContainerEl, pageFormat, openAfterSave = true } = options;
  const pages = pagesContainerEl.querySelectorAll<HTMLElement>(".pdf-page");

  if (pages.length === 0) {
    new Notice(
      "Nothing to export: document is empty or preview has not finished rendering.",
    );
    return;
  }

  const globalWindow = window as unknown as {
    electron?: {
      ipcRenderer: {
        send(channel: string, ...args: unknown[]): void;
        once(channel: string, listener: (...args: unknown[]) => void): void;
      };
      remote?: {
        dialog?: {
          showSaveDialog(
            options: unknown,
          ): Promise<{ canceled: boolean; filePath?: string }>;
        };
      };
    };
    require?: (mod: string) => any;
  };

  const electron = globalWindow.electron ?? globalWindow.require?.("electron");

  if (!electron?.ipcRenderer) {
    // Non-electron environment fallback: invoke browser/OS print dialog
    window.print();
    return;
  }

  let targetFilePath: string | null = null;
  const defaultFileName = `${file.basename}.pdf`;

  if (electron.remote?.dialog) {
    try {
      const saveResult = await electron.remote.dialog.showSaveDialog({
        title: "Export to PDF",
        defaultPath: defaultFileName,
        filters: [
          { name: "PDF Documents", extensions: ["pdf"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["showOverwriteConfirmation"],
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return; // User cancelled the save dialog
      }
      targetFilePath = saveResult.filePath;
    } catch (dialogErr) {
      console.warn(
        "[PDF Studio] showSaveDialog failed, using vault path fallback:",
        dialogErr,
      );
    }
  }

  // Fallback to saving in vault root if dialog was unavailable
  if (!targetFilePath) {
    const adapter = file.vault.adapter as unknown as {
      getBasePath?: () => string;
    };
    const basePath = adapter.getBasePath?.();
    if (basePath) {
      targetFilePath = `${basePath}/${defaultFileName}`;
    } else {
      new Notice("Unable to determine save destination for PDF export.");
      return;
    }
  }

  const notice = new Notice("Exporting PDF document...", 0);

  // In Obsidian, Electron's main process handles "print-to-pdf" on the active window.
  // Obsidian's global print stylesheet enforces: `body > :not(.print) { display: none !important; }`.
  // Therefore, printable elements MUST be inside a direct child of document.body with class "print".
  const doc = document;
  const wasDarkTheme = doc.body.classList.contains("theme-dark");

  let printEl: HTMLElement | null = null;
  let pageStyleEl: HTMLStyleElement | null = null;
  try {
    // Temporarily switch body to theme-light for clean black-on-white text rendering
    if (wasDarkTheme) {
      doc.body.classList.remove("theme-dark");
      doc.body.classList.add("theme-light");
    }

    // Inject dynamic @page style for exact physical dimensions and 0 browser margins
    pageStyleEl = doc.createElement("style");
    pageStyleEl.id = "pdf-studio-export-page-style";
    pageStyleEl.textContent = `
      @page {
        size: ${pageFormat};
        margin: 0;
      }
    `;
    doc.head.appendChild(pageStyleEl);

    // Create root print element attached to document.body
    printEl = doc.body.createDiv({ cls: "print pdf-studio-print" });

    // Clone the assembled virtual pages
    const pagesClone = pagesContainerEl.cloneNode(true) as HTMLElement;
    pagesClone.style.transform = "none";
    pagesClone.style.position = "static";
    pagesClone.style.margin = "0";
    pagesClone.style.padding = "0";

    // Strip copy buttons and interactive widgets before sending to Chromium print
    for (const btn of Array.from(
      pagesClone.querySelectorAll(
        ".copy-code-button, button[aria-label*='Copy' i], button[aria-label*='Copiar' i]",
      ),
    )) {
      btn.remove();
    }

    printEl.appendChild(pagesClone);

    // Wait for fonts and styles to settle
    try {
      if (doc.fonts) {
        await doc.fonts.ready;
      }
    } catch {
      // Ignore if fonts.ready API is unsupported
    }

    const { promise: delayPromise, resolve: delayResolve } =
      Promise.withResolvers<void>();
    window.setTimeout(delayResolve, 200);
    await delayPromise;

    const ipc = electron.ipcRenderer;

    const {
      promise: exportPromise,
      resolve: exportResolve,
      reject: exportReject,
    } = Promise.withResolvers<void>();

    const timeout = window.setTimeout(() => {
      exportReject(new Error("PDF export timed out after 30 seconds."));
    }, 30000);

    ipc.once("print-to-pdf", () => {
      clearTimeout(timeout);
      exportResolve();
    });

    ipc.send("print-to-pdf", {
      filepath: targetFilePath,
      pageSize: pageFormat,
      marginsType: 1, // 1 = none (margins are precisely positioned by .pdf-page-content)
      printBackground: true,
      landscape: false,
      open: openAfterSave,
    });

    await exportPromise;

    notice.hide();
    new Notice(`PDF saved to:\n${targetFilePath}`, 6000);
  } catch (err: unknown) {
    notice.hide();
    const message = err instanceof Error ? err.message : String(err);
    console.error("[PDF Studio] PDF export failed:", err);
    new Notice(`Failed to export PDF: ${message}`, 6000);
  } finally {
    if (printEl) {
      printEl.detach();
    }
    if (pageStyleEl) {
      pageStyleEl.remove();
    }
    if (wasDarkTheme) {
      doc.body.classList.remove("theme-light");
      doc.body.classList.add("theme-dark");
    }
  }
}
