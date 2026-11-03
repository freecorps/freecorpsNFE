// Stand-in for react-style-singleton (vite.config.ts aliases it here). Radix
// dialogs lock page scroll by injecting a <style> element whose content changes
// with the scrollbar width, so no CSP hash can allow it and the browser would
// refuse it on every open. The same rules live in app.css, keyed on the
// data-scroll-locked attribute that react-remove-scroll-bar still sets.
export const styleSingleton = () => () => null;
export const styleHookSingleton = () => () => undefined;
export const stylesheetSingleton = () => ({ add: () => undefined, remove: () => undefined });
