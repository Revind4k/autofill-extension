/* Job application autofill -- runs in the isolated world.
 *
 * Design notes:
 * - Personal data stays in this world. Pages cannot read it. In the JavaScript version
 *   it was hung off `window.__APP_AUTOFILL_DATA`; bundling lets it be a module import
 *   instead, so the global is gone entirely.
 * - Writing a value happens in setter.ts, which runs in the page's own JS context,
 *   because React's internal value tracker is unreachable from here. We tag an element,
 *   ask setter.ts to fire the events, and it reports whether the value survived the
 *   re-render.
 * - A frame fills itself only when it looks like a real application form, so this stays
 *   off search boxes and newsletter signups.
 * - Work-authorisation questions get a dedicated resolver: employers ask them with
 *   opposite polarity and a wrong answer is an automatic rejection.
 * - Nothing is ever submitted. Fields that already have values are never overwritten. */
import { profile } from './profile.js';
import {
  COMMIT_EVENT,
  COMMIT_DONE_EVENT,
  sendMessage,
  type AiQuestion,
  type CommitDetail,
  type FieldKey,
  type ReactInput,
} from './types.js';

const LOG = false; // flip to true to debug a stubborn site
const MAX_AI_QUESTIONS = 25;
const COMMIT_TIMEOUT_MS = 500;

const TAG =
  `[autofill ${window.top === window.self ? 'TOP' : 'frame'} ` +
  `${location.hostname || 'srcdoc'}]`;

function log(...args: unknown[]): void {
  if (!LOG) return;
  try {
    console.log(TAG, ...args);
  } catch {
    /* console unavailable in some sandboxed frames */
  }
}

type Fillable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/* ------------------------------------------------------------------ matching --- */

/* Order matters: first match wins, so compound phrases precede broad single words.
 * Typing this as [RegExp, FieldKey][] is what stops a rule naming a field that does not
 * exist on Profile -- in the JS version a typo here silently matched nothing. */
const RULES: ReadonlyArray<readonly [RegExp, FieldKey]> = [
  [/citizenship|citizen status/i, 'citizenship'],
  [/veteran/i, 'veteran'],
  [/disab/i, 'disability'],
  [/gender identity|\bgender\b|\bsex\b/i, 'gender'],
  [/ethnic|\brace\b|hispanic|latino/i, 'ethnicity'],

  [/current.*(employer|company)|company.?name|\bemployer\b/i, 'company1'],
  [/job.?title|current.?title|position.?title|\btitle\b/i, 'title1'],
  [/school.?name|\bschool\b|university|college|institution/i, 'school'],
  [/degree/i, 'degree'],
  [/major|field of study|discipline|concentration/i, 'major'],
  [/gpa|grade.?point/i, 'gpa'],
  [/graduat.*(date|year)|expected.*(graduat|completion)/i, 'gradDate'],
  [/coursework|relevant course/i, 'coursework'],

  [/first.?name|given.?name|\bfname\b|forename/i, 'firstName'],
  [/middle.?(name|initial)/i, 'middleName'],
  [/last.?name|family.?name|surname|\blname\b/i, 'lastName'],
  [/preferred.?name|nick.?name|preferred first/i, 'preferredName'],
  [
    /full.?name|legal name|applicant name|your name|^name$|\bname\b(?!\s*(of|for))/i,
    'fullName',
  ],

  [/e.?mail/i, 'email'],
  [
    /phone|telephone|\bmobile\s*(phone|number|no\b|#)|\bcell\s*(phone|number)?\b|\btel\b/i,
    'phone',
  ],

  [/linked.?in/i, 'linkedin'],
  [/git.?hub/i, 'github'],
  [/portfolio|personal.?(site|website)|\bwebsite\b|\burl\b/i, 'website'],

  // country before state: "countryRegion" contains "region"
  [/country|nation/i, 'country'],
  [/street|address.?(line.?)?1|\baddress\b|mailing/i, 'address1'],
  [/\bcity\b|town|locality/i, 'city'],
  [/\bstate\b|province|\bregion\b/i, 'state'],
  [/zip|postal/i, 'zip'],

  [/skill/i, 'skills'],
  [/available|start.?date|earliest.*start|when.*begin/i, 'availability'],
  [
    /(desired|expected|requested|target)\s*(salary|compensation|pay)|compensation expectation/i,
    'salary',
  ],
  [/relocat/i, 'relocate'],
];

const IDENTITY_KEYS: ReadonlySet<FieldKey> = new Set([
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
]);

/* Amber-highlighted on the page: legal, financial, or demographic answers a human
 * should read before submitting. */
const REVIEW_KEYS: ReadonlySet<FieldKey> = new Set([
  'authorized',
  'sponsorship',
  'citizenship',
  'veteran',
  'gender',
  'ethnicity',
  'disability',
  'salary',
  'relocate',
  'availability',
]);

const SKIP_TYPES: ReadonlySet<string> = new Set([
  'hidden',
  'submit',
  'button',
  'file',
  'password',
  'checkbox',
  'image',
  'reset',
  'search',
]);

// values that make sense as prose in a textarea; everything else is identity data
const LONGFORM_OK: ReadonlySet<FieldKey> = new Set(['skills', 'coursework']);

/* Employers ask about work authorisation with opposite polarity:
 *     "are you authorized to work (without sponsorship)?"  -> yes
 *     "will you require sponsorship?"                      -> no
 *
 * Three outcomes, which is why this returns a union rather than a string:
 *   a FieldKey -- resolved, fill it
 *   null       -- recognised but ambiguous, leave blank for a human
 *   undefined  -- not a work-authorisation question at all, fall through to RULES
 *
 * In the JS version these three cases were all falsy and the distinction lived only in
 * a comment. */
function resolveWorkAuth(
  l: string,
): Extract<FieldKey, 'authorized' | 'sponsorship'> | null | undefined {
  if (!/sponsor|authoriz|eligible to work|able to work|right to work|work permit/.test(l)) {
    return undefined;
  }

  const withoutSponsor =
    /without\s+(the\s+)?(need\s+(for|of)\s+)?(visa\s+|employment\s+)?sponsor/.test(l) ||
    /no\s+sponsorship\s+(is\s+)?(required|needed)/.test(l);
  const asksAuthorized =
    /authoriz|eligible to work|able to work|legally.*work|right to work|work permit/.test(l);
  const asksRequires =
    /(require|requiring|need|needing|request)\w*\s+(any\s+|a\s+)?(visa|employment|work)?\s*sponsor/.test(
      l,
    ) ||
    /sponsorship\s+(is\s+)?(required|needed)/.test(l) ||
    /need\s+(for|of)\s+sponsor/.test(l);

  if (asksAuthorized && (withoutSponsor || !asksRequires)) return 'authorized';
  if (asksRequires && !asksAuthorized) return 'sponsorship';
  if (/sponsor/.test(l) && !asksAuthorized) return 'sponsorship';
  return null;
}

function labelFor(el: Fillable): string {
  const bits: Array<string | null> = [
    el.name,
    el.id,
    'placeholder' in el ? el.placeholder : null,
    el.getAttribute('aria-label'),
    el.getAttribute('data-automation-id'),
    el.getAttribute('autocomplete'),
  ];

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const node = document.getElementById(id);
      if (node) bits.push(node.innerText);
    }
  }

  for (const label of el.labels ?? []) bits.push(label.innerText);

  const own = el.closest('label');
  if (own) bits.push(own.innerText);

  let parent = el.parentElement;
  let hops = 0;
  while (parent && hops < 5) {
    const q = parent.querySelector<HTMLElement>(
      'label, legend, .question, [class*="label"], [class*="Label"]',
    );
    if (q?.innerText && q.innerText.length < 200) {
      bits.push(q.innerText);
      break;
    }
    parent = parent.parentElement;
    hops++;
  }

  return bits.filter((b): b is string => Boolean(b)).join(' ');
}

function keyFor(el: Fillable): FieldKey | null {
  const hay = labelFor(el);
  if (!hay) return null;

  // work authorisation is resolved by structure, not keywords, and is safe anywhere
  const wa = resolveWorkAuth(hay.toLowerCase());
  if (wa !== undefined) return wa; // null = deliberately leave blank

  let key: FieldKey | null = null;
  for (const [pattern, candidate] of RULES) {
    if (pattern.test(hay)) {
      key = candidate;
      break;
    }
  }
  if (!key) return null;

  // Don't drop a phone number into "describe your experience with mobile development".
  if (el.tagName === 'TEXTAREA' && !LONGFORM_OK.has(key)) return null;

  // A sentence-shaped label is a real question; keyword matching is unreliable there,
  // so leave it for the AI pass, which reads the whole thing.
  const isQuestion = hay.length > 90 || hay.includes('?');
  if (isQuestion && !IDENTITY_KEYS.has(key)) return null;

  return key;
}

/* --------------------------------------------------------------------- DOM --- */

function allFields(root: Document | ShadowRoot, acc: Fillable[] = []): Fillable[] {
  try {
    for (const el of root.querySelectorAll<Fillable>('input, select, textarea')) {
      acc.push(el);
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) allFields(el.shadowRoot, acc);
    }
  } catch {
    /* cross-origin shadow root, or a detached tree */
  }
  return acc;
}

function usable(el: Fillable): boolean {
  if (el.disabled) return false;
  if ('readOnly' in el && el.readOnly) return false;

  const type = ('type' in el ? el.type : '').toLowerCase();
  if (SKIP_TYPES.has(type)) return false;

  // offsetParent is null for display:none, but radios inside a hidden fieldset still matter
  if (el.offsetParent === null && type !== 'radio') return false;

  return true;
}

let reviewCount = 0;

function mark(el: Fillable, key: FieldKey | null): void {
  const review = key !== null && REVIEW_KEYS.has(key);
  if (review) reviewCount++;
  try {
    el.style.outline = review ? '2px solid #d98324' : '2px solid #1f9d63';
    el.style.outlineOffset = '1px';
    if (review) el.title = 'Autofilled -- double-check this answer before submitting';
  } catch {
    /* style blocked by the page's CSP */
  }
}

/* SECURITY: the value is written here, in the isolated world, straight onto the
 * element. Only the element's id crosses into the page context, so no page script can
 * observe the data in transit -- it sees the field's value, which it could read anyway,
 * and nothing more. setter.ts then clears React's value cache and fires the events that
 * make the write stick. */
let afSeq = 0;
const pending = new Map<string, () => void>();

window.addEventListener(COMMIT_DONE_EVENT, (ev) => {
  const id = ev.detail?.id;
  if (!id) return;
  const done = pending.get(id);
  if (done) {
    pending.delete(id);
    done();
  }
});

function setValue(el: Fillable, val: string, done: (stuck: boolean) => void): void {
  const id = `af${++afSeq}`;

  // write it from here -- never through a page-visible channel
  try {
    (el as ReactInput).value = val;
  } catch {
    done(false);
    return;
  }

  try {
    el.setAttribute('data-af-target', id);
  } catch {
    done(false);
    return;
  }

  const finish = (): void => {
    try {
      el.removeAttribute('data-af-target');
    } catch {
      /* element already detached */
    }
    done(el.value.trim() === val.trim());
  };
  pending.set(id, finish);

  const detail: CommitDetail = { id };
  window.dispatchEvent(new CustomEvent(COMMIT_EVENT, { detail }));

  window.setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      finish();
    }
  }, COMMIT_TIMEOUT_MS);
}

/* ----------------------------------------------------------------- filling --- */

let totalFilled = 0;
let skipped = 0;
let failed = 0;
let aiFilled = 0;
let announceTimer: number | null = null;

function announce(forced = false): void {
  if (announceTimer !== null) clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => toast(forced), 400);
}

function fillText(el: HTMLInputElement | HTMLTextAreaElement, val: string, key: FieldKey): void {
  if (!val) return;
  if (el.value.trim()) {
    skipped++;
    return;
  }

  const value =
    'type' in el && el.type === 'tel' ? profile.phoneDigits || val : val;

  setValue(el, value, (stuck) => {
    if (stuck) {
      mark(el, key);
      totalFilled++;
      announce();
    } else {
      failed++;
      try {
        delete el.dataset.afDone;
      } catch {
        /* dataset frozen */
      }
    }
  });
}

function fillSelect(el: HTMLSelectElement, val: string, key: FieldKey | null): void {
  if (!val) return;
  if (el.selectedIndex > 0 && el.value) {
    skipped++;
    return;
  }

  const want = val.toLowerCase();
  let best = -1;
  for (let i = 0; i < el.options.length; i++) {
    const text = (el.options[i]?.text ?? '').trim().toLowerCase();
    if (!text) continue;
    if (text === want) {
      best = i;
      break;
    }
    if (best < 0 && (text.startsWith(want) || want.startsWith(text))) best = i;
  }

  // "NJ" rarely appears in a dropdown; "New Jersey" does
  if (best < 0 && val === profile.state && profile.stateFull) {
    fillSelect(el, profile.stateFull, key);
    return;
  }
  if (best < 0) return;

  el.selectedIndex = best;
  try {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch {
    /* page handler threw */
  }
  mark(el, key);
  totalFilled++;
  announce();
}

function fillRadio(el: HTMLInputElement, val: string, key: FieldKey): void {
  if (!val || !el.name) return;

  let group: NodeListOf<HTMLInputElement>;
  try {
    group = document.querySelectorAll<HTMLInputElement>(
      `input[type=radio][name="${CSS.escape(el.name)}"]`,
    );
  } catch {
    return;
  }

  for (const radio of group) {
    if (radio.checked) {
      skipped++;
      return;
    }
  }

  const want = val.toLowerCase();
  for (const radio of group) {
    if (labelFor(radio).toLowerCase().includes(want)) {
      radio.click();
      mark(radio, key);
      totalFilled++;
      announce();
      return;
    }
  }
}

interface Survey {
  matches: number;
  identity: number;
  total: number;
}

function survey(): Survey {
  let matches = 0;
  let identity = 0;
  let total = 0;

  for (const el of allFields(document)) {
    if (!usable(el)) continue;
    total++;
    const key = keyFor(el);
    if (!key) continue;
    matches++;
    if (IDENTITY_KEYS.has(key)) identity++;
  }

  return { matches, identity, total };
}

function scan(): number {
  let attempted = 0;
  const radioSeen = new Set<string>();

  for (const el of allFields(document)) {
    if (!usable(el)) continue;
    try {
      if (el.dataset.afDone === '1') continue;
    } catch {
      continue;
    }

    const key = keyFor(el);
    if (!key) continue;

    const val = profile[key];
    if (!val) continue;

    try {
      el.dataset.afDone = '1';
    } catch {
      /* dataset frozen */
    }
    attempted++;

    const type = ('type' in el ? el.type : '').toLowerCase();
    if (type === 'radio') {
      if (radioSeen.has(el.name)) continue;
      radioSeen.add(el.name);
      fillRadio(el as HTMLInputElement, val, key);
    } else if (el instanceof HTMLSelectElement) {
      fillSelect(el, val, key);
    } else {
      fillText(el as HTMLInputElement | HTMLTextAreaElement, val, key);
    }
  }

  return attempted;
}

function toast(forced: boolean): void {
  if (!totalFilled && !forced) return;
  try {
    document.getElementById('__af_toast')?.remove();

    const box = document.createElement('div');
    box.id = '__af_toast';
    box.style.cssText =
      'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#14241f;' +
      'color:#eafff5;font:13px/1.5 -apple-system,sans-serif;padding:11px 15px;border-radius:9px;' +
      'box-shadow:0 6px 22px rgba(0,0,0,.3);max-width:300px';

    /* Built with the DOM rather than innerHTML. Every value here is a number we
     * produced, so innerHTML was not exploitable, but a page CSP can block inline HTML
     * parsing and this avoids the question entirely. */
    const line = (text: string, color?: string, dim = false): HTMLDivElement => {
      const div = document.createElement('div');
      div.textContent = text;
      if (color) div.style.color = color;
      if (dim) div.style.opacity = '0.7';
      return div;
    };

    const head = document.createElement('b');
    head.textContent = `Autofilled ${totalFilled} field${totalFilled === 1 ? '' : 's'}`;
    box.append(head);

    if (reviewCount) box.append(line(`${reviewCount} in amber - verify these`, '#f0b36a'));
    if (aiFilled) box.append(line(`${aiFilled} answered by Claude`, undefined, true));
    if (skipped) box.append(line(`${skipped} already had values`, undefined, true));
    if (failed) box.append(line(`${failed} would not stick`, undefined, true));
    box.append(line('Nothing submitted. Review before sending.', undefined, true));

    document.body.appendChild(box);
    window.setTimeout(() => box.remove(), 7000);
  } catch {
    /* no body yet, or the page blocked the insert */
  }
}

/* ------------------------------------------------------------------ AI pass --- */

/* Anything the rule table can't resolve goes to the background worker, which asks
 * Claude. Only unrecognised questions leave this machine; names, email, phone and
 * address are always answered locally above. Nothing here ever submits a form. */

let aiAsked = false;
const aiTargets = new Map<string, Fillable>();

function questionTextFor(el: Fillable): string {
  const bits: Array<string | null> = [];

  for (const label of el.labels ?? []) bits.push(label.innerText);

  const own = el.closest('label');
  if (own) bits.push(own.innerText);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const node = document.getElementById(id);
      if (node) bits.push(node.innerText);
    }
  }

  if (!bits.length) {
    let parent = el.parentElement;
    let hops = 0;
    while (parent && hops < 5) {
      const q = parent.querySelector<HTMLElement>(
        'label, legend, .question, [class*="label"], [class*="Label"]',
      );
      if (q?.innerText) {
        bits.push(q.innerText);
        break;
      }
      parent = parent.parentElement;
      hops++;
    }
  }

  if (!bits.length) bits.push(el.getAttribute('aria-label'));
  if (!bits.length && 'placeholder' in el) bits.push(el.placeholder);

  return bits
    .filter((b): b is string => Boolean(b))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\*$/, '')
    .trim();
}

function collectUnanswered(): AiQuestion[] {
  const out: AiQuestion[] = [];
  const seen = new Set<string>();
  let n = 0;

  for (const el of allFields(document)) {
    if (n >= MAX_AI_QUESTIONS) break;
    if (!usable(el)) continue;

    try {
      if (el.dataset.afAi === '1' || el.dataset.afDone === '1') continue;
    } catch {
      continue;
    }
    if (el.value.trim()) continue;

    const type = ('type' in el ? el.type : '').toLowerCase();
    if (type === 'radio') continue; // radio groups need option text; skip for now

    const key = keyFor(el);
    if (key && profile[key]) continue; // rules already handle it

    const question = questionTextFor(el);
    if (!question || question.length < 8 || question.length > 400) continue;
    if (seen.has(question)) continue;
    seen.add(question);

    const id = `q${++n}`;

    if (el instanceof HTMLSelectElement) {
      const options = [...el.options]
        .map((o) => (o.text || '').trim())
        .filter((x) => x && !/^(select|choose|--)/i.test(x))
        .slice(0, 40);
      if (!options.length) continue;
      out.push({ id, question, kind: 'select', options });
    } else {
      out.push({
        id,
        question,
        kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text',
      });
    }

    aiTargets.set(id, el);
  }

  return out;
}

function applyAiAnswer(el: Fillable, answer: string | null, review: boolean): void {
  if (answer == null || answer === '') return;

  // reuse the amber highlighting for anything the model flagged for review
  const key: FieldKey | null = review ? 'salary' : null;

  if (el instanceof HTMLSelectElement) {
    fillSelect(el, answer, key);
    return;
  }

  setValue(el, answer, (stuck) => {
    if (stuck) {
      mark(el, key);
      totalFilled++;
      aiFilled++;
      announce();
    }
  });
}

/* Open-ended answers are only as good as what the model knows about the role. Pull the
 * company, job title and a slice of the posting from the page -- including the parent
 * document when we're inside an embedded application iframe. */
function buildPageContext(): string {
  const parts: string[] = [];

  const push = (label: string, v: string | null | undefined): void => {
    if (!v) return;
    const clean = v.replace(/\s+/g, ' ').trim();
    if (clean) parts.push(`${label}: ${clean.slice(0, 400)}`);
  };

  const meta = (selector: string): string | null =>
    document.querySelector(selector)?.getAttribute('content') ?? null;

  push('Page title', document.title);
  push('Site', meta('meta[property="og:site_name"]'));
  push('Posting', meta('meta[property="og:title"]') ?? meta('meta[name="title"]'));
  push('Summary', meta('meta[name="description"]') ?? meta('meta[property="og:description"]'));
  push('Heading', document.querySelector<HTMLElement>('h1')?.innerText);

  // the embedding page usually holds the company branding the iframe lacks
  try {
    if (window.top !== window.self && document.referrer) {
      push('Applying via', document.referrer);
    }
  } catch {
    /* cross-origin parent */
  }
  push('Host', location.hostname);

  // a slice of the job description, if one is on the page
  try {
    const body = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    if (body.length > 400) push('Posting text', body.slice(0, 1500));
  } catch {
    /* no body */
  }

  return parts.join('\n').slice(0, 2500);
}

async function runAiPass(): Promise<void> {
  if (aiAsked) return;

  const questions = collectUnanswered();
  if (!questions.length) return;
  aiAsked = true;

  for (const q of questions) {
    try {
      const el = aiTargets.get(q.id);
      if (el) el.dataset.afAi = '1';
    } catch {
      /* dataset frozen */
    }
  }

  const context = buildPageContext();
  const res = await sendMessage({
    type: 'ai-answer',
    questions,
    pageContext: context.slice(0, 300),
  });

  if (!res || !res.ok) {
    if (res?.reason === 'no-key') log('AI skipped: no API key set');
    else if (res?.reason === 'disabled') log('AI disabled in settings');
    else log('AI failed:', res?.message);
    aiAsked = false; // allow a retry on the next pass
    return;
  }

  for (const a of res.answers) {
    const el = aiTargets.get(a.id);
    if (el) applyAiAnswer(el, a.answer, a.review);
  }
  log(`AI answered ${res.answers.length}`);
}

/* --------------------------------------------------------------------- run --- */

function maybeFill(): number {
  const s = survey();
  log(`survey total=${s.total} matched=${s.matches} identity=${s.identity}`);

  // three recognised fields including at least one identity field = a real form
  if (s.matches < 3 || s.identity < 1) return 0;

  const n = scan();
  window.setTimeout(() => void runAiPass(), 1500); // let the rule pass settle first
  return n;
}

try {
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, reply) => {
    if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'fill-now') {
      for (const el of allFields(document)) {
        try {
          delete el.dataset.afDone;
          delete el.dataset.afAi;
        } catch {
          /* dataset frozen */
        }
      }
      aiAsked = false;
      scan();
      window.setTimeout(() => void runAiPass(), 800);
      announce(true);
      reply({ ok: true });
    }
    return true;
  });
} catch {
  /* no extension context in this frame */
}

maybeFill();

let mutationTimer: number | null = null;
try {
  new MutationObserver(() => {
    if (mutationTimer !== null) clearTimeout(mutationTimer);
    mutationTimer = window.setTimeout(maybeFill, 600);
  }).observe(document.documentElement, { childList: true, subtree: true });
} catch {
  /* no documentElement yet */
}

for (const ms of [1200, 2500, 4500, 7000, 10000]) {
  window.setTimeout(maybeFill, ms);
}

// if a framework reverted something we set, let a later pass retry it
window.setInterval(() => {
  for (const el of allFields(document)) {
    try {
      if (el.dataset.afDone !== '1') continue;
      if (el instanceof HTMLSelectElement) continue;
      if ('type' in el && el.type === 'radio') continue;

      const key = keyFor(el);
      if (!key) continue;

      const want = profile[key];
      if (!want) continue;

      if (el.value.trim() !== want.trim()) delete el.dataset.afDone;
    } catch {
      /* dataset frozen or element detached */
    }
  }
}, 2000);
