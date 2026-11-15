import { createContext, useCallback, useContext } from 'react';
import { dictionaries } from './locales';

const I18nCtx = createContext({ t: (k) => k, lang: 'en' });

export function I18nProvider({ lang, children }) {
  const t = useCallback(
    (key, vars) => {
      let s = dictionaries[lang]?.[key] ?? dictionaries.en[key] ?? key;
      if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
      return s;
    },
    [lang]
  );
  t.lang = lang;
  return <I18nCtx.Provider value={{ t, lang }}>{children}</I18nCtx.Provider>;
}

export const useT = () => useContext(I18nCtx).t;
export const useLang = () => useContext(I18nCtx).lang;

export function monthName(t, period, short = false) {
  if (!period) return '';
  const [y, m] = period.split('-');
  return `${t(`month.${short ? 's' : ''}${Number(m)}`)} ${y}`;
}
