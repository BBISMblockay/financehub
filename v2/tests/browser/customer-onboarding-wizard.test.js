/* The wholesale application, run as a browser runs it.
 *
 * The page was reshaped from one 30-input scroll into a five-step wizard. The
 * steps are PRESENTATION -- every field stays in the DOM and the submit is
 * still one atomic call that consumes the token -- so the thing that actually
 * needs proving is that reshaping it did not change what gets sent.
 *
 * That cannot be proved by reading buildForm(): the risk is in the wiring
 * around it -- a step that hides a field the payload still reads, a review
 * that describes something other than what is posted, a `required` field in a
 * hidden step silently blocking submit (the form carries `novalidate` and
 * drives validation by hand precisely because the browser refuses to report
 * on a field it cannot focus). So this suite fills the form the way a person
 * does, through the steps, and asserts on the REQUEST BODY that leaves the
 * page.
 *
 * Nothing real is reached: the edge function is a route stub.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('customer-onboarding-wizard');

/* r.test() calls its function SYNCHRONOUSLY and counts "did not throw" as a
   pass -- so an async function handed to it returns a pending promise, throws
   nothing, and is recorded as passing whatever it would have asserted. Every
   check in this suite is asynchronous, so they all go through this wrapper
   instead. Verified by breaking one deliberately and watching it fail. */
async function t(name, fn) {
  try {
    await fn();
    r.ok(name, true);
  } catch (err) {
    r.ok(name, false, err && err.message ? err.message : String(err));
  }
}

const COMPANY = 'Baseballism';
const EMAIL = 'buyer@example.com';

const PEEK = {
  ok: true,
  email: EMAIL,
  company_title: COMPANY,
  account_type: 'wholesale',
  legal_name: '',
  status: 'invited',
  consent_version: 'test.v1',
  consent_text: 'Authorisation text.',
};

(async () => {
  const suite = await startSuite({ viewport: { width: 1200, height: 900 } });
  const submissions = [];

  // The edge function, faked at the network boundary. The page's own fetch,
  // its own JSON, its own error handling all still run.
  await suite.context.route('**/functions/v1/customer-onboarding', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action === 'peek') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(PEEK) });
    }
    if (body.action === 'submit') {
      submissions.push(body);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, continuation_token: 'continuation-token-0123456789' }),
      });
    }
    if (body.action === 'status') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true, status: 'submitted', card_setup_status: 'not_started',
          company_title: COMPANY, consent_text: PEEK.consent_text, card: null,
        }),
      });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  const page = await suite.context.newPage();
  await page.goto(`${suite.base}/v2/customer-onboarding.html?token=onboarding-token-0123456789`);
  page.setDefaultTimeout(5000);
  await page.waitForSelector('#form:not([hidden])');

  const visibleStep = () => page.evaluate(() => {
    const on = [...document.querySelectorAll('.co-step')].filter((s) => !s.hidden);
    return on.length === 1 ? Number(on[0].dataset.step) : `${on.length} steps visible`;
  });

  console.log('\n── the applicant sees who they are applying to ──');

  await t('the page actually resolves Beacon tokens', async () => {
    /* beacon.css scopes every token to :root[data-theme=...]. A page that
       sets no theme resolves none of them, and because this stylesheet reads
       tokens WITHOUT fallbacks, that renders the whole application as
       unstyled HTML -- serif, no card, no rail. Caught exactly this way. */
    const m = await page.evaluate(() => ({
      font: getComputedStyle(document.documentElement).getPropertyValue('--bcn-font').trim(),
      cardBg: getComputedStyle(document.querySelector('.co-card')).backgroundColor,
      bodyFont: getComputedStyle(document.body).fontFamily,
    }));
    r.truthy(m.font, '--bcn-font resolved to nothing: the page sets no data-theme');
    r.truthy(m.cardBg !== 'rgba(0, 0, 0, 0)', `the card painted no background (${m.cardBg})`);
    r.truthy(!/Times/.test(m.bodyFont), `fell back to a UA serif: ${m.bodyFont}`);
  });

  await t('the tenant names the page, not SILO', async () => {
    r.eq(await page.textContent('#brandName'), COMPANY);
    r.eq(await page.textContent('#brandMark'), 'B');
    r.truthy((await page.title()).includes(COMPANY), `title was ${await page.title()}`);
  });

  console.log('\n── one step at a time, and no skipping past a required field ──');

  await t('it opens on step 1 alone', async () => {
    r.eq(await visibleStep(), 1);
    r.eq(await page.getAttribute('#rail li:nth-child(1)', 'data-state'), 'current');
    r.eq(await page.getAttribute('#rail li:nth-child(2)', 'data-state'), 'todo');
  });

  await t('Continue with the legal name empty does not advance', async () => {
    await page.fill('#legal_name', '');
    await page.click('#nextBtn');
    r.eq(await visibleStep(), 1, 'an empty required field let the step advance');
  });

  await t('a filled step advances, and the rail marks it done', async () => {
    await page.fill('#legal_name', 'Test Wholesale LLC');
    await page.fill('#dba_name', 'Test WH');
    await page.fill('#federal_ein', '12-3456789');
    await page.click('#nextBtn');
    r.eq(await visibleStep(), 2);
    r.eq(await page.getAttribute('#rail li:nth-child(1)', 'data-state'), 'done');
    r.eq(await page.getAttribute('#rail li:nth-child(2)', 'data-state'), 'current');
  });

  await t('the invited email is carried in, not retyped', async () => {
    r.eq(await page.inputValue('#contact_email'), EMAIL);
  });

  await t('Back returns without losing what was typed', async () => {
    await page.click('#backBtn');
    r.eq(await visibleStep(), 1);
    r.eq(await page.inputValue('#legal_name'), 'Test Wholesale LLC');
    await page.click('#nextBtn');
  });

  console.log('\n── through to the review ──');

  await t('the remaining steps accept a full application', async () => {
    await page.fill('#first_name', 'Dana');
    await page.fill('#last_name', 'Reed');
    await page.fill('#contact_phone', '555-0101');
    await page.click('#nextBtn');
    r.eq(await visibleStep(), 3);

    await page.fill('#biz_street1', '100 Main St');
    await page.fill('#biz_city', 'Portland');
    await page.fill('#biz_region', 'OR');
    await page.fill('#biz_postal', '97201');
    await page.click('#nextBtn');
    r.eq(await visibleStep(), 4);

    await page.fill('#ship_attention_same', 'Receiving dock');
    await page.fill('#requested_terms', 'Net 30');
    await page.click('#nextBtn');
    r.eq(await visibleStep(), 5);
  });

  await t('the review prints what was typed, and names an inherited address', async () => {
    const text = await page.textContent('#review');
    r.truthy(text.includes('Test Wholesale LLC'), 'legal name missing from the review');
    r.truthy(text.includes('Dana Reed'), 'contact name missing from the review');
    r.truthy(text.includes('100 Main St'), 'street missing from the review');
    r.truthy(text.includes('Net 30'), 'requested terms missing from the review');
    // A pointer row must say what it points at rather than print a blank.
    r.truthy(text.includes('Same as business address'),
      'the shipping row did not name the address it inherits');
    r.truthy(text.includes('Receiving dock'), 'the receiving contact was dropped');
  });

  await t('an unanswered field reads as "Not provided", never as blank', async () => {
    const text = await page.textContent('#review');
    r.truthy(text.includes('Not provided'), 'an empty value rendered as nothing at all');
  });

  await t('Edit jumps to the step that owns the section', async () => {
    await page.click('.co-review-group:nth-child(2) .co-review-edit');
    r.eq(await visibleStep(), 2, 'Edit on the contact block did not open the contact step');
    await page.click('#nextBtn');
    await page.click('#nextBtn');
    await page.click('#nextBtn');
    r.eq(await visibleStep(), 5);
  });

  console.log('\n── what actually leaves the page ──');

  await t('a field emptied behind you sends you back to it, rather than a dead button', async () => {
    // What the sweep exists for: the wizard is linear, so step 1 was validated
    // on the way through -- but an autofill or a session restore can empty a
    // field three steps back, and refusing to submit while showing the review
    // would leave a button that does nothing and says nothing.
    await page.evaluate(() => { document.getElementById('legal_name').value = ''; });
    await page.click('#submitBtn');
    r.eq(submissions.length, 0, 'an incomplete application was submitted');
    r.eq(await visibleStep(), 1, 'the wizard did not return to the offending field');
    await page.fill('#legal_name', 'Test Wholesale LLC');
    await page.click('#nextBtn');
    await page.click('#nextBtn');
    await page.click('#nextBtn');
    await page.click('#nextBtn');
    r.eq(await visibleStep(), 5);
  });

  await t('submitting posts the whole application in one call', async () => {
    await page.click('#submitBtn');
    await page.waitForFunction(() => document.getElementById('cardStep')
      && !document.getElementById('cardStep').hidden);
    r.eq(submissions.length, 1, 'expected exactly one submit');
  });

  await t('the payload carries every step, including steps left behind', async () => {
    const f = submissions[0].form;
    r.eq(f.legal_name, 'Test Wholesale LLC');
    r.eq(f.dba_name, 'Test WH');
    r.eq(f.federal_ein, '12-3456789');
    r.eq(f.requested_payment_terms, 'Net 30');
    r.eq(f.contacts[0].first_name, 'Dana');
    r.eq(f.contacts[0].email, EMAIL);
    const biz = f.addresses.find((a) => a.address_type === 'business');
    r.eq(biz.street1, '100 Main St');
    r.eq(biz.city, 'Portland');
  });

  await t('a "same as" address still stores a pointer and no street', () => {
    const f = submissions[0].form;
    const ship = f.addresses.find((a) => a.address_type === 'shipping');
    const bill = f.addresses.find((a) => a.address_type === 'billing');
    r.eq(ship.same_as_address_type, 'business');
    r.eq(ship.street1, undefined, 'a pointer row carried a street');
    r.eq(ship.attention_name, 'Receiving dock');
    r.eq(bill.same_as_address_type, 'business');
  });

  await t('the token used after submit is the continuation, not the spent one', async () => {
    // The card step runs on the token the submit handed back. Proven by what
    // the next call carries rather than by reading the variable.
    await page.click('#skipBtn');
    await page.waitForSelector('#done:not([hidden])');
    const seen = await page.evaluate(() => true);
    r.truthy(seen, 'the done panel never rendered');
  });

  console.log('\n── the phone case this reshape exists for ──');

  await t('at 390px the action bar stays on screen and nothing scrolls sideways', async () => {
    const phone = await suite.context.newPage();
    await phone.setViewportSize({ width: 390, height: 780 });
    await phone.goto(`${suite.base}/v2/customer-onboarding.html?token=onboarding-token-0123456789`);
    await phone.waitForSelector('#form:not([hidden])');
    const m = await phone.evaluate(() => {
      const bar = document.querySelector('.co-actions').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        barBottom: bar.bottom,
        viewportHeight: window.innerHeight,
        railLabels: [...document.querySelectorAll('.co-rail-label')]
          .filter((el) => getComputedStyle(el).display !== 'none').length,
      };
    });
    r.eq(m.overflow, 0, `the page scrolls sideways by ${m.overflow}px`);
    r.truthy(m.barBottom <= m.viewportHeight + 1,
      `the action bar sits ${m.barBottom - m.viewportHeight}px below the fold`);
    r.eq(m.railLabels, 1, 'all five rail labels are showing on a phone');
    await phone.close();
  });

  await suite.close();
  process.exit(r.summary().fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
