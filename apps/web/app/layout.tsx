import type { Metadata, Viewport } from "next";
import { Anton, Special_Elite, VT323 } from "next/font/google";
import "./globals.css";

const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-anton", display: "swap" });
const vt323 = VT323({ weight: "400", subsets: ["latin"], variable: "--font-vt323", display: "swap" });
const specialElite = Special_Elite({ weight: "400", subsets: ["latin"], variable: "--font-special-elite", display: "swap" });

export const metadata: Metadata = {
  title: "Blank Check",
  description: "Everyone cheats. The chain remembers. A party game with Face ID triggers and a C referee on Thru.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0a0807",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${anton.variable} ${vt323.variable} ${specialElite.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
