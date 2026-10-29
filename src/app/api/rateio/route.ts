import { NextResponse } from "next/server";

import { isAuthenticated } from "@/lib/auth";
import {
  deleteRateioVersion,
  getRateioData,
  saveRateioVersion,
  setUcName,
  updateRateioVersionMonth,
} from "@/lib/rateio";
import { isStorageConfigured } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const fail = (error: unknown, status = 400) =>
  NextResponse.json({ error: error instanceof Error ? error.message : "Falha na operação." }, { status });

function requireStorage() {
  if (!isStorageConfigured()) throw new Error("Conecte o banco (Upstash) na Vercel para salvar o rateio.");
}

/** GET -> versoes do rateio, apelidos e geracao mensal. */
export async function GET() {
  if (!(await isAuthenticated())) return unauthorized();
  try {
    return NextResponse.json(await getRateioData(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return fail(error, 502);
  }
}

/** POST { effectiveMonth, entries, ... } -> salva uma nova versao (planilha enviada). */
export async function POST(request: Request) {
  if (!(await isAuthenticated())) return unauthorized();
  try {
    requireStorage();
    return NextResponse.json(await saveRateioVersion(await request.json()));
  } catch (error) {
    return fail(error);
  }
}

/** PATCH { uc, name } -> apelido da UC; { id, effectiveMonth } -> muda a vigencia. */
export async function PATCH(request: Request) {
  if (!(await isAuthenticated())) return unauthorized();
  try {
    requireStorage();
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.uc === "string" && typeof body.name === "string") {
      return NextResponse.json(await setUcName(body.uc, body.name));
    }
    if (typeof body.id === "string" && typeof body.effectiveMonth === "string") {
      return NextResponse.json(await updateRateioVersionMonth(body.id, body.effectiveMonth));
    }
    throw new Error("Nada para atualizar.");
  } catch (error) {
    return fail(error);
  }
}

/** DELETE ?id=... -> remove uma versao enviada por engano. */
export async function DELETE(request: Request) {
  if (!(await isAuthenticated())) return unauthorized();
  try {
    requireStorage();
    const id = new URL(request.url).searchParams.get("id") ?? "";
    await deleteRateioVersion(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
