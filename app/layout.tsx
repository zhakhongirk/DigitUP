import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agentic Storefront",
  description: "AI commerce infrastructure for small businesses",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wallpaper" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/background.jpg" alt="" />
        </div>
        {children}
      </body>
    </html>
  );
}
