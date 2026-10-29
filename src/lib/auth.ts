import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

export const AUTH_COOKIE = "solee_auth";

/**
 * Senha do painel: so existe na variavel DASHBOARD_PASSWORD da Vercel (nunca no
 * codigo, que e publico). Sem ela configurada, ninguem consegue entrar.
 */
export function getDashboardPassword(): string | null {
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  return password ? password : null;
}

/**
 * Valor assinado do cookie de acesso. Antes o cookie era apenas "1", e qualquer
 * pessoa podia cria-lo no navegador e entrar sem senha. Trocar a senha (ou
 * AUTH_SECRET) invalida todos os acessos ja feitos.
 */
export function getAuthToken() {
  const secret = process.env.AUTH_SECRET || getDashboardPassword();
  if (!secret) return null;
  return createHmac("sha256", secret).update("solee-auth-v1").digest("hex");
}

export function isValidAuthToken(value: string | undefined) {
  const token = getAuthToken();
  if (!value || !token || !getDashboardPassword()) return false;
  const expected = Buffer.from(token);
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export async function isAuthenticated() {
  const cookieStore = await cookies();
  return isValidAuthToken(cookieStore.get(AUTH_COOKIE)?.value);
}
