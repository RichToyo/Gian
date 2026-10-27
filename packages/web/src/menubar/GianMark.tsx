import {
  GIAN_DRAGON_BODY_PATH,
  GIAN_DRAGON_WHISKER_BOTTOM_PATH,
  GIAN_DRAGON_WHISKER_TOP_PATH,
  GIAN_ICON_VIEWBOX,
} from '../brand-icon.js';

/** The Gian Dragon-G mark in currentColor, for the panel header. */
export function GianMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${GIAN_ICON_VIEWBOX} ${GIAN_ICON_VIEWBOX}`}
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
    >
      <path fill="currentColor" fillRule="evenodd" d={GIAN_DRAGON_BODY_PATH} />
      <path fill="currentColor" d={GIAN_DRAGON_WHISKER_TOP_PATH} />
      <path fill="currentColor" d={GIAN_DRAGON_WHISKER_BOTTOM_PATH} />
    </svg>
  );
}
