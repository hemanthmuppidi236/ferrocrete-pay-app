import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ferrocrete Pay App",
  description: "Pay applications and release trackers for Ferrocrete Builders",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// Runs before first paint so a dark-mode user never sees a flash of the light
// theme (FOUC). Sets data-theme on <html> from localStorage; the topbar keeps
// it in sync afterward. Kept as a string so it's inlined verbatim in <head>.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme');if(t!=='dark')t='light';document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="app-shell" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
