/** Shaded relief from decoded Terrarium heights. No generated geographic detail. */
export function shadeTerrarium(rgba, width, height, tileY, zoom, overview = false) {
  if (!Number.isInteger(width) || width !== height || width < 2 || width > 1024 || rgba.length !== width * height * 4) throw new Error('Invalid elevation image');
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 18 || tileY < 0 || tileY >= 2 ** zoom) throw new Error('Invalid elevation coordinates');
  const size = Math.min(256, width), step = width / size;
  if (!Number.isInteger(step)) throw new Error('Unsupported elevation sampling');
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let value = 0;
    for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) {
      const at = ((y * step + dy) * width + x * step + dx) * 4;
      value += rgba[at] * 256 + rgba[at + 1] + rgba[at + 2] / 256 - 32768;
    }
    heights[y * size + x] = value / (step * step);
  }
  // Terrain colour is an elevation key, not satellite imagery or vegetation classification.
  const stops = [[-500,211,225,203],[200,207,223,194],[650,194,211,174],[1300,205,211,181],[2200,217,210,188],[3300,226,224,212],[4800,244,246,239]];
  const output = new Uint8ClampedArray(size * size * 4);
  const light = [-.48, -.56, .68], accent = overview ? 3.2 : 1.3;
  for (let y = 0; y < size; y++) {
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + (y + .5) / size) / 2 ** zoom)));
    const meters = 40075016.68557849 * Math.cos(latitude) / (2 ** zoom * size);
    for (let x = 0; x < size; x++) {
      const left = Math.max(0,x-1), right = Math.min(size-1,x+1), top = Math.max(0,y-1), bottom = Math.min(size-1,y+1);
      const gx = (heights[y*size+right]-heights[y*size+left]) / (meters * (right-left));
      const gy = (heights[bottom*size+x]-heights[top*size+x]) / (meters * (bottom-top));
      const norm = Math.hypot(gx*accent,gy*accent,1);
      const illumination = (-gx*accent*light[0]-gy*accent*light[1]+light[2])/norm;
      const value = heights[y*size+x], at = (y*size+x)*4;
      if (overview) {
        let hi = 1; while(hi < stops.length-1 && value > stops[hi][0]) hi++;
        const a=stops[hi-1], b=stops[hi], t=Math.max(0,Math.min(1,(value-a[0])/(b[0]-a[0])));
        const exposure = Math.max(.58,Math.min(1.14,.78+illumination*.33));
        for(let c=0;c<3;c++)output[at+c]=(a[c+1]*(1-t)+b[c+1]*t)*exposure;
        output[at+3]=255;
      } else {
        const delta=illumination-light[2];
        const color=delta < 0 ? [31,55,44] : [255,250,228];
        for(let c=0;c<3;c++)output[at+c]=color[c];
        output[at+3]=Math.min(105,Math.abs(delta)*170);
      }
    }
  }
  return {pixels:output,width:size,height:size};
}
