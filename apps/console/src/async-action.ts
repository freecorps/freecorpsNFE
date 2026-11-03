import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Busy and failure state of a console action (a form submit, a button that calls the server).
 * A failure always frees the busy state and keeps the message for the person to try again. A
 * response that arrives after the component left (another page, another organization: the
 * organization layout remounts its pages by slug and membership version) or after a newer run
 * changes nothing on the screen. Messages and what a success does stay with the caller.
 */
export function useAsyncAction(describe: (error: unknown) => string) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  /**
   * Runs `work` and resolves with the failure message, or an empty string on success. `done`
   * receives the result only while this run is still the current one; `current` lets `work` stop
   * between steps. `quiet` returns the failure without showing it, for a confirmation that shows
   * its own.
   */
  async function run<T>(
    work: (current: () => boolean) => Promise<T>,
    options: { done?: (result: T) => void; quiet?: boolean } = {},
  ) {
    const mine = ++generation.current,
      current = () => mine === generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await work(current);
      if (current()) {
        setBusy(false);
        options.done?.(result);
      }
      return "";
    } catch (failure) {
      const message = describe(failure);
      if (current()) {
        setBusy(false);
        if (!options.quiet) setError(message);
      }
      return message;
    }
  }
  return { busy, error, run, clearError: () => setError("") };
}

/**
 * A secret shown once (API key, webhook signing secret). It belongs only to the form that asked
 * for it while that form is mounted and open: closing it, leaving the page or another
 * organization discards a late response, and a full-page navigation clears it before the browser
 * can keep it in the back-forward cache.
 */
export function useSecretOnce() {
  const [secret, setSecret] = useState<string | null>(null);
  const lifetime = useRef(0),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      lifetime.current++;
      // Clear DOM and state before a full-page navigation can preserve them in bfcache.
      flushSync(() => setSecret(null));
    };
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pagehide", hide);
      mounted.current = false;
      lifetime.current++;
    };
  }, []);
  function discard() {
    lifetime.current++;
    setSecret(null);
  }
  async function receive(work: () => Promise<string>) {
    const generation = ++lifetime.current;
    const value = await work();
    if (mounted.current && generation === lifetime.current) setSecret(value);
  }
  return { secret, discard, receive };
}
