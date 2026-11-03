import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/notebook/page";
import type { OpenAPIPageData } from "fumadocs-openapi/server";
import { lazy, Suspense, use } from "react";
import { ContractProvider } from "../components/contract.tsx";
import { HomeFigure } from "../components/home-figure.tsx";
import { mdxComponents } from "../components/mdx.tsx";
import { contractData } from "../lib/contract.server.ts";
import { baseOptions } from "../lib/layout.tsx";
import { source } from "../lib/source.server.ts";
import { docs } from "../lib/source.ts";

// The API reference UI (fumadocs-openapi, Base UI, code samples) is a chunk
// of its own: guide pages never download it. The loader, which runs only
// while prerendering, loads it first, so the HTML holds the whole page
// instead of a suspended fragment that only JavaScript would reveal. In the
// browser the same chunk loads lazily and hydrates that HTML.
type ApiPageComponent = typeof import("../components/api-page.tsx").OpenAPIPage;
let ApiPageLoaded: ApiPageComponent | null = null;
const loadApiPage = () =>
  import("../components/api-page.tsx").then((module) => (ApiPageLoaded = module.OpenAPIPage));
const ApiPageLazy = lazy(() => loadApiPage().then((component) => ({ default: component })));
function OpenAPIPage(props: Parameters<ApiPageComponent>[0]) {
  return ApiPageLoaded ? <ApiPageLoaded {...props} /> : <ApiPageLazy {...props} />;
}

type LoaderArgs = { params: Record<string, string | undefined> };

// Runs at build time only (ssr: false + prerender): the result is written next
// to each page and read back on client-side navigation.
export async function loader({ params }: LoaderArgs) {
  const slugs = (params["*"] ?? "").split("/").filter(Boolean);
  const page = source.getPage(slugs);
  if (!page) throw new Response("Página não encontrada", { status: 404 });
  const pageTree = await source.serializePageTree(source.getPageTree());
  const head = {
    title: page.data.title ?? "",
    description: page.data.description ?? "",
    pageTree,
  };
  if (page.type === "api") {
    await loadApiPage();
    const data = page.data as OpenAPIPageData;
    const props = data.getOpenAPIPageProps();
    const item = props.operations?.[0];
    const paths = (props.payload.bundled?.paths ?? {}) as Record<
      string,
      Record<string, { operationId?: string }>
    >;
    return {
      ...head,
      type: "openapi" as const,
      path: page.path,
      operationId: (item && paths[item.path]?.[item.method]?.operationId) ?? "",
      toc: data.toc,
      props,
      contract: null,
    };
  }
  return {
    ...head,
    type: "docs" as const,
    path: page.path,
    contract: page.data.contract ? contractData() : null,
  };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

export function meta({ loaderData }: { loaderData?: LoaderData }) {
  if (!loaderData) return [{ title: "Documentação · Freecorps Fiscal" }];
  return [
    { title: `${loaderData.title} · Freecorps Fiscal` },
    { name: "description", content: loaderData.description },
  ];
}

function Guide({ path }: { path: string }) {
  const page = docs.getPage(path);
  if (!page) throw new Error(`Página desconhecida: ${path}`);
  const { toc } = use(page.load());
  const Body = page.body;
  return (
    <DocsPage toc={toc} id="conteudo" tabIndex={-1}>
      {path === "index.mdx" ? (
        <div className="home-head">
          <DocsTitle>{page.title}</DocsTitle>
          <HomeFigure />
        </div>
      ) : (
        <DocsTitle>{page.title}</DocsTitle>
      )}
      <DocsDescription>{page.description}</DocsDescription>
      <DocsBody>
        <Body components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export default function Page({ loaderData }: { loaderData: LoaderData }) {
  const data = useFumadocsLoader(loaderData);
  const base = baseOptions();
  return (
    <DocsLayout {...base} nav={{ ...base.nav, mode: "top" }} tree={data.pageTree}>
      {data.type === "openapi" ? (
        <DocsPage toc={data.toc} id="conteudo" tabIndex={-1} className="api-page">
          <DocsTitle>{data.title}</DocsTitle>
          <p className="operation-id">
            <code>{data.operationId}</code>
          </p>
          <DocsBody>
            <Suspense>
              <OpenAPIPage {...data.props} />
            </Suspense>
          </DocsBody>
        </DocsPage>
      ) : (
        <ContractProvider data={data.contract}>
          <Guide path={data.path} />
        </ContractProvider>
      )}
    </DocsLayout>
  );
}
