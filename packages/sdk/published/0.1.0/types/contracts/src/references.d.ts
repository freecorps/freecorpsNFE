import { z } from "zod";
export declare const referenceDataset: z.ZodEnum<{
    municipalities: "municipalities";
    ncm: "ncm";
}>;
export declare const referenceVersion: z.ZodString;
export declare const referenceDate: z.ZodString;
export declare const referenceManifest: z.ZodObject<{
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
export declare const referenceEntry: z.ZodObject<{
    code: z.ZodString;
    description: z.ZodString;
    state: z.ZodNullable<z.ZodString>;
    validFrom: z.ZodNullable<z.ZodString>;
    validTo: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const referenceStatus: z.ZodEnum<{
    valid: "valid";
    out_of_validity: "out_of_validity";
    validity_unknown: "validity_unknown";
}>;
export declare const referenceItem: z.ZodObject<{
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
}, z.core.$strict>;
export declare const referencePage: z.ZodObject<{
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
export declare const referenceLookup: z.ZodObject<{
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
export type ReferenceManifest = z.infer<typeof referenceManifest>;
export type ReferenceEntry = z.infer<typeof referenceEntry>;
export type ReferenceDataset = z.infer<typeof referenceDataset>;
export declare const referenceCursor: z.ZodObject<{
    version: z.ZodString;
    dataset: z.ZodEnum<{
        municipalities: "municipalities";
        ncm: "ncm";
    }>;
    date: z.ZodString;
    q: z.ZodString;
    after: z.ZodString;
}, z.core.$strict>;
export type ReferenceCursor = z.infer<typeof referenceCursor>;
export declare const municipalitySource: z.ZodArray<z.ZodObject<{
    id: z.ZodNumber;
    nome: z.ZodString;
    microrregiao: z.ZodNullable<z.ZodObject<{
        mesorregiao: z.ZodObject<{
            UF: z.ZodObject<{
                sigla: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    "regiao-imediata": z.ZodObject<{
        "regiao-intermediaria": z.ZodObject<{
            UF: z.ZodObject<{
                sigla: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>;
    }, z.core.$strip>;
}, z.core.$strip>>;
export declare const ncmSource: z.ZodObject<{
    Data_Ultima_Atualizacao_NCM: z.ZodString;
    Nomenclaturas: z.ZodArray<z.ZodObject<{
        Codigo: z.ZodString;
        Descricao: z.ZodString;
        Data_Inicio: z.ZodString;
        Data_Fim: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** Unknown dates stay unknown. A snapshot only establishes presence on its reference date. */
export declare function referenceValidity(entry: ReferenceEntry, manifest: ReferenceManifest, date: string): "valid" | "out_of_validity" | "validity_unknown";
export declare function referenceSearch(value: string): string;
