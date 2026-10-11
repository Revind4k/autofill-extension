/* Runs in the PAGE's JS context (world: MAIN).
 *
 * SECURITY: this file never receives, holds, or transmits any personal data. The value
 * is written by the isolated-world script directly onto the element; all this does is
 * reset React's internal value tracker -- which only exists in this world -- and fire
 * the events React listens for. The signal crossing between worlds is an element id and
 * nothing else, so a page listening on these events learns nothing it could not already
 * read from the form field itself.
 *
 * Why the tracker needs resetting: React caches each input's last value. If its cache
 * matches the element's current value it treats the change as already handled and
 * reverts on the next render. Clearing the cache first makes React accept the new
 * value. See the ReactInput comment in types.ts. */
import {
  COMMIT_EVENT,
  COMMIT_DONE_EVENT,
  type ReactInput,
  type CommitDoneDetail,
} from './types.js';

const SETTLE_MS = 60;

function find(id: string): ReactInput | null {
  try {
    return document.querySelector<HTMLInputElement>(
      `[data-af-target="${CSS.escape(id)}"]`,
    ) as ReactInput | null;
  } catch {
    return null;
  }
}

/* Every dispatch is individually guarded: a page can throw from an event handler, and
 * one framework's listener blowing up must not stop the rest of the sequence. */
function fire(el: Element, event: Event): void {
  try {
    el.dispatchEvent(event);
  } catch {
    /* ignore: a page handler threw */
  }
}

function clearReactCache(el: ReactInput): void {
  try {
    const tracker = el._valueTracker;
    /* A space, not an empty string: React skips the update when the cached value and
     * the new value are equal, and an empty string collides with a genuinely empty
     * field. */
    tracker?.setValue(' ');
  } catch {
    /* not a React input, or internals moved -- the plain events below still work */
  }
}

window.addEventListener(COMMIT_EVENT, (ev) => {
  const id = ev.detail?.id;
  if (!id) return;

  const el = find(id);
  if (!el) return;

  clearReactCache(el);

  fire(el, new Event('focus', { bubbles: true }));
  try {
    fire(el, new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  } catch {
    fire(el, new Event('input', { bubbles: true }));
  }
  fire(el, new Event('change', { bubbles: true }));
  fire(el, new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  fire(el, new Event('blur', { bubbles: true }));

  /* Report only whether the write survived the re-render, never the value. */
  window.setTimeout(() => {
    let stuck = false;
    try {
      stuck = el.value.length > 0;
    } catch {
      stuck = false;
    }
    const detail: CommitDoneDetail = { id, stuck };
    window.dispatchEvent(new CustomEvent(COMMIT_DONE_EVENT, { detail }));
  }, SETTLE_MS);
});
