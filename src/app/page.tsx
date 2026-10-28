import type { Metadata } from "next";

import { isAuthenticated } from "@/lib/auth";
import { DashboardShell } from "@/components/dashboard-shell";
import { LockScreen } from "@/components/lock-screen";

export const metadata: Metadata = {
  title: "Solee Energia Solar",
  description:
    "Acompanhamento de geracao, receita, performance e status dos inversores da usina solar.",
};

export default async function Home() {
  if (!(await isAuthenticated())) {
    return <LockScreen />;
  }

  return <DashboardShell />;
}
