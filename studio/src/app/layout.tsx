import type { Metadata } from "next";
import { Geist, Geist_Mono, Orbitron } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// JARVIS HUD display font — brand title + reactor captions only (body text
// stays Geist/Geist Mono for readability). Variable font → no weight list.
const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AgentScope Studio — J.A.R.V.I.S Command Center",
  description:
    "JARVIS-style command center over the AgentScope agentic engine: real streaming chat, multi-agent task execution, laptop control with approval gates, and 10+ LLM providers.",
  keywords: ["AgentScope", "JARVIS", "AI agent", "multi-provider", "OpenAI", "Claude", "Gemini", "chat"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
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
        className={`${geistSans.variable} ${geistMono.variable} ${orbitron.variable} antialiased bg-background text-foreground`}
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
