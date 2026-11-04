import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import rule from "./no-float-fiscal-values.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const ts = (code: string) => ({ code, filename: "platform/convex/lib/example.ts" });

new RuleTester().run("no-float-fiscal-values", rule, {
  valid: [
    // Texto decimal pelos helpers do núcleo fiscal.
    ts("const total = quantize(add(decimal(a.vNF), decimal(b.vNF)), 2, 'half-even');"),
    // Nomes genéricos fora de contêiner fiscal: progresso de upload, limites, contagens.
    ts("const pct = Math.round((event.loaded * 100) / event.total);"),
    ts("const wait = limit.rate * 2;"),
    ts("const n = Number(page.total);"),
    ts("let count = 0; count += rows.length;"),
    // Concatenação de texto não é aritmética.
    ts("const label = 'R$ ' + payload.total;"),
    ts("const label = `${doc.vNF}`;"),
    ts("let s = ''; s += 'x' + item.quantity;"),
    // Comparar, copiar e serializar o texto é permitido.
    ts("const same = a.vNF === b.vNF; const copy = { total: payload.total };"),
    // Identificador genérico solto não é presumido fiscal.
    ts("const value = Number(input); const total = a + b;"),
    // Validador do Convex (`v.string()`) não é tag de valor.
    ts("const field = v.string();"),
  ],
  invalid: [
    { ...ts("const n = Number(doc.vNF);"), errors: [{ messageId: "convert" }] },
    { ...ts("const n = parseFloat(item.unitPrice);"), errors: [{ messageId: "convert" }] },
    {
      ...ts("const n = Number.parseFloat(conversion.brlAmount);"),
      errors: [{ messageId: "convert" }],
    },
    {
      ...ts("const n = parseInt(snapshot.service.amount.value, 10);"),
      errors: [{ messageId: "convert" }],
    },
    { ...ts("const n = Math.round(vProd);"), errors: [{ messageId: "convert" }] },
    { ...ts("const n = Number(payload.total!);"), errors: [{ messageId: "convert" }] },
    { ...ts("const n = Number(doc.items[0].quantity);"), errors: [{ messageId: "convert" }] },
    { ...ts("const t = issRate.toFixed(2);"), errors: [{ messageId: "method" }] },
    { ...ts("const t = (taxes[i].value as any).toFixed(2);"), errors: [{ messageId: "method" }] },
    { ...ts("const sum = a.vNF + b.vNF;"), errors: [{ messageId: "arithmetic" }] },
    { ...ts("const due = payload.total * 1.1;"), errors: [{ messageId: "arithmetic" }] },
    { ...ts("const net = qCom - 1;"), errors: [{ messageId: "arithmetic" }] },
    { ...ts("const n = +pICMS;"), errors: [{ messageId: "arithmetic" }] },
    {
      ...ts("let acc = 0; acc += item.tributaryUnitPrice;"),
      errors: [{ messageId: "arithmetic" }],
    },
    { ...ts("const brl = amount.value * conversion.rate;"), errors: [{ messageId: "arithmetic" }] },
  ],
});
