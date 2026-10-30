"use client";

/**
 * Aba "Repasses": abre o sistema de repasses à Equatorial (Google Apps Script) dentro do painel.
 * O endereço vem da variável NEXT_PUBLIC_REPASSES_URL na Vercel (o "URL do app da Web", terminado em /exec).
 * O sistema de repasses tem o próprio login com a conta Google.
 */
const REPASSES_URL = process.env.NEXT_PUBLIC_REPASSES_URL?.trim() || "";

export function RepassesTab() {
  if (!REPASSES_URL) {
    return (
      <section className="rounded-[1.5rem] border border-amber-300 bg-amber-50 p-6 text-sm font-medium text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <p className="font-black uppercase tracking-wider text-xs">Repasses não configurado</p>
        <p className="mt-2">
          Crie a variável <code className="font-mono">NEXT_PUBLIC_REPASSES_URL</code> na Vercel com o endereço do sistema de repasses
          (o que termina em <code className="font-mono">/exec</code>) e faça um Redeploy.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-xs font-bold text-slate-500 dark:text-emerald-300/50">
          Cobranças do GDash, faturas da Equatorial e envio de pagamentos para a Cora.
        </p>
        <a
          href={REPASSES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-black uppercase tracking-wider text-emerald-700 hover:underline dark:text-amber-400"
        >
          Abrir em nova aba ↗
        </a>
      </div>
      <div className="overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white shadow-sm dark:border-emerald-800/30 dark:bg-[#111713]">
        <iframe
          src={REPASSES_URL}
          title="Repasses à Equatorial"
          allow="clipboard-write"
          className="block h-[calc(100vh-14rem)] min-h-[640px] w-full border-0"
        />
      </div>
    </section>
  );
}
