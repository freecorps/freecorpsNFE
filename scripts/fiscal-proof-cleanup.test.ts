import { expect, it, vi } from "vite-plus/test";
import { shutdownFiscalProof, signOutFiscalProof } from "./lib/fiscal-proof-cleanup.mjs";

it.each(["disable", "pause", "revoke", "all", "none"])(
  "attempts every fiscal shutdown action when %s fails, without exposing error payloads",
  async (failure) => {
    const attempted: string[] = [];
    const action = (name: string) => async () => {
      attempted.push(name);
      if (failure === name || failure === "all") throw new Error("synthetic-sensitive-payload");
    };
    const failures = await shutdownFiscalProof({
      disableTransport: action("disable"),
      pauseCapture: action("pause"),
      revokeCertificate: action("revoke"),
    });
    expect(attempted).toEqual(["disable", "pause", "revoke"]);
    const codes = {
      disable: "TRANSPORT_DISABLE_FAILED",
      pause: "CAPTURE_PAUSE_FAILED",
      revoke: "CERTIFICATE_REVOKE_FAILED",
    };
    expect(failures).toEqual(
      Object.entries(codes)
        .filter(([name]) => failure === name || failure === "all")
        .map(([, code]) => code),
    );
  },
);

it("pause and step cleanup do not require certificate revocation", async () => {
  const pauseCapture = vi.fn(async () => {});
  expect(
    await shutdownFiscalProof({
      disableTransport: async () => {
        throw new Error("unavailable");
      },
      pauseCapture,
      revokeCertificate: undefined,
    }),
  ).toEqual(["TRANSPORT_DISABLE_FAILED"]);
  expect(pauseCapture).toHaveBeenCalledOnce();
});

it("shutdown and logout failures preserve the original command error", async () => {
  const original = new Error("SOURCE_RESULT_UNCERTAIN");
  const unavailable = async () => {
    throw new Error("synthetic-sensitive-payload");
  };
  const run = async () => {
    try {
      try {
        throw original;
      } finally {
        expect(
          await shutdownFiscalProof({
            disableTransport: unavailable,
            pauseCapture: unavailable,
            revokeCertificate: undefined,
          }),
        ).toEqual(["TRANSPORT_DISABLE_FAILED", "CAPTURE_PAUSE_FAILED"]);
      }
    } finally {
      expect(await signOutFiscalProof(unavailable)).toBe("SESSION_SIGN_OUT_FAILED");
    }
  };
  await expect(run()).rejects.toBe(original);
});

it("failed logout reports a fixed warning while retaining a successful result", async () => {
  const run = async () => {
    try {
      return "completed";
    } finally {
      expect(
        await signOutFiscalProof(async () => {
          throw new Error("HTTP_401");
        }),
      ).toBe("SESSION_SIGN_OUT_FAILED");
    }
  };
  await expect(run()).resolves.toBe("completed");
  expect(await signOutFiscalProof(async () => {})).toBeNull();
});
