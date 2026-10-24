import type { Metadata } from "next";
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/orbitron/500.css';
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "AgentScope Studio — J.A.R.V.I.S Command Center",
  description:
    "JARVIS-style command center over the AgentScope agentic engine: real streaming chat, multi-agent task execution, laptop control with approval gates, and 10+ LLM providers.",
  keywords: ["AgentScope", "JARVIS", "AI agent", "multi-provider", "OpenAI", "Claude", "Gemini", "chat"],
  icons: {
    icon: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // .jarvis-scope carries the JARVIS theme: Tailwind v4 palette overrides +
    // state-driven accent variables. It lives on <html> so Radix portals
    // (dialogs, toasts) inherit the theme too.
    <html lang="en" className="jarvis-scope" suppressHydrationWarning>
      <body
        className={"antialiased bg-background text-foreground"}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only fixed top-0 left-0 z-50 p-4 text-white bg-cyan-600 rounded-md"
        >
          Skip to content
        </a>
        <main id="main">{children}</main>
        <Toaster />
      </body>
    </html>
  );
}
