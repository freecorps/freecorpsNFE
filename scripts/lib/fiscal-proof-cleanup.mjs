/** Attempt every shutdown action and return only fixed codes, never error payloads. */
export async function shutdownFiscalProof({ disableTransport, pauseCapture, revokeCertificate }) {
  const failures = [];
  for (const [code, run] of [
    ["TRANSPORT_DISABLE_FAILED", disableTransport],
    ["CAPTURE_PAUSE_FAILED", pauseCapture],
    ["CERTIFICATE_REVOKE_FAILED", revokeCertificate],
  ]) {
    if (!run) continue;
    try {
      await run();
    } catch {
      failures.push(code);
    }
  }
  return failures;
}

/** A logout failure must remain visible without replacing the command's outcome. */
export async function signOutFiscalProof(signOut) {
  try {
    await signOut();
    return null;
  } catch {
    return "SESSION_SIGN_OUT_FAILED";
  }
}
