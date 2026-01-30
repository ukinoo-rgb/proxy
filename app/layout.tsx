import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProxLearn AI – Chat with our blog & analytics",
  description: "AI assistant for Proximity Learning blog and analytics",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased overflow-x-hidden">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
