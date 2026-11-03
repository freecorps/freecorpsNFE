import { Closing, Developers, Guarantees, Infrastructure, Stripe } from "./build.tsx";
import { Pricing } from "./pricing.tsx";
import { Footer, GlowDefs, Header } from "./shell.tsx";
import { Chaos, Coverage, Documents, Hero, Pipeline } from "./story.tsx";

// The public home. Rendered to static HTML at build time (render.tsx); styles
// live in landing.css plus sections/*.css and figures/*.css, behaviour in
// client.ts. Without JavaScript the page reads in its lit end state.
export function HomePage() {
  return (
    <div className="landing" data-landing="">
      <GlowDefs />
      <Header />
      <main id="conteudo" tabIndex={-1}>
        <Hero />
        <Chaos />
        <Pipeline />
        <Documents />
        <Coverage />
        <Developers />
        <Stripe />
        <Pricing />
        <Infrastructure />
        <Guarantees />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
