import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ferrocrete Pay App",
  description: "Pay applications and release trackers for Ferrocrete Builders",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="app-shell">{children}</body>
    </html>
  );
}
