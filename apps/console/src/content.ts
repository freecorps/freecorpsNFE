import { useAction } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import { useQuery } from "./convex-query";

/** `cacheKey`: the arguments and token the answer belongs to; an error only stands for its own. */
type State<T> = { key: string; cacheKey: string } & ({ value: T } | { error: unknown });

/**
 * Answers already read, by arguments and token. The token is the hash of the server's selection
 * under the current identity, so an entry only answers while the server still selects exactly
 * that content for this caller; a caller without access never gets a token. In memory only.
 */
const answers = new Map<string, unknown>();
const MAX_ANSWERS = 64;
function remember(key: string, value: unknown) {
  answers.delete(key);
  answers.set(key, value);
  while (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value!);
}

/**
 * A version's content in the console (ADR 0010, B6). A query cannot read the blob, so `token` is a
 * reactive query that changes with access, the version and the page, and `read` is the action
 * that reads and renders the same selection. The action runs again whenever the token changes;
 * meanwhile the last answer for the same arguments stays on screen, as a subscription would.
 *
 * Like `useQuery`: `undefined` while loading, and an error is thrown to the error boundary.
 */
export function useContent<Read extends FunctionReference<"action">>(
  token: FunctionReference<"query", "public", FunctionArgs<Read>, string>,
  read: Read,
  args: FunctionArgs<Read> | "skip",
): FunctionReturnType<Read> | undefined {
  const current = useQuery(token, args);
  const run = useAction(read);
  const key = args === "skip" ? null : JSON.stringify(args);
  const cacheKey = key !== null && current !== undefined ? `${key}|${current}` : null;
  const [state, setState] = useState<State<FunctionReturnType<Read>>>();
  useEffect(() => {
    if (cacheKey === null || key === null || answers.has(cacheKey)) return;
    let live = true;
    run(JSON.parse(key) as FunctionArgs<Read>).then(
      (value) => {
        remember(cacheKey, value);
        if (live) setState({ key, cacheKey, value });
      },
      (error: unknown) => {
        if (live) setState({ key, cacheKey, error });
      },
    );
    return () => {
      live = false;
    };
  }, [cacheKey, key, run]);
  if (cacheKey !== null && answers.has(cacheKey))
    return answers.get(cacheKey) as FunctionReturnType<Read>;
  if (!state || state.key !== key) return undefined;
  // A failure of an earlier token never stands for the new one: the effect reads it again.
  if ("error" in state) {
    if (state.cacheKey !== cacheKey) return undefined;
    throw state.error;
  }
  return state.value;
}
