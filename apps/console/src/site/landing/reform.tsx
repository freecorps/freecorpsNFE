// The tax reform timeline (EC 132/2023, LC 214/2025), shown at the end of the
// coverage section. One axis from 2026 to 2033, one column per year: the
// phases span their years, the bars show what is left of ICMS and ISS, and
// "hoje" is placed from the date the page is rendered. The axis is decoration
// (aria-hidden); the phase list carries the same facts as text, and is all
// that shows on phones.

const FIRST_YEAR = 2026;
const MONTHS = 8 * 12; // January 2026 to December 2033

// ICMS and ISS as a share of their current rates, per year (EC 132/2023):
// untouched until 2028, nine, eight, seven and six tenths from 2029 to 2032,
// extinct in 2033.
const years = [
  { year: "2026", value: 100, label: "100%" },
  { year: "2027", value: 100 },
  { year: "2028", value: 100 },
  { year: "2029", value: 90, label: "90%" },
  { year: "2030", value: 80, label: "80%" },
  { year: "2031", value: 70, label: "70%" },
  { year: "2032", value: 60, label: "60%" },
  { year: "2033", value: 0, label: "0% · extintos" },
];

// start and end are month offsets from January 2026 (end exclusive).
const phases = [
  {
    id: "test",
    start: 0,
    end: 12,
    range: "2026",
    title: "Ano de teste",
    text: "CBS 0,9% e IBS 0,1% destacados na nota.",
  },
  {
    id: "cbs",
    start: 12,
    end: 36,
    range: "2027 e 2028",
    title: "CBS em vigor",
    text: "PIS e Cofins extintos. IPI zerado, exceto na Zona Franca de Manaus.",
  },
  {
    id: "shift",
    start: 36,
    end: 84,
    range: "2029 a 2032",
    title: "Transição",
    text: "ICMS e ISS caem um décimo por ano enquanto o IBS sobe. Até 2032, a nota leva os dois sistemas.",
  },
  {
    id: "final",
    start: 84,
    end: MONTHS,
    range: "2033",
    title: "Modelo final",
    text: "IBS e CBS integrais. ICMS e ISS extintos.",
  },
];

const monthNames = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

/** Where "hoje" falls on the axis, in Brasília time. The CSP forbids inline
 *  styles, so the position travels as two classes (year and month offset)
 *  that sections/reform.css turns into a percentage. Before 2026 the marker
 *  is hidden; after 2033 it rests at the end of the axis. */
export function reformNow(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value) - 1;
  const offset = (year - FIRST_YEAR) * 12 + month;
  const before = offset < 0;
  const at = Math.min(Math.max(offset, 0), MONTHS - 1);
  return {
    before,
    at,
    label: `hoje · ${monthNames[month]} ${year}`,
    phase: before ? undefined : phases.find((p) => at >= p.start && at < p.end)?.id,
    className: [
      `reform-y${Math.floor(at / 12)}`,
      `reform-m${at % 12}`,
      before ? "reform-before" : "",
      at >= 78 ? "reform-flip" : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export function Reform({ date = new Date() }: { date?: Date }) {
  const now = reformNow(date);
  const nowYear = now.before ? -1 : Math.floor(now.at / 12);
  return (
    <div className={`reform ${now.className}`}>
      <header className="reform-head">
        <div>
          <p className="reform-law">EC 132/2023 · LC 214/2025</p>
          <h3>A Reforma Tributária, ano a ano</h3>
        </div>
        <p>
          Oito anos de transição, de 2026 a 2033. Acompanhar cada etapa na nota está em construção;
          a plataforma ainda não calcula tributos.
        </p>
      </header>

      <div className="reform-line">
        <div className="reform-axis" aria-hidden="true">
          <span className="reform-caption">ICMS e ISS: quanto resta da alíquota atual</span>
          {years.map((y, i) => (
            <span
              key={y.year}
              className={`reform-year reform-v${y.value}${i === nowYear ? " is-now" : ""}`}
            >
              <span className="reform-bar" />
              {y.label ? <span className="reform-value">{y.label}</span> : null}
              <span className="reform-tick">{y.year}</span>
            </span>
          ))}
          <span className="reform-rule" />
          <span className="reform-elapsed" />
          <span className="reform-now">
            <span className="reform-now-label">{now.label}</span>
          </span>
        </div>

        <ol className="reform-phases">
          {phases.map((phase) => {
            const live = phase.id === now.phase;
            return (
              <li
                key={phase.id}
                className={`reform-phase reform-${phase.id}${live ? " is-now" : ""}`}
              >
                <span className="reform-range">{phase.range}</span>
                <strong>
                  {phase.title}
                  {live ? <span className="reform-live">agora</span> : null}
                </strong>
                <span className="reform-text">{phase.text}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <dl className="reform-notes">
        <div>
          <dt>Cálculo tributário</dt>
          <dd>Fora da oferta atual: a plataforma não calcula IBS, CBS, ICMS nem ISS.</dd>
        </div>
        <div>
          <dt>Grupo IBSCBS na DPS</dt>
          <dd>
            Na emissão do sandbox pelo canal de Campinas, CST e cClassTrib vêm do cadastro de cada
            atividade, sem valores calculados.
          </dd>
        </div>
      </dl>
    </div>
  );
}
