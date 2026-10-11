/* Settings page: API key, AI toggle, and the prose profile Claude reads.
 *
 * The prose profile lives in src/profile.ts (gitignored) alongside the structured one,
 * because it carries a home address, a phone number and referees' contact details --
 * none of which belong in a public repository. `defaultProfileText` only seeds the
 * textarea; whatever is saved in chrome.storage wins after that.
 *
 * This prose profile, not the structured `profile` object, is the only thing ever sent
 * to the API. Keep the two in step when either changes. */
import type { Settings } from './types.js';
import { defaultProfileText } from './profile.js';


function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  /* Throwing here is deliberate: a missing element means options.html and this file
   * have drifted apart, which is a build-time mistake, not a runtime condition to
   * handle. The JS version silently did nothing. */
  if (!node) throw new Error(`options.html is missing #${id}`);
  return node as T;
}

const apiKeyInput = el<HTMLInputElement>('apiKey');
const aiEnabledInput = el<HTMLInputElement>('aiEnabled');
const profileInput = el<HTMLTextAreaElement>('profile');
const statusEl = el<HTMLElement>('status');
const saveButton = el<HTMLButtonElement>('save');
const testButton = el<HTMLButtonElement>('test');

async function load(): Promise<void> {
  const d = await chrome.storage.local.get(['apiKey', 'aiEnabled', 'profile']);
  apiKeyInput.value = typeof d.apiKey === 'string' ? d.apiKey : '';
  aiEnabledInput.checked = d.aiEnabled !== false;
  profileInput.value = typeof d.profile === 'string' && d.profile ? d.profile : defaultProfileText;
}

let flashTimer: number | null = null;

function flash(msg: string, bad = false): void {
  statusEl.textContent = msg;
  statusEl.style.color = bad ? '#b45309' : '';
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    statusEl.textContent = '';
  }, 4000);
}

saveButton.addEventListener('click', () => {
  const settings: Settings = {
    apiKey: apiKeyInput.value.trim(),
    aiEnabled: aiEnabledInput.checked,
    profile: profileInput.value.trim(),
  };
  void chrome.storage.local.set(settings).then(() => flash('Saved'));
});

testButton.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    flash('Enter a key first', true);
    return;
  }

  flash('Testing…');
  void (async () => {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        }),
      });

      if (res.ok) flash('Key works');
      else flash(`Failed: HTTP ${res.status} - ${(await res.text()).slice(0, 90)}`, true);
    } catch (e) {
      flash(`Failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  })();
});

void load();
