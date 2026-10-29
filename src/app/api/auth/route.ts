import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { AUTH_COOKIE, getAuthToken, getDashboardPassword } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const password = body.password;
    
    const correctPassword = getDashboardPassword();
    const token = getAuthToken();
    if (!correctPassword || !token) {
      return NextResponse.json(
        {
          success: false,
          error: "Senha do painel não configurada. Crie a variável DASHBOARD_PASSWORD na Vercel e faça Redeploy.",
        },
        { status: 503 },
      );
    }

    if (typeof password === "string" && password === correctPassword) {
      const cookieStore = await cookies();
      cookieStore.set(AUTH_COOKIE, token, { 
        httpOnly: true, 
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 30, // 30 dias
        path: "/"
      });
      return NextResponse.json({ success: true });
    }
    
    return NextResponse.json({ success: false, error: "Senha incorreta" }, { status: 401 });
  } catch (error) {
    return NextResponse.json({ success: false, error: "Erro interno" }, { status: 500 });
  }
}
