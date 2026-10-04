export interface InputRegion { x: number; y: number; width: number; height: number }

/** Convert GL bottom-up alpha pixels into CSS input regions, with a one-cell margin. */
export function alphaInputRegions(pixels: Uint8Array, width: number, height: number, cssWidth: number, cssHeight: number): InputRegion[] {
  const regions: InputRegion[] = []
  const sx = cssWidth / width, sy = cssHeight / height
  for (let y = 0; y < height; y++) {
    let start = -1
    for (let x = 0; x <= width; x++) {
      const hit = x < width && pixels[(y * width + x) * 4 + 3] > 10
      if (hit && start < 0) start = x
      if (!hit && start >= 0) {
        const left = Math.max(0, Math.floor((start - 1) * sx))
        const top = Math.max(0, Math.floor((height - y - 2) * sy))
        regions.push({ x: left, y: top, width: Math.min(cssWidth, Math.ceil((x + 1) * sx)) - left, height: Math.min(cssHeight, Math.ceil((height - y + 1) * sy)) - top })
        start = -1
      }
    }
  }
  return regions
}
