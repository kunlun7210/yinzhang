"use strict";

function extractSeal(pixels, width, height, options) {
  const cut = 3 + 29 * (1 - options.sensitivity / 100) ** 2;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function chroma(r, g, b, blue) {
    const primary = blue ? b : r;
    const first = primary - g;
    const second = primary - (blue ? r : b);
    if (first < 1 || second < 1 || primary < 30) return 0;
    // Fade off near orange, cyan and magenta instead of clipping an entire hue band.
    const hue = clamp((Math.min(first, second) / Math.max(first, second) - .28) * 4, 0, 1);
    return (first + second) * .5 * hue;
  }

  // A light cast at the page edges can otherwise outweigh a small stamp.
  function paperLevel(blue) {
    const values = [];
    let visible = 0;
    function sample(x, y) {
      const i = 4 * (y * width + x);
      if (pixels[i + 3] < 240) return;
      visible++;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (Math.min(r, g, b) >= 185 && Math.max(r, g, b) - Math.min(r, g, b) <= 38) {
        values.push(chroma(r, g, b, blue));
      }
    }
    for (let x = 0; x < width; x += Math.max(1, Math.ceil(width / 160))) {
      sample(x, 0);
      sample(x, height - 1);
    }
    for (let y = 0; y < height; y += Math.max(1, Math.ceil(height / 160))) {
      sample(0, y);
      sample(width - 1, y);
    }
    if (!values.length || values.length < visible * .65) return 0;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  function stats(blue) {
    const paper = paperLevel(blue);
    const histogram = new Float64Array(256);
    let weight = 0;
    const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 90000)));
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const i = (y * width + x) * 4;
        const score = (chroma(pixels[i], pixels[i + 1], pixels[i + 2], blue) - paper) * pixels[i + 3] / 255;
        if (score <= cut + 2) continue;
        const contribution = Math.sqrt(score - cut);
        histogram[Math.floor(score)] += contribution;
        weight += contribution;
      }
    }
    let target = weight * .22;
    let peak = 0;
    for (let i = 255; i >= 0 && target > 0; i--) {
      target -= histogram[i];
      peak = i;
    }
    return { blue, weight, peak, paper };
  }

  const red = options.ink === "blue" ? null : stats(false);
  const blue = options.ink === "red" ? null : stats(true);
  const ink = !red || (blue && blue.weight > red.weight) ? blue : red;
  const color = ink.blue ? "blue" : "red";
  const scores = new Uint8Array(width * height);
  const minimumReference = Math.max(65, ink.peak * .94);
  const sampleThreshold = Math.max(minimumReference * .72, ink.peak * .83);
  let rTotal = 0, gTotal = 0, bTotal = 0, samples = 0;

  for (let n = 0, i = 0; n < scores.length; n++, i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const value = Math.max(0, chroma(r, g, b, ink.blue) - ink.paper);
    const opacity = pixels[i + 3] / 255;
    const effective = value * opacity;
    if (value >= sampleThreshold && opacity > .75) {
      rTotal += r;
      gTotal += g;
      bTotal += b;
      samples++;
    }
    // The smooth threshold gives weak edges a gradual transition to transparent.
    const edge = clamp((effective - cut) / 13, 0, 1);
    const alpha = opacity * clamp(value / minimumReference, 0, 1) * edge * options.strength / 100;
    scores[n] = Math.round(Math.min(opacity, alpha) * 255);
  }

  const average = samples ? [rTotal / samples, gTotal / samples, bTotal / samples] : null;
  const fallback = ink.blue ? [44, 79, 155] : [164, 42, 45];
  const gain = average ? clamp(minimumReference / chroma(...average, ink.blue), 1, 1.65) : 1;
  const base = average ? average.map(value => Math.round(clamp(245 - (245 - value) * gain, 0, 255))) : fallback;

  let left = width, right = -1, top = height, bottom = -1;
  // Keep weak edges next to ink. Remove only pixels with almost no support in a 3×3 neighborhood.
  const mask = options.clean ? scores.slice() : scores;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = y * width + x;
      if (!scores[n]) continue;
      if (options.clean) {
        let neighbors = 0;
        for (let dy = Math.max(-1, -y); dy <= Math.min(1, height - 1 - y); dy++) {
          for (let dx = Math.max(-1, -x); dx <= Math.min(1, width - 1 - x); dx++) {
            if ((dx || dy) && scores[n + dy * width + dx] >= 8) neighbors++;
          }
        }
        if (neighbors < 2) {
          mask[n] = 0;
          continue;
        }
      }
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left) return { color, width: 0, height: 0 };
  const padding = Math.max(3, Math.round(Math.max(right - left, bottom - top) * .035));
  left = options.trim ? Math.max(0, left - padding) : 0;
  top = options.trim ? Math.max(0, top - padding) : 0;
  right = options.trim ? Math.min(width - 1, right + padding) : width - 1;
  bottom = options.trim ? Math.min(height - 1, bottom + padding) : height - 1;
  const resultWidth = right - left + 1, resultHeight = bottom - top + 1;
  const result = new Uint8ClampedArray(resultWidth * resultHeight * 4);
  for (let y = 0; y < resultHeight; y++) {
    for (let x = 0; x < resultWidth; x++) {
      const n = (y + top) * width + x + left;
      const alpha = mask[n];
      if (!alpha) continue;
      const i = (y * resultWidth + x) * 4;
      // Preserve variations in strong ink while recovering weak ink from its paper mixture.
      const original = n * 4;
      const blend = clamp((alpha / 255 - .55) * .65, 0, .25);
      result[i] = base[0] * (1 - blend) + pixels[original] * blend;
      result[i + 1] = base[1] * (1 - blend) + pixels[original + 1] * blend;
      result[i + 2] = base[2] * (1 - blend) + pixels[original + 2] * blend;
      result[i + 3] = alpha;
    }
  }
  return { color, width: resultWidth, height: resultHeight, pixels: result };
}

if (typeof module !== "undefined") module.exports = extractSeal;
