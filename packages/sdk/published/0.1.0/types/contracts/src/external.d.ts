/** Canonical public REST contract. No Convex validators or stored documents belong here. */
import { z } from "zod";
export declare const apiVersion = "8.0.0";
export declare const toJsonSchema: typeof z.core.toJSONSchema;
export declare const id: z.ZodString;
export declare const exactDecimal: z.ZodString;
export declare const fiscalStatus: z.ZodEnum<{
    unknown: "unknown";
    authorized: "authorized";
    cancelled: "cancelled";
    denied: "denied";
    conflict: "conflict";
}>;
export declare const nfePurposeInconsistency: z.ZodEnum<{
    "B25.1-10": "B25.1-10";
    "B25.1-20": "B25.1-20";
    "B25.2-10": "B25.2-10";
    "B25.2-20": "B25.2-20";
}>;
export declare const nfePayload: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"invoice">;
    key: z.ZodString;
    environment: z.ZodEnum<{
        1: "1";
        2: "2";
    }>;
    number: z.ZodString;
    series: z.ZodString;
    issuedAt: z.ZodString;
    operation: z.ZodString;
    purpose: z.ZodNullable<z.ZodObject<{
        code: z.ZodNullable<z.ZodString>;
        label: z.ZodNullable<z.ZodString>;
        creditNoteType: z.ZodNullable<z.ZodObject<{
            code: z.ZodString;
            label: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        debitNoteType: z.ZodNullable<z.ZodObject<{
            code: z.ZodString;
            label: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        inconsistencies: z.ZodArray<z.ZodEnum<{
            "B25.1-10": "B25.1-10";
            "B25.1-20": "B25.1-20";
            "B25.2-10": "B25.2-10";
            "B25.2-20": "B25.2-20";
        }>>;
    }, z.core.$strict>>;
    issuer: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    recipient: z.ZodNullable<z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    total: z.ZodString;
    declaredTotals: z.ZodObject<{
        vNF: z.ZodString;
        vNFTot: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        path: z.ZodString;
        representation: z.ZodLiteral<"decimal">;
        value: z.ZodString;
        basis: z.ZodLiteral<"declared">;
    }, z.core.$strict>, z.ZodObject<{
        path: z.ZodString;
        representation: z.ZodLiteral<"code">;
        value: z.ZodString;
        basis: z.ZodLiteral<"declared">;
    }, z.core.$strict>, z.ZodObject<{
        path: z.ZodString;
        representation: z.ZodLiteral<"text">;
        value: z.ZodString;
        basis: z.ZodLiteral<"declared">;
    }, z.core.$strict>], "representation">>;
    nt2026008: z.ZodNullable<z.ZodObject<{
        vProdLiqTot: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    nt2026006: z.ZodNullable<z.ZodObject<{
        gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
            nPag: z.ZodString;
            idTransacao: z.ZodString;
            tpMeioPgto: z.ZodString;
            tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
            CNPJReceb: z.ZodString;
            CNPJBasePSP: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    protocol: z.ZodNullable<z.ZodObject<{
        key: z.ZodString;
        environment: z.ZodEnum<{
            1: "1";
            2: "2";
        }>;
        status: z.ZodString;
        number: z.ZodNullable<z.ZodString>;
        receivedAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"summary">;
    key: z.ZodString;
    issuer: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    issuedAt: z.ZodString;
    total: z.ZodString;
    status: z.ZodString;
    protocolNumber: z.ZodString;
    receivedAt: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    protocolNumber: z.ZodString;
    registeredAt: z.ZodString;
    key: z.ZodString;
    author: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    type: z.ZodString;
    sequence: z.ZodString;
    occurredAt: z.ZodString;
    description: z.ZodString;
    kind: z.ZodLiteral<"event-summary">;
}, z.core.$strict>, z.ZodObject<{
    environment: z.ZodEnum<{
        1: "1";
        2: "2";
    }>;
    cancellation: z.ZodNullable<z.ZodObject<{
        protocolNumber: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>>;
    correction: z.ZodNullable<z.ZodObject<{
        text: z.ZodString;
        conditions: z.ZodString;
    }, z.core.$strict>>;
    manifestation: z.ZodNullable<z.ZodObject<{
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    receipt: z.ZodNullable<z.ZodObject<{
        key: z.ZodString;
        environment: z.ZodEnum<{
            1: "1";
            2: "2";
        }>;
        type: z.ZodString;
        sequence: z.ZodString;
        status: z.ZodString;
        number: z.ZodNullable<z.ZodString>;
        registeredAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    key: z.ZodString;
    author: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    type: z.ZodString;
    sequence: z.ZodString;
    occurredAt: z.ZodString;
    description: z.ZodString;
    kind: z.ZodLiteral<"event">;
}, z.core.$strict>], "kind">;
export declare const nfeItem: z.ZodObject<{
    item: z.ZodString;
    code: z.ZodString;
    description: z.ZodString;
    ncm: z.ZodString;
    cfop: z.ZodString;
    cest: z.ZodNullable<z.ZodString>;
    purchaseOrder: z.ZodNullable<z.ZodString>;
    purchaseOrderItem: z.ZodNullable<z.ZodString>;
    unit: z.ZodString;
    quantity: z.ZodString;
    unitPrice: z.ZodString;
    total: z.ZodString;
    tributaryUnit: z.ZodString;
    tributaryQuantity: z.ZodString;
    tributaryUnitPrice: z.ZodString;
    nt2026008: z.ZodNullable<z.ZodObject<{
        vUnComLiq: z.ZodNullable<z.ZodString>;
        vProdLiq: z.ZodNullable<z.ZodString>;
        vICMSPrevisto: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    taxes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        path: z.ZodString;
        representation: z.ZodLiteral<"decimal">;
        value: z.ZodString;
        basis: z.ZodLiteral<"declared">;
    }, z.core.$strict>, z.ZodObject<{
        path: z.ZodString;
        representation: z.ZodLiteral<"code">;
        value: z.ZodString;
        basis: z.ZodLiteral<"declared">;
    }, z.core.$strict>, z.ZodObject<{
        path: z.ZodString;
        representation: z.ZodLiteral<"text">;
        value: z.ZodString;
        basis: z.ZodLiteral<"declared">;
    }, z.core.$strict>], "representation">>;
}, z.core.$strict>;
export declare const nfseKey: z.ZodString;
export declare const nfsePayload: z.ZodObject<{
    kind: z.ZodLiteral<"service-invoice">;
    key: z.ZodString;
    number: z.ZodString;
    municipality: z.ZodString;
    municipalRegistration: z.ZodNullable<z.ZodString>;
    verificationCode: z.ZodString;
    issuedAt: z.ZodString;
    competence: z.ZodString;
    issuer: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    recipient: z.ZodNullable<z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    total: z.ZodString;
    serviceCode: z.ZodString;
    description: z.ZodString;
    values: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const documentPayload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"invoice">;
    key: z.ZodString;
    environment: z.ZodEnum<{
        1: "1";
        2: "2";
    }>;
    number: z.ZodString;
    series: z.ZodString;
    issuedAt: z.ZodString;
    operation: z.ZodString;
    purpose: z.ZodNullable<z.ZodObject<{
        code: z.ZodNullable<z.ZodString>;
        label: z.ZodNullable<z.ZodString>;
        creditNoteType: z.ZodNullable<z.ZodObject<{
            code: z.ZodString;
            label: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        debitNoteType: z.ZodNullable<z.ZodObject<{
            code: z.ZodString;
            label: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        inconsistencies: z.ZodArray<z.ZodEnum<{
            "B25.1-10": "B25.1-10";
            "B25.1-20": "B25.1-20";
            "B25.2-10": "B25.2-10";
            "B25.2-20": "B25.2-20";
        }>>;
    }, z.core.$strict>>;
    issuer: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    recipient: z.ZodNullable<z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    total: z.ZodString;
    declaredTotals: z.ZodObject<{
        vNF: z.ZodString;
        vNFTot: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        path: z.ZodString;
        representation: z.ZodLiteral<"decimal">;
        value: z.ZodString;
        basis: z.ZodLiteral<"declared">;
    }, z.core.$strict>, z.ZodObject<{
        path: z.ZodString;
        representation: z.ZodLiteral<"code">;
        value: z.ZodString;
        basis: z.ZodLiteral<"declared">;
    }, z.core.$strict>, z.ZodObject<{
        path: z.ZodString;
        representation: z.ZodLiteral<"text">;
        value: z.ZodString;
        basis: z.ZodLiteral<"declared">;
    }, z.core.$strict>], "representation">>;
    nt2026008: z.ZodNullable<z.ZodObject<{
        vProdLiqTot: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    nt2026006: z.ZodNullable<z.ZodObject<{
        gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
            nPag: z.ZodString;
            idTransacao: z.ZodString;
            tpMeioPgto: z.ZodString;
            tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
            CNPJReceb: z.ZodString;
            CNPJBasePSP: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    protocol: z.ZodNullable<z.ZodObject<{
        key: z.ZodString;
        environment: z.ZodEnum<{
            1: "1";
            2: "2";
        }>;
        status: z.ZodString;
        number: z.ZodNullable<z.ZodString>;
        receivedAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"summary">;
    key: z.ZodString;
    issuer: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    issuedAt: z.ZodString;
    total: z.ZodString;
    status: z.ZodString;
    protocolNumber: z.ZodString;
    receivedAt: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    protocolNumber: z.ZodString;
    registeredAt: z.ZodString;
    key: z.ZodString;
    author: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    type: z.ZodString;
    sequence: z.ZodString;
    occurredAt: z.ZodString;
    description: z.ZodString;
    kind: z.ZodLiteral<"event-summary">;
}, z.core.$strict>, z.ZodObject<{
    environment: z.ZodEnum<{
        1: "1";
        2: "2";
    }>;
    cancellation: z.ZodNullable<z.ZodObject<{
        protocolNumber: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>>;
    correction: z.ZodNullable<z.ZodObject<{
        text: z.ZodString;
        conditions: z.ZodString;
    }, z.core.$strict>>;
    manifestation: z.ZodNullable<z.ZodObject<{
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    receipt: z.ZodNullable<z.ZodObject<{
        key: z.ZodString;
        environment: z.ZodEnum<{
            1: "1";
            2: "2";
        }>;
        type: z.ZodString;
        sequence: z.ZodString;
        status: z.ZodString;
        number: z.ZodNullable<z.ZodString>;
        registeredAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    key: z.ZodString;
    author: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    type: z.ZodString;
    sequence: z.ZodString;
    occurredAt: z.ZodString;
    description: z.ZodString;
    kind: z.ZodLiteral<"event">;
}, z.core.$strict>], "kind">, z.ZodObject<{
    kind: z.ZodLiteral<"service-invoice">;
    key: z.ZodString;
    number: z.ZodString;
    municipality: z.ZodString;
    municipalRegistration: z.ZodNullable<z.ZodString>;
    verificationCode: z.ZodString;
    issuedAt: z.ZodString;
    competence: z.ZodString;
    issuer: z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    recipient: z.ZodNullable<z.ZodObject<{
        kind: z.ZodEnum<{
            CPF: "CPF";
            CNPJ: "CNPJ";
        }>;
        document: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        stateRegistration: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    total: z.ZodString;
    serviceCode: z.ZodString;
    description: z.ZodString;
    values: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>]>;
export declare const documentKey: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
export declare const documentModel: z.ZodEnum<{
    55: "55";
    nfse: "nfse";
}>;
export declare const documentSummary: z.ZodObject<{
    id: z.ZodString;
    originalId: z.ZodOptional<z.ZodString>;
    model: z.ZodEnum<{
        55: "55";
        nfse: "nfse";
    }>;
    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
    kind: z.ZodString;
    importedAt: z.ZodNumber;
    issuedAt: z.ZodNullable<z.ZodString>;
    number: z.ZodNullable<z.ZodString>;
    issuer: z.ZodNullable<z.ZodString>;
    total: z.ZodNullable<z.ZodString>;
    completeness: z.ZodEnum<{
        summary: "summary";
        "full-xml": "full-xml";
        "event-only": "event-only";
    }>;
    source: z.ZodEnum<{
        "imported-xml": "imported-xml";
        "distribution-xml": "distribution-xml";
    }>;
    fiscalStatus: z.ZodEnum<{
        unknown: "unknown";
        authorized: "authorized";
        cancelled: "cancelled";
        denied: "denied";
        conflict: "conflict";
    }>;
    projectionState: z.ZodEnum<{
        unavailable: "unavailable";
        pending: "pending";
        ready: "ready";
        "limit-exceeded": "limit-exceeded";
    }>;
    versionId: z.ZodString;
    resourceVersion: z.ZodNumber;
    processing: z.ZodLiteral<"complete">;
}, z.core.$strict>;
export declare const documentVersion: z.ZodObject<{
    id: z.ZodString;
    originalId: z.ZodOptional<z.ZodString>;
    operationId: z.ZodString;
    artifactId: z.ZodString;
    sha256: z.ZodString;
    source: z.ZodEnum<{
        "imported-xml": "imported-xml";
        "distribution-xml": "distribution-xml";
    }>;
    importedAt: z.ZodNumber;
    publishedAt: z.ZodNumber;
    parserVersion: z.ZodString;
    normalizerVersion: z.ZodNullable<z.ZodString>;
    processorVersion: z.ZodString;
    schema: z.ZodNullable<z.ZodString>;
    code: z.ZodString;
    kind: z.ZodString;
    itemCount: z.ZodNumber;
    originalAvailable: z.ZodBoolean;
}, z.core.$strict>;
export declare const fiscalSituation: z.ZodObject<{
    ruleVersion: z.ZodEnum<{
        "nfe-status/1": "nfe-status/1";
        "nfe-status/2": "nfe-status/2";
    }>;
    key: z.ZodNullable<z.ZodString>;
    reportedStatus: z.ZodEnum<{
        unknown: "unknown";
        authorized: "authorized";
        cancelled: "cancelled";
        denied: "denied";
        conflict: "conflict";
    }>;
    basis: z.ZodLiteral<"preserved-claims">;
    assurance: z.ZodLiteral<"unverified-origin">;
    liveConsultation: z.ZodLiteral<false>;
    evidenceIds: z.ZodArray<z.ZodString>;
    excluded: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>>;
    conflicts: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const document: z.ZodObject<{
    contractVersion: z.ZodLiteral<"documents/1">;
    model: z.ZodEnum<{
        55: "55";
        nfse: "nfse";
    }>;
    summary: z.ZodObject<{
        id: z.ZodString;
        originalId: z.ZodOptional<z.ZodString>;
        model: z.ZodEnum<{
            55: "55";
            nfse: "nfse";
        }>;
        key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
        kind: z.ZodString;
        importedAt: z.ZodNumber;
        issuedAt: z.ZodNullable<z.ZodString>;
        number: z.ZodNullable<z.ZodString>;
        issuer: z.ZodNullable<z.ZodString>;
        total: z.ZodNullable<z.ZodString>;
        completeness: z.ZodEnum<{
            summary: "summary";
            "full-xml": "full-xml";
            "event-only": "event-only";
        }>;
        source: z.ZodEnum<{
            "imported-xml": "imported-xml";
            "distribution-xml": "distribution-xml";
        }>;
        fiscalStatus: z.ZodEnum<{
            unknown: "unknown";
            authorized: "authorized";
            cancelled: "cancelled";
            denied: "denied";
            conflict: "conflict";
        }>;
        projectionState: z.ZodEnum<{
            unavailable: "unavailable";
            pending: "pending";
            ready: "ready";
            "limit-exceeded": "limit-exceeded";
        }>;
        versionId: z.ZodString;
        resourceVersion: z.ZodNumber;
        processing: z.ZodLiteral<"complete">;
    }, z.core.$strict>;
    payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"invoice">;
        key: z.ZodString;
        environment: z.ZodEnum<{
            1: "1";
            2: "2";
        }>;
        number: z.ZodString;
        series: z.ZodString;
        issuedAt: z.ZodString;
        operation: z.ZodString;
        purpose: z.ZodNullable<z.ZodObject<{
            code: z.ZodNullable<z.ZodString>;
            label: z.ZodNullable<z.ZodString>;
            creditNoteType: z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                label: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>>;
            debitNoteType: z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                label: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>>;
            inconsistencies: z.ZodArray<z.ZodEnum<{
                "B25.1-10": "B25.1-10";
                "B25.1-20": "B25.1-20";
                "B25.2-10": "B25.2-10";
                "B25.2-20": "B25.2-20";
            }>>;
        }, z.core.$strict>>;
        issuer: z.ZodObject<{
            kind: z.ZodEnum<{
                CPF: "CPF";
                CNPJ: "CNPJ";
            }>;
            document: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            stateRegistration: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        recipient: z.ZodNullable<z.ZodObject<{
            kind: z.ZodEnum<{
                CPF: "CPF";
                CNPJ: "CNPJ";
            }>;
            document: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            stateRegistration: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        total: z.ZodString;
        declaredTotals: z.ZodObject<{
            vNF: z.ZodString;
            vNFTot: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            path: z.ZodString;
            representation: z.ZodLiteral<"decimal">;
            value: z.ZodString;
            basis: z.ZodLiteral<"declared">;
        }, z.core.$strict>, z.ZodObject<{
            path: z.ZodString;
            representation: z.ZodLiteral<"code">;
            value: z.ZodString;
            basis: z.ZodLiteral<"declared">;
        }, z.core.$strict>, z.ZodObject<{
            path: z.ZodString;
            representation: z.ZodLiteral<"text">;
            value: z.ZodString;
            basis: z.ZodLiteral<"declared">;
        }, z.core.$strict>], "representation">>;
        nt2026008: z.ZodNullable<z.ZodObject<{
            vProdLiqTot: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        nt2026006: z.ZodNullable<z.ZodObject<{
            gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                nPag: z.ZodString;
                idTransacao: z.ZodString;
                tpMeioPgto: z.ZodString;
                tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                CNPJReceb: z.ZodString;
                CNPJBasePSP: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        protocol: z.ZodNullable<z.ZodObject<{
            key: z.ZodString;
            environment: z.ZodEnum<{
                1: "1";
                2: "2";
            }>;
            status: z.ZodString;
            number: z.ZodNullable<z.ZodString>;
            receivedAt: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"summary">;
        key: z.ZodString;
        issuer: z.ZodObject<{
            kind: z.ZodEnum<{
                CPF: "CPF";
                CNPJ: "CNPJ";
            }>;
            document: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            stateRegistration: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        issuedAt: z.ZodString;
        total: z.ZodString;
        status: z.ZodString;
        protocolNumber: z.ZodString;
        receivedAt: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        protocolNumber: z.ZodString;
        registeredAt: z.ZodString;
        key: z.ZodString;
        author: z.ZodObject<{
            kind: z.ZodEnum<{
                CPF: "CPF";
                CNPJ: "CNPJ";
            }>;
            document: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            stateRegistration: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        type: z.ZodString;
        sequence: z.ZodString;
        occurredAt: z.ZodString;
        description: z.ZodString;
        kind: z.ZodLiteral<"event-summary">;
    }, z.core.$strict>, z.ZodObject<{
        environment: z.ZodEnum<{
            1: "1";
            2: "2";
        }>;
        cancellation: z.ZodNullable<z.ZodObject<{
            protocolNumber: z.ZodString;
            reason: z.ZodString;
        }, z.core.$strict>>;
        correction: z.ZodNullable<z.ZodObject<{
            text: z.ZodString;
            conditions: z.ZodString;
        }, z.core.$strict>>;
        manifestation: z.ZodNullable<z.ZodObject<{
            reason: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        receipt: z.ZodNullable<z.ZodObject<{
            key: z.ZodString;
            environment: z.ZodEnum<{
                1: "1";
                2: "2";
            }>;
            type: z.ZodString;
            sequence: z.ZodString;
            status: z.ZodString;
            number: z.ZodNullable<z.ZodString>;
            registeredAt: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        key: z.ZodString;
        author: z.ZodObject<{
            kind: z.ZodEnum<{
                CPF: "CPF";
                CNPJ: "CNPJ";
            }>;
            document: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            stateRegistration: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        type: z.ZodString;
        sequence: z.ZodString;
        occurredAt: z.ZodString;
        description: z.ZodString;
        kind: z.ZodLiteral<"event">;
    }, z.core.$strict>], "kind">, z.ZodObject<{
        kind: z.ZodLiteral<"service-invoice">;
        key: z.ZodString;
        number: z.ZodString;
        municipality: z.ZodString;
        municipalRegistration: z.ZodNullable<z.ZodString>;
        verificationCode: z.ZodString;
        issuedAt: z.ZodString;
        competence: z.ZodString;
        issuer: z.ZodObject<{
            kind: z.ZodEnum<{
                CPF: "CPF";
                CNPJ: "CNPJ";
            }>;
            document: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            stateRegistration: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        recipient: z.ZodNullable<z.ZodObject<{
            kind: z.ZodEnum<{
                CPF: "CPF";
                CNPJ: "CNPJ";
            }>;
            document: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            stateRegistration: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        total: z.ZodString;
        serviceCode: z.ZodString;
        description: z.ZodString;
        values: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>]>;
    version: z.ZodObject<{
        id: z.ZodString;
        originalId: z.ZodOptional<z.ZodString>;
        operationId: z.ZodString;
        artifactId: z.ZodString;
        sha256: z.ZodString;
        source: z.ZodEnum<{
            "imported-xml": "imported-xml";
            "distribution-xml": "distribution-xml";
        }>;
        importedAt: z.ZodNumber;
        publishedAt: z.ZodNumber;
        parserVersion: z.ZodString;
        normalizerVersion: z.ZodNullable<z.ZodString>;
        processorVersion: z.ZodString;
        schema: z.ZodNullable<z.ZodString>;
        code: z.ZodString;
        kind: z.ZodString;
        itemCount: z.ZodNumber;
        originalAvailable: z.ZodBoolean;
    }, z.core.$strict>;
    fiscalSituation: z.ZodNullable<z.ZodObject<{
        ruleVersion: z.ZodEnum<{
            "nfe-status/1": "nfe-status/1";
            "nfe-status/2": "nfe-status/2";
        }>;
        key: z.ZodNullable<z.ZodString>;
        reportedStatus: z.ZodEnum<{
            unknown: "unknown";
            authorized: "authorized";
            cancelled: "cancelled";
            denied: "denied";
            conflict: "conflict";
        }>;
        basis: z.ZodLiteral<"preserved-claims">;
        assurance: z.ZodLiteral<"unverified-origin">;
        liveConsultation: z.ZodLiteral<false>;
        evidenceIds: z.ZodArray<z.ZodString>;
        excluded: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            reason: z.ZodString;
        }, z.core.$strict>>;
        conflicts: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    previousFiscalSituation: z.ZodNullable<z.ZodObject<{
        ruleVersion: z.ZodEnum<{
            "nfe-status/1": "nfe-status/1";
            "nfe-status/2": "nfe-status/2";
        }>;
        key: z.ZodNullable<z.ZodString>;
        reportedStatus: z.ZodEnum<{
            unknown: "unknown";
            authorized: "authorized";
            cancelled: "cancelled";
            denied: "denied";
            conflict: "conflict";
        }>;
        basis: z.ZodLiteral<"preserved-claims">;
        assurance: z.ZodLiteral<"unverified-origin">;
        liveConsultation: z.ZodLiteral<false>;
        evidenceIds: z.ZodArray<z.ZodString>;
        excluded: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            reason: z.ZodString;
        }, z.core.$strict>>;
        conflicts: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const documentFile: z.ZodObject<{
    id: z.ZodString;
    originalId: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    sha256: z.ZodString;
    size: z.ZodNumber;
    source: z.ZodEnum<{
        "imported-xml": "imported-xml";
        "distribution-xml": "distribution-xml";
    }>;
    importedAt: z.ZodNumber;
    originalAvailable: z.ZodBoolean;
}, z.core.$strict>;
export declare const unclassifiedArtifact: z.ZodObject<{
    id: z.ZodString;
    originalId: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    sha256: z.ZodString;
    importedAt: z.ZodNumber;
    size: z.ZodNumber;
    code: z.ZodString;
    originalAvailable: z.ZodBoolean;
}, z.core.$strict>;
export declare const operation: z.ZodObject<{
    id: z.ZodString;
    originalId: z.ZodOptional<z.ZodString>;
    state: z.ZodEnum<{
        queued: "queued";
        running: "running";
        retry_wait: "retry_wait";
        reconciling: "reconciling";
        paused: "paused";
        succeeded: "succeeded";
        failed: "failed";
    }>;
    generation: z.ZodNumber;
    attempts: z.ZodNumber;
    nextAttemptAt: z.ZodNullable<z.ZodNumber>;
    code: z.ZodNullable<z.ZodString>;
    result: z.ZodNullable<z.ZodString>;
    uncertain: z.ZodBoolean;
}, z.core.$strict>;
export declare const importDocument: z.ZodObject<{
    documentId: z.ZodString;
    versionId: z.ZodString;
    number: z.ZodString;
    code: z.ZodString;
}, z.core.$strict>;
export declare const importFile: z.ZodObject<{
    id: z.ZodString;
    originalId: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    size: z.ZodNumber;
    sha256: z.ZodString;
    state: z.ZodUnion<readonly [z.ZodEnum<{
        reserved: "reserved";
        uploaded: "uploaded";
        accepted: "accepted";
        expired: "expired";
    }>, z.ZodEnum<{
        queued: "queued";
        running: "running";
        retry_wait: "retry_wait";
        reconciling: "reconciling";
        paused: "paused";
        succeeded: "succeeded";
        failed: "failed";
    }>]>;
    operationId: z.ZodNullable<z.ZodString>;
    generation: z.ZodNumber;
    code: z.ZodNullable<z.ZodString>;
    documentId: z.ZodNullable<z.ZodString>;
    versionId: z.ZodNullable<z.ZodString>;
    documents: z.ZodOptional<z.ZodArray<z.ZodObject<{
        documentId: z.ZodString;
        versionId: z.ZodString;
        number: z.ZodString;
        code: z.ZodString;
    }, z.core.$strict>>>;
    result: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const importBatch: z.ZodObject<{
    id: z.ZodString;
    originalId: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodNumber;
    files: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        originalId: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        size: z.ZodNumber;
        sha256: z.ZodString;
        state: z.ZodUnion<readonly [z.ZodEnum<{
            reserved: "reserved";
            uploaded: "uploaded";
            accepted: "accepted";
            expired: "expired";
        }>, z.ZodEnum<{
            queued: "queued";
            running: "running";
            retry_wait: "retry_wait";
            reconciling: "reconciling";
            paused: "paused";
            succeeded: "succeeded";
            failed: "failed";
        }>]>;
        operationId: z.ZodNullable<z.ZodString>;
        generation: z.ZodNumber;
        code: z.ZodNullable<z.ZodString>;
        documentId: z.ZodNullable<z.ZodString>;
        versionId: z.ZodNullable<z.ZodString>;
        documents: z.ZodOptional<z.ZodArray<z.ZodObject<{
            documentId: z.ZodString;
            versionId: z.ZodString;
            number: z.ZodString;
            code: z.ZodString;
        }, z.core.$strict>>>;
        result: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const endpoint: z.ZodObject<{
    active: z.ZodBoolean;
    version: z.ZodNumber;
    secretVersion: z.ZodNumber;
    previousUntil: z.ZodNullable<z.ZodNumber>;
    createdAt: z.ZodNumber;
    name: z.ZodString;
    url: z.ZodString;
    events: z.ZodArray<z.ZodEnum<{
        "document.received": "document.received";
        "document.updated": "document.updated";
        "document.event_received": "document.event_received";
        "import.completed": "import.completed";
        "connection.attention_required": "connection.attention_required";
        "connection.release_withdrawn": "connection.release_withdrawn";
        "connection.history_limited": "connection.history_limited";
        "issuance.authorized": "issuance.authorized";
        "issuance.rejected": "issuance.rejected";
        "issuance.cancelled": "issuance.cancelled";
        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
    }>>;
    id: z.ZodString;
}, z.core.$strict>;
export declare const delivery: z.ZodObject<{
    id: z.ZodString;
    eventId: z.ZodString;
    type: z.ZodEnum<{
        "document.received": "document.received";
        "document.updated": "document.updated";
        "document.event_received": "document.event_received";
        "import.completed": "import.completed";
        "connection.attention_required": "connection.attention_required";
        "connection.release_withdrawn": "connection.release_withdrawn";
        "connection.history_limited": "connection.history_limited";
        "issuance.authorized": "issuance.authorized";
        "issuance.rejected": "issuance.rejected";
        "issuance.cancelled": "issuance.cancelled";
        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
        "webhook.test": "webhook.test";
    }>;
    resourceVersion: z.ZodNumber;
    state: z.ZodEnum<{
        queued: "queued";
        running: "running";
        retry_wait: "retry_wait";
        paused: "paused";
        failed: "failed";
        delivered: "delivered";
    }>;
    attempts: z.ZodNumber;
    resends: z.ZodNumber;
    generation: z.ZodNumber;
    nextAttemptAt: z.ZodNullable<z.ZodNumber>;
    code: z.ZodNullable<z.ZodString>;
    httpStatus: z.ZodNullable<z.ZodNumber>;
    durationMs: z.ZodNullable<z.ZodNumber>;
    response: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodNumber;
    canRetry: z.ZodBoolean;
}, z.core.$strict>;
export declare const publicErrorStatus: {
    readonly STREAM_CONFLICT: 409;
    readonly CAPTURE_PAUSED: 409;
    readonly SOURCE_COOLDOWN: 409;
    readonly CERTIFICATE_UNAVAILABLE: 409;
    readonly CAPTURE_DEMONSTRATION_DENIED: 400;
    readonly INVALID_API_KEY: 401;
    readonly NOT_FOUND: 404;
    readonly SCOPE_DENIED: 403;
    readonly ENVIRONMENT_DENIED: 403;
    readonly INVALID_REQUEST: 400;
    readonly INVALID_QUERY: 400;
    readonly INVALID_CURSOR: 400;
    readonly INVALID_PAGINATION: 400;
    readonly ORIGINAL_UNAVAILABLE: 404;
    readonly DANFE_UNAVAILABLE: 409;
    readonly IDEMPOTENCY_CONFLICT: 409;
    readonly OPERATION_CONFLICT: 409;
    readonly RECONCILIATION_REQUIRED: 409;
    readonly ATTEMPTS_EXHAUSTED: 409;
    readonly RECOVERY_BUDGET_EXHAUSTED: 409;
    readonly ACCESS_REVOKED: 409;
    readonly INVALID_FILE: 400;
    readonly FILE_TOO_LARGE: 413;
    readonly UPLOAD_EXPIRED: 409;
    readonly ALREADY_ACCEPTED: 409;
    readonly RATE_LIMITED: 429;
    readonly ENDPOINT_LIMIT: 409;
    readonly ENDPOINT_CHANGED: 409;
    readonly ROTATION_IN_PROGRESS: 409;
    readonly ORGANIZATION_ARCHIVED: 409;
    readonly ISSUANCE_PRODUCTION_DISABLED: 403;
    readonly ISSUANCE_DEMONSTRATION_DENIED: 400;
    readonly NFSE_PROFILE_REQUIRED: 409;
    readonly NFSE_ACTIVITY_NOT_FOUND: 400;
    readonly NFSE_ROUTE_UNSUPPORTED: 409;
    readonly NFSE_ROUTE_PROFILE_INCOMPLETE: 409;
    readonly ISSUANCE_FIELD_INVALID: 400;
    readonly ISSUANCE_TAKER_DOCUMENT_INVALID: 400;
    readonly ISSUANCE_TAKER_NIF_INVALID: 400;
    readonly ISSUANCE_TAKER_INVALID: 400;
    readonly ISSUANCE_EXPORT_TAKER_REQUIRED: 400;
    readonly ISSUANCE_EXPORT_CURRENCY_REQUIRED: 400;
    readonly ISSUANCE_CURRENCY_INVALID: 400;
    readonly ISSUANCE_CURRENCY_UNSUPPORTED: 400;
    readonly ISSUANCE_AMOUNT_INVALID: 400;
    readonly ISSUANCE_ISS_RATE_INVALID: 400;
    readonly ISSUANCE_ISS_RATE_REQUIRED: 400;
    readonly ISSUANCE_ISS_RATE_NOT_ALLOWED: 400;
    readonly ISSUANCE_ISS_NOT_LEVIED: 400;
    readonly ISSUANCE_WITHHOLDING_INVALID: 400;
    readonly ISSUANCE_COMPETENCE_INVALID: 400;
    readonly ISSUANCE_COMPETENCE_FUTURE: 400;
    readonly ISSUANCE_DATE_INVALID: 400;
    readonly ISSUANCE_DATE_FUTURE: 400;
    readonly ISSUANCE_ISSUER_EMAIL_REQUIRED: 400;
    readonly DPS_NUMBER_EXHAUSTED: 409;
    readonly CANCEL_REASON_INVALID: 400;
    readonly ISSUANCE_NOT_CANCELLABLE: 409;
    readonly ISSUANCE_TRANSPORT_CHANGED: 409;
    readonly UNAVAILABLE: 503;
};
export declare const errorResponse: z.ZodObject<{
    error: z.ZodObject<{
        code: z.ZodEnum<{
            STREAM_CONFLICT: "STREAM_CONFLICT";
            CAPTURE_PAUSED: "CAPTURE_PAUSED";
            SOURCE_COOLDOWN: "SOURCE_COOLDOWN";
            CERTIFICATE_UNAVAILABLE: "CERTIFICATE_UNAVAILABLE";
            CAPTURE_DEMONSTRATION_DENIED: "CAPTURE_DEMONSTRATION_DENIED";
            INVALID_API_KEY: "INVALID_API_KEY";
            NOT_FOUND: "NOT_FOUND";
            SCOPE_DENIED: "SCOPE_DENIED";
            ENVIRONMENT_DENIED: "ENVIRONMENT_DENIED";
            INVALID_REQUEST: "INVALID_REQUEST";
            INVALID_QUERY: "INVALID_QUERY";
            INVALID_CURSOR: "INVALID_CURSOR";
            INVALID_PAGINATION: "INVALID_PAGINATION";
            ORIGINAL_UNAVAILABLE: "ORIGINAL_UNAVAILABLE";
            DANFE_UNAVAILABLE: "DANFE_UNAVAILABLE";
            IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT";
            OPERATION_CONFLICT: "OPERATION_CONFLICT";
            RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED";
            ATTEMPTS_EXHAUSTED: "ATTEMPTS_EXHAUSTED";
            RECOVERY_BUDGET_EXHAUSTED: "RECOVERY_BUDGET_EXHAUSTED";
            ACCESS_REVOKED: "ACCESS_REVOKED";
            INVALID_FILE: "INVALID_FILE";
            FILE_TOO_LARGE: "FILE_TOO_LARGE";
            UPLOAD_EXPIRED: "UPLOAD_EXPIRED";
            ALREADY_ACCEPTED: "ALREADY_ACCEPTED";
            RATE_LIMITED: "RATE_LIMITED";
            ENDPOINT_LIMIT: "ENDPOINT_LIMIT";
            ENDPOINT_CHANGED: "ENDPOINT_CHANGED";
            ROTATION_IN_PROGRESS: "ROTATION_IN_PROGRESS";
            ORGANIZATION_ARCHIVED: "ORGANIZATION_ARCHIVED";
            ISSUANCE_PRODUCTION_DISABLED: "ISSUANCE_PRODUCTION_DISABLED";
            ISSUANCE_DEMONSTRATION_DENIED: "ISSUANCE_DEMONSTRATION_DENIED";
            NFSE_PROFILE_REQUIRED: "NFSE_PROFILE_REQUIRED";
            NFSE_ACTIVITY_NOT_FOUND: "NFSE_ACTIVITY_NOT_FOUND";
            NFSE_ROUTE_UNSUPPORTED: "NFSE_ROUTE_UNSUPPORTED";
            NFSE_ROUTE_PROFILE_INCOMPLETE: "NFSE_ROUTE_PROFILE_INCOMPLETE";
            ISSUANCE_FIELD_INVALID: "ISSUANCE_FIELD_INVALID";
            ISSUANCE_TAKER_DOCUMENT_INVALID: "ISSUANCE_TAKER_DOCUMENT_INVALID";
            ISSUANCE_TAKER_NIF_INVALID: "ISSUANCE_TAKER_NIF_INVALID";
            ISSUANCE_TAKER_INVALID: "ISSUANCE_TAKER_INVALID";
            ISSUANCE_EXPORT_TAKER_REQUIRED: "ISSUANCE_EXPORT_TAKER_REQUIRED";
            ISSUANCE_EXPORT_CURRENCY_REQUIRED: "ISSUANCE_EXPORT_CURRENCY_REQUIRED";
            ISSUANCE_CURRENCY_INVALID: "ISSUANCE_CURRENCY_INVALID";
            ISSUANCE_CURRENCY_UNSUPPORTED: "ISSUANCE_CURRENCY_UNSUPPORTED";
            ISSUANCE_AMOUNT_INVALID: "ISSUANCE_AMOUNT_INVALID";
            ISSUANCE_ISS_RATE_INVALID: "ISSUANCE_ISS_RATE_INVALID";
            ISSUANCE_ISS_RATE_REQUIRED: "ISSUANCE_ISS_RATE_REQUIRED";
            ISSUANCE_ISS_RATE_NOT_ALLOWED: "ISSUANCE_ISS_RATE_NOT_ALLOWED";
            ISSUANCE_ISS_NOT_LEVIED: "ISSUANCE_ISS_NOT_LEVIED";
            ISSUANCE_WITHHOLDING_INVALID: "ISSUANCE_WITHHOLDING_INVALID";
            ISSUANCE_COMPETENCE_INVALID: "ISSUANCE_COMPETENCE_INVALID";
            ISSUANCE_COMPETENCE_FUTURE: "ISSUANCE_COMPETENCE_FUTURE";
            ISSUANCE_DATE_INVALID: "ISSUANCE_DATE_INVALID";
            ISSUANCE_DATE_FUTURE: "ISSUANCE_DATE_FUTURE";
            ISSUANCE_ISSUER_EMAIL_REQUIRED: "ISSUANCE_ISSUER_EMAIL_REQUIRED";
            DPS_NUMBER_EXHAUSTED: "DPS_NUMBER_EXHAUSTED";
            CANCEL_REASON_INVALID: "CANCEL_REASON_INVALID";
            ISSUANCE_NOT_CANCELLABLE: "ISSUANCE_NOT_CANCELLABLE";
            ISSUANCE_TRANSPORT_CHANGED: "ISSUANCE_TRANSPORT_CHANGED";
            UNAVAILABLE: "UNAVAILABLE";
        }>;
        message: z.ZodString;
        retryable: z.ZodBoolean;
        field: z.ZodOptional<z.ZodString>;
        missing: z.ZodOptional<z.ZodArray<z.ZodString>>;
        nextAllowedAt: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    requestId: z.ZodString;
}, z.core.$strict>;
export declare const dataResponse: <T extends z.ZodType>(data: T) => z.ZodObject<{
    data: T;
    requestId: z.ZodString;
}, z.core.$strict>;
export type RetryPolicy = "read" | "idempotent" | "never";
export declare const captureConnection: z.ZodObject<{
    id: z.ZodString;
    organizationId: z.ZodString;
    companyId: z.ZodString;
    projectId: z.ZodString;
    environment: z.ZodEnum<{
        sandbox: "sandbox";
        production: "production";
    }>;
    state: z.ZodEnum<{
        paused: "paused";
        active: "active";
        attention: "attention";
    }>;
    version: z.ZodNumber;
    checkpoint: z.ZodString;
    sourceCursor: z.ZodNullable<z.ZodString>;
    sourceMaxNsu: z.ZodNullable<z.ZodString>;
    nextAllowedAt: z.ZodNumber;
    lastAttemptAt: z.ZodNullable<z.ZodNumber>;
    lastSuccessAt: z.ZodNullable<z.ZodNumber>;
    code: z.ZodNullable<z.ZodString>;
    received: z.ZodNumber;
    operationId: z.ZodNullable<z.ZodString>;
    operationState: z.ZodNullable<z.ZodString>;
    certificateState: z.ZodString;
    certificateExpiresAt: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export declare const documentExport: z.ZodObject<{
    id: z.ZodString;
    selection: z.ZodObject<{
        kind: z.ZodLiteral<"document">;
        documentId: z.ZodString;
        companyId: z.ZodString;
        projectId: z.ZodString;
    }, z.core.$strict>;
    environment: z.ZodEnum<{
        sandbox: "sandbox";
        production: "production";
    }>;
    state: z.ZodEnum<{
        running: "running";
        succeeded: "succeeded";
        failed: "failed";
        expired: "expired";
        revoked: "revoked";
    }>;
    createdAt: z.ZodNumber;
    expiresAt: z.ZodNumber;
    parts: z.ZodNumber;
    bytes: z.ZodNumber;
    code: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const exportPart: z.ZodObject<{
    id: z.ZodString;
    sequence: z.ZodNumber;
    sha256: z.ZodString;
    size: z.ZodNumber;
}, z.core.$strict>;
export declare const issuanceRequest: z.ZodObject<{
    companyId: z.ZodString;
    activityCode: z.ZodString;
    competence: z.ZodString;
    issueDate: z.ZodOptional<z.ZodString>;
    issuerEmail: z.ZodOptional<z.ZodString>;
    market: z.ZodEnum<{
        domestic: "domestic";
        export: "export";
    }>;
    taker: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"national">;
        document: z.ZodString;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        address: z.ZodObject<{
            municipalityCode: z.ZodString;
            postalCode: z.ZodString;
            street: z.ZodString;
            number: z.ZodString;
            district: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"foreign">;
        nif: z.ZodOptional<z.ZodString>;
        nifAbsence: z.ZodOptional<z.ZodNumber>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        address: z.ZodObject<{
            country: z.ZodString;
            city: z.ZodString;
            postalCode: z.ZodString;
            state: z.ZodString;
            street: z.ZodString;
            number: z.ZodString;
            district: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>], "kind">;
    description: z.ZodString;
    amount: z.ZodObject<{
        currency: z.ZodString;
        value: z.ZodString;
    }, z.core.$strict>;
    issRate: z.ZodOptional<z.ZodString>;
    issWithheld: z.ZodBoolean;
}, z.core.$strict>;
export declare const issuanceState: z.ZodEnum<{
    authorized: "authorized";
    cancelled: "cancelled";
    processing: "processing";
    rejected: "rejected";
}>;
export declare const issuanceArtifact: z.ZodObject<{
    id: z.ZodString;
    originalId: z.ZodOptional<z.ZodString>;
    kind: z.ZodEnum<{
        nfse: "nfse";
        dps: "dps";
        danfse: "danfse";
        "cancel-request": "cancel-request";
        "cancel-event": "cancel-event";
    }>;
    sha256: z.ZodString;
    size: z.ZodNumber;
    signed: z.ZodBoolean;
    createdAt: z.ZodNumber;
}, z.core.$strict>;
export declare const issuanceCancellation: z.ZodObject<{
    id: z.ZodString;
    operationId: z.ZodString;
    state: z.ZodEnum<{
        processing: "processing";
        rejected: "rejected";
        registered: "registered";
    }>;
    sequence: z.ZodNumber;
    reasonCode: z.ZodEnum<{
        1: "1";
        2: "2";
        9: "9";
    }>;
    reason: z.ZodString;
    code: z.ZodNullable<z.ZodString>;
    rejections: z.ZodArray<z.ZodObject<{
        code: z.ZodNullable<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strict>>;
    alreadyRegistered: z.ZodBoolean;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, z.core.$strict>;
export declare const issuance: z.ZodObject<{
    id: z.ZodString;
    originalId: z.ZodOptional<z.ZodString>;
    companyId: z.ZodString;
    projectId: z.ZodString;
    environment: z.ZodEnum<{
        sandbox: "sandbox";
        production: "production";
    }>;
    operationId: z.ZodString;
    operationState: z.ZodEnum<{
        queued: "queued";
        running: "running";
        retry_wait: "retry_wait";
        reconciling: "reconciling";
        paused: "paused";
        succeeded: "succeeded";
        failed: "failed";
    }>;
    state: z.ZodEnum<{
        authorized: "authorized";
        cancelled: "cancelled";
        processing: "processing";
        rejected: "rejected";
    }>;
    transport: z.ZodEnum<{
        simulated: "simulated";
        "producao-restrita": "producao-restrita";
        producao: "producao";
    }>;
    target: z.ZodString;
    series: z.ZodString;
    number: z.ZodNumber;
    dpsId: z.ZodString;
    issueDate: z.ZodString;
    competence: z.ZodString;
    market: z.ZodEnum<{
        domestic: "domestic";
        export: "export";
    }>;
    amount: z.ZodObject<{
        currency: z.ZodString;
        value: z.ZodString;
    }, z.core.$strict>;
    serviceBrl: z.ZodNullable<z.ZodString>;
    exchange: z.ZodNullable<z.ZodObject<{
        currency: z.ZodString;
        amount: z.ZodString;
        rate: z.ZodString;
        quoteDate: z.ZodString;
        brlAmount: z.ZodString;
        source: z.ZodEnum<{
            simulated: "simulated";
            "ptax-bcb": "ptax-bcb";
        }>;
        frozenAt: z.ZodNumber;
    }, z.core.$strict>>;
    accessKey: z.ZodNullable<z.ZodString>;
    nfseNumber: z.ZodNullable<z.ZodString>;
    code: z.ZodNullable<z.ZodString>;
    rejections: z.ZodArray<z.ZodObject<{
        code: z.ZodNullable<z.ZodString>;
        message: z.ZodString;
    }, z.core.$strict>>;
    artifacts: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        originalId: z.ZodOptional<z.ZodString>;
        kind: z.ZodEnum<{
            nfse: "nfse";
            dps: "dps";
            danfse: "danfse";
            "cancel-request": "cancel-request";
            "cancel-event": "cancel-event";
        }>;
        sha256: z.ZodString;
        size: z.ZodNumber;
        signed: z.ZodBoolean;
        createdAt: z.ZodNumber;
    }, z.core.$strict>>;
    cancellation: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        operationId: z.ZodString;
        state: z.ZodEnum<{
            processing: "processing";
            rejected: "rejected";
            registered: "registered";
        }>;
        sequence: z.ZodNumber;
        reasonCode: z.ZodEnum<{
            1: "1";
            2: "2";
            9: "9";
        }>;
        reason: z.ZodString;
        code: z.ZodNullable<z.ZodString>;
        rejections: z.ZodArray<z.ZodObject<{
            code: z.ZodNullable<z.ZodString>;
            message: z.ZodString;
        }, z.core.$strict>>;
        alreadyRegistered: z.ZodBoolean;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
    }, z.core.$strict>>;
    version: z.ZodNumber;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, z.core.$strict>;
export declare const routes: {
    readonly createExport: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                documentId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                selection: z.ZodObject<{
                    kind: z.ZodLiteral<"document">;
                    documentId: z.ZodString;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                }, z.core.$strict>;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    running: "running";
                    succeeded: "succeeded";
                    failed: "failed";
                    expired: "expired";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodNumber;
                expiresAt: z.ZodNumber;
                parts: z.ZodNumber;
                bytes: z.ZodNumber;
                code: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getExport: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                exportId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                selection: z.ZodObject<{
                    kind: z.ZodLiteral<"document">;
                    documentId: z.ZodString;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                }, z.core.$strict>;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    running: "running";
                    succeeded: "succeeded";
                    failed: "failed";
                    expired: "expired";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodNumber;
                expiresAt: z.ZodNumber;
                parts: z.ZodNumber;
                bytes: z.ZodNumber;
                code: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly exportParts: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                exportId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    sequence: z.ZodNumber;
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly revokeExport: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                exportId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                selection: z.ZodObject<{
                    kind: z.ZodLiteral<"document">;
                    documentId: z.ZodString;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                }, z.core.$strict>;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    running: "running";
                    succeeded: "succeeded";
                    failed: "failed";
                    expired: "expired";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodNumber;
                expiresAt: z.ZodNumber;
                parts: z.ZodNumber;
                bytes: z.ZodNumber;
                code: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly exportTicket: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                partId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                token: z.ZodString;
                expiresAt: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly controlCapture: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                action: z.ZodEnum<{
                    activate: "activate";
                    sync: "sync";
                    pause: "pause";
                    resume: "resume";
                }>;
                expectedVersion: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                organizationId: z.ZodString;
                companyId: z.ZodString;
                projectId: z.ZodString;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    paused: "paused";
                    active: "active";
                    attention: "attention";
                }>;
                version: z.ZodNumber;
                checkpoint: z.ZodString;
                sourceCursor: z.ZodNullable<z.ZodString>;
                sourceMaxNsu: z.ZodNullable<z.ZodString>;
                nextAllowedAt: z.ZodNumber;
                lastAttemptAt: z.ZodNullable<z.ZodNumber>;
                lastSuccessAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                received: z.ZodNumber;
                operationId: z.ZodNullable<z.ZodString>;
                operationState: z.ZodNullable<z.ZodString>;
                certificateState: z.ZodString;
                certificateExpiresAt: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getCapture: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodNullable<z.ZodObject<{
                id: z.ZodString;
                organizationId: z.ZodString;
                companyId: z.ZodString;
                projectId: z.ZodString;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    paused: "paused";
                    active: "active";
                    attention: "attention";
                }>;
                version: z.ZodNumber;
                checkpoint: z.ZodString;
                sourceCursor: z.ZodNullable<z.ZodString>;
                sourceMaxNsu: z.ZodNullable<z.ZodString>;
                nextAllowedAt: z.ZodNumber;
                lastAttemptAt: z.ZodNullable<z.ZodNumber>;
                lastSuccessAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                received: z.ZodNumber;
                operationId: z.ZodNullable<z.ZodString>;
                operationState: z.ZodNullable<z.ZodString>;
                certificateState: z.ZodString;
                certificateExpiresAt: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getRegistry: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                cnpj: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                cnpj: z.ZodString;
                provider: z.ZodLiteral<"opencnpj">;
                sourceUrl: z.ZodLiteral<"https://opencnpj.org/">;
                status: z.ZodEnum<{
                    not_found: "not_found";
                    not_consulted: "not_consulted";
                    found: "found";
                    unavailable: "unavailable";
                    unsupported_format: "unsupported_format";
                }>;
                freshness: z.ZodEnum<{
                    missing: "missing";
                    fresh: "fresh";
                    stale: "stale";
                }>;
                data: z.ZodNullable<z.ZodObject<{
                    name: z.ZodString;
                    status: z.ZodString;
                    address: z.ZodObject<{
                        street: z.ZodString;
                        number: z.ZodString;
                        complement: z.ZodString;
                        district: z.ZodString;
                        city: z.ZodString;
                        state: z.ZodString;
                        postalCode: z.ZodString;
                    }, z.core.$strict>;
                }, z.core.$strict>>;
                sourceUpdatedAt: z.ZodNullable<z.ZodNumber>;
                consultedAt: z.ZodNullable<z.ZodNumber>;
                lastAttemptAt: z.ZodNullable<z.ZodNumber>;
                expiresAt: z.ZodNullable<z.ZodNumber>;
                refreshAfter: z.ZodNullable<z.ZodNumber>;
                version: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly refreshRegistry: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                cnpj: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly listMunicipalities: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                q: z.ZodOptional<z.ZodString>;
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                page: z.ZodArray<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                    status: z.ZodEnum<{
                        valid: "valid";
                        out_of_validity: "out_of_validity";
                        validity_unknown: "validity_unknown";
                    }>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getMunicipality: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                code: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                status: z.ZodEnum<{
                    valid: "valid";
                    out_of_validity: "out_of_validity";
                    validity_unknown: "validity_unknown";
                    not_found: "not_found";
                }>;
                entry: z.ZodNullable<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly listNcm: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                q: z.ZodOptional<z.ZodString>;
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                page: z.ZodArray<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                    status: z.ZodEnum<{
                        valid: "valid";
                        out_of_validity: "out_of_validity";
                        validity_unknown: "validity_unknown";
                    }>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getNcm: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                code: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                status: z.ZodEnum<{
                    valid: "valid";
                    out_of_validity: "out_of_validity";
                    validity_unknown: "validity_unknown";
                    not_found: "not_found";
                }>;
                entry: z.ZodNullable<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly listCompanies: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                cnpj: z.ZodString;
                kind: z.ZodEnum<{
                    declared: "declared";
                    demonstration: "demonstration";
                }>;
                registryStatus: z.ZodLiteral<"not-consulted">;
                fiscalAccess: z.ZodLiteral<"not-configured">;
            }, z.core.$strict>>;
            nextCursor: z.ZodNullable<z.ZodString>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getCompany: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                cnpj: z.ZodString;
                kind: z.ZodEnum<{
                    declared: "declared";
                    demonstration: "demonstration";
                }>;
                registryStatus: z.ZodLiteral<"not-consulted">;
                fiscalAccess: z.ZodLiteral<"not-configured">;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly reserveImport: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                files: z.ZodArray<z.ZodObject<{
                    name: z.ZodString;
                    size: z.ZodNumber;
                    sha256: z.ZodString;
                }, z.core.$strict>>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                importId: z.ZodString;
                fileIds: z.ZodArray<z.ZodString>;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getImport: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                createdAt: z.ZodNumber;
                files: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    name: z.ZodString;
                    size: z.ZodNumber;
                    sha256: z.ZodString;
                    state: z.ZodUnion<readonly [z.ZodEnum<{
                        reserved: "reserved";
                        uploaded: "uploaded";
                        accepted: "accepted";
                        expired: "expired";
                    }>, z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>]>;
                    operationId: z.ZodNullable<z.ZodString>;
                    generation: z.ZodNumber;
                    code: z.ZodNullable<z.ZodString>;
                    documentId: z.ZodNullable<z.ZodString>;
                    versionId: z.ZodNullable<z.ZodString>;
                    documents: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        documentId: z.ZodString;
                        versionId: z.ZodString;
                        number: z.ZodString;
                        code: z.ZodString;
                    }, z.core.$strict>>>;
                    result: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly createUpload: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                url: z.ZodString;
                token: z.ZodString;
                expiresAt: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly confirmImport: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly reprocessImport: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly importHistory: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                processorVersion: z.ZodString;
                completedAt: z.ZodNumber;
                code: z.ZodString;
                result: z.ZodString;
            }, z.core.$strict>>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getOperation: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                operationId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                generation: z.ZodNumber;
                attempts: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                result: z.ZodNullable<z.ZodString>;
                uncertain: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly pauseOperation: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                operationId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedGeneration: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                generation: z.ZodNumber;
                attempts: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                result: z.ZodNullable<z.ZodString>;
                uncertain: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly retryOperation: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                operationId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedGeneration: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                generation: z.ZodNumber;
                attempts: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                result: z.ZodNullable<z.ZodString>;
                uncertain: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly listDocuments: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                status: z.ZodOptional<z.ZodEnum<{
                    unknown: "unknown";
                    authorized: "authorized";
                    cancelled: "cancelled";
                    denied: "denied";
                    conflict: "conflict";
                }>>;
                source: z.ZodOptional<z.ZodEnum<{
                    "imported-xml": "imported-xml";
                    "distribution-xml": "distribution-xml";
                }>>;
                from: z.ZodOptional<z.ZodNumber>;
                to: z.ZodOptional<z.ZodNumber>;
                key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString]>>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    model: z.ZodEnum<{
                        55: "55";
                        nfse: "nfse";
                    }>;
                    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
                    kind: z.ZodString;
                    importedAt: z.ZodNumber;
                    issuedAt: z.ZodNullable<z.ZodString>;
                    number: z.ZodNullable<z.ZodString>;
                    issuer: z.ZodNullable<z.ZodString>;
                    total: z.ZodNullable<z.ZodString>;
                    completeness: z.ZodEnum<{
                        summary: "summary";
                        "full-xml": "full-xml";
                        "event-only": "event-only";
                    }>;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    fiscalStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    projectionState: z.ZodEnum<{
                        unavailable: "unavailable";
                        pending: "pending";
                        ready: "ready";
                        "limit-exceeded": "limit-exceeded";
                    }>;
                    versionId: z.ZodString;
                    resourceVersion: z.ZodNumber;
                    processing: z.ZodLiteral<"complete">;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
                indexing: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getDocument: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                versionId: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                contractVersion: z.ZodLiteral<"documents/1">;
                model: z.ZodEnum<{
                    55: "55";
                    nfse: "nfse";
                }>;
                summary: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    model: z.ZodEnum<{
                        55: "55";
                        nfse: "nfse";
                    }>;
                    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
                    kind: z.ZodString;
                    importedAt: z.ZodNumber;
                    issuedAt: z.ZodNullable<z.ZodString>;
                    number: z.ZodNullable<z.ZodString>;
                    issuer: z.ZodNullable<z.ZodString>;
                    total: z.ZodNullable<z.ZodString>;
                    completeness: z.ZodEnum<{
                        summary: "summary";
                        "full-xml": "full-xml";
                        "event-only": "event-only";
                    }>;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    fiscalStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    projectionState: z.ZodEnum<{
                        unavailable: "unavailable";
                        pending: "pending";
                        ready: "ready";
                        "limit-exceeded": "limit-exceeded";
                    }>;
                    versionId: z.ZodString;
                    resourceVersion: z.ZodNumber;
                    processing: z.ZodLiteral<"complete">;
                }, z.core.$strict>;
                payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"invoice">;
                    key: z.ZodString;
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    number: z.ZodString;
                    series: z.ZodString;
                    issuedAt: z.ZodString;
                    operation: z.ZodString;
                    purpose: z.ZodNullable<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        label: z.ZodNullable<z.ZodString>;
                        creditNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        debitNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        inconsistencies: z.ZodArray<z.ZodEnum<{
                            "B25.1-10": "B25.1-10";
                            "B25.1-20": "B25.1-20";
                            "B25.2-10": "B25.2-10";
                            "B25.2-20": "B25.2-20";
                        }>>;
                    }, z.core.$strict>>;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    declaredTotals: z.ZodObject<{
                        vNF: z.ZodString;
                        vNFTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"decimal">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"code">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"text">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>], "representation">>;
                    nt2026008: z.ZodNullable<z.ZodObject<{
                        vProdLiqTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    nt2026006: z.ZodNullable<z.ZodObject<{
                        gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                            nPag: z.ZodString;
                            idTransacao: z.ZodString;
                            tpMeioPgto: z.ZodString;
                            tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                            CNPJReceb: z.ZodString;
                            CNPJBasePSP: z.ZodString;
                        }, z.core.$strict>>>;
                    }, z.core.$strict>>;
                    protocol: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        receivedAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"summary">;
                    key: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    issuedAt: z.ZodString;
                    total: z.ZodString;
                    status: z.ZodString;
                    protocolNumber: z.ZodString;
                    receivedAt: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    protocolNumber: z.ZodString;
                    registeredAt: z.ZodString;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event-summary">;
                }, z.core.$strict>, z.ZodObject<{
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        protocolNumber: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    correction: z.ZodNullable<z.ZodObject<{
                        text: z.ZodString;
                        conditions: z.ZodString;
                    }, z.core.$strict>>;
                    manifestation: z.ZodNullable<z.ZodObject<{
                        reason: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    receipt: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        registeredAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event">;
                }, z.core.$strict>], "kind">, z.ZodObject<{
                    kind: z.ZodLiteral<"service-invoice">;
                    key: z.ZodString;
                    number: z.ZodString;
                    municipality: z.ZodString;
                    municipalRegistration: z.ZodNullable<z.ZodString>;
                    verificationCode: z.ZodString;
                    issuedAt: z.ZodString;
                    competence: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    serviceCode: z.ZodString;
                    description: z.ZodString;
                    values: z.ZodArray<z.ZodObject<{
                        name: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>;
                version: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    operationId: z.ZodString;
                    artifactId: z.ZodString;
                    sha256: z.ZodString;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    importedAt: z.ZodNumber;
                    publishedAt: z.ZodNumber;
                    parserVersion: z.ZodString;
                    normalizerVersion: z.ZodNullable<z.ZodString>;
                    processorVersion: z.ZodString;
                    schema: z.ZodNullable<z.ZodString>;
                    code: z.ZodString;
                    kind: z.ZodString;
                    itemCount: z.ZodNumber;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>;
                fiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
                previousFiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly documentJson: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                versionId: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                contractVersion: z.ZodLiteral<"documents/1">;
                model: z.ZodEnum<{
                    55: "55";
                    nfse: "nfse";
                }>;
                summary: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    model: z.ZodEnum<{
                        55: "55";
                        nfse: "nfse";
                    }>;
                    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
                    kind: z.ZodString;
                    importedAt: z.ZodNumber;
                    issuedAt: z.ZodNullable<z.ZodString>;
                    number: z.ZodNullable<z.ZodString>;
                    issuer: z.ZodNullable<z.ZodString>;
                    total: z.ZodNullable<z.ZodString>;
                    completeness: z.ZodEnum<{
                        summary: "summary";
                        "full-xml": "full-xml";
                        "event-only": "event-only";
                    }>;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    fiscalStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    projectionState: z.ZodEnum<{
                        unavailable: "unavailable";
                        pending: "pending";
                        ready: "ready";
                        "limit-exceeded": "limit-exceeded";
                    }>;
                    versionId: z.ZodString;
                    resourceVersion: z.ZodNumber;
                    processing: z.ZodLiteral<"complete">;
                }, z.core.$strict>;
                payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"invoice">;
                    key: z.ZodString;
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    number: z.ZodString;
                    series: z.ZodString;
                    issuedAt: z.ZodString;
                    operation: z.ZodString;
                    purpose: z.ZodNullable<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        label: z.ZodNullable<z.ZodString>;
                        creditNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        debitNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        inconsistencies: z.ZodArray<z.ZodEnum<{
                            "B25.1-10": "B25.1-10";
                            "B25.1-20": "B25.1-20";
                            "B25.2-10": "B25.2-10";
                            "B25.2-20": "B25.2-20";
                        }>>;
                    }, z.core.$strict>>;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    declaredTotals: z.ZodObject<{
                        vNF: z.ZodString;
                        vNFTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"decimal">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"code">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"text">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>], "representation">>;
                    nt2026008: z.ZodNullable<z.ZodObject<{
                        vProdLiqTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    nt2026006: z.ZodNullable<z.ZodObject<{
                        gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                            nPag: z.ZodString;
                            idTransacao: z.ZodString;
                            tpMeioPgto: z.ZodString;
                            tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                            CNPJReceb: z.ZodString;
                            CNPJBasePSP: z.ZodString;
                        }, z.core.$strict>>>;
                    }, z.core.$strict>>;
                    protocol: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        receivedAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"summary">;
                    key: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    issuedAt: z.ZodString;
                    total: z.ZodString;
                    status: z.ZodString;
                    protocolNumber: z.ZodString;
                    receivedAt: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    protocolNumber: z.ZodString;
                    registeredAt: z.ZodString;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event-summary">;
                }, z.core.$strict>, z.ZodObject<{
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        protocolNumber: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    correction: z.ZodNullable<z.ZodObject<{
                        text: z.ZodString;
                        conditions: z.ZodString;
                    }, z.core.$strict>>;
                    manifestation: z.ZodNullable<z.ZodObject<{
                        reason: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    receipt: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        registeredAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event">;
                }, z.core.$strict>], "kind">, z.ZodObject<{
                    kind: z.ZodLiteral<"service-invoice">;
                    key: z.ZodString;
                    number: z.ZodString;
                    municipality: z.ZodString;
                    municipalRegistration: z.ZodNullable<z.ZodString>;
                    verificationCode: z.ZodString;
                    issuedAt: z.ZodString;
                    competence: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    serviceCode: z.ZodString;
                    description: z.ZodString;
                    values: z.ZodArray<z.ZodObject<{
                        name: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>;
                version: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    operationId: z.ZodString;
                    artifactId: z.ZodString;
                    sha256: z.ZodString;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    importedAt: z.ZodNumber;
                    publishedAt: z.ZodNumber;
                    parserVersion: z.ZodString;
                    normalizerVersion: z.ZodNullable<z.ZodString>;
                    processorVersion: z.ZodString;
                    schema: z.ZodNullable<z.ZodString>;
                    code: z.ZodString;
                    kind: z.ZodString;
                    itemCount: z.ZodNumber;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>;
                fiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
                previousFiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly documentItems: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                versionId: z.ZodString;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    item: z.ZodString;
                    code: z.ZodString;
                    description: z.ZodString;
                    ncm: z.ZodString;
                    cfop: z.ZodString;
                    cest: z.ZodNullable<z.ZodString>;
                    purchaseOrder: z.ZodNullable<z.ZodString>;
                    purchaseOrderItem: z.ZodNullable<z.ZodString>;
                    unit: z.ZodString;
                    quantity: z.ZodString;
                    unitPrice: z.ZodString;
                    total: z.ZodString;
                    tributaryUnit: z.ZodString;
                    tributaryQuantity: z.ZodString;
                    tributaryUnitPrice: z.ZodString;
                    nt2026008: z.ZodNullable<z.ZodObject<{
                        vUnComLiq: z.ZodNullable<z.ZodString>;
                        vProdLiq: z.ZodNullable<z.ZodString>;
                        vICMSPrevisto: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    taxes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"decimal">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"code">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"text">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>], "representation">>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
                versionId: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly documentEvents: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                kind: z.ZodOptional<z.ZodEnum<{
                    event: "event";
                    "event-summary": "event-summary";
                }>>;
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    version: z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        operationId: z.ZodString;
                        artifactId: z.ZodString;
                        sha256: z.ZodString;
                        source: z.ZodEnum<{
                            "imported-xml": "imported-xml";
                            "distribution-xml": "distribution-xml";
                        }>;
                        importedAt: z.ZodNumber;
                        publishedAt: z.ZodNumber;
                        parserVersion: z.ZodString;
                        normalizerVersion: z.ZodNullable<z.ZodString>;
                        processorVersion: z.ZodString;
                        schema: z.ZodNullable<z.ZodString>;
                        code: z.ZodString;
                        kind: z.ZodString;
                        itemCount: z.ZodNumber;
                        originalAvailable: z.ZodBoolean;
                    }, z.core.$strict>;
                    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
                        kind: z.ZodLiteral<"invoice">;
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        number: z.ZodString;
                        series: z.ZodString;
                        issuedAt: z.ZodString;
                        operation: z.ZodString;
                        purpose: z.ZodNullable<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            label: z.ZodNullable<z.ZodString>;
                            creditNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            debitNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            inconsistencies: z.ZodArray<z.ZodEnum<{
                                "B25.1-10": "B25.1-10";
                                "B25.1-20": "B25.1-20";
                                "B25.2-10": "B25.2-10";
                                "B25.2-20": "B25.2-20";
                            }>>;
                        }, z.core.$strict>>;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        recipient: z.ZodNullable<z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        total: z.ZodString;
                        declaredTotals: z.ZodObject<{
                            vNF: z.ZodString;
                            vNFTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"decimal">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"code">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"text">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>], "representation">>;
                        nt2026008: z.ZodNullable<z.ZodObject<{
                            vProdLiqTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        nt2026006: z.ZodNullable<z.ZodObject<{
                            gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                                nPag: z.ZodString;
                                idTransacao: z.ZodString;
                                tpMeioPgto: z.ZodString;
                                tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                                CNPJReceb: z.ZodString;
                                CNPJBasePSP: z.ZodString;
                            }, z.core.$strict>>>;
                        }, z.core.$strict>>;
                        protocol: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            receivedAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        kind: z.ZodLiteral<"summary">;
                        key: z.ZodString;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        issuedAt: z.ZodString;
                        total: z.ZodString;
                        status: z.ZodString;
                        protocolNumber: z.ZodString;
                        receivedAt: z.ZodString;
                    }, z.core.$strict>, z.ZodObject<{
                        protocolNumber: z.ZodString;
                        registeredAt: z.ZodString;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event-summary">;
                    }, z.core.$strict>, z.ZodObject<{
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        cancellation: z.ZodNullable<z.ZodObject<{
                            protocolNumber: z.ZodString;
                            reason: z.ZodString;
                        }, z.core.$strict>>;
                        correction: z.ZodNullable<z.ZodObject<{
                            text: z.ZodString;
                            conditions: z.ZodString;
                        }, z.core.$strict>>;
                        manifestation: z.ZodNullable<z.ZodObject<{
                            reason: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        receipt: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            type: z.ZodString;
                            sequence: z.ZodString;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            registeredAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event">;
                    }, z.core.$strict>], "kind">;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly documentVersions: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    version: z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        operationId: z.ZodString;
                        artifactId: z.ZodString;
                        sha256: z.ZodString;
                        source: z.ZodEnum<{
                            "imported-xml": "imported-xml";
                            "distribution-xml": "distribution-xml";
                        }>;
                        importedAt: z.ZodNumber;
                        publishedAt: z.ZodNumber;
                        parserVersion: z.ZodString;
                        normalizerVersion: z.ZodNullable<z.ZodString>;
                        processorVersion: z.ZodString;
                        schema: z.ZodNullable<z.ZodString>;
                        code: z.ZodString;
                        kind: z.ZodString;
                        itemCount: z.ZodNumber;
                        originalAvailable: z.ZodBoolean;
                    }, z.core.$strict>;
                    payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                        kind: z.ZodLiteral<"invoice">;
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        number: z.ZodString;
                        series: z.ZodString;
                        issuedAt: z.ZodString;
                        operation: z.ZodString;
                        purpose: z.ZodNullable<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            label: z.ZodNullable<z.ZodString>;
                            creditNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            debitNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            inconsistencies: z.ZodArray<z.ZodEnum<{
                                "B25.1-10": "B25.1-10";
                                "B25.1-20": "B25.1-20";
                                "B25.2-10": "B25.2-10";
                                "B25.2-20": "B25.2-20";
                            }>>;
                        }, z.core.$strict>>;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        recipient: z.ZodNullable<z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        total: z.ZodString;
                        declaredTotals: z.ZodObject<{
                            vNF: z.ZodString;
                            vNFTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"decimal">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"code">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"text">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>], "representation">>;
                        nt2026008: z.ZodNullable<z.ZodObject<{
                            vProdLiqTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        nt2026006: z.ZodNullable<z.ZodObject<{
                            gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                                nPag: z.ZodString;
                                idTransacao: z.ZodString;
                                tpMeioPgto: z.ZodString;
                                tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                                CNPJReceb: z.ZodString;
                                CNPJBasePSP: z.ZodString;
                            }, z.core.$strict>>>;
                        }, z.core.$strict>>;
                        protocol: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            receivedAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        kind: z.ZodLiteral<"summary">;
                        key: z.ZodString;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        issuedAt: z.ZodString;
                        total: z.ZodString;
                        status: z.ZodString;
                        protocolNumber: z.ZodString;
                        receivedAt: z.ZodString;
                    }, z.core.$strict>, z.ZodObject<{
                        protocolNumber: z.ZodString;
                        registeredAt: z.ZodString;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event-summary">;
                    }, z.core.$strict>, z.ZodObject<{
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        cancellation: z.ZodNullable<z.ZodObject<{
                            protocolNumber: z.ZodString;
                            reason: z.ZodString;
                        }, z.core.$strict>>;
                        correction: z.ZodNullable<z.ZodObject<{
                            text: z.ZodString;
                            conditions: z.ZodString;
                        }, z.core.$strict>>;
                        manifestation: z.ZodNullable<z.ZodObject<{
                            reason: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        receipt: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            type: z.ZodString;
                            sequence: z.ZodString;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            registeredAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event">;
                    }, z.core.$strict>], "kind">, z.ZodObject<{
                        kind: z.ZodLiteral<"service-invoice">;
                        key: z.ZodString;
                        number: z.ZodString;
                        municipality: z.ZodString;
                        municipalRegistration: z.ZodNullable<z.ZodString>;
                        verificationCode: z.ZodString;
                        issuedAt: z.ZodString;
                        competence: z.ZodString;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        recipient: z.ZodNullable<z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        total: z.ZodString;
                        serviceCode: z.ZodString;
                        description: z.ZodString;
                        values: z.ZodArray<z.ZodObject<{
                            name: z.ZodString;
                            value: z.ZodString;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly documentFiles: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    name: z.ZodString;
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    importedAt: z.ZodNumber;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly listArtifacts: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    name: z.ZodString;
                    sha256: z.ZodString;
                    importedAt: z.ZodNumber;
                    size: z.ZodNumber;
                    code: z.ZodString;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly reprocessDocument: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly createIssuance: {
        /** Response header pointing to the accepted resource. */
        readonly location: "/v1/issuances/{issuanceId}";
        readonly method: "GET" | "POST" | "PATCH";
        readonly path: string;
        readonly input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                activityCode: z.ZodString;
                competence: z.ZodString;
                issueDate: z.ZodOptional<z.ZodString>;
                issuerEmail: z.ZodOptional<z.ZodString>;
                market: z.ZodEnum<{
                    domestic: "domestic";
                    export: "export";
                }>;
                taker: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"national">;
                    document: z.ZodString;
                    name: z.ZodString;
                    email: z.ZodOptional<z.ZodString>;
                    address: z.ZodObject<{
                        municipalityCode: z.ZodString;
                        postalCode: z.ZodString;
                        street: z.ZodString;
                        number: z.ZodString;
                        district: z.ZodString;
                    }, z.core.$strict>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"foreign">;
                    nif: z.ZodOptional<z.ZodString>;
                    nifAbsence: z.ZodOptional<z.ZodNumber>;
                    name: z.ZodString;
                    email: z.ZodOptional<z.ZodString>;
                    address: z.ZodObject<{
                        country: z.ZodString;
                        city: z.ZodString;
                        postalCode: z.ZodString;
                        state: z.ZodString;
                        street: z.ZodString;
                        number: z.ZodString;
                        district: z.ZodString;
                    }, z.core.$strict>;
                }, z.core.$strict>], "kind">;
                description: z.ZodString;
                amount: z.ZodObject<{
                    currency: z.ZodString;
                    value: z.ZodString;
                }, z.core.$strict>;
                issRate: z.ZodOptional<z.ZodString>;
                issWithheld: z.ZodBoolean;
            }, z.core.$strict>;
        }, z.core.$strict>;
        readonly output: z.ZodObject<{
            data: z.ZodObject<{
                reused: z.ZodBoolean;
                issuance: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                    environment: z.ZodEnum<{
                        sandbox: "sandbox";
                        production: "production";
                    }>;
                    operationId: z.ZodString;
                    operationState: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>;
                    state: z.ZodEnum<{
                        authorized: "authorized";
                        cancelled: "cancelled";
                        processing: "processing";
                        rejected: "rejected";
                    }>;
                    transport: z.ZodEnum<{
                        simulated: "simulated";
                        "producao-restrita": "producao-restrita";
                        producao: "producao";
                    }>;
                    target: z.ZodString;
                    series: z.ZodString;
                    number: z.ZodNumber;
                    dpsId: z.ZodString;
                    issueDate: z.ZodString;
                    competence: z.ZodString;
                    market: z.ZodEnum<{
                        domestic: "domestic";
                        export: "export";
                    }>;
                    amount: z.ZodObject<{
                        currency: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>;
                    serviceBrl: z.ZodNullable<z.ZodString>;
                    exchange: z.ZodNullable<z.ZodObject<{
                        currency: z.ZodString;
                        amount: z.ZodString;
                        rate: z.ZodString;
                        quoteDate: z.ZodString;
                        brlAmount: z.ZodString;
                        source: z.ZodEnum<{
                            simulated: "simulated";
                            "ptax-bcb": "ptax-bcb";
                        }>;
                        frozenAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    accessKey: z.ZodNullable<z.ZodString>;
                    nfseNumber: z.ZodNullable<z.ZodString>;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    artifacts: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        kind: z.ZodEnum<{
                            nfse: "nfse";
                            dps: "dps";
                            danfse: "danfse";
                            "cancel-request": "cancel-request";
                            "cancel-event": "cancel-event";
                        }>;
                        sha256: z.ZodString;
                        size: z.ZodNumber;
                        signed: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        id: z.ZodString;
                        operationId: z.ZodString;
                        state: z.ZodEnum<{
                            processing: "processing";
                            rejected: "rejected";
                            registered: "registered";
                        }>;
                        sequence: z.ZodNumber;
                        reasonCode: z.ZodEnum<{
                            1: "1";
                            2: "2";
                            9: "9";
                        }>;
                        reason: z.ZodString;
                        code: z.ZodNullable<z.ZodString>;
                        rejections: z.ZodArray<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            message: z.ZodString;
                        }, z.core.$strict>>;
                        alreadyRegistered: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                        updatedAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    version: z.ZodNumber;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        readonly scope: string;
        readonly retry: RetryPolicy;
        readonly status: number;
        readonly idempotencyPattern: string;
    };
    readonly listIssuances: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                state: z.ZodOptional<z.ZodEnum<{
                    authorized: "authorized";
                    cancelled: "cancelled";
                    processing: "processing";
                    rejected: "rejected";
                }>>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                    environment: z.ZodEnum<{
                        sandbox: "sandbox";
                        production: "production";
                    }>;
                    operationId: z.ZodString;
                    operationState: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>;
                    state: z.ZodEnum<{
                        authorized: "authorized";
                        cancelled: "cancelled";
                        processing: "processing";
                        rejected: "rejected";
                    }>;
                    transport: z.ZodEnum<{
                        simulated: "simulated";
                        "producao-restrita": "producao-restrita";
                        producao: "producao";
                    }>;
                    target: z.ZodString;
                    series: z.ZodString;
                    number: z.ZodNumber;
                    dpsId: z.ZodString;
                    issueDate: z.ZodString;
                    competence: z.ZodString;
                    market: z.ZodEnum<{
                        domestic: "domestic";
                        export: "export";
                    }>;
                    amount: z.ZodObject<{
                        currency: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>;
                    serviceBrl: z.ZodNullable<z.ZodString>;
                    exchange: z.ZodNullable<z.ZodObject<{
                        currency: z.ZodString;
                        amount: z.ZodString;
                        rate: z.ZodString;
                        quoteDate: z.ZodString;
                        brlAmount: z.ZodString;
                        source: z.ZodEnum<{
                            simulated: "simulated";
                            "ptax-bcb": "ptax-bcb";
                        }>;
                        frozenAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    accessKey: z.ZodNullable<z.ZodString>;
                    nfseNumber: z.ZodNullable<z.ZodString>;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    artifacts: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        kind: z.ZodEnum<{
                            nfse: "nfse";
                            dps: "dps";
                            danfse: "danfse";
                            "cancel-request": "cancel-request";
                            "cancel-event": "cancel-event";
                        }>;
                        sha256: z.ZodString;
                        size: z.ZodNumber;
                        signed: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        id: z.ZodString;
                        operationId: z.ZodString;
                        state: z.ZodEnum<{
                            processing: "processing";
                            rejected: "rejected";
                            registered: "registered";
                        }>;
                        sequence: z.ZodNumber;
                        reasonCode: z.ZodEnum<{
                            1: "1";
                            2: "2";
                            9: "9";
                        }>;
                        reason: z.ZodString;
                        code: z.ZodNullable<z.ZodString>;
                        rejections: z.ZodArray<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            message: z.ZodString;
                        }, z.core.$strict>>;
                        alreadyRegistered: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                        updatedAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    version: z.ZodNumber;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getIssuance: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                issuanceId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
                projectId: z.ZodString;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                operationId: z.ZodString;
                operationState: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                state: z.ZodEnum<{
                    authorized: "authorized";
                    cancelled: "cancelled";
                    processing: "processing";
                    rejected: "rejected";
                }>;
                transport: z.ZodEnum<{
                    simulated: "simulated";
                    "producao-restrita": "producao-restrita";
                    producao: "producao";
                }>;
                target: z.ZodString;
                series: z.ZodString;
                number: z.ZodNumber;
                dpsId: z.ZodString;
                issueDate: z.ZodString;
                competence: z.ZodString;
                market: z.ZodEnum<{
                    domestic: "domestic";
                    export: "export";
                }>;
                amount: z.ZodObject<{
                    currency: z.ZodString;
                    value: z.ZodString;
                }, z.core.$strict>;
                serviceBrl: z.ZodNullable<z.ZodString>;
                exchange: z.ZodNullable<z.ZodObject<{
                    currency: z.ZodString;
                    amount: z.ZodString;
                    rate: z.ZodString;
                    quoteDate: z.ZodString;
                    brlAmount: z.ZodString;
                    source: z.ZodEnum<{
                        simulated: "simulated";
                        "ptax-bcb": "ptax-bcb";
                    }>;
                    frozenAt: z.ZodNumber;
                }, z.core.$strict>>;
                accessKey: z.ZodNullable<z.ZodString>;
                nfseNumber: z.ZodNullable<z.ZodString>;
                code: z.ZodNullable<z.ZodString>;
                rejections: z.ZodArray<z.ZodObject<{
                    code: z.ZodNullable<z.ZodString>;
                    message: z.ZodString;
                }, z.core.$strict>>;
                artifacts: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    kind: z.ZodEnum<{
                        nfse: "nfse";
                        dps: "dps";
                        danfse: "danfse";
                        "cancel-request": "cancel-request";
                        "cancel-event": "cancel-event";
                    }>;
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                    signed: z.ZodBoolean;
                    createdAt: z.ZodNumber;
                }, z.core.$strict>>;
                cancellation: z.ZodNullable<z.ZodObject<{
                    id: z.ZodString;
                    operationId: z.ZodString;
                    state: z.ZodEnum<{
                        processing: "processing";
                        rejected: "rejected";
                        registered: "registered";
                    }>;
                    sequence: z.ZodNumber;
                    reasonCode: z.ZodEnum<{
                        1: "1";
                        2: "2";
                        9: "9";
                    }>;
                    reason: z.ZodString;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    alreadyRegistered: z.ZodBoolean;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>>;
                version: z.ZodNumber;
                createdAt: z.ZodNumber;
                updatedAt: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly cancelIssuance: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                issuanceId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                reasonCode: z.ZodEnum<{
                    1: "1";
                    2: "2";
                    9: "9";
                }>;
                reason: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                reused: z.ZodBoolean;
                issuance: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                    environment: z.ZodEnum<{
                        sandbox: "sandbox";
                        production: "production";
                    }>;
                    operationId: z.ZodString;
                    operationState: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>;
                    state: z.ZodEnum<{
                        authorized: "authorized";
                        cancelled: "cancelled";
                        processing: "processing";
                        rejected: "rejected";
                    }>;
                    transport: z.ZodEnum<{
                        simulated: "simulated";
                        "producao-restrita": "producao-restrita";
                        producao: "producao";
                    }>;
                    target: z.ZodString;
                    series: z.ZodString;
                    number: z.ZodNumber;
                    dpsId: z.ZodString;
                    issueDate: z.ZodString;
                    competence: z.ZodString;
                    market: z.ZodEnum<{
                        domestic: "domestic";
                        export: "export";
                    }>;
                    amount: z.ZodObject<{
                        currency: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>;
                    serviceBrl: z.ZodNullable<z.ZodString>;
                    exchange: z.ZodNullable<z.ZodObject<{
                        currency: z.ZodString;
                        amount: z.ZodString;
                        rate: z.ZodString;
                        quoteDate: z.ZodString;
                        brlAmount: z.ZodString;
                        source: z.ZodEnum<{
                            simulated: "simulated";
                            "ptax-bcb": "ptax-bcb";
                        }>;
                        frozenAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    accessKey: z.ZodNullable<z.ZodString>;
                    nfseNumber: z.ZodNullable<z.ZodString>;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    artifacts: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        kind: z.ZodEnum<{
                            nfse: "nfse";
                            dps: "dps";
                            danfse: "danfse";
                            "cancel-request": "cancel-request";
                            "cancel-event": "cancel-event";
                        }>;
                        sha256: z.ZodString;
                        size: z.ZodNumber;
                        signed: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        id: z.ZodString;
                        operationId: z.ZodString;
                        state: z.ZodEnum<{
                            processing: "processing";
                            rejected: "rejected";
                            registered: "registered";
                        }>;
                        sequence: z.ZodNumber;
                        reasonCode: z.ZodEnum<{
                            1: "1";
                            2: "2";
                            9: "9";
                        }>;
                        reason: z.ZodString;
                        code: z.ZodNullable<z.ZodString>;
                        rejections: z.ZodArray<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            message: z.ZodString;
                        }, z.core.$strict>>;
                        alreadyRegistered: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                        updatedAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    version: z.ZodNumber;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly listWebhookEndpoints: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodArray<z.ZodObject<{
                active: z.ZodBoolean;
                version: z.ZodNumber;
                secretVersion: z.ZodNumber;
                previousUntil: z.ZodNullable<z.ZodNumber>;
                createdAt: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                id: z.ZodString;
            }, z.core.$strict>>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getWebhookEndpoint: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                active: z.ZodBoolean;
                version: z.ZodNumber;
                secretVersion: z.ZodNumber;
                previousUntil: z.ZodNullable<z.ZodNumber>;
                createdAt: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                id: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly createWebhookEndpoint: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                companyId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                endpoint: z.ZodObject<{
                    active: z.ZodBoolean;
                    version: z.ZodNumber;
                    secretVersion: z.ZodNumber;
                    previousUntil: z.ZodNullable<z.ZodNumber>;
                    createdAt: z.ZodNumber;
                    name: z.ZodString;
                    url: z.ZodString;
                    events: z.ZodArray<z.ZodEnum<{
                        "document.received": "document.received";
                        "document.updated": "document.updated";
                        "document.event_received": "document.event_received";
                        "import.completed": "import.completed";
                        "connection.attention_required": "connection.attention_required";
                        "connection.release_withdrawn": "connection.release_withdrawn";
                        "connection.history_limited": "connection.history_limited";
                        "issuance.authorized": "issuance.authorized";
                        "issuance.rejected": "issuance.rejected";
                        "issuance.cancelled": "issuance.cancelled";
                        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                    }>>;
                    id: z.ZodString;
                }, z.core.$strict>;
                secret: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly editWebhookEndpoint: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                active: z.ZodBoolean;
                expectedVersion: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                active: z.ZodBoolean;
                version: z.ZodNumber;
                secretVersion: z.ZodNumber;
                previousUntil: z.ZodNullable<z.ZodNumber>;
                createdAt: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                id: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly rotateWebhookSecret: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedVersion: z.ZodNumber;
                overlapMs: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                endpoint: z.ZodObject<{
                    active: z.ZodBoolean;
                    version: z.ZodNumber;
                    secretVersion: z.ZodNumber;
                    previousUntil: z.ZodNullable<z.ZodNumber>;
                    createdAt: z.ZodNumber;
                    name: z.ZodString;
                    url: z.ZodString;
                    events: z.ZodArray<z.ZodEnum<{
                        "document.received": "document.received";
                        "document.updated": "document.updated";
                        "document.event_received": "document.event_received";
                        "import.completed": "import.completed";
                        "connection.attention_required": "connection.attention_required";
                        "connection.release_withdrawn": "connection.release_withdrawn";
                        "connection.history_limited": "connection.history_limited";
                        "issuance.authorized": "issuance.authorized";
                        "issuance.rejected": "issuance.rejected";
                        "issuance.cancelled": "issuance.cancelled";
                        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                    }>>;
                    id: z.ZodString;
                }, z.core.$strict>;
                secret: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly testWebhookEndpoint: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                eventId: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly listWebhookDeliveries: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                endpointId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                items: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    eventId: z.ZodString;
                    type: z.ZodEnum<{
                        "document.received": "document.received";
                        "document.updated": "document.updated";
                        "document.event_received": "document.event_received";
                        "import.completed": "import.completed";
                        "connection.attention_required": "connection.attention_required";
                        "connection.release_withdrawn": "connection.release_withdrawn";
                        "connection.history_limited": "connection.history_limited";
                        "issuance.authorized": "issuance.authorized";
                        "issuance.rejected": "issuance.rejected";
                        "issuance.cancelled": "issuance.cancelled";
                        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                        "webhook.test": "webhook.test";
                    }>;
                    resourceVersion: z.ZodNumber;
                    state: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        paused: "paused";
                        failed: "failed";
                        delivered: "delivered";
                    }>;
                    attempts: z.ZodNumber;
                    resends: z.ZodNumber;
                    generation: z.ZodNumber;
                    nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                    code: z.ZodNullable<z.ZodString>;
                    httpStatus: z.ZodNullable<z.ZodNumber>;
                    durationMs: z.ZodNullable<z.ZodNumber>;
                    response: z.ZodNullable<z.ZodString>;
                    createdAt: z.ZodNumber;
                    canRetry: z.ZodBoolean;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly retryWebhookDelivery: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                deliveryId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedGeneration: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                eventId: z.ZodString;
                type: z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                    "webhook.test": "webhook.test";
                }>;
                resourceVersion: z.ZodNumber;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    paused: "paused";
                    failed: "failed";
                    delivered: "delivered";
                }>;
                attempts: z.ZodNumber;
                resends: z.ZodNumber;
                generation: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                httpStatus: z.ZodNullable<z.ZodNumber>;
                durationMs: z.ZodNullable<z.ZodNumber>;
                response: z.ZodNullable<z.ZodString>;
                createdAt: z.ZodNumber;
                canRetry: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
    readonly getCapabilities: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                apiVersion: z.ZodLiteral<"8.0.0">;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                models: z.ZodArray<z.ZodEnum<{
                    55: "55";
                    nfse: "nfse";
                }>>;
                capabilities: z.ZodArray<z.ZodString>;
                webhookEvents: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                limits: z.ZodObject<{
                    importFiles: z.ZodNumber;
                    importBytes: z.ZodNumber;
                    pageSize: z.ZodNumber;
                }, z.core.$strict>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    };
};
export type RouteName = keyof typeof routes;
export declare const uploadResponse: z.ZodObject<{
    data: z.ZodObject<{
        uploaded: z.ZodLiteral<true>;
    }, z.core.$strict>;
    requestId: z.ZodString;
}, z.core.$strict>;
/** Transport definitions share this source; SDK upload sends bytes instead of JSON. */
export declare const transferPaths: {
    readonly "/v1/export-download": {
        readonly get: {
            readonly operationId: "downloadExportPart";
            readonly "x-scope": "ticket privado com acesso revalidado";
            readonly "x-retry-policy": "never";
            readonly security: readonly [];
            readonly parameters: readonly [{
                readonly name: "X-Download-Token";
                readonly in: "header";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly minLength: 72;
                    readonly maxLength: 72;
                };
            }];
            readonly responses: {
                readonly 200: {
                    readonly description: "Parte gzip JSONL; ticket válido por até 60 segundos; Cache-Control: no-store";
                    readonly content: {
                        readonly "application/gzip": {
                            readonly schema: {
                                readonly type: "string";
                                readonly format: "binary";
                            };
                        };
                    };
                };
                readonly default: {
                    readonly description: "Ticket expirado ou acesso revogado";
                    readonly headers: {
                        readonly "X-Request-Id": {
                            readonly schema: {
                                readonly type: "string";
                            };
                        };
                        readonly "Cache-Control": {
                            readonly schema: {
                                readonly type: "string";
                                readonly const: "no-store";
                            };
                        };
                    };
                    readonly content: {
                        readonly "application/json": {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/Error";
                            };
                        };
                    };
                };
            };
        };
    };
    readonly "/v1/import-upload": {
        readonly post: {
            readonly operationId: "uploadImport";
            readonly "x-scope": "ticket de upload";
            readonly "x-retry-policy": "never";
            readonly security: readonly [{
                readonly uploadTicket: readonly [];
            }];
            readonly parameters: readonly [{
                readonly name: "X-Upload-Token";
                readonly in: "header";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly minLength: 72;
                    readonly maxLength: 72;
                };
            }];
            readonly requestBody: {
                readonly required: true;
                readonly content: {
                    readonly "application/xml": {
                        readonly schema: {
                            readonly type: "string";
                            readonly format: "binary";
                            readonly "x-max-bytes": 2097152;
                        };
                    };
                };
            };
            readonly responses: {
                readonly 200: {
                    readonly description: "Bytes conferidos; confirmação ainda necessária";
                    readonly content: {
                        readonly "application/json": {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/UploadResponse";
                            };
                        };
                    };
                };
                readonly default: {
                    readonly description: "Ticket ou bytes inválidos";
                    readonly content: {
                        readonly "application/json": {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/Error";
                            };
                        };
                    };
                };
            };
        };
    };
    readonly "/v1/document-artifacts/{artifactId}/original": {
        readonly get: {
            readonly operationId: "downloadOriginal";
            readonly "x-scope": "documents:read";
            readonly "x-retry-policy": "never";
            readonly parameters: readonly [{
                readonly name: "artifactId";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                };
            }, {
                readonly name: "companyId";
                readonly in: "query";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                };
            }, {
                readonly name: "X-Environment";
                readonly in: "header";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly enum: readonly ["sandbox", "production"];
                };
            }];
            readonly responses: {
                readonly 200: {
                    readonly description: "Bytes originais; autorização revalidada no acesso";
                    readonly content: {
                        readonly "application/octet-stream": {
                            readonly schema: {
                                readonly type: "string";
                                readonly format: "binary";
                            };
                        };
                    };
                };
                readonly default: {
                    readonly description: "Acesso negado ou original indisponível";
                    readonly content: {
                        readonly "application/json": {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/Error";
                            };
                        };
                    };
                };
            };
        };
    };
    readonly "/v1/documents/{documentId}/danfe": {
        readonly get: {
            readonly operationId: "downloadDanfe";
            readonly "x-scope": "documents:read";
            readonly "x-retry-policy": "never";
            readonly parameters: readonly [{
                readonly name: "documentId";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly minLength: 1;
                    readonly maxLength: 128;
                };
            }, {
                readonly name: "companyId";
                readonly in: "query";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly minLength: 1;
                    readonly maxLength: 128;
                };
            }, {
                readonly name: "X-Environment";
                readonly in: "header";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly enum: readonly ["sandbox", "production"];
                };
            }];
            readonly responses: {
                readonly 200: {
                    readonly description: "PDF do DANFE, representação auxiliar gerada do XML preservado da NF-e modelo 55 e dos eventos de cancelamento preservados; o XML original não muda. A primeira chamada pode gerar o arquivo; autorização revalidada no acesso";
                    readonly content: {
                        readonly "application/pdf": {
                            readonly schema: {
                                readonly type: "string";
                                readonly format: "binary";
                            };
                        };
                    };
                };
                readonly default: {
                    readonly description: "Acesso negado, documento sem DANFE (DANFE_UNAVAILABLE: não é NF-e 55 com XML completo, ou o gerador recusou o XML) ou geração limitada";
                    readonly content: {
                        readonly "application/json": {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/Error";
                            };
                        };
                    };
                };
            };
        };
    };
    readonly "/v1/issuances/{issuanceId}/artifacts/{artifactId}": {
        readonly get: {
            readonly operationId: "downloadIssuanceArtifact";
            readonly "x-scope": "documents:issue ou documents:cancel";
            readonly "x-retry-policy": "never";
            readonly parameters: readonly [{
                readonly name: "issuanceId";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly minLength: 1;
                    readonly maxLength: 128;
                };
            }, {
                readonly name: "artifactId";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly minLength: 1;
                    readonly maxLength: 128;
                };
            }, {
                readonly name: "companyId";
                readonly in: "query";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly minLength: 1;
                    readonly maxLength: 128;
                };
            }, {
                readonly name: "X-Environment";
                readonly in: "header";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly enum: readonly ["sandbox", "production"];
                };
            }];
            readonly responses: {
                readonly 200: {
                    readonly description: "Artefato preservado da emissão: XML (DPS, NFS-e, pedido ou retorno do evento) ou PDF do DANFSe; autorização revalidada no acesso";
                    readonly content: {
                        readonly "application/octet-stream": {
                            readonly schema: {
                                readonly type: "string";
                                readonly format: "binary";
                            };
                        };
                    };
                };
                readonly default: {
                    readonly description: "Acesso negado ou artefato indisponível";
                    readonly content: {
                        readonly "application/json": {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/Error";
                            };
                        };
                    };
                };
            };
        };
    };
};
export type RequestOf<K extends RouteName> = z.infer<(typeof routes)[K]["input"]>;
export type ResponseOf<K extends RouteName> = z.infer<(typeof routes)[K]["output"]>;
/** Query coercion is transport-only. Schemas and SDK still use typed numbers. */
export declare function matchRoute(method: string, pathname: string): {
    name: RouteName;
    entry: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                documentId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                selection: z.ZodObject<{
                    kind: z.ZodLiteral<"document">;
                    documentId: z.ZodString;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                }, z.core.$strict>;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    running: "running";
                    succeeded: "succeeded";
                    failed: "failed";
                    expired: "expired";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodNumber;
                expiresAt: z.ZodNumber;
                parts: z.ZodNumber;
                bytes: z.ZodNumber;
                code: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                exportId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                selection: z.ZodObject<{
                    kind: z.ZodLiteral<"document">;
                    documentId: z.ZodString;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                }, z.core.$strict>;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    running: "running";
                    succeeded: "succeeded";
                    failed: "failed";
                    expired: "expired";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodNumber;
                expiresAt: z.ZodNumber;
                parts: z.ZodNumber;
                bytes: z.ZodNumber;
                code: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                exportId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    sequence: z.ZodNumber;
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                exportId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                selection: z.ZodObject<{
                    kind: z.ZodLiteral<"document">;
                    documentId: z.ZodString;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                }, z.core.$strict>;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    running: "running";
                    succeeded: "succeeded";
                    failed: "failed";
                    expired: "expired";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodNumber;
                expiresAt: z.ZodNumber;
                parts: z.ZodNumber;
                bytes: z.ZodNumber;
                code: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                partId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                token: z.ZodString;
                expiresAt: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                action: z.ZodEnum<{
                    activate: "activate";
                    sync: "sync";
                    pause: "pause";
                    resume: "resume";
                }>;
                expectedVersion: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                organizationId: z.ZodString;
                companyId: z.ZodString;
                projectId: z.ZodString;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    paused: "paused";
                    active: "active";
                    attention: "attention";
                }>;
                version: z.ZodNumber;
                checkpoint: z.ZodString;
                sourceCursor: z.ZodNullable<z.ZodString>;
                sourceMaxNsu: z.ZodNullable<z.ZodString>;
                nextAllowedAt: z.ZodNumber;
                lastAttemptAt: z.ZodNullable<z.ZodNumber>;
                lastSuccessAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                received: z.ZodNumber;
                operationId: z.ZodNullable<z.ZodString>;
                operationState: z.ZodNullable<z.ZodString>;
                certificateState: z.ZodString;
                certificateExpiresAt: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodNullable<z.ZodObject<{
                id: z.ZodString;
                organizationId: z.ZodString;
                companyId: z.ZodString;
                projectId: z.ZodString;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    paused: "paused";
                    active: "active";
                    attention: "attention";
                }>;
                version: z.ZodNumber;
                checkpoint: z.ZodString;
                sourceCursor: z.ZodNullable<z.ZodString>;
                sourceMaxNsu: z.ZodNullable<z.ZodString>;
                nextAllowedAt: z.ZodNumber;
                lastAttemptAt: z.ZodNullable<z.ZodNumber>;
                lastSuccessAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                received: z.ZodNumber;
                operationId: z.ZodNullable<z.ZodString>;
                operationState: z.ZodNullable<z.ZodString>;
                certificateState: z.ZodString;
                certificateExpiresAt: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                cnpj: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                cnpj: z.ZodString;
                provider: z.ZodLiteral<"opencnpj">;
                sourceUrl: z.ZodLiteral<"https://opencnpj.org/">;
                status: z.ZodEnum<{
                    not_found: "not_found";
                    not_consulted: "not_consulted";
                    found: "found";
                    unavailable: "unavailable";
                    unsupported_format: "unsupported_format";
                }>;
                freshness: z.ZodEnum<{
                    missing: "missing";
                    fresh: "fresh";
                    stale: "stale";
                }>;
                data: z.ZodNullable<z.ZodObject<{
                    name: z.ZodString;
                    status: z.ZodString;
                    address: z.ZodObject<{
                        street: z.ZodString;
                        number: z.ZodString;
                        complement: z.ZodString;
                        district: z.ZodString;
                        city: z.ZodString;
                        state: z.ZodString;
                        postalCode: z.ZodString;
                    }, z.core.$strict>;
                }, z.core.$strict>>;
                sourceUpdatedAt: z.ZodNullable<z.ZodNumber>;
                consultedAt: z.ZodNullable<z.ZodNumber>;
                lastAttemptAt: z.ZodNullable<z.ZodNumber>;
                expiresAt: z.ZodNullable<z.ZodNumber>;
                refreshAfter: z.ZodNullable<z.ZodNumber>;
                version: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                cnpj: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                q: z.ZodOptional<z.ZodString>;
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                page: z.ZodArray<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                    status: z.ZodEnum<{
                        valid: "valid";
                        out_of_validity: "out_of_validity";
                        validity_unknown: "validity_unknown";
                    }>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                code: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                status: z.ZodEnum<{
                    valid: "valid";
                    out_of_validity: "out_of_validity";
                    validity_unknown: "validity_unknown";
                    not_found: "not_found";
                }>;
                entry: z.ZodNullable<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                q: z.ZodOptional<z.ZodString>;
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                page: z.ZodArray<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                    status: z.ZodEnum<{
                        valid: "valid";
                        out_of_validity: "out_of_validity";
                        validity_unknown: "validity_unknown";
                    }>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                code: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                status: z.ZodEnum<{
                    valid: "valid";
                    out_of_validity: "out_of_validity";
                    validity_unknown: "validity_unknown";
                    not_found: "not_found";
                }>;
                entry: z.ZodNullable<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                cnpj: z.ZodString;
                kind: z.ZodEnum<{
                    declared: "declared";
                    demonstration: "demonstration";
                }>;
                registryStatus: z.ZodLiteral<"not-consulted">;
                fiscalAccess: z.ZodLiteral<"not-configured">;
            }, z.core.$strict>>;
            nextCursor: z.ZodNullable<z.ZodString>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                cnpj: z.ZodString;
                kind: z.ZodEnum<{
                    declared: "declared";
                    demonstration: "demonstration";
                }>;
                registryStatus: z.ZodLiteral<"not-consulted">;
                fiscalAccess: z.ZodLiteral<"not-configured">;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                files: z.ZodArray<z.ZodObject<{
                    name: z.ZodString;
                    size: z.ZodNumber;
                    sha256: z.ZodString;
                }, z.core.$strict>>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                importId: z.ZodString;
                fileIds: z.ZodArray<z.ZodString>;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                createdAt: z.ZodNumber;
                files: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    name: z.ZodString;
                    size: z.ZodNumber;
                    sha256: z.ZodString;
                    state: z.ZodUnion<readonly [z.ZodEnum<{
                        reserved: "reserved";
                        uploaded: "uploaded";
                        accepted: "accepted";
                        expired: "expired";
                    }>, z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>]>;
                    operationId: z.ZodNullable<z.ZodString>;
                    generation: z.ZodNumber;
                    code: z.ZodNullable<z.ZodString>;
                    documentId: z.ZodNullable<z.ZodString>;
                    versionId: z.ZodNullable<z.ZodString>;
                    documents: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        documentId: z.ZodString;
                        versionId: z.ZodString;
                        number: z.ZodString;
                        code: z.ZodString;
                    }, z.core.$strict>>>;
                    result: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                url: z.ZodString;
                token: z.ZodString;
                expiresAt: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                processorVersion: z.ZodString;
                completedAt: z.ZodNumber;
                code: z.ZodString;
                result: z.ZodString;
            }, z.core.$strict>>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                operationId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                generation: z.ZodNumber;
                attempts: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                result: z.ZodNullable<z.ZodString>;
                uncertain: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                operationId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedGeneration: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                generation: z.ZodNumber;
                attempts: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                result: z.ZodNullable<z.ZodString>;
                uncertain: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                operationId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedGeneration: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                generation: z.ZodNumber;
                attempts: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                result: z.ZodNullable<z.ZodString>;
                uncertain: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                status: z.ZodOptional<z.ZodEnum<{
                    unknown: "unknown";
                    authorized: "authorized";
                    cancelled: "cancelled";
                    denied: "denied";
                    conflict: "conflict";
                }>>;
                source: z.ZodOptional<z.ZodEnum<{
                    "imported-xml": "imported-xml";
                    "distribution-xml": "distribution-xml";
                }>>;
                from: z.ZodOptional<z.ZodNumber>;
                to: z.ZodOptional<z.ZodNumber>;
                key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString]>>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    model: z.ZodEnum<{
                        55: "55";
                        nfse: "nfse";
                    }>;
                    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
                    kind: z.ZodString;
                    importedAt: z.ZodNumber;
                    issuedAt: z.ZodNullable<z.ZodString>;
                    number: z.ZodNullable<z.ZodString>;
                    issuer: z.ZodNullable<z.ZodString>;
                    total: z.ZodNullable<z.ZodString>;
                    completeness: z.ZodEnum<{
                        summary: "summary";
                        "full-xml": "full-xml";
                        "event-only": "event-only";
                    }>;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    fiscalStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    projectionState: z.ZodEnum<{
                        unavailable: "unavailable";
                        pending: "pending";
                        ready: "ready";
                        "limit-exceeded": "limit-exceeded";
                    }>;
                    versionId: z.ZodString;
                    resourceVersion: z.ZodNumber;
                    processing: z.ZodLiteral<"complete">;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
                indexing: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                versionId: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                contractVersion: z.ZodLiteral<"documents/1">;
                model: z.ZodEnum<{
                    55: "55";
                    nfse: "nfse";
                }>;
                summary: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    model: z.ZodEnum<{
                        55: "55";
                        nfse: "nfse";
                    }>;
                    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
                    kind: z.ZodString;
                    importedAt: z.ZodNumber;
                    issuedAt: z.ZodNullable<z.ZodString>;
                    number: z.ZodNullable<z.ZodString>;
                    issuer: z.ZodNullable<z.ZodString>;
                    total: z.ZodNullable<z.ZodString>;
                    completeness: z.ZodEnum<{
                        summary: "summary";
                        "full-xml": "full-xml";
                        "event-only": "event-only";
                    }>;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    fiscalStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    projectionState: z.ZodEnum<{
                        unavailable: "unavailable";
                        pending: "pending";
                        ready: "ready";
                        "limit-exceeded": "limit-exceeded";
                    }>;
                    versionId: z.ZodString;
                    resourceVersion: z.ZodNumber;
                    processing: z.ZodLiteral<"complete">;
                }, z.core.$strict>;
                payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"invoice">;
                    key: z.ZodString;
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    number: z.ZodString;
                    series: z.ZodString;
                    issuedAt: z.ZodString;
                    operation: z.ZodString;
                    purpose: z.ZodNullable<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        label: z.ZodNullable<z.ZodString>;
                        creditNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        debitNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        inconsistencies: z.ZodArray<z.ZodEnum<{
                            "B25.1-10": "B25.1-10";
                            "B25.1-20": "B25.1-20";
                            "B25.2-10": "B25.2-10";
                            "B25.2-20": "B25.2-20";
                        }>>;
                    }, z.core.$strict>>;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    declaredTotals: z.ZodObject<{
                        vNF: z.ZodString;
                        vNFTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"decimal">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"code">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"text">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>], "representation">>;
                    nt2026008: z.ZodNullable<z.ZodObject<{
                        vProdLiqTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    nt2026006: z.ZodNullable<z.ZodObject<{
                        gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                            nPag: z.ZodString;
                            idTransacao: z.ZodString;
                            tpMeioPgto: z.ZodString;
                            tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                            CNPJReceb: z.ZodString;
                            CNPJBasePSP: z.ZodString;
                        }, z.core.$strict>>>;
                    }, z.core.$strict>>;
                    protocol: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        receivedAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"summary">;
                    key: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    issuedAt: z.ZodString;
                    total: z.ZodString;
                    status: z.ZodString;
                    protocolNumber: z.ZodString;
                    receivedAt: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    protocolNumber: z.ZodString;
                    registeredAt: z.ZodString;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event-summary">;
                }, z.core.$strict>, z.ZodObject<{
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        protocolNumber: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    correction: z.ZodNullable<z.ZodObject<{
                        text: z.ZodString;
                        conditions: z.ZodString;
                    }, z.core.$strict>>;
                    manifestation: z.ZodNullable<z.ZodObject<{
                        reason: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    receipt: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        registeredAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event">;
                }, z.core.$strict>], "kind">, z.ZodObject<{
                    kind: z.ZodLiteral<"service-invoice">;
                    key: z.ZodString;
                    number: z.ZodString;
                    municipality: z.ZodString;
                    municipalRegistration: z.ZodNullable<z.ZodString>;
                    verificationCode: z.ZodString;
                    issuedAt: z.ZodString;
                    competence: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    serviceCode: z.ZodString;
                    description: z.ZodString;
                    values: z.ZodArray<z.ZodObject<{
                        name: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>;
                version: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    operationId: z.ZodString;
                    artifactId: z.ZodString;
                    sha256: z.ZodString;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    importedAt: z.ZodNumber;
                    publishedAt: z.ZodNumber;
                    parserVersion: z.ZodString;
                    normalizerVersion: z.ZodNullable<z.ZodString>;
                    processorVersion: z.ZodString;
                    schema: z.ZodNullable<z.ZodString>;
                    code: z.ZodString;
                    kind: z.ZodString;
                    itemCount: z.ZodNumber;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>;
                fiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
                previousFiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                versionId: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                contractVersion: z.ZodLiteral<"documents/1">;
                model: z.ZodEnum<{
                    55: "55";
                    nfse: "nfse";
                }>;
                summary: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    model: z.ZodEnum<{
                        55: "55";
                        nfse: "nfse";
                    }>;
                    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
                    kind: z.ZodString;
                    importedAt: z.ZodNumber;
                    issuedAt: z.ZodNullable<z.ZodString>;
                    number: z.ZodNullable<z.ZodString>;
                    issuer: z.ZodNullable<z.ZodString>;
                    total: z.ZodNullable<z.ZodString>;
                    completeness: z.ZodEnum<{
                        summary: "summary";
                        "full-xml": "full-xml";
                        "event-only": "event-only";
                    }>;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    fiscalStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    projectionState: z.ZodEnum<{
                        unavailable: "unavailable";
                        pending: "pending";
                        ready: "ready";
                        "limit-exceeded": "limit-exceeded";
                    }>;
                    versionId: z.ZodString;
                    resourceVersion: z.ZodNumber;
                    processing: z.ZodLiteral<"complete">;
                }, z.core.$strict>;
                payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"invoice">;
                    key: z.ZodString;
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    number: z.ZodString;
                    series: z.ZodString;
                    issuedAt: z.ZodString;
                    operation: z.ZodString;
                    purpose: z.ZodNullable<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        label: z.ZodNullable<z.ZodString>;
                        creditNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        debitNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        inconsistencies: z.ZodArray<z.ZodEnum<{
                            "B25.1-10": "B25.1-10";
                            "B25.1-20": "B25.1-20";
                            "B25.2-10": "B25.2-10";
                            "B25.2-20": "B25.2-20";
                        }>>;
                    }, z.core.$strict>>;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    declaredTotals: z.ZodObject<{
                        vNF: z.ZodString;
                        vNFTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"decimal">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"code">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"text">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>], "representation">>;
                    nt2026008: z.ZodNullable<z.ZodObject<{
                        vProdLiqTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    nt2026006: z.ZodNullable<z.ZodObject<{
                        gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                            nPag: z.ZodString;
                            idTransacao: z.ZodString;
                            tpMeioPgto: z.ZodString;
                            tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                            CNPJReceb: z.ZodString;
                            CNPJBasePSP: z.ZodString;
                        }, z.core.$strict>>>;
                    }, z.core.$strict>>;
                    protocol: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        receivedAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"summary">;
                    key: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    issuedAt: z.ZodString;
                    total: z.ZodString;
                    status: z.ZodString;
                    protocolNumber: z.ZodString;
                    receivedAt: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    protocolNumber: z.ZodString;
                    registeredAt: z.ZodString;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event-summary">;
                }, z.core.$strict>, z.ZodObject<{
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        protocolNumber: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    correction: z.ZodNullable<z.ZodObject<{
                        text: z.ZodString;
                        conditions: z.ZodString;
                    }, z.core.$strict>>;
                    manifestation: z.ZodNullable<z.ZodObject<{
                        reason: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    receipt: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        registeredAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event">;
                }, z.core.$strict>], "kind">, z.ZodObject<{
                    kind: z.ZodLiteral<"service-invoice">;
                    key: z.ZodString;
                    number: z.ZodString;
                    municipality: z.ZodString;
                    municipalRegistration: z.ZodNullable<z.ZodString>;
                    verificationCode: z.ZodString;
                    issuedAt: z.ZodString;
                    competence: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    serviceCode: z.ZodString;
                    description: z.ZodString;
                    values: z.ZodArray<z.ZodObject<{
                        name: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>;
                version: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    operationId: z.ZodString;
                    artifactId: z.ZodString;
                    sha256: z.ZodString;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    importedAt: z.ZodNumber;
                    publishedAt: z.ZodNumber;
                    parserVersion: z.ZodString;
                    normalizerVersion: z.ZodNullable<z.ZodString>;
                    processorVersion: z.ZodString;
                    schema: z.ZodNullable<z.ZodString>;
                    code: z.ZodString;
                    kind: z.ZodString;
                    itemCount: z.ZodNumber;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>;
                fiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
                previousFiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                versionId: z.ZodString;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    item: z.ZodString;
                    code: z.ZodString;
                    description: z.ZodString;
                    ncm: z.ZodString;
                    cfop: z.ZodString;
                    cest: z.ZodNullable<z.ZodString>;
                    purchaseOrder: z.ZodNullable<z.ZodString>;
                    purchaseOrderItem: z.ZodNullable<z.ZodString>;
                    unit: z.ZodString;
                    quantity: z.ZodString;
                    unitPrice: z.ZodString;
                    total: z.ZodString;
                    tributaryUnit: z.ZodString;
                    tributaryQuantity: z.ZodString;
                    tributaryUnitPrice: z.ZodString;
                    nt2026008: z.ZodNullable<z.ZodObject<{
                        vUnComLiq: z.ZodNullable<z.ZodString>;
                        vProdLiq: z.ZodNullable<z.ZodString>;
                        vICMSPrevisto: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    taxes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"decimal">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"code">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"text">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>], "representation">>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
                versionId: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                kind: z.ZodOptional<z.ZodEnum<{
                    event: "event";
                    "event-summary": "event-summary";
                }>>;
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    version: z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        operationId: z.ZodString;
                        artifactId: z.ZodString;
                        sha256: z.ZodString;
                        source: z.ZodEnum<{
                            "imported-xml": "imported-xml";
                            "distribution-xml": "distribution-xml";
                        }>;
                        importedAt: z.ZodNumber;
                        publishedAt: z.ZodNumber;
                        parserVersion: z.ZodString;
                        normalizerVersion: z.ZodNullable<z.ZodString>;
                        processorVersion: z.ZodString;
                        schema: z.ZodNullable<z.ZodString>;
                        code: z.ZodString;
                        kind: z.ZodString;
                        itemCount: z.ZodNumber;
                        originalAvailable: z.ZodBoolean;
                    }, z.core.$strict>;
                    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
                        kind: z.ZodLiteral<"invoice">;
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        number: z.ZodString;
                        series: z.ZodString;
                        issuedAt: z.ZodString;
                        operation: z.ZodString;
                        purpose: z.ZodNullable<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            label: z.ZodNullable<z.ZodString>;
                            creditNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            debitNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            inconsistencies: z.ZodArray<z.ZodEnum<{
                                "B25.1-10": "B25.1-10";
                                "B25.1-20": "B25.1-20";
                                "B25.2-10": "B25.2-10";
                                "B25.2-20": "B25.2-20";
                            }>>;
                        }, z.core.$strict>>;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        recipient: z.ZodNullable<z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        total: z.ZodString;
                        declaredTotals: z.ZodObject<{
                            vNF: z.ZodString;
                            vNFTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"decimal">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"code">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"text">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>], "representation">>;
                        nt2026008: z.ZodNullable<z.ZodObject<{
                            vProdLiqTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        nt2026006: z.ZodNullable<z.ZodObject<{
                            gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                                nPag: z.ZodString;
                                idTransacao: z.ZodString;
                                tpMeioPgto: z.ZodString;
                                tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                                CNPJReceb: z.ZodString;
                                CNPJBasePSP: z.ZodString;
                            }, z.core.$strict>>>;
                        }, z.core.$strict>>;
                        protocol: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            receivedAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        kind: z.ZodLiteral<"summary">;
                        key: z.ZodString;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        issuedAt: z.ZodString;
                        total: z.ZodString;
                        status: z.ZodString;
                        protocolNumber: z.ZodString;
                        receivedAt: z.ZodString;
                    }, z.core.$strict>, z.ZodObject<{
                        protocolNumber: z.ZodString;
                        registeredAt: z.ZodString;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event-summary">;
                    }, z.core.$strict>, z.ZodObject<{
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        cancellation: z.ZodNullable<z.ZodObject<{
                            protocolNumber: z.ZodString;
                            reason: z.ZodString;
                        }, z.core.$strict>>;
                        correction: z.ZodNullable<z.ZodObject<{
                            text: z.ZodString;
                            conditions: z.ZodString;
                        }, z.core.$strict>>;
                        manifestation: z.ZodNullable<z.ZodObject<{
                            reason: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        receipt: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            type: z.ZodString;
                            sequence: z.ZodString;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            registeredAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event">;
                    }, z.core.$strict>], "kind">;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    version: z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        operationId: z.ZodString;
                        artifactId: z.ZodString;
                        sha256: z.ZodString;
                        source: z.ZodEnum<{
                            "imported-xml": "imported-xml";
                            "distribution-xml": "distribution-xml";
                        }>;
                        importedAt: z.ZodNumber;
                        publishedAt: z.ZodNumber;
                        parserVersion: z.ZodString;
                        normalizerVersion: z.ZodNullable<z.ZodString>;
                        processorVersion: z.ZodString;
                        schema: z.ZodNullable<z.ZodString>;
                        code: z.ZodString;
                        kind: z.ZodString;
                        itemCount: z.ZodNumber;
                        originalAvailable: z.ZodBoolean;
                    }, z.core.$strict>;
                    payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                        kind: z.ZodLiteral<"invoice">;
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        number: z.ZodString;
                        series: z.ZodString;
                        issuedAt: z.ZodString;
                        operation: z.ZodString;
                        purpose: z.ZodNullable<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            label: z.ZodNullable<z.ZodString>;
                            creditNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            debitNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            inconsistencies: z.ZodArray<z.ZodEnum<{
                                "B25.1-10": "B25.1-10";
                                "B25.1-20": "B25.1-20";
                                "B25.2-10": "B25.2-10";
                                "B25.2-20": "B25.2-20";
                            }>>;
                        }, z.core.$strict>>;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        recipient: z.ZodNullable<z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        total: z.ZodString;
                        declaredTotals: z.ZodObject<{
                            vNF: z.ZodString;
                            vNFTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"decimal">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"code">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"text">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>], "representation">>;
                        nt2026008: z.ZodNullable<z.ZodObject<{
                            vProdLiqTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        nt2026006: z.ZodNullable<z.ZodObject<{
                            gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                                nPag: z.ZodString;
                                idTransacao: z.ZodString;
                                tpMeioPgto: z.ZodString;
                                tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                                CNPJReceb: z.ZodString;
                                CNPJBasePSP: z.ZodString;
                            }, z.core.$strict>>>;
                        }, z.core.$strict>>;
                        protocol: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            receivedAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        kind: z.ZodLiteral<"summary">;
                        key: z.ZodString;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        issuedAt: z.ZodString;
                        total: z.ZodString;
                        status: z.ZodString;
                        protocolNumber: z.ZodString;
                        receivedAt: z.ZodString;
                    }, z.core.$strict>, z.ZodObject<{
                        protocolNumber: z.ZodString;
                        registeredAt: z.ZodString;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event-summary">;
                    }, z.core.$strict>, z.ZodObject<{
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        cancellation: z.ZodNullable<z.ZodObject<{
                            protocolNumber: z.ZodString;
                            reason: z.ZodString;
                        }, z.core.$strict>>;
                        correction: z.ZodNullable<z.ZodObject<{
                            text: z.ZodString;
                            conditions: z.ZodString;
                        }, z.core.$strict>>;
                        manifestation: z.ZodNullable<z.ZodObject<{
                            reason: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        receipt: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            type: z.ZodString;
                            sequence: z.ZodString;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            registeredAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event">;
                    }, z.core.$strict>], "kind">, z.ZodObject<{
                        kind: z.ZodLiteral<"service-invoice">;
                        key: z.ZodString;
                        number: z.ZodString;
                        municipality: z.ZodString;
                        municipalRegistration: z.ZodNullable<z.ZodString>;
                        verificationCode: z.ZodString;
                        issuedAt: z.ZodString;
                        competence: z.ZodString;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        recipient: z.ZodNullable<z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        total: z.ZodString;
                        serviceCode: z.ZodString;
                        description: z.ZodString;
                        values: z.ZodArray<z.ZodObject<{
                            name: z.ZodString;
                            value: z.ZodString;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    name: z.ZodString;
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    importedAt: z.ZodNumber;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    name: z.ZodString;
                    sha256: z.ZodString;
                    importedAt: z.ZodNumber;
                    size: z.ZodNumber;
                    code: z.ZodString;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                state: z.ZodOptional<z.ZodEnum<{
                    authorized: "authorized";
                    cancelled: "cancelled";
                    processing: "processing";
                    rejected: "rejected";
                }>>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                    environment: z.ZodEnum<{
                        sandbox: "sandbox";
                        production: "production";
                    }>;
                    operationId: z.ZodString;
                    operationState: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>;
                    state: z.ZodEnum<{
                        authorized: "authorized";
                        cancelled: "cancelled";
                        processing: "processing";
                        rejected: "rejected";
                    }>;
                    transport: z.ZodEnum<{
                        simulated: "simulated";
                        "producao-restrita": "producao-restrita";
                        producao: "producao";
                    }>;
                    target: z.ZodString;
                    series: z.ZodString;
                    number: z.ZodNumber;
                    dpsId: z.ZodString;
                    issueDate: z.ZodString;
                    competence: z.ZodString;
                    market: z.ZodEnum<{
                        domestic: "domestic";
                        export: "export";
                    }>;
                    amount: z.ZodObject<{
                        currency: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>;
                    serviceBrl: z.ZodNullable<z.ZodString>;
                    exchange: z.ZodNullable<z.ZodObject<{
                        currency: z.ZodString;
                        amount: z.ZodString;
                        rate: z.ZodString;
                        quoteDate: z.ZodString;
                        brlAmount: z.ZodString;
                        source: z.ZodEnum<{
                            simulated: "simulated";
                            "ptax-bcb": "ptax-bcb";
                        }>;
                        frozenAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    accessKey: z.ZodNullable<z.ZodString>;
                    nfseNumber: z.ZodNullable<z.ZodString>;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    artifacts: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        kind: z.ZodEnum<{
                            nfse: "nfse";
                            dps: "dps";
                            danfse: "danfse";
                            "cancel-request": "cancel-request";
                            "cancel-event": "cancel-event";
                        }>;
                        sha256: z.ZodString;
                        size: z.ZodNumber;
                        signed: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        id: z.ZodString;
                        operationId: z.ZodString;
                        state: z.ZodEnum<{
                            processing: "processing";
                            rejected: "rejected";
                            registered: "registered";
                        }>;
                        sequence: z.ZodNumber;
                        reasonCode: z.ZodEnum<{
                            1: "1";
                            2: "2";
                            9: "9";
                        }>;
                        reason: z.ZodString;
                        code: z.ZodNullable<z.ZodString>;
                        rejections: z.ZodArray<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            message: z.ZodString;
                        }, z.core.$strict>>;
                        alreadyRegistered: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                        updatedAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    version: z.ZodNumber;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                issuanceId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
                projectId: z.ZodString;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                operationId: z.ZodString;
                operationState: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                state: z.ZodEnum<{
                    authorized: "authorized";
                    cancelled: "cancelled";
                    processing: "processing";
                    rejected: "rejected";
                }>;
                transport: z.ZodEnum<{
                    simulated: "simulated";
                    "producao-restrita": "producao-restrita";
                    producao: "producao";
                }>;
                target: z.ZodString;
                series: z.ZodString;
                number: z.ZodNumber;
                dpsId: z.ZodString;
                issueDate: z.ZodString;
                competence: z.ZodString;
                market: z.ZodEnum<{
                    domestic: "domestic";
                    export: "export";
                }>;
                amount: z.ZodObject<{
                    currency: z.ZodString;
                    value: z.ZodString;
                }, z.core.$strict>;
                serviceBrl: z.ZodNullable<z.ZodString>;
                exchange: z.ZodNullable<z.ZodObject<{
                    currency: z.ZodString;
                    amount: z.ZodString;
                    rate: z.ZodString;
                    quoteDate: z.ZodString;
                    brlAmount: z.ZodString;
                    source: z.ZodEnum<{
                        simulated: "simulated";
                        "ptax-bcb": "ptax-bcb";
                    }>;
                    frozenAt: z.ZodNumber;
                }, z.core.$strict>>;
                accessKey: z.ZodNullable<z.ZodString>;
                nfseNumber: z.ZodNullable<z.ZodString>;
                code: z.ZodNullable<z.ZodString>;
                rejections: z.ZodArray<z.ZodObject<{
                    code: z.ZodNullable<z.ZodString>;
                    message: z.ZodString;
                }, z.core.$strict>>;
                artifacts: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    kind: z.ZodEnum<{
                        nfse: "nfse";
                        dps: "dps";
                        danfse: "danfse";
                        "cancel-request": "cancel-request";
                        "cancel-event": "cancel-event";
                    }>;
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                    signed: z.ZodBoolean;
                    createdAt: z.ZodNumber;
                }, z.core.$strict>>;
                cancellation: z.ZodNullable<z.ZodObject<{
                    id: z.ZodString;
                    operationId: z.ZodString;
                    state: z.ZodEnum<{
                        processing: "processing";
                        rejected: "rejected";
                        registered: "registered";
                    }>;
                    sequence: z.ZodNumber;
                    reasonCode: z.ZodEnum<{
                        1: "1";
                        2: "2";
                        9: "9";
                    }>;
                    reason: z.ZodString;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    alreadyRegistered: z.ZodBoolean;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>>;
                version: z.ZodNumber;
                createdAt: z.ZodNumber;
                updatedAt: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                issuanceId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                reasonCode: z.ZodEnum<{
                    1: "1";
                    2: "2";
                    9: "9";
                }>;
                reason: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                reused: z.ZodBoolean;
                issuance: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                    environment: z.ZodEnum<{
                        sandbox: "sandbox";
                        production: "production";
                    }>;
                    operationId: z.ZodString;
                    operationState: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>;
                    state: z.ZodEnum<{
                        authorized: "authorized";
                        cancelled: "cancelled";
                        processing: "processing";
                        rejected: "rejected";
                    }>;
                    transport: z.ZodEnum<{
                        simulated: "simulated";
                        "producao-restrita": "producao-restrita";
                        producao: "producao";
                    }>;
                    target: z.ZodString;
                    series: z.ZodString;
                    number: z.ZodNumber;
                    dpsId: z.ZodString;
                    issueDate: z.ZodString;
                    competence: z.ZodString;
                    market: z.ZodEnum<{
                        domestic: "domestic";
                        export: "export";
                    }>;
                    amount: z.ZodObject<{
                        currency: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>;
                    serviceBrl: z.ZodNullable<z.ZodString>;
                    exchange: z.ZodNullable<z.ZodObject<{
                        currency: z.ZodString;
                        amount: z.ZodString;
                        rate: z.ZodString;
                        quoteDate: z.ZodString;
                        brlAmount: z.ZodString;
                        source: z.ZodEnum<{
                            simulated: "simulated";
                            "ptax-bcb": "ptax-bcb";
                        }>;
                        frozenAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    accessKey: z.ZodNullable<z.ZodString>;
                    nfseNumber: z.ZodNullable<z.ZodString>;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    artifacts: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        kind: z.ZodEnum<{
                            nfse: "nfse";
                            dps: "dps";
                            danfse: "danfse";
                            "cancel-request": "cancel-request";
                            "cancel-event": "cancel-event";
                        }>;
                        sha256: z.ZodString;
                        size: z.ZodNumber;
                        signed: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        id: z.ZodString;
                        operationId: z.ZodString;
                        state: z.ZodEnum<{
                            processing: "processing";
                            rejected: "rejected";
                            registered: "registered";
                        }>;
                        sequence: z.ZodNumber;
                        reasonCode: z.ZodEnum<{
                            1: "1";
                            2: "2";
                            9: "9";
                        }>;
                        reason: z.ZodString;
                        code: z.ZodNullable<z.ZodString>;
                        rejections: z.ZodArray<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            message: z.ZodString;
                        }, z.core.$strict>>;
                        alreadyRegistered: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                        updatedAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    version: z.ZodNumber;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodArray<z.ZodObject<{
                active: z.ZodBoolean;
                version: z.ZodNumber;
                secretVersion: z.ZodNumber;
                previousUntil: z.ZodNullable<z.ZodNumber>;
                createdAt: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                id: z.ZodString;
            }, z.core.$strict>>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                active: z.ZodBoolean;
                version: z.ZodNumber;
                secretVersion: z.ZodNumber;
                previousUntil: z.ZodNullable<z.ZodNumber>;
                createdAt: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                id: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                companyId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                endpoint: z.ZodObject<{
                    active: z.ZodBoolean;
                    version: z.ZodNumber;
                    secretVersion: z.ZodNumber;
                    previousUntil: z.ZodNullable<z.ZodNumber>;
                    createdAt: z.ZodNumber;
                    name: z.ZodString;
                    url: z.ZodString;
                    events: z.ZodArray<z.ZodEnum<{
                        "document.received": "document.received";
                        "document.updated": "document.updated";
                        "document.event_received": "document.event_received";
                        "import.completed": "import.completed";
                        "connection.attention_required": "connection.attention_required";
                        "connection.release_withdrawn": "connection.release_withdrawn";
                        "connection.history_limited": "connection.history_limited";
                        "issuance.authorized": "issuance.authorized";
                        "issuance.rejected": "issuance.rejected";
                        "issuance.cancelled": "issuance.cancelled";
                        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                    }>>;
                    id: z.ZodString;
                }, z.core.$strict>;
                secret: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                active: z.ZodBoolean;
                expectedVersion: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                active: z.ZodBoolean;
                version: z.ZodNumber;
                secretVersion: z.ZodNumber;
                previousUntil: z.ZodNullable<z.ZodNumber>;
                createdAt: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                id: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedVersion: z.ZodNumber;
                overlapMs: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                endpoint: z.ZodObject<{
                    active: z.ZodBoolean;
                    version: z.ZodNumber;
                    secretVersion: z.ZodNumber;
                    previousUntil: z.ZodNullable<z.ZodNumber>;
                    createdAt: z.ZodNumber;
                    name: z.ZodString;
                    url: z.ZodString;
                    events: z.ZodArray<z.ZodEnum<{
                        "document.received": "document.received";
                        "document.updated": "document.updated";
                        "document.event_received": "document.event_received";
                        "import.completed": "import.completed";
                        "connection.attention_required": "connection.attention_required";
                        "connection.release_withdrawn": "connection.release_withdrawn";
                        "connection.history_limited": "connection.history_limited";
                        "issuance.authorized": "issuance.authorized";
                        "issuance.rejected": "issuance.rejected";
                        "issuance.cancelled": "issuance.cancelled";
                        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                    }>>;
                    id: z.ZodString;
                }, z.core.$strict>;
                secret: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                eventId: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                endpointId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                items: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    eventId: z.ZodString;
                    type: z.ZodEnum<{
                        "document.received": "document.received";
                        "document.updated": "document.updated";
                        "document.event_received": "document.event_received";
                        "import.completed": "import.completed";
                        "connection.attention_required": "connection.attention_required";
                        "connection.release_withdrawn": "connection.release_withdrawn";
                        "connection.history_limited": "connection.history_limited";
                        "issuance.authorized": "issuance.authorized";
                        "issuance.rejected": "issuance.rejected";
                        "issuance.cancelled": "issuance.cancelled";
                        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                        "webhook.test": "webhook.test";
                    }>;
                    resourceVersion: z.ZodNumber;
                    state: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        paused: "paused";
                        failed: "failed";
                        delivered: "delivered";
                    }>;
                    attempts: z.ZodNumber;
                    resends: z.ZodNumber;
                    generation: z.ZodNumber;
                    nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                    code: z.ZodNullable<z.ZodString>;
                    httpStatus: z.ZodNullable<z.ZodNumber>;
                    durationMs: z.ZodNullable<z.ZodNumber>;
                    response: z.ZodNullable<z.ZodString>;
                    createdAt: z.ZodNumber;
                    canRetry: z.ZodBoolean;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                deliveryId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedGeneration: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                eventId: z.ZodString;
                type: z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                    "webhook.test": "webhook.test";
                }>;
                resourceVersion: z.ZodNumber;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    paused: "paused";
                    failed: "failed";
                    delivered: "delivered";
                }>;
                attempts: z.ZodNumber;
                resends: z.ZodNumber;
                generation: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                httpStatus: z.ZodNullable<z.ZodNumber>;
                durationMs: z.ZodNullable<z.ZodNumber>;
                response: z.ZodNullable<z.ZodString>;
                createdAt: z.ZodNumber;
                canRetry: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                apiVersion: z.ZodLiteral<"8.0.0">;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                models: z.ZodArray<z.ZodEnum<{
                    55: "55";
                    nfse: "nfse";
                }>>;
                capabilities: z.ZodArray<z.ZodString>;
                webhookEvents: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                limits: z.ZodObject<{
                    importFiles: z.ZodNumber;
                    importBytes: z.ZodNumber;
                    pageSize: z.ZodNumber;
                }, z.core.$strict>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        /** Response header pointing to the accepted resource. */
        readonly location: "/v1/issuances/{issuanceId}";
        readonly method: "GET" | "POST" | "PATCH";
        readonly path: string;
        readonly input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                activityCode: z.ZodString;
                competence: z.ZodString;
                issueDate: z.ZodOptional<z.ZodString>;
                issuerEmail: z.ZodOptional<z.ZodString>;
                market: z.ZodEnum<{
                    domestic: "domestic";
                    export: "export";
                }>;
                taker: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"national">;
                    document: z.ZodString;
                    name: z.ZodString;
                    email: z.ZodOptional<z.ZodString>;
                    address: z.ZodObject<{
                        municipalityCode: z.ZodString;
                        postalCode: z.ZodString;
                        street: z.ZodString;
                        number: z.ZodString;
                        district: z.ZodString;
                    }, z.core.$strict>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"foreign">;
                    nif: z.ZodOptional<z.ZodString>;
                    nifAbsence: z.ZodOptional<z.ZodNumber>;
                    name: z.ZodString;
                    email: z.ZodOptional<z.ZodString>;
                    address: z.ZodObject<{
                        country: z.ZodString;
                        city: z.ZodString;
                        postalCode: z.ZodString;
                        state: z.ZodString;
                        street: z.ZodString;
                        number: z.ZodString;
                        district: z.ZodString;
                    }, z.core.$strict>;
                }, z.core.$strict>], "kind">;
                description: z.ZodString;
                amount: z.ZodObject<{
                    currency: z.ZodString;
                    value: z.ZodString;
                }, z.core.$strict>;
                issRate: z.ZodOptional<z.ZodString>;
                issWithheld: z.ZodBoolean;
            }, z.core.$strict>;
        }, z.core.$strict>;
        readonly output: z.ZodObject<{
            data: z.ZodObject<{
                reused: z.ZodBoolean;
                issuance: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                    environment: z.ZodEnum<{
                        sandbox: "sandbox";
                        production: "production";
                    }>;
                    operationId: z.ZodString;
                    operationState: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>;
                    state: z.ZodEnum<{
                        authorized: "authorized";
                        cancelled: "cancelled";
                        processing: "processing";
                        rejected: "rejected";
                    }>;
                    transport: z.ZodEnum<{
                        simulated: "simulated";
                        "producao-restrita": "producao-restrita";
                        producao: "producao";
                    }>;
                    target: z.ZodString;
                    series: z.ZodString;
                    number: z.ZodNumber;
                    dpsId: z.ZodString;
                    issueDate: z.ZodString;
                    competence: z.ZodString;
                    market: z.ZodEnum<{
                        domestic: "domestic";
                        export: "export";
                    }>;
                    amount: z.ZodObject<{
                        currency: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>;
                    serviceBrl: z.ZodNullable<z.ZodString>;
                    exchange: z.ZodNullable<z.ZodObject<{
                        currency: z.ZodString;
                        amount: z.ZodString;
                        rate: z.ZodString;
                        quoteDate: z.ZodString;
                        brlAmount: z.ZodString;
                        source: z.ZodEnum<{
                            simulated: "simulated";
                            "ptax-bcb": "ptax-bcb";
                        }>;
                        frozenAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    accessKey: z.ZodNullable<z.ZodString>;
                    nfseNumber: z.ZodNullable<z.ZodString>;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    artifacts: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        kind: z.ZodEnum<{
                            nfse: "nfse";
                            dps: "dps";
                            danfse: "danfse";
                            "cancel-request": "cancel-request";
                            "cancel-event": "cancel-event";
                        }>;
                        sha256: z.ZodString;
                        size: z.ZodNumber;
                        signed: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        id: z.ZodString;
                        operationId: z.ZodString;
                        state: z.ZodEnum<{
                            processing: "processing";
                            rejected: "rejected";
                            registered: "registered";
                        }>;
                        sequence: z.ZodNumber;
                        reasonCode: z.ZodEnum<{
                            1: "1";
                            2: "2";
                            9: "9";
                        }>;
                        reason: z.ZodString;
                        code: z.ZodNullable<z.ZodString>;
                        rejections: z.ZodArray<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            message: z.ZodString;
                        }, z.core.$strict>>;
                        alreadyRegistered: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                        updatedAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    version: z.ZodNumber;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        readonly scope: string;
        readonly retry: RetryPolicy;
        readonly status: number;
        readonly idempotencyPattern: string;
    };
    path: {
        [k: string]: string;
    };
} | null;
export declare function parseRequest(method: string, url: URL, body: unknown): {
    value: {
        path: Record<string, never>;
        query: Record<string, never>;
        body: {
            companyId: string;
            documentId: string;
        };
    } | {
        path: {
            exportId: string;
        };
        query: Record<string, never>;
        body: Record<string, never>;
    } | {
        path: {
            exportId: string;
        };
        query: {
            cursor?: string | undefined;
            limit?: number | undefined;
        };
        body: Record<string, never>;
    } | {
        path: {
            partId: string;
        };
        query: Record<string, never>;
        body: Record<string, never>;
    } | {
        path: Record<string, never>;
        query: Record<string, never>;
        body: {
            companyId: string;
            action: "activate" | "sync" | "pause" | "resume";
            expectedVersion?: number | undefined;
        };
    } | {
        path: Record<string, never>;
        query: {
            companyId: string;
        };
        body: Record<string, never>;
    } | {
        path: {
            cnpj: string;
        };
        query: {
            companyId: string;
        };
        body: Record<string, never>;
    } | {
        path: {
            cnpj: string;
        };
        query: Record<string, never>;
        body: {
            companyId: string;
        };
    } | {
        path: {
            code: string;
        };
        query: {
            companyId: string;
            date?: string | undefined;
            version?: string | undefined;
        };
        body: Record<string, never>;
    } | {
        path: Record<string, never>;
        query: {
            cursor?: string | undefined;
            limit?: number | undefined;
        };
        body: Record<string, never>;
    } | {
        path: {
            companyId: string;
        };
        query: {
            cursor?: string | undefined;
            limit?: number | undefined;
        };
        body: Record<string, never>;
    } | {
        path: Record<string, never>;
        query: Record<string, never>;
        body: {
            companyId: string;
            files: {
                name: string;
                size: number;
                sha256: string;
            }[];
        };
    } | {
        path: {
            importId: string;
        };
        query: Record<string, never>;
        body: Record<string, never>;
    } | {
        path: {
            operationId: string;
        };
        query: Record<string, never>;
        body: Record<string, never>;
    } | {
        path: {
            operationId: string;
        };
        query: Record<string, never>;
        body: {
            expectedGeneration: number;
        };
    } | {
        path: {
            documentId: string;
        };
        query: {
            companyId: string;
        };
        body: Record<string, never>;
    } | {
        path: Record<string, never>;
        query: Record<string, never>;
        body: {
            companyId: string;
            activityCode: string;
            competence: string;
            market: "domestic" | "export";
            taker: {
                kind: "national";
                document: string;
                name: string;
                address: {
                    municipalityCode: string;
                    postalCode: string;
                    street: string;
                    number: string;
                    district: string;
                };
                email?: string | undefined;
            } | {
                kind: "foreign";
                name: string;
                address: {
                    country: string;
                    city: string;
                    postalCode: string;
                    state: string;
                    street: string;
                    number: string;
                    district: string;
                };
                nif?: string | undefined;
                nifAbsence?: number | undefined;
                email?: string | undefined;
            };
            description: string;
            amount: {
                currency: string;
                value: string;
            };
            issWithheld: boolean;
            issueDate?: string | undefined;
            issuerEmail?: string | undefined;
            issRate?: string | undefined;
        };
    } | {
        path: {
            issuanceId: string;
        };
        query: {
            companyId: string;
        };
        body: Record<string, never>;
    } | {
        path: {
            issuanceId: string;
        };
        query: Record<string, never>;
        body: {
            companyId: string;
            reasonCode: "1" | "2" | "9";
            reason: string;
        };
    } | {
        path: {
            endpointId: string;
        };
        query: Record<string, never>;
        body: Record<string, never>;
    } | {
        path: Record<string, never>;
        query: Record<string, never>;
        body: {
            name: string;
            url: string;
            events: ("document.received" | "document.updated" | "document.event_received" | "import.completed" | "connection.attention_required" | "connection.release_withdrawn" | "connection.history_limited" | "issuance.authorized" | "issuance.rejected" | "issuance.cancelled" | "issuance.cancellation_rejected")[];
            companyId: string;
        };
    } | {
        path: {
            endpointId: string;
        };
        query: Record<string, never>;
        body: {
            active: boolean;
            expectedVersion: number;
            name: string;
            url: string;
            events: ("document.received" | "document.updated" | "document.event_received" | "import.completed" | "connection.attention_required" | "connection.release_withdrawn" | "connection.history_limited" | "issuance.authorized" | "issuance.rejected" | "issuance.cancelled" | "issuance.cancellation_rejected")[];
        };
    } | {
        path: {
            endpointId: string;
        };
        query: Record<string, never>;
        body: {
            expectedVersion: number;
            overlapMs: number;
        };
    } | {
        path: {
            deliveryId: string;
        };
        query: Record<string, never>;
        body: {
            expectedGeneration: number;
        };
    } | {
        path: Record<string, never>;
        query: Record<string, never>;
        body: Record<string, never>;
    };
    name: RouteName;
    entry: {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                documentId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                selection: z.ZodObject<{
                    kind: z.ZodLiteral<"document">;
                    documentId: z.ZodString;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                }, z.core.$strict>;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    running: "running";
                    succeeded: "succeeded";
                    failed: "failed";
                    expired: "expired";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodNumber;
                expiresAt: z.ZodNumber;
                parts: z.ZodNumber;
                bytes: z.ZodNumber;
                code: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                exportId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                selection: z.ZodObject<{
                    kind: z.ZodLiteral<"document">;
                    documentId: z.ZodString;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                }, z.core.$strict>;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    running: "running";
                    succeeded: "succeeded";
                    failed: "failed";
                    expired: "expired";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodNumber;
                expiresAt: z.ZodNumber;
                parts: z.ZodNumber;
                bytes: z.ZodNumber;
                code: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                exportId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    sequence: z.ZodNumber;
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                exportId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                selection: z.ZodObject<{
                    kind: z.ZodLiteral<"document">;
                    documentId: z.ZodString;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                }, z.core.$strict>;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    running: "running";
                    succeeded: "succeeded";
                    failed: "failed";
                    expired: "expired";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodNumber;
                expiresAt: z.ZodNumber;
                parts: z.ZodNumber;
                bytes: z.ZodNumber;
                code: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                partId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                token: z.ZodString;
                expiresAt: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                action: z.ZodEnum<{
                    activate: "activate";
                    sync: "sync";
                    pause: "pause";
                    resume: "resume";
                }>;
                expectedVersion: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                organizationId: z.ZodString;
                companyId: z.ZodString;
                projectId: z.ZodString;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    paused: "paused";
                    active: "active";
                    attention: "attention";
                }>;
                version: z.ZodNumber;
                checkpoint: z.ZodString;
                sourceCursor: z.ZodNullable<z.ZodString>;
                sourceMaxNsu: z.ZodNullable<z.ZodString>;
                nextAllowedAt: z.ZodNumber;
                lastAttemptAt: z.ZodNullable<z.ZodNumber>;
                lastSuccessAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                received: z.ZodNumber;
                operationId: z.ZodNullable<z.ZodString>;
                operationState: z.ZodNullable<z.ZodString>;
                certificateState: z.ZodString;
                certificateExpiresAt: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodNullable<z.ZodObject<{
                id: z.ZodString;
                organizationId: z.ZodString;
                companyId: z.ZodString;
                projectId: z.ZodString;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                state: z.ZodEnum<{
                    paused: "paused";
                    active: "active";
                    attention: "attention";
                }>;
                version: z.ZodNumber;
                checkpoint: z.ZodString;
                sourceCursor: z.ZodNullable<z.ZodString>;
                sourceMaxNsu: z.ZodNullable<z.ZodString>;
                nextAllowedAt: z.ZodNumber;
                lastAttemptAt: z.ZodNullable<z.ZodNumber>;
                lastSuccessAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                received: z.ZodNumber;
                operationId: z.ZodNullable<z.ZodString>;
                operationState: z.ZodNullable<z.ZodString>;
                certificateState: z.ZodString;
                certificateExpiresAt: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                cnpj: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                cnpj: z.ZodString;
                provider: z.ZodLiteral<"opencnpj">;
                sourceUrl: z.ZodLiteral<"https://opencnpj.org/">;
                status: z.ZodEnum<{
                    not_found: "not_found";
                    not_consulted: "not_consulted";
                    found: "found";
                    unavailable: "unavailable";
                    unsupported_format: "unsupported_format";
                }>;
                freshness: z.ZodEnum<{
                    missing: "missing";
                    fresh: "fresh";
                    stale: "stale";
                }>;
                data: z.ZodNullable<z.ZodObject<{
                    name: z.ZodString;
                    status: z.ZodString;
                    address: z.ZodObject<{
                        street: z.ZodString;
                        number: z.ZodString;
                        complement: z.ZodString;
                        district: z.ZodString;
                        city: z.ZodString;
                        state: z.ZodString;
                        postalCode: z.ZodString;
                    }, z.core.$strict>;
                }, z.core.$strict>>;
                sourceUpdatedAt: z.ZodNullable<z.ZodNumber>;
                consultedAt: z.ZodNullable<z.ZodNumber>;
                lastAttemptAt: z.ZodNullable<z.ZodNumber>;
                expiresAt: z.ZodNullable<z.ZodNumber>;
                refreshAfter: z.ZodNullable<z.ZodNumber>;
                version: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                cnpj: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                q: z.ZodOptional<z.ZodString>;
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                page: z.ZodArray<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                    status: z.ZodEnum<{
                        valid: "valid";
                        out_of_validity: "out_of_validity";
                        validity_unknown: "validity_unknown";
                    }>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                code: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                status: z.ZodEnum<{
                    valid: "valid";
                    out_of_validity: "out_of_validity";
                    validity_unknown: "validity_unknown";
                    not_found: "not_found";
                }>;
                entry: z.ZodNullable<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                q: z.ZodOptional<z.ZodString>;
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                page: z.ZodArray<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                    status: z.ZodEnum<{
                        valid: "valid";
                        out_of_validity: "out_of_validity";
                        validity_unknown: "validity_unknown";
                    }>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                code: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                date: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                manifest: z.ZodObject<{
                    dataset: z.ZodEnum<{
                        municipalities: "municipalities";
                        ncm: "ncm";
                    }>;
                    version: z.ZodString;
                    source: z.ZodString;
                    sourceUrl: z.ZodURL;
                    sourceVersion: z.ZodString;
                    retrievedAt: z.ZodISODateTime;
                    asOf: z.ZodString;
                    coverage: z.ZodEnum<{
                        snapshot: "snapshot";
                        intervals: "intervals";
                    }>;
                    sourceSha256: z.ZodString;
                    contentSha256: z.ZodString;
                    count: z.ZodNumber;
                    termsUrl: z.ZodURL;
                    redistribution: z.ZodEnum<{
                        synthetic: "synthetic";
                        "review-required": "review-required";
                        "permitted-with-attribution": "permitted-with-attribution";
                    }>;
                    terms: z.ZodString;
                }, z.core.$strict>;
                date: z.ZodString;
                status: z.ZodEnum<{
                    valid: "valid";
                    out_of_validity: "out_of_validity";
                    validity_unknown: "validity_unknown";
                    not_found: "not_found";
                }>;
                entry: z.ZodNullable<z.ZodObject<{
                    code: z.ZodString;
                    description: z.ZodString;
                    state: z.ZodNullable<z.ZodString>;
                    validFrom: z.ZodNullable<z.ZodString>;
                    validTo: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                cnpj: z.ZodString;
                kind: z.ZodEnum<{
                    declared: "declared";
                    demonstration: "demonstration";
                }>;
                registryStatus: z.ZodLiteral<"not-consulted">;
                fiscalAccess: z.ZodLiteral<"not-configured">;
            }, z.core.$strict>>;
            nextCursor: z.ZodNullable<z.ZodString>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                cnpj: z.ZodString;
                kind: z.ZodEnum<{
                    declared: "declared";
                    demonstration: "demonstration";
                }>;
                registryStatus: z.ZodLiteral<"not-consulted">;
                fiscalAccess: z.ZodLiteral<"not-configured">;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                files: z.ZodArray<z.ZodObject<{
                    name: z.ZodString;
                    size: z.ZodNumber;
                    sha256: z.ZodString;
                }, z.core.$strict>>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                importId: z.ZodString;
                fileIds: z.ZodArray<z.ZodString>;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                createdAt: z.ZodNumber;
                files: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    name: z.ZodString;
                    size: z.ZodNumber;
                    sha256: z.ZodString;
                    state: z.ZodUnion<readonly [z.ZodEnum<{
                        reserved: "reserved";
                        uploaded: "uploaded";
                        accepted: "accepted";
                        expired: "expired";
                    }>, z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>]>;
                    operationId: z.ZodNullable<z.ZodString>;
                    generation: z.ZodNumber;
                    code: z.ZodNullable<z.ZodString>;
                    documentId: z.ZodNullable<z.ZodString>;
                    versionId: z.ZodNullable<z.ZodString>;
                    documents: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        documentId: z.ZodString;
                        versionId: z.ZodString;
                        number: z.ZodString;
                        code: z.ZodString;
                    }, z.core.$strict>>>;
                    result: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                url: z.ZodString;
                token: z.ZodString;
                expiresAt: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                fileId: z.ZodString;
                importId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                processorVersion: z.ZodString;
                completedAt: z.ZodNumber;
                code: z.ZodString;
                result: z.ZodString;
            }, z.core.$strict>>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                operationId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                generation: z.ZodNumber;
                attempts: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                result: z.ZodNullable<z.ZodString>;
                uncertain: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                operationId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedGeneration: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                generation: z.ZodNumber;
                attempts: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                result: z.ZodNullable<z.ZodString>;
                uncertain: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                operationId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedGeneration: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                generation: z.ZodNumber;
                attempts: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                result: z.ZodNullable<z.ZodString>;
                uncertain: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                status: z.ZodOptional<z.ZodEnum<{
                    unknown: "unknown";
                    authorized: "authorized";
                    cancelled: "cancelled";
                    denied: "denied";
                    conflict: "conflict";
                }>>;
                source: z.ZodOptional<z.ZodEnum<{
                    "imported-xml": "imported-xml";
                    "distribution-xml": "distribution-xml";
                }>>;
                from: z.ZodOptional<z.ZodNumber>;
                to: z.ZodOptional<z.ZodNumber>;
                key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString]>>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    model: z.ZodEnum<{
                        55: "55";
                        nfse: "nfse";
                    }>;
                    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
                    kind: z.ZodString;
                    importedAt: z.ZodNumber;
                    issuedAt: z.ZodNullable<z.ZodString>;
                    number: z.ZodNullable<z.ZodString>;
                    issuer: z.ZodNullable<z.ZodString>;
                    total: z.ZodNullable<z.ZodString>;
                    completeness: z.ZodEnum<{
                        summary: "summary";
                        "full-xml": "full-xml";
                        "event-only": "event-only";
                    }>;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    fiscalStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    projectionState: z.ZodEnum<{
                        unavailable: "unavailable";
                        pending: "pending";
                        ready: "ready";
                        "limit-exceeded": "limit-exceeded";
                    }>;
                    versionId: z.ZodString;
                    resourceVersion: z.ZodNumber;
                    processing: z.ZodLiteral<"complete">;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
                indexing: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                versionId: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                contractVersion: z.ZodLiteral<"documents/1">;
                model: z.ZodEnum<{
                    55: "55";
                    nfse: "nfse";
                }>;
                summary: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    model: z.ZodEnum<{
                        55: "55";
                        nfse: "nfse";
                    }>;
                    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
                    kind: z.ZodString;
                    importedAt: z.ZodNumber;
                    issuedAt: z.ZodNullable<z.ZodString>;
                    number: z.ZodNullable<z.ZodString>;
                    issuer: z.ZodNullable<z.ZodString>;
                    total: z.ZodNullable<z.ZodString>;
                    completeness: z.ZodEnum<{
                        summary: "summary";
                        "full-xml": "full-xml";
                        "event-only": "event-only";
                    }>;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    fiscalStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    projectionState: z.ZodEnum<{
                        unavailable: "unavailable";
                        pending: "pending";
                        ready: "ready";
                        "limit-exceeded": "limit-exceeded";
                    }>;
                    versionId: z.ZodString;
                    resourceVersion: z.ZodNumber;
                    processing: z.ZodLiteral<"complete">;
                }, z.core.$strict>;
                payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"invoice">;
                    key: z.ZodString;
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    number: z.ZodString;
                    series: z.ZodString;
                    issuedAt: z.ZodString;
                    operation: z.ZodString;
                    purpose: z.ZodNullable<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        label: z.ZodNullable<z.ZodString>;
                        creditNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        debitNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        inconsistencies: z.ZodArray<z.ZodEnum<{
                            "B25.1-10": "B25.1-10";
                            "B25.1-20": "B25.1-20";
                            "B25.2-10": "B25.2-10";
                            "B25.2-20": "B25.2-20";
                        }>>;
                    }, z.core.$strict>>;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    declaredTotals: z.ZodObject<{
                        vNF: z.ZodString;
                        vNFTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"decimal">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"code">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"text">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>], "representation">>;
                    nt2026008: z.ZodNullable<z.ZodObject<{
                        vProdLiqTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    nt2026006: z.ZodNullable<z.ZodObject<{
                        gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                            nPag: z.ZodString;
                            idTransacao: z.ZodString;
                            tpMeioPgto: z.ZodString;
                            tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                            CNPJReceb: z.ZodString;
                            CNPJBasePSP: z.ZodString;
                        }, z.core.$strict>>>;
                    }, z.core.$strict>>;
                    protocol: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        receivedAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"summary">;
                    key: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    issuedAt: z.ZodString;
                    total: z.ZodString;
                    status: z.ZodString;
                    protocolNumber: z.ZodString;
                    receivedAt: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    protocolNumber: z.ZodString;
                    registeredAt: z.ZodString;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event-summary">;
                }, z.core.$strict>, z.ZodObject<{
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        protocolNumber: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    correction: z.ZodNullable<z.ZodObject<{
                        text: z.ZodString;
                        conditions: z.ZodString;
                    }, z.core.$strict>>;
                    manifestation: z.ZodNullable<z.ZodObject<{
                        reason: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    receipt: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        registeredAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event">;
                }, z.core.$strict>], "kind">, z.ZodObject<{
                    kind: z.ZodLiteral<"service-invoice">;
                    key: z.ZodString;
                    number: z.ZodString;
                    municipality: z.ZodString;
                    municipalRegistration: z.ZodNullable<z.ZodString>;
                    verificationCode: z.ZodString;
                    issuedAt: z.ZodString;
                    competence: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    serviceCode: z.ZodString;
                    description: z.ZodString;
                    values: z.ZodArray<z.ZodObject<{
                        name: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>;
                version: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    operationId: z.ZodString;
                    artifactId: z.ZodString;
                    sha256: z.ZodString;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    importedAt: z.ZodNumber;
                    publishedAt: z.ZodNumber;
                    parserVersion: z.ZodString;
                    normalizerVersion: z.ZodNullable<z.ZodString>;
                    processorVersion: z.ZodString;
                    schema: z.ZodNullable<z.ZodString>;
                    code: z.ZodString;
                    kind: z.ZodString;
                    itemCount: z.ZodNumber;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>;
                fiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
                previousFiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                versionId: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                contractVersion: z.ZodLiteral<"documents/1">;
                model: z.ZodEnum<{
                    55: "55";
                    nfse: "nfse";
                }>;
                summary: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    model: z.ZodEnum<{
                        55: "55";
                        nfse: "nfse";
                    }>;
                    key: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
                    kind: z.ZodString;
                    importedAt: z.ZodNumber;
                    issuedAt: z.ZodNullable<z.ZodString>;
                    number: z.ZodNullable<z.ZodString>;
                    issuer: z.ZodNullable<z.ZodString>;
                    total: z.ZodNullable<z.ZodString>;
                    completeness: z.ZodEnum<{
                        summary: "summary";
                        "full-xml": "full-xml";
                        "event-only": "event-only";
                    }>;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    fiscalStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    projectionState: z.ZodEnum<{
                        unavailable: "unavailable";
                        pending: "pending";
                        ready: "ready";
                        "limit-exceeded": "limit-exceeded";
                    }>;
                    versionId: z.ZodString;
                    resourceVersion: z.ZodNumber;
                    processing: z.ZodLiteral<"complete">;
                }, z.core.$strict>;
                payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"invoice">;
                    key: z.ZodString;
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    number: z.ZodString;
                    series: z.ZodString;
                    issuedAt: z.ZodString;
                    operation: z.ZodString;
                    purpose: z.ZodNullable<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        label: z.ZodNullable<z.ZodString>;
                        creditNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        debitNoteType: z.ZodNullable<z.ZodObject<{
                            code: z.ZodString;
                            label: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        inconsistencies: z.ZodArray<z.ZodEnum<{
                            "B25.1-10": "B25.1-10";
                            "B25.1-20": "B25.1-20";
                            "B25.2-10": "B25.2-10";
                            "B25.2-20": "B25.2-20";
                        }>>;
                    }, z.core.$strict>>;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    declaredTotals: z.ZodObject<{
                        vNF: z.ZodString;
                        vNFTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"decimal">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"code">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"text">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>], "representation">>;
                    nt2026008: z.ZodNullable<z.ZodObject<{
                        vProdLiqTot: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    nt2026006: z.ZodNullable<z.ZodObject<{
                        gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                            nPag: z.ZodString;
                            idTransacao: z.ZodString;
                            tpMeioPgto: z.ZodString;
                            tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                            CNPJReceb: z.ZodString;
                            CNPJBasePSP: z.ZodString;
                        }, z.core.$strict>>>;
                    }, z.core.$strict>>;
                    protocol: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        receivedAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"summary">;
                    key: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    issuedAt: z.ZodString;
                    total: z.ZodString;
                    status: z.ZodString;
                    protocolNumber: z.ZodString;
                    receivedAt: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    protocolNumber: z.ZodString;
                    registeredAt: z.ZodString;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event-summary">;
                }, z.core.$strict>, z.ZodObject<{
                    environment: z.ZodEnum<{
                        1: "1";
                        2: "2";
                    }>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        protocolNumber: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    correction: z.ZodNullable<z.ZodObject<{
                        text: z.ZodString;
                        conditions: z.ZodString;
                    }, z.core.$strict>>;
                    manifestation: z.ZodNullable<z.ZodObject<{
                        reason: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    receipt: z.ZodNullable<z.ZodObject<{
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        status: z.ZodString;
                        number: z.ZodNullable<z.ZodString>;
                        registeredAt: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    key: z.ZodString;
                    author: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    type: z.ZodString;
                    sequence: z.ZodString;
                    occurredAt: z.ZodString;
                    description: z.ZodString;
                    kind: z.ZodLiteral<"event">;
                }, z.core.$strict>], "kind">, z.ZodObject<{
                    kind: z.ZodLiteral<"service-invoice">;
                    key: z.ZodString;
                    number: z.ZodString;
                    municipality: z.ZodString;
                    municipalRegistration: z.ZodNullable<z.ZodString>;
                    verificationCode: z.ZodString;
                    issuedAt: z.ZodString;
                    competence: z.ZodString;
                    issuer: z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                    recipient: z.ZodNullable<z.ZodObject<{
                        kind: z.ZodEnum<{
                            CPF: "CPF";
                            CNPJ: "CNPJ";
                        }>;
                        document: z.ZodString;
                        name: z.ZodNullable<z.ZodString>;
                        stateRegistration: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    total: z.ZodString;
                    serviceCode: z.ZodString;
                    description: z.ZodString;
                    values: z.ZodArray<z.ZodObject<{
                        name: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>;
                version: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    operationId: z.ZodString;
                    artifactId: z.ZodString;
                    sha256: z.ZodString;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    importedAt: z.ZodNumber;
                    publishedAt: z.ZodNumber;
                    parserVersion: z.ZodString;
                    normalizerVersion: z.ZodNullable<z.ZodString>;
                    processorVersion: z.ZodString;
                    schema: z.ZodNullable<z.ZodString>;
                    code: z.ZodString;
                    kind: z.ZodString;
                    itemCount: z.ZodNumber;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>;
                fiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
                previousFiscalSituation: z.ZodNullable<z.ZodObject<{
                    ruleVersion: z.ZodEnum<{
                        "nfe-status/1": "nfe-status/1";
                        "nfe-status/2": "nfe-status/2";
                    }>;
                    key: z.ZodNullable<z.ZodString>;
                    reportedStatus: z.ZodEnum<{
                        unknown: "unknown";
                        authorized: "authorized";
                        cancelled: "cancelled";
                        denied: "denied";
                        conflict: "conflict";
                    }>;
                    basis: z.ZodLiteral<"preserved-claims">;
                    assurance: z.ZodLiteral<"unverified-origin">;
                    liveConsultation: z.ZodLiteral<false>;
                    evidenceIds: z.ZodArray<z.ZodString>;
                    excluded: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        reason: z.ZodString;
                    }, z.core.$strict>>;
                    conflicts: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                versionId: z.ZodString;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    item: z.ZodString;
                    code: z.ZodString;
                    description: z.ZodString;
                    ncm: z.ZodString;
                    cfop: z.ZodString;
                    cest: z.ZodNullable<z.ZodString>;
                    purchaseOrder: z.ZodNullable<z.ZodString>;
                    purchaseOrderItem: z.ZodNullable<z.ZodString>;
                    unit: z.ZodString;
                    quantity: z.ZodString;
                    unitPrice: z.ZodString;
                    total: z.ZodString;
                    tributaryUnit: z.ZodString;
                    tributaryQuantity: z.ZodString;
                    tributaryUnitPrice: z.ZodString;
                    nt2026008: z.ZodNullable<z.ZodObject<{
                        vUnComLiq: z.ZodNullable<z.ZodString>;
                        vProdLiq: z.ZodNullable<z.ZodString>;
                        vICMSPrevisto: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>>;
                    taxes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"decimal">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"code">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>, z.ZodObject<{
                        path: z.ZodString;
                        representation: z.ZodLiteral<"text">;
                        value: z.ZodString;
                        basis: z.ZodLiteral<"declared">;
                    }, z.core.$strict>], "representation">>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
                versionId: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                kind: z.ZodOptional<z.ZodEnum<{
                    event: "event";
                    "event-summary": "event-summary";
                }>>;
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    version: z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        operationId: z.ZodString;
                        artifactId: z.ZodString;
                        sha256: z.ZodString;
                        source: z.ZodEnum<{
                            "imported-xml": "imported-xml";
                            "distribution-xml": "distribution-xml";
                        }>;
                        importedAt: z.ZodNumber;
                        publishedAt: z.ZodNumber;
                        parserVersion: z.ZodString;
                        normalizerVersion: z.ZodNullable<z.ZodString>;
                        processorVersion: z.ZodString;
                        schema: z.ZodNullable<z.ZodString>;
                        code: z.ZodString;
                        kind: z.ZodString;
                        itemCount: z.ZodNumber;
                        originalAvailable: z.ZodBoolean;
                    }, z.core.$strict>;
                    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
                        kind: z.ZodLiteral<"invoice">;
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        number: z.ZodString;
                        series: z.ZodString;
                        issuedAt: z.ZodString;
                        operation: z.ZodString;
                        purpose: z.ZodNullable<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            label: z.ZodNullable<z.ZodString>;
                            creditNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            debitNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            inconsistencies: z.ZodArray<z.ZodEnum<{
                                "B25.1-10": "B25.1-10";
                                "B25.1-20": "B25.1-20";
                                "B25.2-10": "B25.2-10";
                                "B25.2-20": "B25.2-20";
                            }>>;
                        }, z.core.$strict>>;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        recipient: z.ZodNullable<z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        total: z.ZodString;
                        declaredTotals: z.ZodObject<{
                            vNF: z.ZodString;
                            vNFTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"decimal">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"code">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"text">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>], "representation">>;
                        nt2026008: z.ZodNullable<z.ZodObject<{
                            vProdLiqTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        nt2026006: z.ZodNullable<z.ZodObject<{
                            gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                                nPag: z.ZodString;
                                idTransacao: z.ZodString;
                                tpMeioPgto: z.ZodString;
                                tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                                CNPJReceb: z.ZodString;
                                CNPJBasePSP: z.ZodString;
                            }, z.core.$strict>>>;
                        }, z.core.$strict>>;
                        protocol: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            receivedAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        kind: z.ZodLiteral<"summary">;
                        key: z.ZodString;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        issuedAt: z.ZodString;
                        total: z.ZodString;
                        status: z.ZodString;
                        protocolNumber: z.ZodString;
                        receivedAt: z.ZodString;
                    }, z.core.$strict>, z.ZodObject<{
                        protocolNumber: z.ZodString;
                        registeredAt: z.ZodString;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event-summary">;
                    }, z.core.$strict>, z.ZodObject<{
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        cancellation: z.ZodNullable<z.ZodObject<{
                            protocolNumber: z.ZodString;
                            reason: z.ZodString;
                        }, z.core.$strict>>;
                        correction: z.ZodNullable<z.ZodObject<{
                            text: z.ZodString;
                            conditions: z.ZodString;
                        }, z.core.$strict>>;
                        manifestation: z.ZodNullable<z.ZodObject<{
                            reason: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        receipt: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            type: z.ZodString;
                            sequence: z.ZodString;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            registeredAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event">;
                    }, z.core.$strict>], "kind">;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    version: z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        operationId: z.ZodString;
                        artifactId: z.ZodString;
                        sha256: z.ZodString;
                        source: z.ZodEnum<{
                            "imported-xml": "imported-xml";
                            "distribution-xml": "distribution-xml";
                        }>;
                        importedAt: z.ZodNumber;
                        publishedAt: z.ZodNumber;
                        parserVersion: z.ZodString;
                        normalizerVersion: z.ZodNullable<z.ZodString>;
                        processorVersion: z.ZodString;
                        schema: z.ZodNullable<z.ZodString>;
                        code: z.ZodString;
                        kind: z.ZodString;
                        itemCount: z.ZodNumber;
                        originalAvailable: z.ZodBoolean;
                    }, z.core.$strict>;
                    payload: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                        kind: z.ZodLiteral<"invoice">;
                        key: z.ZodString;
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        number: z.ZodString;
                        series: z.ZodString;
                        issuedAt: z.ZodString;
                        operation: z.ZodString;
                        purpose: z.ZodNullable<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            label: z.ZodNullable<z.ZodString>;
                            creditNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            debitNoteType: z.ZodNullable<z.ZodObject<{
                                code: z.ZodString;
                                label: z.ZodNullable<z.ZodString>;
                            }, z.core.$strict>>;
                            inconsistencies: z.ZodArray<z.ZodEnum<{
                                "B25.1-10": "B25.1-10";
                                "B25.1-20": "B25.1-20";
                                "B25.2-10": "B25.2-10";
                                "B25.2-20": "B25.2-20";
                            }>>;
                        }, z.core.$strict>>;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        recipient: z.ZodNullable<z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        total: z.ZodString;
                        declaredTotals: z.ZodObject<{
                            vNF: z.ZodString;
                            vNFTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        totals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"decimal">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"code">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>, z.ZodObject<{
                            path: z.ZodString;
                            representation: z.ZodLiteral<"text">;
                            value: z.ZodString;
                            basis: z.ZodLiteral<"declared">;
                        }, z.core.$strict>], "representation">>;
                        nt2026008: z.ZodNullable<z.ZodObject<{
                            vProdLiqTot: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        nt2026006: z.ZodNullable<z.ZodObject<{
                            gPgtoVinc: z.ZodNullable<z.ZodArray<z.ZodObject<{
                                nPag: z.ZodString;
                                idTransacao: z.ZodString;
                                tpMeioPgto: z.ZodString;
                                tpMeioPgtoLabel: z.ZodNullable<z.ZodString>;
                                CNPJReceb: z.ZodString;
                                CNPJBasePSP: z.ZodString;
                            }, z.core.$strict>>>;
                        }, z.core.$strict>>;
                        protocol: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            receivedAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        kind: z.ZodLiteral<"summary">;
                        key: z.ZodString;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        issuedAt: z.ZodString;
                        total: z.ZodString;
                        status: z.ZodString;
                        protocolNumber: z.ZodString;
                        receivedAt: z.ZodString;
                    }, z.core.$strict>, z.ZodObject<{
                        protocolNumber: z.ZodString;
                        registeredAt: z.ZodString;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event-summary">;
                    }, z.core.$strict>, z.ZodObject<{
                        environment: z.ZodEnum<{
                            1: "1";
                            2: "2";
                        }>;
                        cancellation: z.ZodNullable<z.ZodObject<{
                            protocolNumber: z.ZodString;
                            reason: z.ZodString;
                        }, z.core.$strict>>;
                        correction: z.ZodNullable<z.ZodObject<{
                            text: z.ZodString;
                            conditions: z.ZodString;
                        }, z.core.$strict>>;
                        manifestation: z.ZodNullable<z.ZodObject<{
                            reason: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        receipt: z.ZodNullable<z.ZodObject<{
                            key: z.ZodString;
                            environment: z.ZodEnum<{
                                1: "1";
                                2: "2";
                            }>;
                            type: z.ZodString;
                            sequence: z.ZodString;
                            status: z.ZodString;
                            number: z.ZodNullable<z.ZodString>;
                            registeredAt: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        key: z.ZodString;
                        author: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        type: z.ZodString;
                        sequence: z.ZodString;
                        occurredAt: z.ZodString;
                        description: z.ZodString;
                        kind: z.ZodLiteral<"event">;
                    }, z.core.$strict>], "kind">, z.ZodObject<{
                        kind: z.ZodLiteral<"service-invoice">;
                        key: z.ZodString;
                        number: z.ZodString;
                        municipality: z.ZodString;
                        municipalRegistration: z.ZodNullable<z.ZodString>;
                        verificationCode: z.ZodString;
                        issuedAt: z.ZodString;
                        competence: z.ZodString;
                        issuer: z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>;
                        recipient: z.ZodNullable<z.ZodObject<{
                            kind: z.ZodEnum<{
                                CPF: "CPF";
                                CNPJ: "CNPJ";
                            }>;
                            document: z.ZodString;
                            name: z.ZodNullable<z.ZodString>;
                            stateRegistration: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        total: z.ZodString;
                        serviceCode: z.ZodString;
                        description: z.ZodString;
                        values: z.ZodArray<z.ZodObject<{
                            name: z.ZodString;
                            value: z.ZodString;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    name: z.ZodString;
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                    source: z.ZodEnum<{
                        "imported-xml": "imported-xml";
                        "distribution-xml": "distribution-xml";
                    }>;
                    importedAt: z.ZodNumber;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                limit: z.ZodOptional<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    name: z.ZodString;
                    sha256: z.ZodString;
                    importedAt: z.ZodNumber;
                    size: z.ZodNumber;
                    code: z.ZodString;
                    originalAvailable: z.ZodBoolean;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                documentId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                operationId: z.ZodString;
                reused: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                state: z.ZodOptional<z.ZodEnum<{
                    authorized: "authorized";
                    cancelled: "cancelled";
                    processing: "processing";
                    rejected: "rejected";
                }>>;
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                page: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                    environment: z.ZodEnum<{
                        sandbox: "sandbox";
                        production: "production";
                    }>;
                    operationId: z.ZodString;
                    operationState: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>;
                    state: z.ZodEnum<{
                        authorized: "authorized";
                        cancelled: "cancelled";
                        processing: "processing";
                        rejected: "rejected";
                    }>;
                    transport: z.ZodEnum<{
                        simulated: "simulated";
                        "producao-restrita": "producao-restrita";
                        producao: "producao";
                    }>;
                    target: z.ZodString;
                    series: z.ZodString;
                    number: z.ZodNumber;
                    dpsId: z.ZodString;
                    issueDate: z.ZodString;
                    competence: z.ZodString;
                    market: z.ZodEnum<{
                        domestic: "domestic";
                        export: "export";
                    }>;
                    amount: z.ZodObject<{
                        currency: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>;
                    serviceBrl: z.ZodNullable<z.ZodString>;
                    exchange: z.ZodNullable<z.ZodObject<{
                        currency: z.ZodString;
                        amount: z.ZodString;
                        rate: z.ZodString;
                        quoteDate: z.ZodString;
                        brlAmount: z.ZodString;
                        source: z.ZodEnum<{
                            simulated: "simulated";
                            "ptax-bcb": "ptax-bcb";
                        }>;
                        frozenAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    accessKey: z.ZodNullable<z.ZodString>;
                    nfseNumber: z.ZodNullable<z.ZodString>;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    artifacts: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        kind: z.ZodEnum<{
                            nfse: "nfse";
                            dps: "dps";
                            danfse: "danfse";
                            "cancel-request": "cancel-request";
                            "cancel-event": "cancel-event";
                        }>;
                        sha256: z.ZodString;
                        size: z.ZodNumber;
                        signed: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        id: z.ZodString;
                        operationId: z.ZodString;
                        state: z.ZodEnum<{
                            processing: "processing";
                            rejected: "rejected";
                            registered: "registered";
                        }>;
                        sequence: z.ZodNumber;
                        reasonCode: z.ZodEnum<{
                            1: "1";
                            2: "2";
                            9: "9";
                        }>;
                        reason: z.ZodString;
                        code: z.ZodNullable<z.ZodString>;
                        rejections: z.ZodArray<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            message: z.ZodString;
                        }, z.core.$strict>>;
                        alreadyRegistered: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                        updatedAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    version: z.ZodNumber;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                issuanceId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                originalId: z.ZodOptional<z.ZodString>;
                companyId: z.ZodString;
                projectId: z.ZodString;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                operationId: z.ZodString;
                operationState: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    reconciling: "reconciling";
                    paused: "paused";
                    succeeded: "succeeded";
                    failed: "failed";
                }>;
                state: z.ZodEnum<{
                    authorized: "authorized";
                    cancelled: "cancelled";
                    processing: "processing";
                    rejected: "rejected";
                }>;
                transport: z.ZodEnum<{
                    simulated: "simulated";
                    "producao-restrita": "producao-restrita";
                    producao: "producao";
                }>;
                target: z.ZodString;
                series: z.ZodString;
                number: z.ZodNumber;
                dpsId: z.ZodString;
                issueDate: z.ZodString;
                competence: z.ZodString;
                market: z.ZodEnum<{
                    domestic: "domestic";
                    export: "export";
                }>;
                amount: z.ZodObject<{
                    currency: z.ZodString;
                    value: z.ZodString;
                }, z.core.$strict>;
                serviceBrl: z.ZodNullable<z.ZodString>;
                exchange: z.ZodNullable<z.ZodObject<{
                    currency: z.ZodString;
                    amount: z.ZodString;
                    rate: z.ZodString;
                    quoteDate: z.ZodString;
                    brlAmount: z.ZodString;
                    source: z.ZodEnum<{
                        simulated: "simulated";
                        "ptax-bcb": "ptax-bcb";
                    }>;
                    frozenAt: z.ZodNumber;
                }, z.core.$strict>>;
                accessKey: z.ZodNullable<z.ZodString>;
                nfseNumber: z.ZodNullable<z.ZodString>;
                code: z.ZodNullable<z.ZodString>;
                rejections: z.ZodArray<z.ZodObject<{
                    code: z.ZodNullable<z.ZodString>;
                    message: z.ZodString;
                }, z.core.$strict>>;
                artifacts: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    kind: z.ZodEnum<{
                        nfse: "nfse";
                        dps: "dps";
                        danfse: "danfse";
                        "cancel-request": "cancel-request";
                        "cancel-event": "cancel-event";
                    }>;
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                    signed: z.ZodBoolean;
                    createdAt: z.ZodNumber;
                }, z.core.$strict>>;
                cancellation: z.ZodNullable<z.ZodObject<{
                    id: z.ZodString;
                    operationId: z.ZodString;
                    state: z.ZodEnum<{
                        processing: "processing";
                        rejected: "rejected";
                        registered: "registered";
                    }>;
                    sequence: z.ZodNumber;
                    reasonCode: z.ZodEnum<{
                        1: "1";
                        2: "2";
                        9: "9";
                    }>;
                    reason: z.ZodString;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    alreadyRegistered: z.ZodBoolean;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>>;
                version: z.ZodNumber;
                createdAt: z.ZodNumber;
                updatedAt: z.ZodNumber;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                issuanceId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                reasonCode: z.ZodEnum<{
                    1: "1";
                    2: "2";
                    9: "9";
                }>;
                reason: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                reused: z.ZodBoolean;
                issuance: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                    environment: z.ZodEnum<{
                        sandbox: "sandbox";
                        production: "production";
                    }>;
                    operationId: z.ZodString;
                    operationState: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>;
                    state: z.ZodEnum<{
                        authorized: "authorized";
                        cancelled: "cancelled";
                        processing: "processing";
                        rejected: "rejected";
                    }>;
                    transport: z.ZodEnum<{
                        simulated: "simulated";
                        "producao-restrita": "producao-restrita";
                        producao: "producao";
                    }>;
                    target: z.ZodString;
                    series: z.ZodString;
                    number: z.ZodNumber;
                    dpsId: z.ZodString;
                    issueDate: z.ZodString;
                    competence: z.ZodString;
                    market: z.ZodEnum<{
                        domestic: "domestic";
                        export: "export";
                    }>;
                    amount: z.ZodObject<{
                        currency: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>;
                    serviceBrl: z.ZodNullable<z.ZodString>;
                    exchange: z.ZodNullable<z.ZodObject<{
                        currency: z.ZodString;
                        amount: z.ZodString;
                        rate: z.ZodString;
                        quoteDate: z.ZodString;
                        brlAmount: z.ZodString;
                        source: z.ZodEnum<{
                            simulated: "simulated";
                            "ptax-bcb": "ptax-bcb";
                        }>;
                        frozenAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    accessKey: z.ZodNullable<z.ZodString>;
                    nfseNumber: z.ZodNullable<z.ZodString>;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    artifacts: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        kind: z.ZodEnum<{
                            nfse: "nfse";
                            dps: "dps";
                            danfse: "danfse";
                            "cancel-request": "cancel-request";
                            "cancel-event": "cancel-event";
                        }>;
                        sha256: z.ZodString;
                        size: z.ZodNumber;
                        signed: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        id: z.ZodString;
                        operationId: z.ZodString;
                        state: z.ZodEnum<{
                            processing: "processing";
                            rejected: "rejected";
                            registered: "registered";
                        }>;
                        sequence: z.ZodNumber;
                        reasonCode: z.ZodEnum<{
                            1: "1";
                            2: "2";
                            9: "9";
                        }>;
                        reason: z.ZodString;
                        code: z.ZodNullable<z.ZodString>;
                        rejections: z.ZodArray<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            message: z.ZodString;
                        }, z.core.$strict>>;
                        alreadyRegistered: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                        updatedAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    version: z.ZodNumber;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                companyId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodArray<z.ZodObject<{
                active: z.ZodBoolean;
                version: z.ZodNumber;
                secretVersion: z.ZodNumber;
                previousUntil: z.ZodNullable<z.ZodNumber>;
                createdAt: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                id: z.ZodString;
            }, z.core.$strict>>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                active: z.ZodBoolean;
                version: z.ZodNumber;
                secretVersion: z.ZodNumber;
                previousUntil: z.ZodNullable<z.ZodNumber>;
                createdAt: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                id: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                companyId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                endpoint: z.ZodObject<{
                    active: z.ZodBoolean;
                    version: z.ZodNumber;
                    secretVersion: z.ZodNumber;
                    previousUntil: z.ZodNullable<z.ZodNumber>;
                    createdAt: z.ZodNumber;
                    name: z.ZodString;
                    url: z.ZodString;
                    events: z.ZodArray<z.ZodEnum<{
                        "document.received": "document.received";
                        "document.updated": "document.updated";
                        "document.event_received": "document.event_received";
                        "import.completed": "import.completed";
                        "connection.attention_required": "connection.attention_required";
                        "connection.release_withdrawn": "connection.release_withdrawn";
                        "connection.history_limited": "connection.history_limited";
                        "issuance.authorized": "issuance.authorized";
                        "issuance.rejected": "issuance.rejected";
                        "issuance.cancelled": "issuance.cancelled";
                        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                    }>>;
                    id: z.ZodString;
                }, z.core.$strict>;
                secret: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                active: z.ZodBoolean;
                expectedVersion: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                active: z.ZodBoolean;
                version: z.ZodNumber;
                secretVersion: z.ZodNumber;
                previousUntil: z.ZodNullable<z.ZodNumber>;
                createdAt: z.ZodNumber;
                name: z.ZodString;
                url: z.ZodString;
                events: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                id: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedVersion: z.ZodNumber;
                overlapMs: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                endpoint: z.ZodObject<{
                    active: z.ZodBoolean;
                    version: z.ZodNumber;
                    secretVersion: z.ZodNumber;
                    previousUntil: z.ZodNullable<z.ZodNumber>;
                    createdAt: z.ZodNumber;
                    name: z.ZodString;
                    url: z.ZodString;
                    events: z.ZodArray<z.ZodEnum<{
                        "document.received": "document.received";
                        "document.updated": "document.updated";
                        "document.event_received": "document.event_received";
                        "import.completed": "import.completed";
                        "connection.attention_required": "connection.attention_required";
                        "connection.release_withdrawn": "connection.release_withdrawn";
                        "connection.history_limited": "connection.history_limited";
                        "issuance.authorized": "issuance.authorized";
                        "issuance.rejected": "issuance.rejected";
                        "issuance.cancelled": "issuance.cancelled";
                        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                    }>>;
                    id: z.ZodString;
                }, z.core.$strict>;
                secret: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                endpointId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                eventId: z.ZodString;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{
                cursor: z.ZodOptional<z.ZodString>;
                limit: z.ZodOptional<z.ZodNumber>;
                endpointId: z.ZodString;
            }, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                items: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    eventId: z.ZodString;
                    type: z.ZodEnum<{
                        "document.received": "document.received";
                        "document.updated": "document.updated";
                        "document.event_received": "document.event_received";
                        "import.completed": "import.completed";
                        "connection.attention_required": "connection.attention_required";
                        "connection.release_withdrawn": "connection.release_withdrawn";
                        "connection.history_limited": "connection.history_limited";
                        "issuance.authorized": "issuance.authorized";
                        "issuance.rejected": "issuance.rejected";
                        "issuance.cancelled": "issuance.cancelled";
                        "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                        "webhook.test": "webhook.test";
                    }>;
                    resourceVersion: z.ZodNumber;
                    state: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        paused: "paused";
                        failed: "failed";
                        delivered: "delivered";
                    }>;
                    attempts: z.ZodNumber;
                    resends: z.ZodNumber;
                    generation: z.ZodNumber;
                    nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                    code: z.ZodNullable<z.ZodString>;
                    httpStatus: z.ZodNullable<z.ZodNumber>;
                    durationMs: z.ZodNullable<z.ZodNumber>;
                    response: z.ZodNullable<z.ZodString>;
                    createdAt: z.ZodNumber;
                    canRetry: z.ZodBoolean;
                }, z.core.$strict>>;
                nextCursor: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{
                deliveryId: z.ZodString;
            }, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                expectedGeneration: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                id: z.ZodString;
                eventId: z.ZodString;
                type: z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                    "webhook.test": "webhook.test";
                }>;
                resourceVersion: z.ZodNumber;
                state: z.ZodEnum<{
                    queued: "queued";
                    running: "running";
                    retry_wait: "retry_wait";
                    paused: "paused";
                    failed: "failed";
                    delivered: "delivered";
                }>;
                attempts: z.ZodNumber;
                resends: z.ZodNumber;
                generation: z.ZodNumber;
                nextAttemptAt: z.ZodNullable<z.ZodNumber>;
                code: z.ZodNullable<z.ZodString>;
                httpStatus: z.ZodNullable<z.ZodNumber>;
                durationMs: z.ZodNullable<z.ZodNumber>;
                response: z.ZodNullable<z.ZodString>;
                createdAt: z.ZodNumber;
                canRetry: z.ZodBoolean;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        method: "GET" | "POST" | "PATCH";
        path: string;
        input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{}, z.core.$strict>;
        }, z.core.$strict>;
        output: z.ZodObject<{
            data: z.ZodObject<{
                apiVersion: z.ZodLiteral<"8.0.0">;
                environment: z.ZodEnum<{
                    sandbox: "sandbox";
                    production: "production";
                }>;
                models: z.ZodArray<z.ZodEnum<{
                    55: "55";
                    nfse: "nfse";
                }>>;
                capabilities: z.ZodArray<z.ZodString>;
                webhookEvents: z.ZodArray<z.ZodEnum<{
                    "document.received": "document.received";
                    "document.updated": "document.updated";
                    "document.event_received": "document.event_received";
                    "import.completed": "import.completed";
                    "connection.attention_required": "connection.attention_required";
                    "connection.release_withdrawn": "connection.release_withdrawn";
                    "connection.history_limited": "connection.history_limited";
                    "issuance.authorized": "issuance.authorized";
                    "issuance.rejected": "issuance.rejected";
                    "issuance.cancelled": "issuance.cancelled";
                    "issuance.cancellation_rejected": "issuance.cancellation_rejected";
                }>>;
                limits: z.ZodObject<{
                    importFiles: z.ZodNumber;
                    importBytes: z.ZodNumber;
                    pageSize: z.ZodNumber;
                }, z.core.$strict>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        scope: string;
        retry: RetryPolicy;
        status: number;
        idempotencyPattern: string;
    } | {
        /** Response header pointing to the accepted resource. */
        readonly location: "/v1/issuances/{issuanceId}";
        readonly method: "GET" | "POST" | "PATCH";
        readonly path: string;
        readonly input: z.ZodObject<{
            path: z.ZodObject<{}, z.core.$strict>;
            query: z.ZodObject<{}, z.core.$strict>;
            body: z.ZodObject<{
                companyId: z.ZodString;
                activityCode: z.ZodString;
                competence: z.ZodString;
                issueDate: z.ZodOptional<z.ZodString>;
                issuerEmail: z.ZodOptional<z.ZodString>;
                market: z.ZodEnum<{
                    domestic: "domestic";
                    export: "export";
                }>;
                taker: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"national">;
                    document: z.ZodString;
                    name: z.ZodString;
                    email: z.ZodOptional<z.ZodString>;
                    address: z.ZodObject<{
                        municipalityCode: z.ZodString;
                        postalCode: z.ZodString;
                        street: z.ZodString;
                        number: z.ZodString;
                        district: z.ZodString;
                    }, z.core.$strict>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"foreign">;
                    nif: z.ZodOptional<z.ZodString>;
                    nifAbsence: z.ZodOptional<z.ZodNumber>;
                    name: z.ZodString;
                    email: z.ZodOptional<z.ZodString>;
                    address: z.ZodObject<{
                        country: z.ZodString;
                        city: z.ZodString;
                        postalCode: z.ZodString;
                        state: z.ZodString;
                        street: z.ZodString;
                        number: z.ZodString;
                        district: z.ZodString;
                    }, z.core.$strict>;
                }, z.core.$strict>], "kind">;
                description: z.ZodString;
                amount: z.ZodObject<{
                    currency: z.ZodString;
                    value: z.ZodString;
                }, z.core.$strict>;
                issRate: z.ZodOptional<z.ZodString>;
                issWithheld: z.ZodBoolean;
            }, z.core.$strict>;
        }, z.core.$strict>;
        readonly output: z.ZodObject<{
            data: z.ZodObject<{
                reused: z.ZodBoolean;
                issuance: z.ZodObject<{
                    id: z.ZodString;
                    originalId: z.ZodOptional<z.ZodString>;
                    companyId: z.ZodString;
                    projectId: z.ZodString;
                    environment: z.ZodEnum<{
                        sandbox: "sandbox";
                        production: "production";
                    }>;
                    operationId: z.ZodString;
                    operationState: z.ZodEnum<{
                        queued: "queued";
                        running: "running";
                        retry_wait: "retry_wait";
                        reconciling: "reconciling";
                        paused: "paused";
                        succeeded: "succeeded";
                        failed: "failed";
                    }>;
                    state: z.ZodEnum<{
                        authorized: "authorized";
                        cancelled: "cancelled";
                        processing: "processing";
                        rejected: "rejected";
                    }>;
                    transport: z.ZodEnum<{
                        simulated: "simulated";
                        "producao-restrita": "producao-restrita";
                        producao: "producao";
                    }>;
                    target: z.ZodString;
                    series: z.ZodString;
                    number: z.ZodNumber;
                    dpsId: z.ZodString;
                    issueDate: z.ZodString;
                    competence: z.ZodString;
                    market: z.ZodEnum<{
                        domestic: "domestic";
                        export: "export";
                    }>;
                    amount: z.ZodObject<{
                        currency: z.ZodString;
                        value: z.ZodString;
                    }, z.core.$strict>;
                    serviceBrl: z.ZodNullable<z.ZodString>;
                    exchange: z.ZodNullable<z.ZodObject<{
                        currency: z.ZodString;
                        amount: z.ZodString;
                        rate: z.ZodString;
                        quoteDate: z.ZodString;
                        brlAmount: z.ZodString;
                        source: z.ZodEnum<{
                            simulated: "simulated";
                            "ptax-bcb": "ptax-bcb";
                        }>;
                        frozenAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    accessKey: z.ZodNullable<z.ZodString>;
                    nfseNumber: z.ZodNullable<z.ZodString>;
                    code: z.ZodNullable<z.ZodString>;
                    rejections: z.ZodArray<z.ZodObject<{
                        code: z.ZodNullable<z.ZodString>;
                        message: z.ZodString;
                    }, z.core.$strict>>;
                    artifacts: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        originalId: z.ZodOptional<z.ZodString>;
                        kind: z.ZodEnum<{
                            nfse: "nfse";
                            dps: "dps";
                            danfse: "danfse";
                            "cancel-request": "cancel-request";
                            "cancel-event": "cancel-event";
                        }>;
                        sha256: z.ZodString;
                        size: z.ZodNumber;
                        signed: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    cancellation: z.ZodNullable<z.ZodObject<{
                        id: z.ZodString;
                        operationId: z.ZodString;
                        state: z.ZodEnum<{
                            processing: "processing";
                            rejected: "rejected";
                            registered: "registered";
                        }>;
                        sequence: z.ZodNumber;
                        reasonCode: z.ZodEnum<{
                            1: "1";
                            2: "2";
                            9: "9";
                        }>;
                        reason: z.ZodString;
                        code: z.ZodNullable<z.ZodString>;
                        rejections: z.ZodArray<z.ZodObject<{
                            code: z.ZodNullable<z.ZodString>;
                            message: z.ZodString;
                        }, z.core.$strict>>;
                        alreadyRegistered: z.ZodBoolean;
                        createdAt: z.ZodNumber;
                        updatedAt: z.ZodNumber;
                    }, z.core.$strict>>;
                    version: z.ZodNumber;
                    createdAt: z.ZodNumber;
                    updatedAt: z.ZodNumber;
                }, z.core.$strict>;
            }, z.core.$strict>;
            requestId: z.ZodString;
        }, z.core.$strict>;
        readonly scope: string;
        readonly retry: RetryPolicy;
        readonly status: number;
        readonly idempotencyPattern: string;
    };
    path: {
        [k: string]: string;
    };
} | null;
