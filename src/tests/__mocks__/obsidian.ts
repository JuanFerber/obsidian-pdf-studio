/**
 * Test mock for the runtime "obsidian" module.
 */

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (!HTMLElement.prototype.createDiv) {
  HTMLElement.prototype.createDiv = function (
    o?: string | { cls?: string },
  ): HTMLDivElement {
    const el = document.createElement("div");
    if (typeof o === "string") {
      el.className = o;
    } else if (o?.cls) {
      el.className = o.cls;
    }
    this.appendChild(el);
    return el;
  };
}

if (!HTMLElement.prototype.createSpan) {
  HTMLElement.prototype.createSpan = function (
    o?: string | { cls?: string; text?: string },
  ): HTMLSpanElement {
    const el = document.createElement("span");
    if (typeof o === "string") {
      el.className = o;
    } else if (o) {
      if (o.cls) el.className = o.cls;
      if (o.text) el.textContent = o.text;
    }
    this.appendChild(el);
    return el;
  };
}

if (!HTMLElement.prototype.createEl) {
  HTMLElement.prototype.createEl = function <
    K extends keyof HTMLElementTagNameMap,
  >(
    tag: K,
    o?: { cls?: string; type?: string; text?: string },
  ): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (o) {
      if (o.cls) el.className = o.cls;
      if (o.type && "type" in el) {
        const withType = el as unknown as { type: string };
        withType.type = o.type;
      }
      if (o.text) el.textContent = o.text;
    }
    this.appendChild(el);
    return el;
  };
}

if (!HTMLElement.prototype.empty) {
  HTMLElement.prototype.empty = function (): void {
    while (this.firstChild) {
      this.removeChild(this.firstChild);
    }
  };
}

if (!HTMLElement.prototype.setText) {
  HTMLElement.prototype.setText = function (val: string): void {
    this.textContent = val;
  };
}

export class Component {
  public children: Component[] = [];
  addChild<T extends Component>(component: T): T {
    this.children.push(component);
    return component;
  }
  removeChild<T extends Component>(component: T): T {
    const idx = this.children.indexOf(component);
    if (idx !== -1) {
      this.children.splice(idx, 1);
    }
    return component;
  }
  load(): void {}
  unload(): void {
    for (const child of this.children) {
      child.unload();
    }
    this.children = [];
  }
  registerEvent(_event: unknown): void {}
}

export class ItemView extends Component {
  public leaf: unknown;
  public containerEl: HTMLElement;
  constructor(leaf: unknown) {
    super();
    this.leaf = leaf;
    this.containerEl = document.createElement("div");
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
  getState(): Record<string, unknown> {
    return {};
  }
  async setState(
    _state: Record<string, unknown>,
    _result: unknown,
  ): Promise<void> {}
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class Plugin extends Component {
  public app: unknown;
  public manifest: unknown;
  constructor(app: unknown, manifest: unknown) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  async loadData(): Promise<unknown> {
    return {};
  }
  async saveData(_data: unknown): Promise<void> {}
}

export class PluginSettingTab {
  public app: unknown;
  public plugin: unknown;
  public containerEl: HTMLElement;
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }
  display(): void {}
  hide(): void {}
}

interface DropdownComponentMock {
  addOption(value: string, display: string): DropdownComponentMock;
  setValue(value: string): DropdownComponentMock;
  onChange(cb: (value: string) => Promise<void> | void): DropdownComponentMock;
}

interface TextComponentMock {
  setValue(value: string): TextComponentMock;
  onChange(cb: (value: string) => Promise<void> | void): TextComponentMock;
}

interface SliderComponentMock {
  setLimits(min: number, max: number, step: number): SliderComponentMock;
  setValue(value: number): SliderComponentMock;
  onChange(cb: (value: number) => Promise<void> | void): SliderComponentMock;
}

interface ToggleComponentMock {
  setValue(value: boolean): ToggleComponentMock;
  onChange(cb: (value: boolean) => Promise<void> | void): ToggleComponentMock;
}

export class Setting {
  public settingEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv();
  }
  setName(_name: string): this {
    return this;
  }
  setDesc(_desc: string): this {
    return this;
  }
  addDropdown(cb: (dropdown: DropdownComponentMock) => void): this {
    const mock: DropdownComponentMock = {
      addOption() {
        return this;
      },
      setValue() {
        return this;
      },
      onChange() {
        return this;
      },
    };
    cb(mock);
    return this;
  }
  addText(cb: (text: TextComponentMock) => void): this {
    const mock: TextComponentMock = {
      setValue() {
        return this;
      },
      onChange() {
        return this;
      },
    };
    cb(mock);
    return this;
  }
  addSlider(cb: (slider: SliderComponentMock) => void): this {
    const mock: SliderComponentMock = {
      setLimits() {
        return this;
      },
      setValue() {
        return this;
      },
      onChange() {
        return this;
      },
    };
    cb(mock);
    return this;
  }
  addToggle(cb: (toggle: ToggleComponentMock) => void): this {
    const mock: ToggleComponentMock = {
      setValue() {
        return this;
      },
      onChange() {
        return this;
      },
    };
    cb(mock);
    return this;
  }
}

export class Notice {
  public message: string;
  constructor(message: string) {
    this.message = message;
  }
}

export class TFile {
  public path = "";
  public basename = "";
  public extension = "";
  public stat = { mtime: 0, ctime: 0, size: 0 };
}

export class WorkspaceLeaf {
  public view: unknown = null;
  public app: unknown = null;
}

export const MarkdownRenderer = {
  render: async (
    _app: unknown,
    _markdown: string,
    _el: HTMLElement,
    _sourcePath: string,
    _component: Component,
  ): Promise<void> => {},
};

export function setIcon(parent: HTMLElement, iconId: string): void {
  parent.setAttribute("data-icon", iconId);
}
