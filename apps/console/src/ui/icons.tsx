import type { ReactNode } from "react";

/**
 * Ícones de traço do console, desenhados aqui (16 px, traço de 1,5). São decorativos: o texto
 * ao lado nomeia a ação, por isso `aria-hidden`. Sem biblioteca de ícones no console.
 */
const paths = {
  home: <path d="M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5h-3v-4h-4v4H3a.5.5 0 0 1-.5-.5Z" />,
  document: (
    <>
      <path d="M4 1.75h5L12.25 5v8.75a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5V2.25a.5.5 0 0 1 .5-.5Z" />
      <path d="M8.75 1.75V5.25h3.5M5.75 8.25h4.5M5.75 10.75h3" />
    </>
  ),
  receipt: (
    <>
      <path d="M3.5 1.75h9v12.5l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1Z" />
      <path d="M5.75 5.25h4.5M5.75 8h4.5" />
    </>
  ),
  upload: (
    <path d="M8 10.5V2.25M4.75 5.5 8 2.25l3.25 3.25M2.75 10v3a.75.75 0 0 0 .75.75h9a.75.75 0 0 0 .75-.75v-3" />
  ),
  download: (
    <path d="M8 2.25v8.25M4.75 7.25 8 10.5l3.25-3.25M2.75 10v3a.75.75 0 0 0 .75.75h9a.75.75 0 0 0 .75-.75v-3" />
  ),
  building: (
    <>
      <path d="M2.75 14.25V2.75a1 1 0 0 1 1-1h5.5a1 1 0 0 1 1 1v11.5M10.25 6.25h2a1 1 0 0 1 1 1v7M1.75 14.25h12.5" />
      <path d="M5.25 4.75h2.5M5.25 7.5h2.5M5.25 10.25h2.5" />
    </>
  ),
  book: (
    <>
      <path d="M2.75 3.25a1.5 1.5 0 0 1 1.5-1.5h8.5v10.5h-8.5a1.5 1.5 0 0 0-1.5 1.5Z" />
      <path d="M2.75 13.75a1.5 1.5 0 0 1 1.5-1.5h8.5v2h-8.5a1.5 1.5 0 0 1-1.5-1.5" />
    </>
  ),
  code: <path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5M9 2.75 7 13.25" />,
  users: (
    <>
      <circle cx="6" cy="5.25" r="2.5" />
      <path d="M1.75 13.5c.4-2.4 2.1-3.75 4.25-3.75s3.85 1.35 4.25 3.75M10.5 2.9a2.5 2.5 0 0 1 0 4.7M12 10c1.2.5 2 1.6 2.25 3.5" />
    </>
  ),
  gauge: (
    <>
      <path d="M2.25 11.5a6 6 0 1 1 11.5 0" />
      <path d="M8 9.25 10.75 5.5" />
      <circle cx="8" cy="10" r="1" />
    </>
  ),
  lifebuoy: (
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.5" />
      <path d="m3.75 3.75 2.5 2.5M9.75 9.75l2.5 2.5M12.25 3.75l-2.5 2.5M6.25 9.75l-2.5 2.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.05 1.05M4.65 11.35 3.6 12.4M12.4 12.4l-1.05-1.05M4.65 4.65 3.6 3.6" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.25 3.25" />
    </>
  ),
  chevronsUpDown: <path d="m5 6 3-3 3 3M5 10l3 3 3-3" />,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  arrowRight: <path d="M3 8h10M9 4l4 4-4 4" />,
  arrowLeft: <path d="M13 8H3M7 4 3 8l4 4" />,
  check: <path d="m3 8.5 3 3 7-7" />,
  plus: <path d="M8 3v10M3 8h10" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.25M8 13.25v1.25M14.5 8h-1.25M2.75 8H1.5M12.6 3.4l-.9.9M4.3 11.7l-.9.9M12.6 12.6l-.9-.9M4.3 4.3l-.9-.9" />
    </>
  ),
  moon: <path d="M13.25 9.75A5.5 5.5 0 0 1 6.25 2.75a5.5 5.5 0 1 0 7 7Z" />,
  monitor: (
    <>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1" />
      <path d="M5.5 14h5M8 11v3" />
    </>
  ),
  logout: (
    <path d="M6 2.75H3.5a.75.75 0 0 0-.75.75v9a.75.75 0 0 0 .75.75H6M10.25 11 13.25 8l-3-3M13 8H6.25" />
  ),
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  copy: (
    <>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25" />
      <path d="M10.75 5.25V3.5a1.25 1.25 0 0 0-1.25-1.25h-6A1.25 1.25 0 0 0 2.25 3.5v6a1.25 1.25 0 0 0 1.25 1.25h1.75" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v3.75M8 5h.01" />
    </>
  ),
  warning: (
    <>
      <path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.75a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5Z" />
      <path d="M8 6.25v3M8 11.5h.01" />
    </>
  ),
  danger: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75M8 11h.01" />
    </>
  ),
  success: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.25 8.25 1.9 1.9 3.6-3.9" />
    </>
  ),
  inbox: (
    <>
      <path d="M1.75 9.25 3.6 3.2a1 1 0 0 1 .96-.7h6.88a1 1 0 0 1 .96.7l1.85 6.05v3.5a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75Z" />
      <path d="M1.75 9.25h3.5l1 1.5h3.5l1-1.5h3.5" />
    </>
  ),
  shield: (
    <>
      <path d="M8 1.75 13.25 3.5v4.25c0 3-2.2 5.3-5.25 6.5-3.05-1.2-5.25-3.5-5.25-6.5V3.5Z" />
      <path d="m5.75 8 1.6 1.6 2.9-3.1" />
    </>
  ),
  layers: (
    <>
      <path d="m8 1.75 6.25 3.25L8 8.25 1.75 5Z" />
      <path d="m1.75 8 6.25 3.25L14.25 8M1.75 11 8 14.25 14.25 11" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `ui-icon ${className}` : "ui-icon"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
