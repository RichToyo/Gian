import { createContext, useCallback, useContext } from 'react';
import type { ReactNode } from 'react';
import { ChatUiI18nContext } from '@gian/chat-ui';
import type { Locale, MessageKey } from './messages.js';
import { EN } from './en.js';

interface LocaleCtx {
  locale: Locale;
  t: (key: MessageKey) => string;
}

const Ctx = createContext<LocaleCtx>({
  locale: 'en',
  t: (k) => EN[k] ?? k,
});

export function LocaleProvider({
  locale: _legacyLocale,
  children,
}: {
  /** Legacy callers may still pass zh-CN. The product context is always English. */
  locale?: Locale;
  children: ReactNode;
}) {
  void _legacyLocale;
  const t = useCallback((k: MessageKey) => EN[k] ?? k, []);
  // Chat-ui reads copy through its own context. Web's MessageKey union is a
  // superset of the chat-ui keys, and both stay on the English table.
  return (
    <Ctx.Provider value={{ locale: 'en', t }}>
      <ChatUiI18nContext.Provider value={t}>{children}</ChatUiI18nContext.Provider>
    </Ctx.Provider>
  );
}

export function useT(): (key: MessageKey) => string {
  return useContext(Ctx).t;
}

export function useLocale(): Locale {
  return useContext(Ctx).locale;
}

export type { Locale, MessageKey };
