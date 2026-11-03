import defaultMdxComponents from "fumadocs-ui/mdx";
import { Step, Steps } from "fumadocs-ui/components/steps";
import type { MDXComponents } from "mdx/types";
import type { ReactNode } from "react";
import {
  ContractVersion,
  Environments,
  ErrorCodes,
  Op,
  Operations,
  PageRange,
  Tolerance,
  WebhookEvents,
} from "./contract.tsx";

/** A label of the panel's interface, such as a button or a menu: <Ui>Novo destino</Ui>. */
function Ui({ children }: { children: ReactNode }) {
  return <span className="ui">{children}</span>;
}

export const mdxComponents = {
  ...defaultMdxComponents,
  Step,
  Steps,
  ContractVersion,
  Environments,
  ErrorCodes,
  Op,
  Operations,
  PageRange,
  Tolerance,
  Ui,
  WebhookEvents,
} satisfies MDXComponents;

declare global {
  type MDXProvidedComponents = typeof mdxComponents;
}
