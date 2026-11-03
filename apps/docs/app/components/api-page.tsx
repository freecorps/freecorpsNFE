import { createCodeUsageGeneratorRegistry } from "fumadocs-openapi/requests/generators";
import { curl } from "fumadocs-openapi/requests/generators/curl";
import { javascript } from "fumadocs-openapi/requests/generators/javascript";
import { createOpenAPIPage } from "fumadocs-openapi/ui";
import { codeClasses, codeTheme } from "../lib/code-theme.ts";

// Examples in curl and fetch, the two the guides use.
const codeUsages = createCodeUsageGeneratorRegistry();
codeUsages.add("curl", curl);
codeUsages.add("js", javascript);

// Reference pages are read only: no playground. Requests from the docs origin
// to the API would need connect-src for it, and an API key typed into a docs
// page is not something to encourage.
export const OpenAPIPage = createOpenAPIPage({
  playground: { enabled: false },
  codeUsages,
  shikiOptions: {
    themes: { light: codeTheme, dark: codeTheme },
    defaultColor: "dark",
    transformers: [codeClasses],
  },
});
