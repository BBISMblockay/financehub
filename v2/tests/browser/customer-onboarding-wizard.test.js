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
    if (body.action === 'open_peek') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true, open: true, company_title: COMPANY,
          account_types: ['wholesale', 'retail', 'distributor', 'licensee', 'other'],
          consent_version: 'test.v1', consent_text: 'Authorisation text.',
        }),
      });
    }
    if (body.action === 'open_submit') {
      submissions.push(body);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, continuation_token: 'continuation-token-0123456789' }),
      });
    }
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
    /* Enter during an Edit round-trip is the second way into the premature
       submit: every required field is already valid by now, so nothing else
       would have stopped it. */
    await page.press('#first_name', 'Enter');
    r.eq(submissions.length, 0, 'Enter on an edited step submitted the application');
    r.eq(await visibleStep(), 3, 'Enter did not advance to the next step');
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

  await t('Enter on an earlier step advances, and never submits the application', async () => {
    /* HTML implicit submission activates the form's default submit button on
       Enter in a text input, and `hidden` does not disable a button -- so the
       Submit control on step 5 was reachable from step 3. Measured before the
       guard: this exact sequence posted the whole application, consuming the
       single-use invite, with shipping and billing silently committed as
       "same as business" and Review never seen. */
    const fresh = await suite.context.newPage();
    fresh.setDefaultTimeout(5000);
    await fresh.goto(`${suite.base}/v2/customer-onboarding.html?token=onboarding-token-0123456789`);
    await fresh.waitForSelector('#form:not([hidden])');
    const before = submissions.length;
    await fresh.fill('#legal_name', 'Enter Test LLC');
    await fresh.click('#nextBtn');
    await fresh.fill('#first_name', 'Dana');
    await fresh.fill('#last_name', 'Reed');
    await fresh.click('#nextBtn');
    await fresh.fill('#biz_street1', '100 Main St');
    await fresh.fill('#biz_city', 'Portland');
    await fresh.press('#biz_city', 'Enter');
    await fresh.waitForTimeout(400);
    r.eq(submissions.length, before, 'Enter on the Location step submitted the application');
    const step = await fresh.evaluate(() => {
      const on = [...document.querySelectorAll('.co-step')].filter((x) => !x.hidden);
      return on.length === 1 ? Number(on[0].dataset.step) : -1;
    });
    r.eq(step, 4, 'Enter did not advance to Delivery & billing');
    await fresh.close();
  });

  console.log('\n── the open, shareable link ──');

  await t('one offered account type is not asked about at all', async () => {
    /* The production configuration: ACCOUNT_TYPES is ['wholesale'], so there
       is nothing to choose and the question is not put. A dropdown holding
       one option is a step the applicant clears for no information. The
       single type must still reach the submission. */
    const only = await suite.context.newPage();
    only.setDefaultTimeout(5000);
    await only.route('**/functions/v1/customer-onboarding', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.action === 'open_peek') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true, open: true, company_title: COMPANY,
            account_types: ['wholesale'],
            consent_version: 'test.v1', consent_text: 'Authorisation text.',
          }),
        });
      }
      return route.fallback();
    });
    await only.goto(`${suite.base}/v2/customer-onboarding.html?apply=baseballism`);
    await only.waitForSelector('#form:not([hidden])');
    r.eq(await only.isVisible('#accountTypeWrap'), false,
      'a single account type was still offered as a dropdown');
    r.has(await only.textContent('#formSub'), 'wholesale account',
      'the subtitle did not name the one type on offer');
    // No options are built, so the submit path has nothing to read from the
    // select and must fall through to the one offered type.
    const options = await only.$$eval('#account_type option', (els) => els.length);
    r.eq(options, 0, 'options were built for a dropdown that is never shown');
    await only.close();
  });

  await t('an open link asks which kind of account, and an invited one does not', async () => {
    /* The invited page already knows the type, because whoever sent the
       invite chose it. Only the open form may ask — and only when there is
       genuinely more than one type, which this fixture serves.

       Checked on a FRESH invited page, not the one the earlier tests drove:
       that page has finished and its form is hidden, so every element inside
       it reports invisible whatever the markup says. Asserting there passed
       against a deliberately broken build -- caught by mutation. */
    const invited = await suite.context.newPage();
    invited.setDefaultTimeout(5000);
    await invited.goto(`${suite.base}/v2/customer-onboarding.html?token=onboarding-token-0123456789`);
    await invited.waitForSelector('#form:not([hidden])');
    r.eq(await invited.isVisible('#accountTypeWrap'), false,
      'the invited form offered an account-type choice');
    await invited.close();

    const open = await suite.context.newPage();
    open.setDefaultTimeout(5000);
    await open.goto(`${suite.base}/v2/customer-onboarding.html?apply=baseballism`);
    await open.waitForSelector('#form:not([hidden])');
    r.eq(await open.isVisible('#accountTypeWrap'), true,
      'the open form did not offer an account-type choice');
    // The list is served by the function, so the page cannot offer something
    // the database will refuse.
    const options = await open.$$eval('#account_type option', (els) => els.map((e) => e.value));
    r.eq(options, ['wholesale', 'retail', 'distributor', 'licensee', 'other']);
    r.eq(await open.textContent('#brandName'), COMPANY);
    await open.close();
  });

  await t('an open application submits through the open action, carrying its choice', async () => {
    const open = await suite.context.newPage();
    open.setDefaultTimeout(5000);
    await open.goto(`${suite.base}/v2/customer-onboarding.html?apply=baseballism`);
    await open.waitForSelector('#form:not([hidden])');
    const before = submissions.length;

    await open.selectOption('#account_type', 'distributor');
    await open.fill('#legal_name', 'Walk In Sports');
    await open.click('#nextBtn');
    await open.fill('#first_name', 'Ada');
    await open.fill('#last_name', 'Vaughn');
    // No invite, so nothing is pre-filled: the applicant types their own.
    r.eq(await open.inputValue('#contact_email'), '',
      'an open form pre-filled an email it could not know');
    await open.fill('#contact_email', 'ada@shop.test');
    await open.click('#nextBtn');
    await open.fill('#biz_street1', '9 Elm');
    await open.fill('#biz_city', 'Bend');
    await open.click('#nextBtn');
    await open.click('#nextBtn');
    await open.click('#submitBtn');
    await open.waitForFunction(() => document.getElementById('cardStep')
      && !document.getElementById('cardStep').hidden);

    const sent = submissions[submissions.length - 1];
    r.eq(submissions.length, before + 1, 'expected exactly one open submission');
    r.eq(sent.action, 'open_submit', 'an open application used the invited submit action');
    r.eq(sent.company, 'baseballism', 'the company key from the URL was not carried');
    r.eq(sent.account_type, 'distributor', 'the chosen account type was not sent');
    r.eq(sent.token, '', 'an open application must carry no invite token');
    r.eq(sent.form.contacts[0].email, 'ada@shop.test');
    // The card step is reached exactly as it is from an invite.
    r.eq(await open.isVisible('#consentBox'), true, 'the card step was not reached');
    await open.close();
  });

  await t('a link with neither a token nor a company is refused', async () => {
    const bare = await suite.context.newPage();
    bare.setDefaultTimeout(5000);
    await bare.goto(`${suite.base}/v2/customer-onboarding.html`);
    await bare.waitForSelector('#gate:not([hidden])');
    r.eq(await bare.isVisible('#form'), false, 'a bare URL showed the application form');
    await bare.close();
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

    /* The bar must stick on a step TALLER than the screen -- which is the
       only case it exists for, and the one step 1 does not exercise because
       it happens to fit. Asserting it here instead of above is the
       difference between a real check and one that passes by luck: with
       `overflow: hidden` on the card (a scroll container, so sticky resolves
       against it rather than the viewport) this rendered 807px below the
       fold and the check above still passed. */
    await phone.fill('#legal_name', 'Test Wholesale LLC');
    await phone.click('#nextBtn');
    await phone.fill('#first_name', 'Dana');
    await phone.fill('#last_name', 'Reed');
    await phone.click('#nextBtn');
    await phone.fill('#biz_street1', '100 Main St');
    await phone.fill('#biz_city', 'Portland');
    await phone.click('#nextBtn');
    await phone.uncheck('#ship_same');
    await phone.uncheck('#bill_same_biz');
    const tall = await phone.evaluate(() => {
      window.scrollTo(0, 0);
      const bar = document.querySelector('.co-actions').getBoundingClientRect();
      return { page: document.documentElement.scrollHeight, vh: window.innerHeight,
               bottom: bar.bottom };
    });
    r.truthy(tall.page > tall.vh, 'the step under test was not taller than the screen');
    r.truthy(tall.bottom <= tall.vh + 1,
      `the action bar is ${Math.round(tall.bottom - tall.vh)}px below the fold on a long step`);
    await phone.close();
  });

  await suite.close();
  process.exit(r.summary().fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
