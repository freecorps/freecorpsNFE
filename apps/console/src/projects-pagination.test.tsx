// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { More } from "./load-more";

afterEach(cleanup);

it("loads another page inside a grant form without saving the selected grant", () => {
  const save = vi.fn(),
    loadMore = vi.fn();
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <More status="CanLoadMore" loadMore={loadMore} />
      <button type="submit">Salvar concessão</button>
    </form>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
  expect(loadMore).toHaveBeenCalledExactlyOnceWith(20);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Salvar concessão" }));
  expect(save).toHaveBeenCalledOnce();
});
