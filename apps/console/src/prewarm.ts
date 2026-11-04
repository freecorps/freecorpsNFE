import { useEffect } from "react";
import { useConvex } from "convex/react";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { convexToJson, type Value } from "convex/values";
/**
 * Asks for a query a component below will subscribe to once another answer arrives (the list
 * under the company the server is still confirming), so both answers travel together. The
 * Convex client keeps the subscription for a few seconds (`prewarmQuery`); the component then
 * subscribes with the same arguments and finds the answer. Nothing is rendered from it: an error
 * (a company the member cannot open) stays in the client, and the screen shows what the
 * confirming query says. The server checks access on every query as always.
 */
export function usePrewarm<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
) {
  const convex = useConvex();
  const key = args === "skip" ? null : JSON.stringify(convexToJson(args as Value));
  useEffect(() => {
    if (args !== "skip") convex.prewarmQuery({ query, args });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The serialized arguments identify the query; a new object with the same ones is the same.
  }, [convex, query, key]);
}
