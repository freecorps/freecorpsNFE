/**
 * Assinatura XMLDSig enveloped (C14N) sobre infDPS/infPedReg, com <Signature>
 * como PRÓXIMO IRMÃO do elemento assinado. O prolog UTF-8 entra APÓS assinar,
 * fora do elemento assinado (E1229). Portado de `convex/engine/signer.ts`.
 *
 * O pacote não abre PFX: recebe chave privada e certificado PEM já carregados
 * pelo cofre da plataforma. Nenhuma mensagem de erro inclui material de chave.
 */
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { NfseError, fail } from "./errors.js";
import { NFSE_NS, type BuiltXml } from "./dps.js";
import type { SignaturePolicy } from "./targets.js";

const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

// A política mora em targets.ts, junto do alvo que a define, para que o
// subconjunto `./pure` não alcance xml-crypto por um import de tipo.
export type { SignaturePolicy };

export interface SignerKeys {
  privateKeyPem: string;
  certificatePem: string;
}

const ALGORITHMS: Record<SignaturePolicy, { signature: string; digest: string }> = {
  "rsa-sha256": {
    signature: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    digest: "http://www.w3.org/2001/04/xmlenc#sha256",
  },
  "rsa-sha1": {
    signature: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    digest: "http://www.w3.org/2000/09/xmldsig#sha1",
  },
};

type SignedElement = "infDPS" | "infPedReg";

/** Raiz em que cada elemento assinado mora, como os builders a montam. */
const ROOT_OF: Record<SignedElement, string> = { infDPS: "DPS", infPedReg: "pedRegEvento" };
/** As transformações que o signer grava e a verificação aceita, nesta ordem. */
const TRANSFORMS = [ENVELOPED, C14N];

function parseXml(xml: string): Document {
  return new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (message: string) => {
        throw new NfseError("XML_MALFORMED", message);
      },
      fatalError: (message: string) => {
        throw new NfseError("XML_MALFORMED", message);
      },
    },
  }).parseFromString(xml, "text/xml");
}

/**
 * O único elemento assinável do documento: filho direto da raiz esperada, no
 * namespace da NFS-e, sem outro elemento de mesmo nome em nenhum nível. Um
 * XPath como `//infDPS` casaria cada ocorrência, aninhada ou não, e o
 * xml-crypto canonicalizaria e digeriria o conteúdo uma vez por ocorrência.
 */
function findSignedElement(doc: Document, element?: SignedElement): Element | null {
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== NFSE_NS) return null;
  const name =
    element ??
    (Object.keys(ROOT_OF) as SignedElement[]).find((key) => ROOT_OF[key] === root.localName);
  if (!name || ROOT_OF[name] !== root.localName) return null;
  const matches = doc.getElementsByTagNameNS("*", name);
  if (matches.length !== 1) return null;
  const target = matches[0]!;
  return target.parentNode === root && target.namespaceURI === NFSE_NS ? target : null;
}

/**
 * A assinatura cobre só o alvo, como o signer a grava: fica na raiz, tem uma
 * única Reference para o Id do alvo e as transformações de `TRANSFORMS`.
 * Conferido antes do xml-crypto, que processa cada Reference e cada
 * transformação antes de olhar o SignatureValue.
 */
function coversOnlyTarget(signature: Element, target: Element): boolean {
  if (signature.parentNode !== target.parentNode) return false;
  const references = signature.getElementsByTagNameNS(DSIG_NS, "Reference");
  if (references.length !== 1) return false;
  const id = target.getAttribute("Id");
  if (!id || references[0]!.getAttribute("URI") !== `#${id}`) return false;
  const transforms = references[0]!.getElementsByTagNameNS(DSIG_NS, "Transform");
  if (transforms.length !== TRANSFORMS.length) return false;
  return TRANSFORMS.every(
    (algorithm, index) => transforms[index]!.getAttribute("Algorithm") === algorithm,
  );
}

function signEnveloped(
  built: BuiltXml,
  element: SignedElement,
  keys: SignerKeys,
  policy: SignaturePolicy,
): string {
  const algorithms = ALGORITHMS[policy];
  if (!algorithms) return fail("SIGNATURE_POLICY_INVALID", "Política de assinatura desconhecida.");
  const root = ROOT_OF[element];
  let target: Element | null = null;
  try {
    target = findSignedElement(parseXml(built.xml), element);
  } catch {
    // XML malformado cai na recusa abaixo, sem repetir a mensagem do parser.
  }
  if (!target || target.getAttribute("Id") !== built.id)
    return fail(
      "SIGNATURE_TARGET_INVALID",
      `O XML deve ter um único ${element}, filho de ${root}, com o Id informado.`,
    );
  // Caminho absoluto e agnóstico de namespace (o documento tem namespace
  // default); com o alvo único conferido acima, casa exatamente um nó.
  const xpath = `/*[local-name(.)='${root}']/*[local-name(.)='${element}']`;
  let out: string;
  try {
    const sig = new SignedXml({
      privateKey: keys.privateKeyPem,
      publicCert: keys.certificatePem, // vira KeyInfo/X509Data/X509Certificate
      signatureAlgorithm: algorithms.signature,
      canonicalizationAlgorithm: C14N,
    });
    sig.addReference({
      xpath,
      transforms: TRANSFORMS,
      digestAlgorithm: algorithms.digest,
      uri: built.id, // renderizado como URI="#<id>"
    });
    sig.computeSignature(built.xml, { location: { reference: xpath, action: "after" } });
    out = sig.getSignedXml();
  } catch {
    // A mensagem original pode citar a chave; não a propague.
    return fail("SIGNATURE_FAILED", "Não foi possível assinar o XML com a chave informada.");
  }
  const signed = out.startsWith("<?xml") ? out : PROLOG + out;
  // Verificação local da própria assinatura antes de qualquer envio.
  if (!verifySignature(signed, keys.certificatePem))
    fail(
      "SIGNATURE_NOT_VERIFIED",
      "A assinatura gerada não verificou com o certificado informado.",
    );
  return signed;
}

/** Assina a DPS (infDPS). */
export const signDps = (built: BuiltXml, keys: SignerKeys, policy: SignaturePolicy) =>
  signEnveloped(built, "infDPS", keys, policy);

/** Assina o pedido de registro de evento (infPedReg). */
export const signEvent = (built: BuiltXml, keys: SignerKeys, policy: SignaturePolicy) =>
  signEnveloped(built, "infPedReg", keys, policy);

/**
 * Integridade local: exatamente uma <Signature>, na raiz, com uma única
 * Reference para o único infDPS ou infPedReg do documento, e ela confere com
 * o certificado dado. Não prova cadeia ICP-Brasil, revogação nem titularidade.
 */
export function verifySignature(signedXml: string, certificatePem: string): boolean {
  try {
    const doc = parseXml(signedXml);
    const signatures = doc.getElementsByTagNameNS(DSIG_NS, "Signature");
    if (signatures.length !== 1) return false;
    const target = findSignedElement(doc);
    if (!target || !coversOnlyTarget(signatures[0]!, target)) return false;
    const verifier = new SignedXml({ publicCert: certificatePem });
    verifier.loadSignature(signatures[0]!);
    return verifier.checkSignature(signedXml);
  } catch {
    return false;
  }
}
