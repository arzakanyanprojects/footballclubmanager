// The app's texts (en / hy) live in electron/locales.mjs, so the main process can use the same ones (e.g. for
// report files the automations email); the screens import them from here.
export { dictionaries } from '../electron/locales.mjs';
