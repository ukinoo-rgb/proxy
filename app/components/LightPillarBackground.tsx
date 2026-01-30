"use client";

import LightPillar from "@/components/LightPillar";

export interface LightPillarBackgroundProps {
  topColor?: string;
  bottomColor?: string;
  intensity?: number;
  rotationSpeed?: number;
  glowAmount?: number;
  pillarWidth?: number;
  pillarHeight?: number;
  noiseIntensity?: number;
  pillarRotation?: number;
  interactive?: boolean;
  mixBlendMode?: React.CSSProperties["mixBlendMode"];
  quality?: "low" | "high";
  className?: string;
}

/* Match React Bits example usage */
const DEFAULTS = {
  topColor: "#df910c",
  bottomColor: "#01d0cd",
  intensity: 1,
  rotationSpeed: 0.3,
  glowAmount: 0.002,
  pillarWidth: 3,
  pillarHeight: 0.4,
  noiseIntensity: 0.5,
  pillarRotation: 25,
  interactive: true,
  mixBlendMode: "screen" as const,
  quality: "high" as const,
};

/**
 * Full-viewport Light Pillar background.
 * Accepts all customization props; defaults match reactbits.dev/backgrounds/light-pillar.
 */
export default function LightPillarBackground(props: LightPillarBackgroundProps) {
  const {
    topColor = DEFAULTS.topColor,
    bottomColor = DEFAULTS.bottomColor,
    intensity = DEFAULTS.intensity,
    rotationSpeed = DEFAULTS.rotationSpeed,
    glowAmount = DEFAULTS.glowAmount,
    pillarWidth = DEFAULTS.pillarWidth,
    pillarHeight = DEFAULTS.pillarHeight,
    noiseIntensity = DEFAULTS.noiseIntensity,
    pillarRotation = DEFAULTS.pillarRotation,
    interactive = DEFAULTS.interactive,
    mixBlendMode = DEFAULTS.mixBlendMode,
    quality = DEFAULTS.quality,
    className = "",
  } = props;

  return (
    <div
      className={`fixed inset-0 overflow-hidden ${!interactive ? "pointer-events-none" : ""} ${className}`.trim()}
    >
      <LightPillar
        topColor={topColor}
        bottomColor={bottomColor}
        intensity={intensity}
        rotationSpeed={rotationSpeed}
        glowAmount={glowAmount}
        pillarWidth={pillarWidth}
        pillarHeight={pillarHeight}
        noiseIntensity={noiseIntensity}
        pillarRotation={pillarRotation}
        interactive={interactive}
        mixBlendMode={mixBlendMode}
        quality={quality}
        className="w-full h-full"
      />
    </div>
  );
}
