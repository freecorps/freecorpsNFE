// SPDX-License-Identifier: MIT
// Copyright (c) 2026 FREECORPS TECNOLOGIA DA INFORMACAO LTDA
import { z } from "zod";

export const registryData = z.strictObject({
  name: z.string().max(160),
  status: z.string().max(80),
  address: z.strictObject({
    street: z.string().max(120),
    number: z.string().max(20),
    complement: z.string().max(80),
    district: z.string().max(80),
    city: z.string().max(80),
    state: z.string().max(2),
    postalCode: z.string().max(8),
  }),
});
export const registryLookup = z.strictObject({
  cnpj: z.string().regex(/^[A-Z0-9]{12}[0-9]{2}$/),
  provider: z.literal("opencnpj"),
  sourceUrl: z.literal("https://opencnpj.org/"),
  status: z.enum(["not_consulted", "found", "not_found", "unavailable", "unsupported_format"]),
  freshness: z.enum(["missing", "fresh", "stale"]),
  data: registryData.nullable(),
  sourceUpdatedAt: z.number().nullable(),
  consultedAt: z.number().nullable(),
  lastAttemptAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  refreshAfter: z.number().nullable(),
  version: z.number().int().nonnegative(),
});
export type RegistryLookup = z.infer<typeof registryLookup>;
export type RegistryData = z.infer<typeof registryData>;
