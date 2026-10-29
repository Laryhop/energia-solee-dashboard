import { NextResponse } from "next/server";

import { runMonitor } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/*
 * Verificacao de paradas, chamada a cada 5 minutos pelo GitHub Actions
 * (.github/workflows/monitor.yml). E publica de proposito, para nao exigir
 * segredos: so le o SEMS+, tem trava de 55 s contra chamadas repetidas e
 * nao devolve dados da usina.
 */
async function handle() {
  try {
    const result = await runMonitor();
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: "Armazenamento nao configurado. Conecte o Upstash Redis ao projeto na Vercel." },
        { status: 503 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Falha na verificacao." },
      { status: 502 },
    );
  }
}

export const GET = handle;
export const POST = handle;
