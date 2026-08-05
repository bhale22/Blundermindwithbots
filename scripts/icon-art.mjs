// The chimera mark, kept in its own module so both the generator and the
// verifier draw from one definition — the placement constants are the thing
// that can silently regress, and a check that re-implements them proves
// nothing.
// Authored at 512; every other size scales from these.
export const BASE = 512;
export const ANY  = { s: 1.13,        x: 100, y: 56  };  // fills the tile, shown uncropped
export const MASK = { s: 1.13 * 0.62, x: 155, y: 132 };  // inside the safe circle, ink-centred

export const ground = () => `
  <div style="position:absolute;inset:0;background:linear-gradient(160deg,#16283a 0%,#0b1622 46%,#060a10 100%)"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(66% 56% at 29% 29%,#d6e7f6 0%,rgba(186,214,236,.86) 24%,rgba(132,172,206,.52) 48%,rgba(60,95,130,.16) 68%,rgba(0,0,0,0) 82%)"></div>
  <div style="position:absolute;left:0;right:0;top:62%;bottom:0;background:linear-gradient(180deg,#3d6484 0%,#0a121b 100%)"></div>
  <div style="position:absolute;left:0;right:0;top:62%;height:2px;background:linear-gradient(90deg,rgba(214,234,250,0) 0%,rgba(214,234,250,.85) 26%,rgba(214,234,250,.15) 62%,rgba(214,234,250,0) 100%)"></div>
  <div style="position:absolute;left:12%;right:46%;top:62%;bottom:0;background:linear-gradient(180deg,rgba(190,220,244,.34) 0%,rgba(190,220,244,0) 78%);filter:blur(6px)"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(120% 78% at 78% 108%,rgba(0,0,0,.72) 0%,rgba(0,0,0,0) 60%)"></div>`;

// The knight is drawn twice: a cool copy offset up-left is the moon rim, the
// solid black copy sits on top. A rim on the lit side only — an even stroke all
// round would read as an outline rather than as light.
export const knight = (fill) => `
  <div style="position:absolute;left:0;top:0;width:157px;height:355px;overflow:hidden">
    <div style="position:absolute;left:-92px;top:-42.5px;font-family:Georgia,serif;font-size:480px;line-height:1;color:${fill};white-space:nowrap;user-select:none">&#9822;</div>
  </div>`;

export const mark = ({ s, x, y }) => `
  <div style="position:absolute;left:${x}px;top:${y}px;width:276px;height:355px;transform:scale(${s});transform-origin:0 0">
    <div style="position:absolute;left:-2px;top:-2px;width:276px;height:355px;opacity:.5;filter:blur(1.1px)">${knight('#bcd6ea')}</div>
    ${knight('#05070a')}
    <div style="position:absolute;left:157px;top:-60px;width:142px;height:415px;overflow:hidden">
      <svg viewBox="-142 -60 284 415" width="284" height="415" style="position:absolute;left:-142px;top:0">
        <defs><linearGradient id="pl" gradientUnits="userSpaceOnUse" x1="22.3" y1="0" x2="23.6" y2="0">
          <stop offset="0" stop-color="#c9d3dc"/><stop offset="0.5" stop-color="#eef2f6"/><stop offset="1" stop-color="#ffffff"/>
        </linearGradient></defs>
        <g transform="translate(0,-103.2) scale(11.6) translate(-22.5,0)" fill="url(#pl)">
          <path d="M 22.5,9 C 20.29,9 18.5,10.79 18.5,13 C 18.5,13.89 18.79,14.71 19.28,15.38 C 17.33,16.5 16,18.59 16,21 C 16,23.03 16.94,24.84 18.41,26.03 C 15.41,27.09 11,31.58 11,39.5 L 34,39.5 C 34,31.58 29.59,27.09 26.59,26.03 C 28.06,24.84 29,23.03 29,21 C 29,18.59 27.67,16.5 25.72,15.38 C 26.21,14.71 26.5,13.89 26.5,13 C 26.5,10.79 24.71,9 22.5,9 z"/>
        </g>
      </svg>
    </div>
    <div style="position:absolute;left:34px;top:82px;width:108px;height:17px;border-radius:9px;background:#05070a;overflow:hidden;-webkit-mask-image:linear-gradient(to left,#000 0 47%,rgba(0,0,0,0) 66%);mask-image:linear-gradient(to left,#000 0 47%,rgba(0,0,0,0) 66%)">
      <div style="position:absolute;left:0;top:0;width:38px;height:17px;transform:translateX(66px);opacity:.96;background:radial-gradient(closest-side,rgba(255,72,58,1),rgba(255,58,46,0) 88%);filter:blur(.8px)"></div>
    </div>
  </div>`;

// The whole tile is scaled from the 512 authoring size, so the visor slot and
// the rim keep their proportions instead of thickening at small sizes.
export const page = (size, placement) => {
  const k = size / BASE;
  return `<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:#060a10;}</style>
  <div style="position:relative;width:${BASE}px;height:${BASE}px;overflow:hidden;transform:scale(${k});transform-origin:0 0;background:#060a10">
    ${ground()}${mark(placement)}
  </div>`;
};

