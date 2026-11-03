import "virtual:landing-figure.css";
import { intake } from "../../../console/src/site/landing/figures/intake.ts";
import { GlowDefs, Iso } from "../../../console/src/site/landing/shell.tsx";

// The landing's first station (XML arriving in an inbox), at rest in its lit
// end state, beside the title of the docs home. Decorative: hidden from
// assistive technology, since the guide's own title says the same thing.
const figure = intake();

export function HomeFigure() {
  return (
    <div className="home-figure" aria-hidden="true">
      <GlowDefs />
      <Iso figure={figure} label="" />
    </div>
  );
}
