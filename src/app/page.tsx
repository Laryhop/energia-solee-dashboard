import type { Metadata } from "next";

import { DashboardShell } from "@/components/dashboard-shell";

export const metadata: Metadata = {
  title: "Solee Energia Solar",
  description:
    "Acompanhamento de geracao, receita, performance e status dos inversores da usina solar.",
};

export default function Home() {
  return <DashboardShell />;
}
