/**
 * @fileoverview Main entry point, lifecycle orchestrator, and command coordinator for PDF Studio.
 *
 * Implements the concrete Obsidian {@link Plugin} class:
 * - Registers the custom item view {@link PDFStudioView} under view type `pdf-studio-preview`.
 * - Coordinates left ribbon shortcuts and command palette actions.
 * - Mounts the native configuration tab {@link PDFStudioSettingsTab}.
 * - Manages leaf activation and geometry adjustments in split workspace layouts.
 * - Broadcasts setting mutations to active preview leaves.
 */

import { Plugin, WorkspaceLeaf } from "obsidian";
import type { IPDFStudioPlugin, PDFStudioSettings } from "@/types";
import { DEFAULT_SETTINGS, PDFStudioSettingsTab } from "@/settings";
import { PDFStudioView, PDF_VIEW_TYPE } from "@/view/pdf-view";

/**
 * Obsidian host plugin implementation managing lifecycle, commands, and view leaves.
 */
export default class PDFStudioPlugin
  extends Plugin
  implements IPDFStudioPlugin
{
  /** Active persistent settings instance in memory. */
  settings!: PDFStudioSettings;

  /**
   * Initializes plugin state upon Obsidian workspace loading.
   *
   * Lifecycle Steps:
   * 1. Loads persisted configuration from Obsidian vault data storage.
   * 2. Registers custom {@link PDFStudioView} leaf factory.
   * 3. Mounts ribbon icon for instant preview launching.
   * 4. Registers command palette entries for opening preview and layout adjustments.
   * 5. Registers native settings tab in Obsidian preferences.
   *
   * @returns Promise resolving when all registrations complete.
   */
  async onload(): Promise<void> {
    await this.loadSettings();

    // Register custom view
    this.registerView(
      PDF_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new PDFStudioView(leaf, this),
    );

    // Ribbon icon in left sidebar
    this.addRibbonIcon("file-text", "Open PDF Studio Live Preview", () => {
      void this.activateView();
    });

    // Command palette action: Open Live Preview
    this.addCommand({
      id: "open-pdf-studio-preview",
      name: "Open Live Preview",
      callback: () => {
        void this.activateView();
      },
    });

    // Command palette action: Fit preview to half width
    this.addCommand({
      id: "adjust-pdf-studio-half-width",
      name: "Fit Preview to Half Width (50%)",
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(PDF_VIEW_TYPE);
        for (const leaf of leaves) {
          if (leaf.view instanceof PDFStudioView) {
            leaf.view.adjustToHalfWidth();
            break;
          }
        }
      },
    });

    // Settings tab in Obsidian preferences
    this.addSettingTab(new PDFStudioSettingsTab(this.app, this));
  }

  /**
   * Cleanly tears down plugin resources and detaches active preview leaves upon unload.
   *
   * Guarantees that unmounting or disabling the plugin leaves zero detached DOM artifacts
   * in the active Obsidian workspace.
   *
   * @returns Promise resolving once workspace leaves are detached.
   */
  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(PDF_VIEW_TYPE);
  }

  /**
   * Loads persisted settings from Obsidian storage, merging with defaults.
   *
   * Schema Migration Guarantee:
   * If stored configuration lacks newer keys, {@link DEFAULT_SETTINGS} fills them in safely.
   */
  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  /**
   * Serializes current settings to Obsidian storage and propagates updates to open preview leaves.
   *
   * Triggers an immediate, un-debounced layout re-render on each active {@link PDFStudioView}
   * so adjustments to margins or paper format reflect without delay.
   *
   * @returns Promise resolving upon successful disk save.
   */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // Notify open views to refresh with new dimensions / margins
    const leaves = this.app.workspace.getLeavesOfType(PDF_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof PDFStudioView) {
        void leaf.view.triggerRender(false);
      }
    }
  }

  /**
   * Opens or reveals the PDF Studio preview leaf in the right sidebar or split pane.
   *
   * Workspace Management:
   * - If a preview leaf already exists, reveals and focuses it.
   * - If no leaf exists, allocates a new right-side leaf and mounts `PDFStudioView`.
   * - Automatically triggers half-width (50%) layout adjustment for optimal side-by-side editing.
   */
  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(PDF_VIEW_TYPE);

    if (leaves.length > 0 && leaves[0]) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: PDF_VIEW_TYPE,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
      if (leaf.view instanceof PDFStudioView) {
        leaf.view.adjustToHalfWidth();
      }
    }
  }
}
