// The site's one motion language, for the WAAPI / rAF cases. Mirrors the CSS
// tokens in css/base.css (--dur-*, --ease-*). Reduced motion is decided here.
export const DUR = { fast: 140, base: 240, pop: 320 };
const linearOK = typeof CSS !== 'undefined' && CSS.supports?.('transition-timing-function', 'linear(0, 1)');
export const EASE = {
  out: 'cubic-bezier(.22, 1, .36, 1)',
  in: 'cubic-bezier(.55, 0, .75, .25)',
  // a soft spring with a small overshoot
  spring: linearOK ? 'linear(0, .32 8%, .78 18%, 1.04 30%, 1.07 38%, 1.03 50%, .995 64%, 1)' : 'cubic-bezier(.34, 1.45, .64, 1)',
};
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
