import type { Metadata } from "next";

import { cookies } from "next/headers";
import { DashboardShell } from "@/components/dashboard-shell";
import { LockScreen } from "@/components/lock-screen";

export const metadata: Metadata = {
  title: "Solee Energia Solar",
  description:
    "Acompanhamento de geracao, receita, performance e status dos inversores da usina solar.",
};

export default async function Home() {
  const cookieStore = await cookies();
  const isAuthenticated = cookieStore.get("solee_auth")?.value === "1";

  if (!isAuthenticated) {
    return <LockScreen />;
  }

  return <DashboardShell />;
}
