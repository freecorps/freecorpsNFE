import type { ShikiTransformer, ThemeRegistration } from "shiki";

// Code colours of the docs, in the landing palette: green tinted neutrals and
// phosphor only on keywords. Every colour here needs a class in app.css
// (.tk-<hex>), written by hand: a new colour adds its class there. The
// transformer below swaps Shiki's inline `style` for that class, because the
// CSP (style-src 'self') blocks style attributes.
const ink = {
  text: "#c9d6ce",
  muted: "#98aa9f",
  faint: "#6e8277",
  punctuation: "#7f948a",
  keyword: "#d4f36e",
  string: "#b9d8c4",
  constant: "#efffbe",
  fn: "#e6eee8",
  type: "#9fd4b2",
  property: "#b4c7bb",
  variable: "#cfdcd3",
} as const;

export const codeTheme: ThemeRegistration = {
  name: "freecorps-night",
  type: "dark",
  colors: { "editor.background": "#0b130f", "editor.foreground": ink.text },
  fg: ink.text,
  bg: "#0b130f",
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: ink.faint } },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "keyword.operator.new",
        "keyword.operator.expression",
      ],
      settings: { foreground: ink.keyword },
    },
    {
      scope: ["keyword.operator", "punctuation", "meta.brace"],
      settings: { foreground: ink.punctuation },
    },
    {
      scope: ["string", "string.quoted", "string.template", "markup.inline.raw"],
      settings: { foreground: ink.string },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character",
        "constant.other",
        "support.constant",
      ],
      settings: { foreground: ink.constant },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call",
        "entity.name.command",
      ],
      settings: { foreground: ink.fn },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
      ],
      settings: { foreground: ink.type },
    },
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "meta.object-literal.key",
        "support.type.property-name",
        "entity.name.tag",
        "entity.other.attribute-name",
      ],
      settings: { foreground: ink.property },
    },
    {
      scope: [
        "variable",
        "variable.parameter",
        "variable.other",
        "support.variable",
        "variable.other.readwrite",
      ],
      settings: { foreground: ink.variable },
    },
    {
      scope: ["variable.language", "support.variable.automatic"],
      settings: { foreground: ink.muted },
    },
    { scope: ["markup.heading", "markup.bold"], settings: { foreground: ink.fn } },
  ],
};

const tokenClass = (color: string) => `tk-${color.slice(1).toLowerCase()}`;

// Replaces `style="color:#xxxxxx"` with the matching class and drops the
// colours Shiki puts on <pre>; app.css paints the block.
export const codeClasses: ShikiTransformer = {
  name: "freecorps:token-classes",
  pre(node) {
    delete node.properties.style;
  },
  span(node) {
    const style = node.properties.style;
    if (typeof style !== "string") return;
    delete node.properties.style;
    const color = /color:\s*(#[0-9a-fA-F]{6})/.exec(style)?.[1];
    if (color) this.addClassToHast(node, tokenClass(color));
  },
};
