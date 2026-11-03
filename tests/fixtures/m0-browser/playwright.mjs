// A permissive page: every element exists, is focusable and fits the viewport. No heading is
// counted, so the offline sign-in never reaches a confirmed session.
//
// With M0_FAKE_SHELL=1 the sign-in goes through, as the console behaves after a load: the shell
// renders a moment after `goto`, a heading appears only then, and on a phone the sidebar (with the
// account menu) stays hidden until the "Abrir menu" button, visible only once the shell rendered,
// opens the drawer. Any load closes the drawer again. The session ends when "Sair" is chosen.
import { appendFileSync } from "node:fs";

const shellMode = process.env.M0_FAKE_SHELL === "1";
const shellDelayMs = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const session = (globalThis.m0FakeSession ??= { role: null, signedOut: false });

class Locator {
  constructor(description = {}, page) {
    this.description = description;
    this.page = page;
  }
  getByRole(role, options = {}) {
    return new Locator({ role, name: String(options.name) }, this.page ?? this);
  }
  getByLabel(label) {
    return new Locator({ label }, this.page ?? this);
  }
  getByText(text) {
    return new Locator({ text }, this.page ?? this);
  }
  locator(selector) {
    return new Locator({ selector }, this.page ?? this);
  }
  get isDrawerButton() {
    return this.description.role === "button" && this.description.name === "Abrir menu";
  }
  get isAccountMenu() {
    return this.description.role === "button" && this.description.name === "/menu da conta/";
  }
  async waitFor() {
    const page = this.page;
    if (!shellMode || !page) return;
    if (this.description.role === "heading") await page.shellRendered();
    if (this.isAccountMenu && page.mobile && !page.drawer)
      throw new Error("Timeout: the account menu stays hidden in the closed drawer");
  }
  async isVisible() {
    if (!shellMode || !this.isDrawerButton) return false;
    return this.page.mobile && this.page.rendered();
  }
  async boundingBox() {
    return { x: 0, y: 0, width: 200, height: 48 };
  }
  async count() {
    return this.description.role === "heading" ? 0 : 1;
  }
  async evaluate() {
    // `keyboardTo` asks whether the element took the focus: it does, on the first Tab.
    if (this.page) this.page.focused = this;
    return true;
  }
  async fill(value) {
    if (this.description.label === "E-mail") {
      session.role = /^([a-z]+)-/.exec(value)?.[1] ?? null;
      session.signedOut = false;
    }
    appendFileSync(
      process.env.M0_FAKE_FILLS,
      `${JSON.stringify({ ...this.description, value })}\n`,
    );
  }
  async press() {}
  async click() {}
}

class Page extends Locator {
  focused = null;
  drawer = false;
  menu = false;
  // The shell's render is the timer's own effect, never a clock comparison: a timer may wake a
  // millisecond before `Date.now()` reaches its deadline, and the heading would then wait out a
  // shell that `rendered()` still denies (#634).
  shown = true;
  shell = Promise.resolve();
  constructor(viewport) {
    super();
    this.mobile = (viewport?.width ?? 1440) < 961;
    this.keyboard = { press: async (key) => this.press(key) };
  }
  rendered() {
    return this.shown;
  }
  async shellRendered() {
    await this.shell;
  }
  async press(key) {
    if (!shellMode) return;
    if (key === "Enter" && this.focused?.isDrawerButton && this.rendered()) this.drawer = true;
    else if (key === "ArrowUp" && this.focused?.isAccountMenu) this.menu = true;
    else if (key === "Enter" && this.menu) {
      this.menu = false;
      session.signedOut = true;
    }
  }
  on() {}
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async goto() {
    const shell = (this.shell = sleep(shellDelayMs).then(() => {
      if (this.shell === shell) this.shown = true;
    }));
    this.shown = false;
    this.drawer = false;
    this.menu = false;
    this.focused = null;
    return { status: () => 200, headers: () => ({ "x-robots-tag": "noindex" }) };
  }
  async evaluate(script) {
    if (shellMode && String(script).includes("convex_jwt"))
      return session.role ? `fake-jwt:${session.role}` : null;
    return true;
  }
  async reload() {}
  async route() {}
  async waitForURL() {}
  async waitForFunction() {}
  async waitForResponse() {
    return { status: () => 200, url: () => "" };
  }
  async screenshot() {}
}

const browser = {
  version: () => "offline",
  async newContext({ viewport } = {}) {
    return {
      newPage: async () => new Page(viewport),
      route: async () => {},
      close: async () => {},
    };
  },
  async close() {},
};

export const chromium = { launch: async () => browser };
