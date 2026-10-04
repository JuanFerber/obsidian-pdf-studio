/**
 * @fileoverview User settings management, persistent schema defaults, and Obsidian preferences pane for PDF Studio.
 *
 * Implements the {@link PDFStudioSettingsTab} configuration interface mounted within Obsidian's native
 * settings modal. Bridges user interaction with the plugin's persistent state storage (`data.json`)
 * and coordinates asynchronous settings persistence.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type { IPDFStudioPlugin, PDFStudioSettings, PageFormat } from "@/types";

/**
 * Baseline configuration values loaded on fresh installations or missing schema keys.
 *
 * Establishes conservative publishing baselines:
 * - A4 standard format (210 x 297 mm)
 * - 20 mm symmetrical margins conforming to formal print guidelines
 * - 200 ms debounce delay balancing typing responsiveness against CPU reflow overhead
 * - Auto-fit zoom enabled by default for optimal preview ergonomics
 */
export const DEFAULT_SETTINGS: PDFStudioSettings = {
  pageFormat: "A4",
  margins: {
    top: 20,
    bottom: 20,
    left: 20,
    right: 20,
  },
  debounceDelayMs: 200,
  defaultZoom: 100,
  autoZoom: true,
  openPdfAfterExport: false,
  savedSplitWidth: undefined,
};

/**
 * Obsidian preference pane tab for configuring PDF Studio.
 *
 * Architectural Responsibilities:
 * - Translates human user inputs (sliders, dropdowns, toggles) into validated {@link PDFStudioSettings} records.
 * - Dispatches asynchronous save transactions to Obsidian via {@link IPDFStudioPlugin.saveSettings}.
 * - Guarantees that preference mutations persist across vault restarts without requiring application reloads.
 *
 * UI Lifecycle:
 * - Instantiated during plugin initialization (`onload`).
 * - Mounted dynamically whenever the user navigates to the plugin settings in Obsidian.
 * - Rebuilds form controls upon each {@link display} invocation, ensuring fresh synchronization with current state.
 */
export class PDFStudioSettingsTab extends PluginSettingTab {
  private readonly plugin: IPDFStudioPlugin;

  /**
   * Constructs the settings tab interface.
   *
   * @param app - The current Obsidian application runtime environment.
   * @param plugin - Host plugin instance exposing configuration state and persistence primitives.
   */
  constructor(app: App, plugin: IPDFStudioPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Renders the reactive configuration controls into Obsidian's settings container element.
   *
   * Reconstructs the DOM tree for the settings tab whenever navigated to:
   * 1. Purges stale DOM nodes from `containerEl`.
   * 2. Renders section headers and individual preference inputs.
   * 3. Attaches debounced change listeners bound to {@link IPDFStudioPlugin.saveSettings}.
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "PDF Studio - Settings" });

    // Page format selector
    new Setting(containerEl)
      .setName("Page Format")
      .setDesc(
        "Select the target physical paper format for live preview and PDF export.",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("A4", "A4 (210 x 297 mm)")
          .addOption("Letter", "Letter (8.5 x 11 in)")
          .addOption("Legal", "Legal (8.5 x 14 in)")
          .addOption("A3", "A3 (297 x 420 mm)")
          .addOption("A5", "A5 (148 x 210 mm)")
          .setValue(this.plugin.settings.pageFormat)
          .onChange(async (value) => {
            this.plugin.settings.pageFormat = value as PageFormat;
            await this.plugin.saveSettings();
          });
      });

    // Margin Top
    new Setting(containerEl)
      .setName("Margin Top (mm)")
      .setDesc("Top printable margin clearance in physical millimeters.")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.margins.top))
          .onChange(async (value) => {
            const num = Number(value);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.margins.top = num;
              await this.plugin.saveSettings();
            }
          });
      });

    // Margin Bottom
    new Setting(containerEl)
      .setName("Margin Bottom (mm)")
      .setDesc(
        "Bottom printable margin clearance in physical millimeters (overflow threshold).",
      )
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.margins.bottom))
          .onChange(async (value) => {
            const num = Number(value);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.margins.bottom = num;
              await this.plugin.saveSettings();
            }
          });
      });

    // Debounce delay
    new Setting(containerEl)
      .setName("Debounce Delay (ms)")
      .setDesc(
        "Waiting time in milliseconds after typing stops before triggering a layout re-render (100–1000 ms).",
      )
      .addSlider((slider) => {
        slider
          .setLimits(100, 1000, 50)
          .setValue(this.plugin.settings.debounceDelayMs)
          .onChange(async (value) => {
            this.plugin.settings.debounceDelayMs = value;
            await this.plugin.saveSettings();
          });
      });

    // Open PDF after export
    new Setting(containerEl)
      .setName("Open PDF after Export")
      .setDesc(
        "Automatically launch the generated PDF in the operating system's default viewer upon export completion.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.openPdfAfterExport)
          .onChange(async (value) => {
            this.plugin.settings.openPdfAfterExport = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
