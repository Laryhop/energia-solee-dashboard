import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const password = body.password;
    
    // Default password for easy setup.
    // The user should set DASHBOARD_PASSWORD in Vercel to change this.
    const correctPassword = process.env.DASHBOARD_PASSWORD || "solee2026";
    
    if (password === correctPassword) {
      const cookieStore = await cookies();
      cookieStore.set("solee_auth", "1", { 
        httpOnly: true, 
        secure: process.env.NODE_ENV === "production",
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
