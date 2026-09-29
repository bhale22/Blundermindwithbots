import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? '  — ' + extra : ''));
  cond ? pass++ : fail++;
};

const browser = await chromium.launch();

async function probe(url, label) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => {
    const g = id => {
      const el = document.getElementById(id);
      return el ? { present: true, hidden: el.hidden } : { present: false };
    };
    return {
      appNote: g('aboutAppNote'),
      webNote: g('aboutWebNote'),
      landing: g('landingWebNote'),
      appCtx:  typeof bmIsAppContext === 'function' ? bmIsAppContext() : null,
      noteText: (document.getElementById('aboutAppNote') || {}).innerText || '',
      privacyHref: !!document.querySelector('#aboutFeedbackPanel a[href="/privacy"]'),
    };
  });
  await page.close();
  return { state, errors, label };
}

// ── Browser context: the app note should be the one showing ──────────────────
{
  const { state, errors } = await probe(BASE + '/', 'web');
  console.log('\n[browser context]');
  ok('bmIsAppContext() is false', state.appCtx === false);
  // The web-side notice — "there is an Android app, here is how to join the
  // test" — is PARKED while the app is in closed testing (27d9651), so on the
  // web there is nothing to reveal and bmRevealWebNotes has no web-only branch.
  // These used to assert the notice was present, visible, and recruiting
  // testers by Google account email.
  //
  // This is a park, not a deletion: when the app reaches open testing or
  // production the element comes back and these assertions come back with it.
  // Until then the honest check is that the web shows NO app notice at all —
  // which is also what catches it reappearing by accident.
  ok('the Android notice stays parked on the web', !state.appNote.present);
  ok('aboutWebNote stays hidden', state.webNote.hidden === true);
  ok('landingWebNote stays hidden', state.landing.hidden === true);
  ok('privacy policy link present', state.privacyHref);
  ok('no page errors', errors.length === 0, errors[0] || '');
}

// ── App context (?app=1): the original web note should show instead ──────────
{
  const { state, errors } = await probe(BASE + '/?app=1', 'app');
  console.log('\n[app context ?app=1]');
  ok('bmIsAppContext() is true', state.appCtx === true);
  ok('aboutWebNote is VISIBLE', state.webNote.hidden === false);
  ok('landingWebNote is VISIBLE', state.landing.hidden === false);
  // Parked, so it cannot be circular in here either — but assert it is absent
  // rather than merely hidden, since "hidden" on a missing element reads as
  // undefined and would pass for the wrong reason.
  ok('and is absent in the app too, not just hidden', !state.appNote.present);
  ok('no page errors', errors.length === 0, errors[0] || '');
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
