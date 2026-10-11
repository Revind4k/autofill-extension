/* Shared types.
 *
 * Three of these exist because the compiler can close a real bug class that bit this
 * extension in its JavaScript form. Each one is commented with the bug it prevents. */

/* ------------------------------------------------------------------- profile --- */

/* Every answerable field, keyed. In the JS version this was an untyped object literal,
 * so a renamed or missing key produced a silently blank form field discovered only at
 * submit time. Typed, a missing key is a build error.
 *
 * `FieldKey` is derived from this interface rather than written out separately, so the
 * match rules below cannot name a field that does not exist. */
export interface Profile {
  firstName: string;
  middleName: string;
  lastName: string;
  fullName: string;
  preferredName: string;

  email: string;
  altEmail: string;
  phone: string;
  phoneDigits: string;

  address1: string;
  city: string;
  state: string;
  stateFull: string;
  zip: string;
  country: string;

  linkedin: string;
  github: string;
  website: string;

  school: string;
  degree: string;
  major: string;
  gpa: string;
  eduStart: string;
  gradDate: string;
  coursework: string;

  company1: string;
  title1: string;
  loc1: string;
  start1: string;
  end1: string;

  skills: string;
  availability: string;
  salary: string;
  relocate: string;

  authorized: string;
  sponsorship: string;
  citizenship: string;
  veteran: string;

  /* Deliberately optional: these are the candidate's to decide, and an empty string
   * means "leave the field blank for a human". Not optional-as-in-forgotten. */
  gender: string;
  ethnicity: string;
  disability: string;
}

export type FieldKey = keyof Profile;

/* ------------------------------------------------------------------ messaging --- */

/* chrome.runtime message passing is untyped: sendMessage takes `any` and the listener
 * receives `any`. A typo in a message's `type` string used to fail silently, with the
 * listener simply never matching. A discriminated union makes the compiler check both
 * ends against the same contract.
 *
 * Request and response are paired by the `RequestFor` map at the bottom, so a handler
 * cannot return the wrong response shape for a request. */

export interface AiQuestion {
  id: string;
  question: string;
  kind: 'text' | 'textarea' | 'select';
  options?: string[];
}

export interface AiAnswer {
  id: string;
  answer: string | null;
  review: boolean;
  why?: string;
  cached?: boolean;
}

export type Request =
  | { type: 'ai-answer'; questions: AiQuestion[]; pageContext: string }
  | { type: 'open-options' }
  | { type: 'fill-now' };

export type AiFailure = 'disabled' | 'no-key' | 'no-profile' | 'error';

export type AiResponse =
  | { ok: true; answers: AiAnswer[] }
  | { ok: false; reason: AiFailure; message?: string };

export interface RequestFor {
  'ai-answer': AiResponse;
  'open-options': void;
  'fill-now': { ok: true };
}

/* Typed wrapper so callers get the right response type for the request they sent,
 * instead of `any`. */
export function sendMessage<T extends Request['type']>(
  message: Extract<Request, { type: T }>,
): Promise<RequestFor[T] | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: RequestFor[T]) => {
        /* Reading lastError is what suppresses the "unchecked runtime.lastError"
         * console noise when no receiver exists. */
        void chrome.runtime.lastError;
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/* ---------------------------------------------------------------- react input --- */

/* React keeps a private cache of each input's last value on the DOM node itself. If the
 * cache still matches the element's current value, React treats the change as already
 * handled and reverts it on the next render, so a plain `el.value = x` write disappears.
 * Clearing the cache first makes React accept the write.
 *
 * `_valueTracker` is React internals: it is in neither the DOM lib nor @types/chrome,
 * because no standard describes it. Declaring the shape we actually depend on is the
 * honest way to type it. The alternative, casting to `any`, would also silence the
 * error, but it would silence every other mistake on that object too. */
export interface ValueTracker {
  getValue(): string;
  setValue(value: string): void;
}

export type ReactInput = (HTMLInputElement | HTMLTextAreaElement) & {
  _valueTracker?: ValueTracker;
};

/* ---------------------------------------------------- cross-world event detail --- */

/* The isolated world and the MAIN world can only talk through DOM events, and the
 * payload is whatever the sender put in `detail`.
 *
 * SECURITY: only an element id crosses. The value itself is written from the isolated
 * world straight onto the element, so a page script listening on these events learns
 * nothing it could not already read off the form field. These two interfaces exist to
 * make that guarantee checkable: if someone later adds a `value` field here, the
 * security property breaks visibly in the type, not silently at runtime. */
export interface CommitDetail {
  id: string;
}

export interface CommitDoneDetail {
  id: string;
  stuck: boolean;
}

export const COMMIT_EVENT = '__af_commit' as const;
export const COMMIT_DONE_EVENT = '__af_commit_done' as const;

declare global {
  interface WindowEventMap {
    [COMMIT_EVENT]: CustomEvent<CommitDetail>;
    [COMMIT_DONE_EVENT]: CustomEvent<CommitDoneDetail>;
  }
}

/* ------------------------------------------------------------------- settings --- */

export interface Settings {
  apiKey: string;
  aiEnabled: boolean;
  profile: string;
}

export interface CachedAnswer {
  answer: string;
  review: boolean;
}
