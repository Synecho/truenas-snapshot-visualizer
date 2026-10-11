import { initLang, applyStatic, t } from './i18n.js';

initLang();
applyStatic();

const params = new URLSearchParams(location.search);
const next = params.get('next');
if (next && next.startsWith('/') && !next.startsWith('//')) document.getElementById('login-next').value = next;

const error = params.get('error');
if (error) {
  const el = document.getElementById('login-error');
  el.textContent = error === 'locked' ? t('login_locked') : t('login_error');
  el.hidden = false;
}
