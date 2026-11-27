export type StarMapRGB = readonly [number, number, number];

export function rgba(rgb: StarMapRGB, alpha: number) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function sprite(size: number) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext("2d")! };
}

/** Gradients are rasterized once per material/status instead of being rebuilt
 * for every body on every animation frame. */
export class StarMapSpriteCache {
  private readonly sprites = new Map<string, HTMLCanvasElement>();
  constructor(private readonly light: boolean) {}

  private get(key: string, paint: (ctx: CanvasRenderingContext2D, size: number) => void, size = 256) {
    const existing = this.sprites.get(key);
    if (existing) return existing;
    const next = sprite(size);
    paint(next.ctx, size);
    this.sprites.set(key, next.canvas);
    return next.canvas;
  }

  sun(rgb: StarMapRGB) {
    return this.get(`sun:${rgb.join(",")}`, (ctx, size) => {
      const c = size / 2;
      const glow = ctx.createRadialGradient(c, c, 4, c, c, c);
      glow.addColorStop(0, this.light ? "rgba(255,255,255,.96)" : "rgba(255,255,255,.98)");
      glow.addColorStop(0.18, this.light ? rgba(rgb, 0.42) : "rgba(248,250,252,.82)");
      glow.addColorStop(0.42, this.light ? rgba(rgb, 0.14) : "rgba(226,232,240,.20)");
      glow.addColorStop(0.72, rgba(rgb, this.light ? 0.04 : 0.055));
      glow.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);
      ctx.beginPath();
      ctx.arc(c, c, size * 0.34, 0, Math.PI * 2);
      ctx.fillStyle = "#f8fafc";
      ctx.fill();
      const rim = ctx.createLinearGradient(c, c - size * 0.34, c, c + size * 0.34);
      rim.addColorStop(0, "rgba(255,255,255,.95)");
      rim.addColorStop(0.55, rgba(rgb, 0.48));
      rim.addColorStop(1, rgba(rgb, 0.14));
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  aura(rgb: StarMapRGB) {
    return this.get(`aura:${rgb.join(",")}`, (ctx, size) => {
      const c = size / 2;
      const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
      glow.addColorStop(0, rgba(rgb, this.light ? 0.28 : 0.42));
      glow.addColorStop(0.24, rgba(rgb, this.light ? 0.14 : 0.24));
      glow.addColorStop(0.62, rgba(rgb, this.light ? 0.035 : 0.065));
      glow.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);
    });
  }

  veil(rgb: StarMapRGB) {
    return this.get(`veil:${rgb.join(",")}`, (ctx, size) => {
      const c = size / 2;
      const glow = ctx.createRadialGradient(c, c, size * 0.03, c, c, c);
      glow.addColorStop(0, rgba(rgb, this.light ? 0.09 : 0.22));
      glow.addColorStop(0.22, rgba(rgb, this.light ? 0.055 : 0.14));
      glow.addColorStop(0.58, rgba(rgb, this.light ? 0.025 : 0.06));
      glow.addColorStop(0.84, rgba(rgb, this.light ? 0.01 : 0.02));
      glow.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);
    });
  }

  orb(rgb: StarMapRGB, luminous: boolean, closed: boolean) {
    return this.get(`orb:${rgb.join(",")}:${luminous}:${closed}`, (ctx, size) => {
      const c = size / 2;
      const r = size * 0.34;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      if (closed) {
        ctx.fillStyle = this.light ? "rgba(226,232,240,.74)" : "rgba(20,25,35,.82)";
      } else if (this.light) {
        const fill = ctx.createLinearGradient(c, c - r, c, c + r);
        fill.addColorStop(0, luminous ? rgba(rgb, 0.64) : "rgba(255,255,255,.98)");
        fill.addColorStop(1, luminous ? rgba(rgb, 0.94) : "rgba(226,232,240,.94)");
        ctx.fillStyle = fill;
      } else {
        const fill = ctx.createRadialGradient(c, c - r * 0.16, 1, c, c, r);
        if (luminous) {
          fill.addColorStop(0, rgba(rgb, 0.98));
          fill.addColorStop(0.58, rgba(rgb, 0.82));
          fill.addColorStop(1, "rgba(15,23,42,.94)");
        } else {
          fill.addColorStop(0, "rgba(51,65,85,.88)");
          fill.addColorStop(1, "rgba(22,28,40,.94)");
        }
        ctx.fillStyle = fill;
      }
      ctx.fill();
      const rim = ctx.createLinearGradient(c, c - r, c, c + r);
      rim.addColorStop(0, closed ? "rgba(226,232,240,.4)" : "rgba(255,255,255,.88)");
      rim.addColorStop(0.48, rgba(rgb, closed ? 0.16 : 0.55));
      rim.addColorStop(1, rgba(rgb, 0.12));
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }, 128);
  }
}
