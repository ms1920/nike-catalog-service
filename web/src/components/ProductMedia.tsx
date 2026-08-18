import { useState } from 'react';
import { stableIndex } from '../lib/format.js';
import { Swoosh } from './Swoosh.js';

/**
 * Product imagery, with a generated fallback.
 *
 * The seed's image URLs point at example.com and do not resolve. Rather than
 * ship broken <img> tags or invent stock photography, this draws a tile in
 * Nike's real product-tile grey (#F5F5F5) and washes it with a tint *derived
 * from the product's own colourway string*. So "Volt/Bright Crimson" renders
 * a volt-and-crimson tile — the variety is meaningful rather than random.
 *
 * Point `images` at a real CDN and the photograph replaces this with no code
 * change: the <img> only yields to the tile after an actual load error.
 */

/** Colour words Nike actually uses in colourway names, mapped to tile washes. */
const TINTS: Array<{ match: RegExp; tint: string }> = [
  { match: /volt|lime/i, tint: 'oklch(90% 0.19 118)' },
  { match: /crimson|red|chicago|bred|varsity red|mandarin/i, tint: 'oklch(62% 0.20 30)' },
  { match: /navy|blue|cobalt|turquoise|racer|void/i, tint: 'oklch(58% 0.15 250)' },
  { match: /jungle|olive|cactus|green|sea glass/i, tint: 'oklch(66% 0.11 155)' },
  { match: /pink|fuchsia|violet|foam/i, tint: 'oklch(80% 0.12 350)' },
  { match: /gold|orange|sunrise|amber/i, tint: 'oklch(78% 0.15 70)' },
  { match: /purple|court purple/i, tint: 'oklch(52% 0.17 300)' },
  { match: /khaki|cargo|sail|cream|egret/i, tint: 'oklch(86% 0.05 90)' },
  { match: /grey|gray|charcoal|anthracite|slate|smoke/i, tint: 'oklch(72% 0.01 265)' },
  { match: /black/i, tint: 'oklch(38% 0.01 265)' },
  // Deliberately stepped down to 86%: a lighter grey would vanish against the
  // 96.8% product tile, leaving white colourways looking like a failed load.
  { match: /white|summit|optical|pearl/i, tint: 'oklch(86% 0.006 265)' },
];

function tintFor(colorway: string, seed: string): string {
  const hit = TINTS.find((entry) => entry.match.test(colorway));
  if (hit) return hit.tint;
  // Unrecognised colourway: fall back to a deterministic neutral so the tile is
  // still stable across renders.
  const neutrals = ['oklch(85% 0.01 265)', 'oklch(78% 0.02 240)', 'oklch(88% 0.02 100)'];
  return neutrals[stableIndex(seed, neutrals.length)]!;
}

/**
 * Five hard-edged compositions, chosen deterministically per product.
 *
 * One repeated shape across a 24-tile grid reads as a template no matter how
 * the colour varies — the eye locks onto the silhouette, not the hue. Rotating
 * the composition breaks that pattern while keeping every tile from the same
 * visual family. All stops are hard (two stops at one position), so the cuts
 * stay crisp: a soft gradient bloom is the exact look being avoided.
 */
const COMPOSITIONS: Array<(tint: string) => string> = [
  // Wide diagonal sweep
  (t) => `linear-gradient(115deg, transparent 0 38%, ${t} 38% 62%, transparent 62% 100%)`,
  // Twin pinstripes
  (t) =>
    `linear-gradient(115deg, transparent 0 28%, ${t} 28% 39%, transparent 39% 54%, ${t} 54% 65%, transparent 65% 100%)`,
  // Low horizon block
  (t) => `linear-gradient(180deg, transparent 0 62%, ${t} 62% 100%)`,
  // Corner wedge
  (t) => `linear-gradient(48deg, ${t} 0 32%, transparent 32% 100%)`,
  // Offset half-cut
  (t) => `linear-gradient(158deg, ${t} 0 46%, transparent 46% 100%)`,
];

/** Mark size varies with the composition so the watermark doesn't tile either. */
const MARK_SIZES = [64, 56, 72, 60, 68];

interface ProductMediaProps {
  src: string | undefined;
  alt: string;
  colorway: string;
  seed: string;
  /** Out-of-stock tiles desaturate, matching how Nike greys sold-out product. */
  muted?: boolean;
}

export function ProductMedia({
  src,
  alt,
  colorway,
  seed,
  muted = false,
}: ProductMediaProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  if (showImage) {
    return (
      <div className="media" data-muted={muted || undefined}>
        <img
          className="media__img"
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  const tint = tintFor(colorway, seed);
  const variant = stableIndex(seed, COMPOSITIONS.length);
  const band = COMPOSITIONS[variant]!(tint);

  return (
    <div
      className="media media--generated"
      data-muted={muted || undefined}
      style={{ backgroundImage: band }}
      role="img"
      aria-label={`${alt} — ${colorway}`}
    >
      <Swoosh size={MARK_SIZES[variant]!} className="media__mark" />
    </div>
  );
}
