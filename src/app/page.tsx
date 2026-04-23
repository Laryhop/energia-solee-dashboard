import type { Metadata } from "next";

import { DashboardShell } from "@/components/dashboard-shell";

export const metadata: Metadata = {
  title: "Usina Solar | Dashboard",
  description:
    "Acompanhamento de geração, performance, economia e status dos inversores da usina solar.",
};

export default function Home() {
  return <DashboardShell />;
}
