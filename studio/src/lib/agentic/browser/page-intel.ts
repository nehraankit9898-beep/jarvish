// page-intel.ts — DOM intelligence for forms, checkout and payments
// (Features 11 + 13 + 14).
//
// The analysis script runs INSIDE the page and reports STRUCTURE, never
// sensitive VALUES: a card number, CVV or password field is reported by its
// presence, label and autocomplete hint — its value is never read, logged
// or persisted. That is the hard rule of the payment guard.
//
// Detected signal groups:
//   forms     — every form with its fields (label, name, type, required)
//   checkout  — cart-like evidence (items, quantities, totals, tax, shipping)
//   payment   — card/CVV/expiry fields, pay/subscribe buttons, wallets
//   page      — title, headings, visible buttons/links (bounded)

export interface IntelField {
  tag: string;
  name: string;
  type: string;
  label: string;
  required: boolean;
  placeholder?: string;
  autocomplete?: string;
  /** SENSITIVE fields report their presence but never their value */
  sensitive: boolean;
}

export interface IntelForm {
  id: string;
  heading: string;
  fields: IntelField[];
  submitLabels: string[];
  /** a submit on this form looks like a PAYMENT commit */
  looksLikePayment: boolean;
  /** a submit on this form looks like a CHECKOUT step (address, shipping) */
  looksLikeCheckout: boolean;
}

export interface PageIntel {
  url: string;
  title: string;
  headings: string[];
  forms: IntelForm[];
  checkout: {
    detected: boolean;
    items: { name: string; quantity: string; price: string }[];
    totals: { label: string; amount: string }[];
    currency: string[];
    returnPolicyLink: string | null;
    subscriptionWords: string[];
  };
  payment: {
    detected: boolean;
    cardFields: string[];
    cvvFields: string[];
    expiryFields: string[];
    payButtons: string[];
    walletOptions: string[];
  };
  /** pages whose whole purpose looks like login/OTP/CAPTCHA (agent must NOT
   *  bypass these — it can only report and wait for the user) */
  humanVerification: {
    detected: boolean;
    kinds: string[];
  };
}

/** Patterns that mark a field as sensitive (value must never be captured). */
const SENSITIVE_PATTERNS =
  /(card|ccnum|cvc|cvv|csc|cid|pan|expiry|exp-date|expmonth|expyear|password|passphrase|pin|otp|secret|ssn|security.?code)/i;

/** The in-page extraction (serialized, runs in the browser context). */
export const PAGE_INTEL_SCRIPT = `() => {
  const SENS = /(card|ccnum|cvc|cvv|csc|cid|pan|expiry|exp-date|expmonth|expyear|password|passphrase|pin|otp|secret|ssn|security.?code)/i;
  const PAY_WORDS = /(pay|purchase|buy.?now|checkout|place.?order|complete.?order|subscribe)/i;
  const CARD_AUTOCOMPLETE = /^(cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|transaction-amount)$/i;
  const SUB_WORDS = /(subscribe|subscription|recurring|auto.?renew|per month|per month|monthly|annually|\\b\\/mo\\b)/i;
  const PRICE_RE = /(?:rs\\.?|inr|\\$|€|£|₹|usd|eur|gbp)\\s?\\d[\\d,.]*/i;

  const trim = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const labelFor = (el) => {
    if (el.labels && el.labels.length) return trim(el.labels[0].textContent);
    const id = el.id;
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab) return trim(lab.textContent);
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return trim(aria);
    return '';
  };
  const sensitive = (el) => {
    const hay = [el.name, el.id, el.autocomplete, el.placeholder, labelFor(el), el.getAttribute('data-testid')].join(' ');
    return SENS.test(hay) || CARD_AUTOCOMPLETE.test(el.autocomplete || '');
  };

  const forms = [];
  for (const form of Array.from(document.querySelectorAll('form')).slice(0, 12)) {
    const controls = Array.from(form.querySelectorAll('input, select, textarea')).slice(0, 40);
    const fields = controls.map((el) => ({
      tag: el.tagName.toLowerCase(),
      name: trim(el.name || el.id || ''),
      type: trim(el.type || el.getAttribute('role') || ''),
      label: labelFor(el),
      required: el.required === true || el.hasAttribute('required'),
      placeholder: trim(el.placeholder || ''),
      autocomplete: trim(el.autocomplete || ''),
      sensitive: sensitive(el),
    }));
    const submitLabels = Array.from(form.querySelectorAll('button, input[type=submit], input[type=button]'))
      .map((b) => trim(b.textContent || b.value || b.getAttribute('aria-label') || ''))
      .filter(Boolean).slice(0, 8);
    const formText = (form.textContent || '').slice(0, 4000);
    const hasCard = fields.some((f) => SENS.test(f.name + f.label + f.autocomplete) && !/password/i.test(f.name + f.label));
    forms.push({
      id: trim(form.id || form.name || form.getAttribute('aria-label') || ''),
      heading: trim((form.querySelector('h1,h2,h3,h4') || {}).textContent || ''),
      fields,
      submitLabels,
      looksLikePayment: hasCard || submitLabels.some((l) => PAY_WORDS.test(l)),
      looksLikeCheckout: /(ship|address|delivery|billing|cart|order summary)/i.test(formText),
    });
  }

  // checkout signals: price-like text near cart/order words
  const bodyText = (document.body.innerText || '').slice(0, 30000);
  const totals = [];
  const totalRe = /(total|subtotal|tax|gst|vat|shipping|delivery charge|grand total)\\s*[:\\-]?\\s*((?:rs\\.?|inr|\\$|€|£|₹|usd|eur|gbp)\\s?\\d[\\d,.]*)/gi;
  let m;
  while ((m = totalRe.exec(bodyText)) && totals.length < 10) {
    totals.push({ label: trim(m[1]), amount: trim(m[2]) });
  }
  const items = [];
  for (const row of Array.from(document.querySelectorAll('[class*="cart" i] li, [class*="item" i] li, [data-testid*="cart" i] li')).slice(0, 20)) {
    const t = trim(row.textContent);
    if (t && t.length > 3 && items.length < 10) items.push({ name: t, quantity: '', price: (t.match(PRICE_RE) || [''])[0] });
  }
  const currencies = Array.from(new Set((bodyText.match(/(?:rs\\.?|inr|\\$|€|£|₹|usd|eur|gbp)/gi) || []).map((c) => c.trim()))).slice(0, 5);
  let returnPolicyLink = null;
  for (const a of Array.from(document.querySelectorAll('a'))) {
    if (/(return|refund|cancellation|exchange)\\s*polic/i.test(a.textContent || '') || /return|refund/i.test(a.href || '')) { returnPolicyLink = a.href; break; }
  }
  const subscriptionWords = (bodyText.match(/(subscribe|subscription|recurring|auto.?renew)/gi) || []).slice(0, 5);

  // payment signals OUTSIDE forms too (payment sheets are often form-less)
  const cardFields = [];
  const cvvFields = [];
  const expiryFields = [];
  for (const el of Array.from(document.querySelectorAll('input, iframe[title], [data-elements-stable-field-name]'))) {
    const hay = [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('title') || '', el.getAttribute('data-elements-stable-field-name') || ''].join(' ');
    if (/cvc|cvv|csc|cid|security.?code/i.test(hay)) cvvFields.push(trim(hay));
    else if (/expir|exp[-_ ]?(date|month|year)|cc-exp/i.test(hay)) expiryFields.push(trim(hay));
    else if (/card|cc-number|pan|cardnumber/i.test(hay)) cardFields.push(trim(hay));
  }
  const payButtons = [];
  for (const b of Array.from(document.querySelectorAll('button, [role=button], a[class*=btn i]'))) {
    const t = trim(b.textContent || '');
    if (t && PAY_WORDS.test(t) && payButtons.length < 10) payButtons.push(t);
  }
  const walletOptions = [];
  for (const el of Array.from(document.querySelectorAll('[class*="wallet" i], [data-testid*="wallet" i], iframe[title], [aria-label]'))) {
    const t = trim(el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '');
    if (/(stripe.?link|apple.?pay|google.?pay|paypal|amazon.?pay|upi)/i.test(t) && walletOptions.length < 8) walletOptions.push(t);
  }

  // human verification: the agent must report and wait, never bypass
  const hvKinds = [];
  const html = document.documentElement.outerHTML.slice(0, 200000);
  if (/recaptcha|hcaptcha|turnstile/i.test(html)) hvKinds.push('captcha');
  if (/otp|one.?time.?pass|verification.?code/i.test(bodyText)) hvKinds.push('otp');
  if (document.querySelector('input[type=password]') && /login|sign.?in/i.test(bodyText)) hvKinds.push('login');

  return {
    url: location.href,
    title: document.title,
    headings: Array.from(document.querySelectorAll('h1,h2')).map((h) => trim(h.textContent)).filter(Boolean).slice(0, 10),
    forms,
    checkout: {
      detected: totals.length > 0 || items.length > 0 || /cart|checkout/i.test(bodyText.slice(0, 2000)),
      items,
      totals,
      currency: currencies,
      returnPolicyLink,
      subscriptionWords: Array.from(new Set(subscriptionWords)),
    },
    payment: {
      detected: cardFields.length > 0 || cvvFields.length > 0 || expiryFields.length > 0 || payButtons.length > 0,
      cardFields: cardFields.slice(0, 5),
      cvvFields: cvvFields.slice(0, 5),
      expiryFields: expiryFields.slice(0, 5),
      payButtons: payButtons.slice(0, 5),
      walletOptions: walletOptions.slice(0, 5),
    },
    humanVerification: {
      detected: hvKinds.length > 0,
      kinds: hvKinds,
    },
  };
}`;

/** Typescript-side shape check + bounding for safety. */
export function boundIntel(intel: unknown): PageIntel {
  const raw = (intel ?? {}) as Partial<PageIntel>;
  return {
    url: String(raw.url ?? '').slice(0, 2000),
    title: String(raw.title ?? '').slice(0, 300),
    headings: (raw.headings ?? []).slice(0, 10).map((h) => String(h).slice(0, 200)),
    forms: (raw.forms ?? []).slice(0, 12).map((f) => ({
      id: String(f.id ?? '').slice(0, 120),
      heading: String(f.heading ?? '').slice(0, 200),
      fields: (f.fields ?? []).slice(0, 40).map((fl) => ({
        tag: String(fl.tag ?? '').slice(0, 20),
        name: String(fl.name ?? '').slice(0, 120),
        type: String(fl.type ?? '').slice(0, 40),
        label: String(fl.label ?? '').slice(0, 200),
        required: Boolean(fl.required),
        placeholder: String(fl.placeholder ?? '').slice(0, 200),
        autocomplete: String(fl.autocomplete ?? '').slice(0, 80),
        sensitive: Boolean(fl.sensitive),
      })),
      submitLabels: (f.submitLabels ?? []).slice(0, 8).map((s) => String(s).slice(0, 120)),
      looksLikePayment: Boolean(f.looksLikePayment),
      looksLikeCheckout: Boolean(f.looksLikeCheckout),
    })),
    checkout: {
      detected: Boolean(raw.checkout?.detected),
      items: (raw.checkout?.items ?? []).slice(0, 10).map((i) => ({
        name: String(i.name ?? '').slice(0, 300),
        quantity: String(i.quantity ?? '').slice(0, 20),
        price: String(i.price ?? '').slice(0, 40),
      })),
      totals: (raw.checkout?.totals ?? []).slice(0, 10).map((t) => ({
        label: String(t.label ?? '').slice(0, 80),
        amount: String(t.amount ?? '').slice(0, 40),
      })),
      currency: (raw.checkout?.currency ?? []).slice(0, 5).map(String),
      returnPolicyLink: raw.checkout?.returnPolicyLink ? String(raw.checkout.returnPolicyLink).slice(0, 2000) : null,
      subscriptionWords: (raw.checkout?.subscriptionWords ?? []).slice(0, 5).map(String),
    },
    payment: {
      detected: Boolean(raw.payment?.detected),
      cardFields: (raw.payment?.cardFields ?? []).slice(0, 5).map(String),
      cvvFields: (raw.payment?.cvvFields ?? []).slice(0, 5).map(String),
      expiryFields: (raw.payment?.expiryFields ?? []).slice(0, 5).map(String),
      payButtons: (raw.payment?.payButtons ?? []).slice(0, 5).map(String),
      walletOptions: (raw.payment?.walletOptions ?? []).slice(0, 5).map(String),
    },
    humanVerification: {
      detected: Boolean(raw.humanVerification?.detected),
      kinds: (raw.humanVerification?.kinds ?? []).slice(0, 5).map(String),
    },
  };
}

/**
 * The PAYMENT GUARD decision (Features 14 + 15).
 *
 * A click/submit is a PAYMENT COMMIT when the page shows payment fields or
 * pay buttons. The agent can NEVER confirm a payment — `confirm` may only
 * come from the user through the API (the tool layer refuses to pass it).
 */
export function paymentGuardDecision(intel: PageIntel): {
  requiresConfirmation: boolean;
  reason: string;
} {
  if (intel.payment.detected) {
    return {
      requiresConfirmation: true,
      reason:
        'Payment form detected — the final pay/submit action needs the USER\'s explicit confirmation. ' +
        'Card/CVV values are never read or stored by the agent.',
    };
  }
  const paySubmit = intel.forms.some(
    (f) => f.looksLikePayment && f.submitLabels.some((l) => /pay|purchase|buy|place.?order|subscribe/i.test(l))
  );
  if (paySubmit) {
    return {
      requiresConfirmation: true,
      reason: 'A form with a purchase/subscribe submit button is present — explicit user confirmation required.',
    };
  }
  return { requiresConfirmation: false, reason: '' };
}
