import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "../lib/layout.tsx";

export function meta() {
  return [{ title: "Página não encontrada · Freecorps Fiscal" }];
}

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <main id="conteudo" className="not-found">
        <p className="eyebrow">404</p>
        <h1>Página não encontrada</h1>
        <p>O endereço não corresponde a nenhuma página desta documentação.</p>
        <a className="pill pill-primary" href="/docs/">
          Ir para a documentação
        </a>
      </main>
    </HomeLayout>
  );
}
