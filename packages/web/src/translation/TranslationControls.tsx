/**
 * Local Web adapters for the shared conversation-translation components in
 * `@gian/chat-ui`. The shared components take display models and callbacks;
 * this module maps the local TranslationController onto them, so SessionMain,
 * the transcript, the new-session form, and the selection popover keep their
 * existing props.
 */

import {
  AutoTranslationChip,
  TranslationEchoPendingRow,
  TranslationResultBlock,
  TranslationSendRow as SharedTranslationSendRow,
  TranslationToggleButton,
  TranslatingIndicator,
  languageName,
  type MsgItem,
} from '@gian/chat-ui';
import { useT } from '../i18n/index.js';
import { SEND_TRANSLATE_TIMEOUT_MS } from './send-timeout.js';
import type { ReadingTranslation, TranslationController } from './use-translation.js';

export { AutoTranslationChip, TranslationEchoPendingRow, TranslatingIndicator, languageName };

export function TranslationButton({ item, controller }: { item: MsgItem; controller: TranslationController }) {
  const t = useT();
  const key = `turn:${item.turn}`;
  const expanded = controller.isReadExpanded(key);
  const title = t('translation.to').replace('{language}', languageName(controller.state.preferences.reading_language));
  // Not disabled while pending: the toggle must stay clickable so the user can
  // collapse a slow translation; toggleRead already no-ops the read when one
  // is in flight.
  return <TranslationToggleButton
    expanded={expanded}
    ready={controller.ready}
    title={title}
    onClick={() => controller.toggleRead(item.text, key)}
  />;
}

/**
 * The assistant message's translation block. Rendering is owned by the globe
 * toggle (`expanded`): collapsed renders nothing — even when the Host already
 * has a cached record.
 */
export function TranslationResult({ value, expanded, onRetry }: { value: ReadingTranslation; expanded: boolean; onRetry: () => void }) {
  return <TranslationResultBlock
    value={{
      pending: value.pending,
      ...(value.error ? { error: value.error } : {}),
      ...(value.record ? { text: value.record.text, targetLanguage: value.record.targetLanguage } : {}),
    }}
    expanded={expanded}
    onRetry={onRetry}
  />;
}

/**
 * Inline progress row under a pending send echo while its translation runs.
 * Translating: dots + a "Send original" shortcut. Failed (error or the 45s
 * timeout): the message plus Retry / Send original / Take text back. There
 * is deliberately no way to silently drop the message — reclaim hands the
 * text back to the composer instead.
 */
export function TranslationSendRow({ controller }: { controller: TranslationController }) {
  return <SharedTranslationSendRow
    sending={controller.sending}
    timeoutSeconds={SEND_TRANSLATE_TIMEOUT_MS / 1000}
    onRetry={() => void controller.retrySend()}
    onSendOriginal={() => controller.finishSend(true)}
    onReclaim={() => controller.reclaimSend()}
  />;
}
