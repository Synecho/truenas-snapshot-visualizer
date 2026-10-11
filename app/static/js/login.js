import { initLang, applyStatic, t } from './i18n.js';

initLang();
applyStatic();

const params = new URLSearchParams(location.search);
const next = params.get('next');
if (next?.startsWith('/') && !next.startsWith('//')) document.getElementById('login-next').value = next;
// A shared link keeps view, filters and selection in the hash, which never reaches the server and is
// dropped by the form post. Carry it through so the user lands on the linked view after logging in.
if (location.hash) document.getElementById('login-next').value += location.hash;

const error = params.get('error');
if (error) {
  const el = document.getElementById('login-error');
  el.textContent = error === 'locked' ? t('login_locked') : t('login_error');
  el.hidden = false;
}
