import { renderToStaticMarkup } from "react-dom/server";
import { HomePage } from "./landing/home.tsx";

// Static HTML for the landing. The console build runs this once; the dev
// server runs it per request. Nothing here touches the browser. The guides
// under /docs are a separate app (apps/docs), copied in by site-plugin.ts.
export const landing = () => renderToStaticMarkup(<HomePage />);
