import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import rule from "./require-disposable-render.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const tsx = (code: string) => ({ code, filename: "apps/console/src/example.browser.test.tsx" });

new RuleTester().run("require-disposable-render", rule, {
  valid: [
    tsx(`it("x", async () => {
      await using screen = await render(<Tela />);
    });`),
    tsx(`it("x", async () => {
      await using screen = await render(<Tela />, { convex, path: "/app/equipe" });
      {
        await using later = await render(<Tela />, { convex });
      }
    });`),
    // Other renders: React's root and a method of another object.
    tsx(`root.render(<Tela />);`),
    tsx(`view.render();`),
    // A function that only shares the name's prefix.
    tsx(`renderShell(<Tela />);`),
  ],
  invalid: [
    { ...tsx(`render(<Tela />);`), errors: [{ messageId: "render" }] },
    { ...tsx(`await render(<Tela />);`), errors: [{ messageId: "render" }] },
    { ...tsx(`const screen = await render(<Tela />);`), errors: [{ messageId: "render" }] },
    { ...tsx(`let screen = await render(<Tela />);`), errors: [{ messageId: "render" }] },
    // `using` only calls Symbol.dispose, which the screen does not have.
    { ...tsx(`using screen = await render(<Tela />);`), errors: [{ messageId: "render" }] },
    // Without awaiting it, `await using` receives the Promise, which is not disposable.
    { ...tsx(`await using screen = render(<Tela />);`), errors: [{ messageId: "render" }] },
    {
      ...tsx(`await using screen = await Promise.resolve(render(<Tela />));`),
      errors: [{ messageId: "render" }],
    },
    {
      ...tsx(`it("x", async () => {
        const screens = [await render(<A />), await render(<B />)];
      });`),
      errors: [{ messageId: "render" }, { messageId: "render" }],
    },
  ],
});
