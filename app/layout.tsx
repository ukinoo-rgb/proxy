import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProxLearn AI – Chat with our blog & analytics",
  description: "AI assistant for Proximity Learning blog and analytics",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
