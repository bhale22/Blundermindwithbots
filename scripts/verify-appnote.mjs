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
  ok('aboutAppNote exists', state.appNote.present);
  ok('aboutAppNote is VISIBLE', state.appNote.hidden === false);
  ok('aboutWebNote stays hidden', state.webNote.hidden === true);
  ok('landingWebNote stays hidden', state.landing.hidden === true);
  ok('note mentions closed testing', /closed testing/i.test(state.noteText));
  ok('note asks for Play Store email', /google account email/i.test(state.noteText));
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
  ok('aboutAppNote stays HIDDEN (not circular)', state.appNote.hidden === true);
  ok('no page errors', errors.length === 0, errors[0] || '');
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
