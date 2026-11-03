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
import type { BuiltXml } from "./dps.js";
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

function signEnveloped(
  built: BuiltXml,
  element: SignedElement,
  keys: SignerKeys,
  policy: SignaturePolicy,
): string {
  const algorithms = ALGORITHMS[policy];
  if (!algorithms) return fail("SIGNATURE_POLICY_INVALID", "Política de assinatura desconhecida.");
  // XPath agnóstico de namespace: o documento tem namespace default.
  const xpath = `//*[local-name(.)='${element}']`;
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
      transforms: [ENVELOPED, C14N],
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
 * Integridade local: exatamente uma <Signature> e ela confere com o
 * certificado dado. Não prova cadeia ICP-Brasil, revogação nem titularidade.
 */
export function verifySignature(signedXml: string, certificatePem: string): boolean {
  try {
    const doc = new DOMParser({
      errorHandler: {
        warning: () => undefined,
        error: (message: string) => {
          throw new NfseError("XML_MALFORMED", message);
        },
        fatalError: (message: string) => {
          throw new NfseError("XML_MALFORMED", message);
        },
      },
    }).parseFromString(signedXml, "text/xml");
    const signatures = doc.getElementsByTagNameNS(DSIG_NS, "Signature");
    if (signatures.length !== 1) return false;
    const verifier = new SignedXml({ publicCert: certificatePem });
    verifier.loadSignature(signatures[0]!);
    return verifier.checkSignature(signedXml);
  } catch {
    return false;
  }
}
