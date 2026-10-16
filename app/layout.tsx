import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

// Fonte geometrica, de cara tecnologica, boa para numeros.
const fonte = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--fonte",
});

export const metadata: Metadata = {
  title: "Minhas contas",
  description: "Controle mensal de contas e gastos",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#05070f",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={fonte.variable}>
      <body>{children}</body>
    </html>
  );
}
