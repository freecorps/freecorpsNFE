import { useEffect, useRef } from "react";
import { Icon } from "./ui/icons";

export const describedBy = (id: string, error?: string, help?: unknown) =>
  [help ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;

/**
 * Props for the control of a field (`FormField` of `ui/form.tsx`): invalid state and the texts
 * that describe it.
 */
export const controlProps = (id: string, error?: string, help?: unknown) => ({
  id,
  "aria-invalid": error ? (true as const) : undefined,
  "aria-describedby": describedBy(id, error, help),
});

export type FieldErrors = Record<string, string>;

/** Moves the focus to the element and keeps its label in view. */
export function focusField(id: string) {
  const element = document.getElementById(id);
  element?.focus({ preventScroll: true });
  element?.scrollIntoView?.({ block: "center" });
}

/**
 * Error summary at the top of a form: receives the focus when the form is refused and links to
 * each field in form order. `fields` maps element id → label; ids without a label are skipped.
 */
export function ErrorSummary({
  id,
  title,
  errors,
  fields,
  general,
  focusKey,
}: {
  id: string;
  title: string;
  errors: FieldErrors;
  fields: Array<[id: string, label: string]>;
  /** Message without a field, as a server rejection of the whole request. */
  general?: string;
  /** Changes on every refused submit, so a repeated refusal moves the focus again. */
  focusKey: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const listed = fields.filter(([field]) => errors[field]);
  const visible = listed.length > 0 || Boolean(general);
  useEffect(() => {
    if (focusKey && visible) {
      ref.current?.focus({ preventScroll: true });
      ref.current?.scrollIntoView?.({ block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only a new refused submit moves the focus; typing does not.
  }, [focusKey]);
  if (!visible) return null;
  // The danger callout of `ui/`, focusable: it receives the focus on every refused submit.
  return (
    <div
      ref={ref}
      className="ui-callout ui-callout--danger"
      role="alert"
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
    >
      <Icon name="danger" />
      <div className="ui-callout__body">
        <h3 id={`${id}-title`} className="ui-callout__title">
          {title}
        </h3>
        {general && <p className="ui-callout__content">{general}</p>}
        {listed.length > 0 && (
          <ul className="ui-callout__content ui-callout__list">
            {listed.map(([field, label]) => (
              <li key={field}>
                <a
                  className="ui-link"
                  href={`#${field}`}
                  onClick={(event) => {
                    event.preventDefault();
                    focusField(field);
                  }}
                >
                  {label}: {errors[field]}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
