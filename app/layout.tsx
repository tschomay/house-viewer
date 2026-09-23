import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ProjectProvider } from "@/lib/client/project";
import TopBar from "@/components/TopBar";

export const metadata: Metadata = {
  title: "House Viewer: stereoscopic tours",
  description: "Walk through a listing room by room in cross-eyed 3D, made from its photos and floor plan.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0e1014",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ProjectProvider>
          <TopBar />
          {children}
        </ProjectProvider>
      </body>
    </html>
  );
}
