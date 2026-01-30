"use client";

import { GridScan } from "@/components/GridScan";

/**
 * Full-viewport Grid Scan background (React Bits).
 * When active (AI thinking), scan animation plays; else pure black (#000000).
 */
export default function GridScanBackground({ active = false }: { active?: boolean }) {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none">
      <div className="absolute inset-0 w-full h-full bg-[#000000]">
        {active && (
        <GridScan
          enableWebcam={false}
          showPreview={false}
          sensitivity={0.55}
          lineThickness={0}
          linesColor="#000000"
          gridScale={0.1}
          scanColor="#39cdea"
          scanOpacity={0.4}
          enablePost
          bloomIntensity={0.6}
          chromaticAberration={0.002}
          noiseIntensity={0.01}
          scanDirection="pingpong"
          scanOnClick={false}
          className="w-full h-full"
          style={{ width: "100%", height: "100%" }}
        />
        )}
      </div>
    </div>
  );
}
