import { PLATFORM_PLANS } from "../../../../../platform/convex/lib/planCatalog";

// Plans, read from the catalog the server enforces (planCatalog.ts), so the
// page never shows a price or quota the platform does not have. The catalog is
// still switched off (docs/plataforma/PLATFORM-PLAN-PROPOSAL.md): the copy says
// so, and support response times stay out until they are measured.

const integer = new Intl.NumberFormat("pt-BR");
/**
 * Integer cents as BRL through their decimal digits, never floating point (AGENTS.md, §3).
 * Centavos are kept; only a whole price drops its ",00". Not `formatBRL`: format.ts
 * re-exports @freecorps/contracts, which vite.config.ts cannot load when it renders the page.
 */
const reais = (cents: number) => {
  const digits = String(cents).padStart(3, "0");
  const whole = integer.format(Number(digits.slice(0, -2)));
  const centavos = digits.slice(-2);
  return `R$ ${whole}${centavos === "00" ? "" : `,${centavos}`}`;
};

const { free, intermediate, large } = PLATFORM_PLANS;

type Column = {
  id: string;
  name: string;
  price: string;
  cadence: string;
  annual: string;
  volume: string;
  companies: number;
  members: number;
  projects: number;
  concurrency: number;
  support: string;
};

const columns: Column[] = [
  {
    id: "gratuito",
    name: free.name,
    price: reais(free.monthlyCents),
    cadence: "para sempre",
    annual: "Sem cartão e sem vencimento",
    // In Production the free plan caps new notes, imports and captures together
    // (ADR 0010, decision 10), so its imports are that cap with captures counted in.
    volume: `${integer.format(free.limits.notes)}, somando as capturas da empresa`,
    companies: free.capacity.companies,
    members: free.capacity.members,
    projects: free.capacity.projects,
    concurrency: free.concurrency,
    support: "Documentação",
  },
  {
    id: "intermediario",
    name: intermediate.name,
    price: reais(intermediate.monthlyCents),
    cadence: "por mês",
    annual: `ou ${reais(intermediate.annualCents)} por ano`,
    volume: integer.format(intermediate.limits.imports),
    companies: intermediate.capacity.companies,
    members: intermediate.capacity.members,
    projects: intermediate.capacity.projects,
    concurrency: intermediate.concurrency,
    support: "E-mail",
  },
  {
    id: "grande",
    name: large.name,
    price: reais(large.monthlyCents),
    cadence: "por mês",
    annual: `ou ${reais(large.annualCents)} por ano`,
    volume: integer.format(large.limits.imports),
    companies: large.capacity.companies,
    members: large.capacity.members,
    projects: large.capacity.projects,
    concurrency: large.concurrency,
    support: "E-mail prioritário",
  },
];

const rows: { label: string; value: (column: Column) => string }[] = [
  { label: "Empresas", value: (c) => integer.format(c.companies) },
  { label: "Membros", value: (c) => integer.format(c.members) },
  { label: "Projetos de integração", value: (c) => integer.format(c.projects) },
  { label: "Importações por mês", value: (c) => c.volume },
  { label: "Operações simultâneas", value: (c) => integer.format(c.concurrency) },
  { label: "Suporte", value: (c) => c.support },
];

export function Pricing() {
  return (
    <section className="pricing" id="planos" aria-labelledby="pricing-title">
      <div className="section-head">
        <h2 id="pricing-title">Preço fechado. Sem taxa de implantação.</h2>
        <p>
          Os planos estão aprovados, mas a contratação ainda não abriu. Até lá, toda conta usa o
          sandbox sem custo.
        </p>
      </div>
      <div className="price-board">
        {columns.map((column) => (
          <article
            key={column.id}
            className={`price-plan price-${column.id}`}
            aria-labelledby={`plano-${column.id}`}
          >
            <header className="price-top">
              <h3 id={`plano-${column.id}`}>{column.name}</h3>
              <p className="price-amount">
                <span className="price-value">{column.price}</span>
                <span className="price-cadence">{column.cadence}</span>
              </p>
              <p className="price-annual">{column.annual}</p>
            </header>
            <dl className="price-specs">
              {rows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value(column)}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
      <div className="price-foot">
        <div className="price-custom">
          <h3>Personalizado</h3>
          <p>
            Mais empresas, membros ou volume. Preço por orçamento, sem piso público, e prazo
            acordado com você.
          </p>
        </div>
        <ul className="price-terms">
          <li>Cartão pelo Stripe ou Pix</li>
          <li>Anual: 12 meses pelo preço de 10</li>
          <li>Cancelamento sem multa, vale até o fim do período pago</li>
          <li>Emissão com validade fiscal fora dos planos</li>
        </ul>
      </div>
    </section>
  );
}
