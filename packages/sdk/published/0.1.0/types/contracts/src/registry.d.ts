import { z } from "zod";
export declare const registryData: z.ZodObject<{
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
}, z.core.$strict>;
export declare const registryLookup: z.ZodObject<{
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
export type RegistryLookup = z.infer<typeof registryLookup>;
export type RegistryData = z.infer<typeof registryData>;
