import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <rect width="512" height="512" rx="96" fill="#3b82f6"/>
  <path d="M192 160L96 256L192 352" stroke="white" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M320 160L416 256L320 352" stroke="white" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const TAURI_ICONS_DIR = path.join(import.meta.dirname, '../src-tauri/icons');
const PUBLIC_DIR = path.join(import.meta.dirname, '../public');

// Tauri icon sizes
const tauriSizes = [
  { name: '32x32.png', size: 32 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png', size: 512 },
  // Windows Store logos
  { name: 'Square30x30Logo.png', size: 30 },
  { name: 'Square44x44Logo.png', size: 44 },
  { name: 'Square71x71Logo.png', size: 71 },
  { name: 'Square89x89Logo.png', size: 89 },
  { name: 'Square107x107Logo.png', size: 107 },
  { name: 'Square142x142Logo.png', size: 142 },
  { name: 'Square150x150Logo.png', size: 150 },
  { name: 'Square284x284Logo.png', size: 284 },
  { name: 'Square310x310Logo.png', size: 310 },
  { name: 'StoreLogo.png', size: 50 },
];

// Web icon sizes
const webSizes = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'android-chrome-192x192.png', size: 192 },
  { name: 'android-chrome-512x512.png', size: 512 },
];

async function generateIcons() {
  const svgBuffer = Buffer.from(SVG);

  // Generate Tauri icons
  console.log('Generating Tauri icons...');
  for (const { name, size } of tauriSizes) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(TAURI_ICONS_DIR, name));
    console.log(`  ✓ ${name}`);
  }

  // Generate ICO file (Windows)
  const ico32 = await sharp(svgBuffer).resize(32, 32).png().toBuffer();
  const ico48 = await sharp(svgBuffer).resize(48, 48).png().toBuffer();
  const ico256 = await sharp(svgBuffer).resize(256, 256).png().toBuffer();

  // For ICO, we'll just use the 256x256 PNG as ico (simple approach)
  // A proper ICO would need a dedicated library
  await sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(path.join(TAURI_ICONS_DIR, 'icon.ico'));
  console.log('  ✓ icon.ico (256x256 PNG)');

  // Generate ICNS placeholder (macOS) - using PNG as placeholder
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(TAURI_ICONS_DIR, 'icon.icns'));
  console.log('  ✓ icon.icns (512x512 PNG placeholder)');

  // Generate web icons
  console.log('Generating web icons...');
  for (const { name, size } of webSizes) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(PUBLIC_DIR, name));
    console.log(`  ✓ ${name}`);
  }

  console.log('\nDone! Icons generated successfully.');
}

generateIcons().catch(console.error);
