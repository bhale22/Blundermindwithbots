// The chimera mark, kept in its own module so both the generator and the
// verifier draw from one definition — the placement constants are the thing
// that can silently regress, and a check that re-implements them proves
// nothing.
// Authored at 512; every other size scales from these.
export const BASE = 512;
export const ANY  = { s: 1.13,        x: 100, y: 56  };  // fills the tile, shown uncropped
export const MASK = { s: 1.13 * 0.62, x: 155, y: 132 };  // inside the safe circle, ink-centred

// Moonlight, with the lake as colour rather than as scenery. An earlier version
// drew a literal frozen surface — horizon rule, specular line, reflection — which
// read well at 512 and turned to noise by 96. What survives downscaling is the
// cold blue itself, so the lake is now a soft lift from the lower left with no
// edge anywhere in it. That lift also carries the bottom of the piece, which the
// horizon band used to light.
export const ground = () => `
  <div style="position:absolute;inset:0;background:linear-gradient(158deg,#1b3348 0%,#0d1a27 44%,#060b12 100%)"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(74% 62% at 28% 27%,#cfe3f5 0%,rgba(178,208,233,.82) 23%,rgba(120,163,200,.50) 46%,rgba(56,92,128,.20) 68%,rgba(0,0,0,0) 84%)"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(96% 58% at 24% 106%,rgba(72,116,152,.62) 0%,rgba(48,82,112,.30) 42%,rgba(0,0,0,0) 74%)"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(104% 82% at 84% 74%,rgba(0,0,0,.70) 0%,rgba(0,0,0,0) 62%)"></div>`;

// The knight is filled with a gradient rather than flat black, so it does not
// end at a hard vertical seam where the pawn begins. Black across the muzzle and
// cheek, lifting only over the last ~40px to arrive at the tone the pawn starts
// on. The stops are measured in the text element's own box, which begins 92px
// left of the visible clip — so the seam at clip-x 157 falls at 249px here.
//
// No rim light. An offset copy underneath made the silhouette crisp and easy to
// pick out, but the piece is meant to be ominous, and a lit outline is the
// opposite of that. The moon behind it does the separating instead.
export const knight = () => `
  <div style="position:absolute;left:0;top:0;width:157px;height:355px;overflow:hidden">
    <div style="position:absolute;left:-92px;top:-42.5px;font-family:Georgia,serif;font-size:480px;line-height:1;
                color:transparent;white-space:nowrap;user-select:none;
                background-image:linear-gradient(to right,#04060a 0,#04060a 206px,#0d1219 226px,#232b34 240px,#3d4650 249px);
                -webkit-background-clip:text;background-clip:text">&#9822;</div>
  </div>`;

// The pawn starts on the tone the knight arrives at and climbs to white across
// its width, so the two halves meet in the middle instead of colliding.
export const mark = ({ s, x, y }) => `
  <div style="position:absolute;left:${x}px;top:${y}px;width:276px;height:355px;transform:scale(${s});transform-origin:0 0">
    ${knight()}
    <div style="position:absolute;left:157px;top:-60px;width:142px;height:415px;overflow:hidden">
      <svg viewBox="-142 -60 284 415" width="284" height="415" style="position:absolute;left:-142px;top:0">
        <defs><linearGradient id="pl" gradientUnits="userSpaceOnUse" x1="15" y1="0" x2="31" y2="0">
          <stop offset="0" stop-color="#414b56"/><stop offset="0.34" stop-color="#b3bec8"/>
          <stop offset="0.72" stop-color="#eff3f7"/><stop offset="1" stop-color="#ffffff"/>
        </linearGradient></defs>
        <g transform="translate(0,-103.2) scale(11.6) translate(-22.5,0)" fill="url(#pl)">
          <path d="M 22.5,9 C 20.29,9 18.5,10.79 18.5,13 C 18.5,13.89 18.79,14.71 19.28,15.38 C 17.33,16.5 16,18.59 16,21 C 16,23.03 16.94,24.84 18.41,26.03 C 15.41,27.09 11,31.58 11,39.5 L 34,39.5 C 34,31.58 29.59,27.09 26.59,26.03 C 28.06,24.84 29,23.03 29,21 C 29,18.59 27.67,16.5 25.72,15.38 C 26.21,14.71 26.5,13.89 26.5,13 C 26.5,10.79 24.71,9 22.5,9 z"/>
        </g>
      </svg>
    </div>
    <div style="position:absolute;left:34px;top:82px;width:108px;height:17px;border-radius:9px;background:#04060a;overflow:hidden;-webkit-mask-image:linear-gradient(to left,#000 0 47%,rgba(0,0,0,0) 66%);mask-image:linear-gradient(to left,#000 0 47%,rgba(0,0,0,0) 66%)">
      <div style="position:absolute;left:0;top:0;width:38px;height:17px;transform:translateX(66px);opacity:.96;background:radial-gradient(closest-side,rgba(255,72,58,1),rgba(255,58,46,0) 88%);filter:blur(.8px)"></div>
    </div>
  </div>`;

// The whole tile is scaled from the 512 authoring size, so the visor slot and
// the fill ramps keep their proportions instead of coarsening at small sizes.
export const page = (size, placement) => {
  const k = size / BASE;
  return `<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:#060b12;}</style>
  <div style="position:relative;width:${BASE}px;height:${BASE}px;overflow:hidden;transform:scale(${k});transform-origin:0 0;background:#060b12">
    ${ground()}${mark(placement)}
  </div>`;
};
