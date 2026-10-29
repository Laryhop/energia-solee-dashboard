/*
 * Armazenamento persistente via Upstash Redis (REST), sem dependencias extras.
 *
 * Na Vercel: Storage -> Create Database -> Upstash for Redis -> conectar ao projeto.
 * A integracao cria KV_REST_API_URL e KV_REST_API_TOKEN automaticamente.
 * Tambem aceita UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (configuracao manual).
 */

type RedisValue = string | number;
type RedisResult = { result?: unknown; error?: string };

function getConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export function isStorageConfigured() {
  return getConfig() !== null;
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Armazenamento nao configurado (KV_REST_API_URL / KV_REST_API_TOKEN).");
  }
}

/** Executa varios comandos Redis numa unica requisicao. */
export async function redis(commands: RedisValue[][]): Promise<unknown[]> {
  const config = getConfig();
  if (!config) throw new StorageNotConfiguredError();

  const response = await fetch(`${config.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands.map((command) => command.map(String))),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error(`Redis respondeu HTTP ${response.status}.`);
  }

  const results = (await response.json()) as RedisResult[];
  return results.map((item) => {
    if (item.error) throw new Error(`Redis: ${item.error}`);
    return item.result;
  });
}

/** Converte a resposta de HGETALL ([campo, valor, ...]) em objeto. */
export function hashToObject(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      result[String(raw[index])] = String(raw[index + 1]);
    }
  } else if (raw && typeof raw === "object") {
    Object.assign(result, raw);
  }
  return result;
}

export function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
