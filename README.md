# PDF Studio for Obsidian

> Real-time paginated Markdown preview on virtual sheets (A4, Letter, Legal, A3, A5) with print-faithful typography, intelligent semantic content splitting, and direct vector PDF export.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Obsidian: Desktop](https://img.shields.io/badge/Obsidian-v1.5.0+-purple.svg)](https://obsidian.md)
[![TypeScript: 6.0](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![Vitest: 5.0](https://img.shields.io/badge/Tested%20with-Vitest-yellow.svg)](https://vitest.dev/)

---

## The Problem & The Solution

Traditional Obsidian PDF preview tools often suffer from structural instabilities when handling complex documents with syntax-highlighted code blocks, mathematical expressions, or third-party DOM enhancements:

- **Destructive DOM Recycling:** Dismantling rendered pages (`restoreFromPages`) breaks nested DOM structures created by syntax enhancers, causing measurement loops and page oscillations (e.g. jumping between 5 and 14 pages).
- **Measurement Jitter:** Measuring elements synchronously before fonts and math formulas settle causes incorrect zero-height measurements.
- **Visual Flicker:** Rebuilding the view in-place results in white flashes while typing.
- **Main Thread UI Freezes:** Synchronous layout thrashing and redundant mass-cloning during pagination of large documents lock up the main Obsidian UI thread.
- **Redundant Re-pagination on Tab Switching:** Switching between editor tabs typically destroys and recomputes the entire paginated DOM from scratch, introducing high latency and high CPU overhead.

**PDF Studio** resolves these challenges through a **strict unidirectional, double-buffered, and cooperative pagination pipeline**:

1. **Write-Only Virtual Pages:** Each pagination cycle constructs fresh, ephemeral pages from clean Markdown. Nodes are never recycled or torn down across cycles.
2. **Double-Buffered Atomic Swapping:** Rendering and measurement take place in an off-screen staging container. Virtual sheets are swapped into the viewport atomically, preserving the user's scroll position without flickering.
3. **Event-Driven Stabilization:** An asynchronous stabilization barrier (`waitForDomSettled`) ensures fonts, MathJax formulas, and syntax styles are fully laid out before pagination calculations begin.
4. **Change Detection Gate:** Aborts immediately when text content and page geometry remain unchanged, ensuring 0% CPU consumption during editor idle states.
5. **Time-Sliced Cooperative Pagination:** Paginates complex and massive documents asynchronously without UI freezes, yielding control every frame (`maxFrameBudgetMs = 10` via `waitForNextFrame()`) and supporting responsive cancellation via `shouldCancel`.
6. **Sandboxed Multi-Tab LRU Cache:** Maintains an in-memory LRU preview cache (up to 8 notes) using native `DocumentFragment` detachment for instant (<1 ms, 0% CPU) tab switching, sandboxing `MarkdownRenderer` with ephemeral `Component` instances and preventing race conditions via `renderSeq` and `pendingFilePath` token guards.

---

## Architectural Topography

```mermaid
flowchart TD
    subgraph Input["1. Input & Leaf Coordination"]
        E1["Vault Editor Keystroke"] --> D["200ms Debounce"]
        E2["Active File Switch"] --> G0{"LRU Cache Hit?<br/>mtime & config match"}
        G0 -- "Hit (< 1ms, 0% CPU)" --> SWAP["Twin-Container Atomic Swap<br/>Restore DocumentFragment & Scroll"]
        G0 -- "Miss" --> G1["Change Detection Gate"]
        D --> G1
    end

    subgraph Preprocess["2. Memory Preprocessor"]
        G1 -- "Changes Detected" --> PP["preprocessMarkdown()<br/>Shield code blocks & map \\pagebreak"]
        G1 -- "No Changes" --> IDLE["0% CPU Idle"]
    end

    subgraph Staging["3. Staging & Stabilization"]
        PP --> RENDER["MarkdownRenderer.render() into Isolated Staging<br/>Ephemeral Component Lifecycle Sandbox"]
        RENDER --> STAB["waitForDomSettled()<br/>Font readiness + MutationObserver quiet window"]
    end

    subgraph Pagination["4. Cooperative Time-Sliced Paginator"]
        STAB --> CALC["calculatePageLimits()<br/>Dynamic mm-to-pixel ratio"]
        CALC --> PAG["paginate()<br/>Yields every 10ms via waitForNextFrame()<br/>Guarded by shouldCancel token"]
    end

    subgraph Viewport["5. Viewport Mount & Cache"]
        PAG --> SWAP
        SWAP --> CACHE["Cache into DocumentFragment<br/>LRU capacity max 8 entries"]
        CACHE --> ZOOM["Auto-Fit or Manual Zoom (20%–500%)"]
    end
```

---

## Key Features

- **Standard Paper Formats:** Native support for ISO 216 formats (**A4**, **A3**, **A5**) and ANSI formats (**Letter**, **Legal**).
- **Customizable Margins:** Independent control over all 4 printable gutters (**Top**, **Bottom**, **Left**, **Right**) with boundary validation enforcing a minimum printable content area (at least 20mm width and height), alongside instant presets (**Normal 20mm**, **Compact 10mm**, **Wide 30mm**).
- **Semantic Overflow Splitting:**
  - **Code Blocks:** Bisected strictly along line breaks (`\n`) with minimum thresholds (3 lines head, 2 lines tail) to prevent orphaned code lines.
  - **Tables:** Split cleanly across table row boundaries (`<tr>`), automatically replicating the `<thead>` column headers on continuation sheets while preventing orphaned headers when body rows overflow.
  - **Lists:** Ordered lists (`<ol>`) split between items, preserving continuous numbering via `start="N + 1"`.
  - **Prose & Blockquotes:** Bisected via bounded logarithmic binary search with DOM `Range` probing and backward word-boundary snapping to avoid cutting words in half.
  - **Headings & Lead-ins:** Enforces _keep-with-next_ heuristics to prevent lonely section titles or introductory short paragraphs at the bottom of a page.
- **Double-Buffered Viewport:** Smooth typing experience with zero white flash and persistent scroll tracking.
- **Instant Multi-Tab Switching:** Zero-latency (<1 ms) tab switching with an in-memory LRU cache of up to 8 notes, retaining scroll positions and virtual DOM sheets without disk reads or re-parsing.
- **Time-Sliced 60 FPS Engine:** Cooperative pagination loop yields to the browser every 10 ms, ensuring silky-smooth responsiveness even on 500+ paragraph documents.
- **Direct Vector PDF Export:** Generates clean, print-ready PDF files via Chromium's native `printToPDF` engine without heavy binary dependencies.
- **Floating Quick Options:** In-toolbar popover to switch paper dimensions, margins, and auto-zoom with a single click.

---

## Authoring Directives

PDF Studio supports explicit page break directives on standalone lines in your Markdown notes:

```markdown
# Section One

This content appears on the first virtual page.

\pagebreak

# Section Two

This content starts at the top of the next virtual sheet.
```

### Supported Page Break Syntax

- `\pagebreak` (LaTeX / Pandoc standard delimiter)
- `<!-- pagebreak -->` (Standard HTML comment delimiter)
- `//page` (Concise shorthand directive)

> **Safety Invariant:** Directives located inside fenced code blocks (```` or `~~~`), including nested code fences (e.g. 4+ backtick/tilde documentation blocks enclosing 3-backtick snippets), are strictly shielded and will not trigger a page break.

---

## Installation

### Manual Installation

1. Download the latest release assets (`main.js`, `manifest.json`, `styles.css`) from the [Releases](https://github.com/JuanFerber/obsidian-pdf-studio/releases) page.
2. Create a folder named `pdf-studio` in your vault's plugin directory:
   `<VaultFolder>/.obsidian/plugins/pdf-studio/`
3. Copy the release files into that directory.
4. Reload Obsidian, open **Settings $\rightarrow$ Community Plugins**, and enable **PDF Studio**.

---

## Commands & Usage

| Command                                         | Action                                                                         |
| :---------------------------------------------- | :----------------------------------------------------------------------------- |
| **PDF Studio: Open Live Preview**               | Opens or focuses the paginated preview pane in the right workspace leaf.       |
| **PDF Studio: Fit Preview to Half Width (50%)** | Resizes the preview pane to occupy exactly 50% of the active workspace window. |

### Preview Toolbar Controls

- **Page Navigator:** Navigate directly to any page number or enter a specific sheet index.
- **Format & Margin Popover:** Click the options button (`⚙` / sliders) to select paper sizes and margin presets.
- **Zoom Controls:** Switch between **Auto-Fit** (scales dynamically to leaf width) and **Manual Zoom** (20% to 500%).
- **Export to PDF:** Opens the native save dialog to export the document directly to a vector PDF.
- **Reload Preview:** Forces a fresh re-render bypassing the change detection cache.

---

## Development & Verification

### Prerequisites

- [Node.js](https://nodejs.org/) (version 22 or higher recommended)
- [npm](https://www.npmjs.com/)

### Setup & Compilation

```bash
# Clone the repository
git clone https://github.com/JuanFerber/obsidian-pdf-studio.git
cd obsidian-pdf-studio

# Install dependencies
npm install

# TypeScript strict typecheck
npx tsc --noEmit

# Check & format code style
npm run format:check
npm run format

# Run Vitest unit & integration test suite
npm test
# Build production bundle (build/main.js)
npm run build
# Start live incremental compiler for development
npm run dev
```

---

## Repository Structure

```text
├── .github/
│   └── workflows/           # CI and automated release pipelines
├── manifest.json            # Obsidian plugin metadata and minimum app version
├── package.json             # Build toolchain and development scripts
├── tsconfig.json            # TypeScript compiler options (ES2021 / ES2024 lib)
├── vitest.config.mts        # Vitest test runner configuration
├── esbuild.config.mjs       # Bundling pipeline and local vault sync
├── styles.css               # Virtual sheet layout, paper shadows, and print media rules
├── LICENSE                  # MIT License definition
└── src/
    ├── main.ts              # Plugin lifecycle, command registry, and workspace coordinator
    ├── types.ts             # Paper dimensions (ISO/ANSI), margins, and settings contracts
    ├── settings.ts          # Native Obsidian preferences tab UI
    ├── engine/
    │   ├── dom-utils.ts     # Metric conversion (mm -> px) and DOM stabilization gate
    │   ├── preprocessor.ts  # Markdown authoring directives (\pagebreak) parser
    │   ├── splitter.ts      # Semantic bisection for code blocks, tables, lists, and text
    │   └── paginator.ts     # Unidirectional virtual sheet distribution engine
    ├── view/
    │   ├── pdf-view.ts      # Obsidian ItemView controller, debounce, and twin-container swap
    │   └── options-popover.ts # Floating toolbar selector for page formats and margins
    ├── export/
    │   └── pdf-export.ts    # Headless Chromium vector PDF export pipeline
    └── tests/
        ├── __mocks__/
        │   └── obsidian.ts  # Runtime mocks for Obsidian API classes and DOM helpers
        ├── paginator.test.ts # Time-slicing, DOM transfer, and metric fallback tests
        ├── pdf-view-cache.test.ts # Multi-tab LRU cache, race shielding, and sandboxing tests
        ├── preprocessor.test.ts # Directive translation and code block shielding tests
        └── splitter.test.ts # Bisection unit tests (tables, lists, code fences, prose)
```

---

## Contributing & Governance

- **Commit Messages:** Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`).
- **Versioning:** Strictly governed by [Semantic Versioning (SemVer 2.0.0)](https://semver.org/).
- **Testing:** All pull requests must pass the complete test suite (`npm test`) with 0 failures before review.

---

## License

This project is licensed under the [MIT License](LICENSE).
