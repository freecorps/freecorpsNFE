import { vi } from "vite-plus/test";

/**
 * The console's tests answer the Convex hooks by mocking `convex/react`. The organization's
 * query cache (`apps/console/src/convex-query.tsx`) comes from `convex-helpers`, which reads
 * `convex/react` outside the test's module graph; here its hooks forward to the ones the test
 * file answers, and the cache only renders its children. `query-cache.test.tsx` unmocks it to
 * prove the real cache.
 */
vi.mock("../../apps/console/src/convex-query", async (original) => {
  // The test's `convex/react` first: loading the actual cache also loads `convex/react`, and
  // asking for both at once sometimes handed the hooks below the real module, not the test's.
  const react = await import("convex/react");
  const actual = await original<typeof import("../../apps/console/src/convex-query")>();
  const forward = (hook: unknown) => hook as (...args: never[]) => unknown;
  return {
    ...actual,
    OrganizationQueryCache: ({ children }: { children: unknown }) => children,
    // Read on each call: a test that mocks `convex/react` without one of them never calls it.
    useQuery: ((...args: never[]) => forward(react.useQuery)(...args)) as typeof actual.useQuery,
    usePaginatedQuery: ((...args: never[]) =>
      forward(react.usePaginatedQuery)(...args)) as typeof actual.usePaginatedQuery,
  };
});

/**
 * Asking ahead (`prewarm.ts`) renders nothing, and the tests answer the subscriptions themselves.
 * A module of its own: the real one reads `convex/react`, which each test mocks.
 */
vi.mock("../../apps/console/src/prewarm", () => ({ usePrewarm: () => undefined }));
