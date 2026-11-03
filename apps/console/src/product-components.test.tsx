// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  DOWNLOAD_TICKET_TIMEOUT,
  DownloadFeedback,
  originLabel,
  useTicketDownload,
} from "./product-components";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Harness({ ticket }: { ticket: () => Promise<{ token: string }> }) {
  const download = useTicketDownload();
  const start = () => void download.start(ticket, { name: "danfse.pdf", label: "PDF" });
  return (
    <>
      <button disabled={download.busy} onClick={start}>
        Baixar PDF
      </button>
      <DownloadFeedback state={download.state} onRetry={start} />
    </>
  );
}

it("says the download is being prepared and gives up with a retry when the ticket never answers", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const ticket = vi.fn(() => new Promise<{ token: string }>(() => {}));
  render(<Harness ticket={ticket} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Baixar PDF" }));
  });
  expect(screen.getByRole("status").textContent).toBe("Preparando o download…");
  expect((screen.getByRole("button", { name: "Baixar PDF" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => {
    vi.advanceTimersByTime(DOWNLOAD_TICKET_TIMEOUT + 10);
  });
  expect(screen.getByRole("alert").textContent).toMatch(/A preparação do PDF não respondeu/);
  expect((screen.getByRole("button", { name: "Baixar PDF" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
  });
  expect(ticket).toHaveBeenCalledTimes(2);
});

it("names the origin of a record", () => {
  expect(originLabel({ kind: "console", integration: null })).toBe("Console");
  expect(originLabel({ kind: "integration", integration: "ERP" })).toBe("Integração ERP");
  expect(originLabel({ kind: "integration", integration: null })).toBe("Integração");
});
