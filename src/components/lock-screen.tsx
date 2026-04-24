"use client";
import { useState } from "react";

export function LockScreen() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(false);
    
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      
      if (res.ok) {
        window.location.reload();
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] dark:bg-[#060d09] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-[#0f1d15] rounded-[2.5rem] p-8 shadow-2xl border border-slate-200 dark:border-emerald-900/30 text-center transition-all">
        <div className="mx-auto w-20 h-20 bg-emerald-50 dark:bg-emerald-900/20 rounded-3xl flex items-center justify-center mb-6 border border-emerald-100 dark:border-emerald-900/50">
          <svg className="w-10 h-10 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h1 className="text-2xl font-black text-[#052e16] dark:text-white mb-2">Painel Protegido</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-8 font-medium">
          Por favor, insira a senha de acesso para visualizar os dados da usina solar.
        </p>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Senha de acesso" 
              className="w-full px-5 py-4 rounded-2xl bg-slate-50 dark:bg-[#060d09] border border-slate-200 dark:border-emerald-900/50 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-center text-lg font-black dark:text-white transition-colors"
              disabled={loading}
            />
          </div>
          {error && <p className="text-xs font-bold text-rose-500">Senha incorreta. Tente novamente.</p>}
          <button 
            type="submit" 
            disabled={loading || !password}
            className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black uppercase tracking-widest transition-colors disabled:opacity-50"
          >
            {loading ? "Verificando..." : "Desbloquear Painel"}
          </button>
        </form>
      </div>
    </div>
  );
}
