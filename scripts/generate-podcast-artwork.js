/**
 * One-off: render the podcast channel artwork (3000×3000 PNG) and upload it
 * to troy-podcast/artwork.png (referenced by the feed's itunes:image).
 *
 * Adapts the Troy coin SVG from TroyStack-mobile/generate-icon.js — vector
 * source, so rendering at 3000² is lossless (Apple requires 1400–3000 square,
 * RGB). Requires sharp (devDependency).
 *
 * Run: node scripts/generate-podcast-artwork.js
 */
require('dotenv').config();
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CANVAS = 3000;
const COIN_SIZE = 2460; // ~82% of canvas, same proportions as the app icon
const OFFSET = (CANVAS - COIN_SIZE) / 2;

const size = COIN_SIZE;
const half = size / 2;
const rimWidth = 1.5 * (size / 20);
const bodyR = half - rimWidth;
const rimR = half - rimWidth / 2;
const fontSize = size * 0.6;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <rect width="${CANVAS}" height="${CANVAS}" fill="#000000"/>
  <g transform="translate(${OFFSET}, ${OFFSET})">
    <defs>
      <radialGradient id="troyCoinGrad" cx="45%" cy="40%" r="50%">
        <stop offset="0" stop-color="#F5D780"/>
        <stop offset="1" stop-color="#A07C28"/>
      </radialGradient>
    </defs>
    <circle cx="${half}" cy="${half}" r="${bodyR}" fill="url(#troyCoinGrad)"/>
    <circle cx="${half}" cy="${half}" r="${rimR}" fill="none" stroke="#8B6914" stroke-width="${rimWidth}"/>
    <text x="${half}" y="${half}" text-anchor="middle" dominant-baseline="central"
          font-family="Georgia, 'Times New Roman', serif" font-weight="700"
          font-size="${fontSize}" fill="#7A5C1F">T</text>
    <text x="${half}" y="${half - size * 0.006}" text-anchor="middle" dominant-baseline="central"
          font-family="Georgia, 'Times New Roman', serif" font-weight="700"
          font-size="${fontSize}" fill="rgba(255, 224, 160, 0.35)">T</text>
  </g>
</svg>`;

(async () => {
  const png = await sharp(Buffer.from(svg), { density: 300 })
    .resize(CANVAS, CANVAS)
    .png()
    .toBuffer();

  const meta = await sharp(png).metadata();
  console.log(`🎨 Rendered artwork: ${meta.width}x${meta.height} ${meta.format}, ${png.length} bytes`);
  if (meta.width !== CANVAS || meta.height !== CANVAS) {
    console.error('❌ Unexpected dimensions');
    process.exit(1);
  }

  const { error } = await supabase.storage
    .from('troy-podcast')
    .upload('artwork.png', png, { contentType: 'image/png', upsert: true });
  if (error) {
    console.error('❌ Upload failed:', error.message);
    process.exit(1);
  }
  const { data: pub } = supabase.storage.from('troy-podcast').getPublicUrl('artwork.png');
  console.log(`✅ Uploaded: ${pub.publicUrl}`);
  process.exit(0);
})();
