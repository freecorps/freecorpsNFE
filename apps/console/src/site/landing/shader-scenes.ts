import type { ComponentConfig, PresetConfig } from "shaders/js";

// Shader scenes for the landing (client.ts). Colours stay inside the page
// palette: night, brand green, phosphor.
export const scenes: Record<string, PresetConfig> = {
  hero: {
    components: [
      { type: "SolidColor", props: { color: "#09100d" } },
      {
        type: "Dither",
        props: {
          pattern: "bayer4",
          pixelSize: 2,
          colorMode: "custom",
          colorA: "#09100d",
          colorB: "#4a6656",
        },
        children: [
          {
            type: "FlowField",
            props: { strength: 0.22, detail: 2.2, speed: 1.2, evolutionSpeed: 0.6 },
            children: [
              {
                type: "FractalNoise",
                props: {
                  colorA: "#000000",
                  colorB: "#ffffff",
                  octaves: 5,
                  contrast: 0.62,
                  speed: 0.08,
                  seed: 7,
                },
              },
            ],
          },
        ],
      },
    ],
  },
  chaos: {
    components: [
      { type: "SolidColor", props: { color: "#09100d" } },
      {
        type: "Dither",
        props: {
          pattern: "bayer8",
          pixelSize: 1,
          colorMode: "custom",
          colorA: "#09100d",
          colorB: "#2e4337",
        },
        children: [
          {
            type: "WaveDistortion",
            props: { strength: 0.12, frequency: 3, speed: 2.4, waveType: "square" },
            children: [
              {
                type: "SimplexNoise",
                props: { colorA: "#ffffff", colorB: "#000000", scale: 3.2, speed: 2.2 },
              },
            ],
          },
        ],
      },
    ],
  },
  coverage: {
    components: [
      {
        type: "DotGrid",
        props: {
          color: "#2f6b52",
          density: 70,
          dotSize: 0.18,
          twinkle: 0.7,
          speed: 0.6,
          speedVariance: 0.5,
        },
      },
    ],
  },
  closing: {
    components: [
      { type: "SolidColor", props: { color: "#09100d" } },
      {
        type: "IsometricCubes",
        props: {
          colorA: "#0c1511",
          colorB: "#14231b",
          lineColor: "#2a3d33",
          cells: 14,
          thickness: 1,
          colorVariation: 0.6,
        },
      },
      {
        type: "Godrays",
        props: {
          center: { x: 0.5, y: 1.1 },
          density: 0.25,
          intensity: 0.5,
          speed: 0.3,
          rayColor: "#d4f36e",
          opacity: 0.35,
        },
      },
    ],
  },
};

// Every effect type the scenes use, children included. The build keeps only
// these in the shader engine (shaders-plugin.ts), so a new effect only has to
// appear in a scene to ship.
export function sceneEffects(list: Record<string, PresetConfig> = scenes) {
  const types = new Set<string>();
  const walk = (components: ComponentConfig[] | undefined) => {
    for (const component of components ?? []) {
      types.add(component.type);
      walk(component.children);
    }
  };
  for (const scene of Object.values(list)) walk(scene.components);
  return [...types].sort();
}
