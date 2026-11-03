import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";

// Runs only while prerendering (ssr: false). Every page waits for all content,
// so the HTML is complete without JavaScript and holds no streamed fragments.
// Any render error rejects: the build stops instead of shipping a page that
// React would finish in the browser, such as an MDX component citing an
// operation that left the contract.
export default function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
) {
  return new Promise<Response>((resolve, reject) => {
    let failed: unknown = null;
    const { pipe } = renderToPipeableStream(<ServerRouter context={context} url={request.url} />, {
      // React moves large Suspense boundaries out of place and back with an
      // inline script; without JavaScript they would stay hidden.
      progressiveChunkSize: Number.POSITIVE_INFINITY,
      onAllReady() {
        if (failed) return reject(failed);
        const body = new PassThrough();
        headers.set("Content-Type", "text/html; charset=utf-8");
        pipe(body);
        resolve(new Response(createReadableStreamFromReadable(body), { headers, status }));
      },
      onShellError: reject,
      onError(error: unknown) {
        failed = error;
      },
    });
  });
}
