import { z } from "zod";

const envSchema = z.object({
  SEMS_USER: z.string().min(1, "SEMS_USER nao foi definido."),
  SEMS_PASS: z.string().min(1, "SEMS_PASS nao foi definido."),
  SEMS_PLANT_ID: z.string().optional(),
  TARIFA_KWH: z.coerce.number().positive().default(0.9),
  META_DIARIA: z.coerce.number().positive().default(1500),
  SEMS_CACHE_TTL_MS: z.coerce.number().int().positive().default(60_000),
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse({
      SEMS_USER: process.env.SEMS_USER,
      SEMS_PASS: process.env.SEMS_PASS,
      SEMS_PLANT_ID: process.env.SEMS_PLANT_ID,
      TARIFA_KWH: process.env.TARIFA_KWH,
      META_DIARIA: process.env.META_DIARIA,
      SEMS_CACHE_TTL_MS: process.env.SEMS_CACHE_TTL_MS,
    });
  }

  return cachedEnv;
}
