# Application Autofill

A Chrome extension (Manifest V3, TypeScript) that fills job application forms. It reads
each question off the page, answers what it can from a structured profile, and sends only
the questions it cannot resolve to the Claude API for an answer. It never submits a form.

Built because filling the same forty fields on Workday, Greenhouse, Lever and iCIMS by
hand is most of the cost of applying to a job.

## What it does

- **Rule-based pass.** 33 ordered patterns map a field's label to a profile key. Name,
  email, phone, address, education and work authorization are answered locally; nothing
  about them leaves the browser.
- **AI pass.** Anything the rules cannot resolve is batched into one request per page.
  Answers are cached and normalized, so the same question on a later application is free.
- **Never submits.** Fields that already hold a value are never overwritten. Legal,
  financial and demographic answers are outlined in amber as a prompt to check them.
- **Works inside embedded forms.** Greenhouse, Lever and Ashby deliver their forms in
  iframes and `srcdoc` documents, where a hostname check fails. A frame decides for
  itself, filling only when it finds at least three recognized fields including one
  identity field, which keeps it off search boxes and newsletter signups.

## Architecture

Two content scripts in two different JavaScript worlds:

| File | World | Holds data | Role |
|---|---|---|---|
| `src/fill.ts` | isolated | yes | Reads labels, decides answers, writes values |
| `src/setter.ts` | MAIN | **no** | Clears React's value cache, fires input events |
| `src/background.ts` | service worker | API key | Calls the Claude API, caches answers |

React caches each input's last value on the DOM node, in a private `_valueTracker`
field. If the cache still matches the element's value, React treats the change as
already handled and reverts it on the next render, so writing `el.value` from an
isolated content script silently does nothing. The tracker only exists in the page's own
JS context.

The fix is a second script in the MAIN world that resets the tracker. The question is
what crosses between the two worlds, because anything dispatched as a DOM event is
readable by the page.

**Only an element id crosses.** The value is written from the isolated world directly
onto the element; the MAIN-world script receives an id, resets the tracker on that
element, fires the events, and reports back a single boolean for whether the write
survived. A page script listening on those events learns the id of a field it could
already read, and nothing else.

That property is enforced in the type system rather than left to a comment:

```ts
export interface CommitDetail { id: string; }
export interface CommitDoneDetail { id: string; stuck: boolean; }
```

Adding a value to either interface breaks the guarantee visibly, in a type, rather than
silently at runtime.

## Why TypeScript

The port closed three real bug classes that the JavaScript version had hit:

**1. A typed profile.** Field keys used to be strings in an untyped object literal, so a
renamed or missing key produced a blank form field discovered at submit time. `FieldKey`
is now `keyof Profile`, and the 33 match rules are typed `[RegExp, FieldKey][]`, so a
rule cannot name a field that does not exist.

**2. A message contract.** `chrome.runtime.sendMessage` takes `any` and the listener
receives `any`, so a typo in a message's `type` meant the listener never matched and
nothing happened. Messages are now a discriminated union, with requests paired to
response types, so both ends are checked against one contract.

**3. A tri-state that used to be two falsy values.** Employers ask about work
authorization with opposite polarity: "authorized to work without sponsorship" and
"require sponsorship" have opposite correct answers, and answering wrong is an automatic
rejection. The resolver has three outcomes — resolved, recognized-but-ambiguous, and
not-a-work-authorization-question — which in JavaScript were `'authorized'`, `null` and
`undefined`, two of them falsy and distinguished only in a comment. The return type is
now `FieldKey | null | undefined` and the compiler checks every caller.

`strict` is on, along with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## Setup

```bash
npm install
cp src/profile.example.ts src/profile.ts   # then fill it in
npm run build
```

Load `dist/` at `chrome://extensions` with Developer mode on. On first install the
options page opens; add an Anthropic API key and the prose profile the model reads.

```bash
npm run typecheck   # tsc --noEmit
npm run watch       # rebuild on change
```

`src/profile.ts` is gitignored. Real personal data stays out of the repository, and
`profile.example.ts` is the committed template.

## Privacy

- Personal data lives in the isolated content-script world. Page scripts cannot read it.
- The API key lives in the service worker and never enters a page's context.
- Only unresolved question *text* is sent to the API, never the structured profile, and
  never anything the rules already answered.
- The model is instructed to treat page text as untrusted input, to answer only from the
  profile, to return null rather than invent a credential, and to refuse any question
  asking for the profile wholesale. Oversized answers are dropped rather than filled,
  since a form field that wants 1500+ characters is a signal something is wrong.

## Known limits

- Radio groups are skipped in the AI pass; they need option text the collector does not
  yet gather.
- Multi-page Workday flows fill one page at a time.
- File uploads are never touched. Resumes are attached by hand, on purpose.

## License

MIT
