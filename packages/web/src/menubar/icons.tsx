/* Vendored lucide-style stroke icons (24 grid, 1.5px stroke), same idiom as
 * SidebarChrome: geometry only, painted with currentColor. */

export function SvgIcon({
  d,
  size = 16,
  stroke = 1.5,
  className,
}: {
  d: string | readonly string[];
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const segments = Array.isArray(d)
    ? (d as readonly string[])
    : (d as string).split(' M').map((seg, i) => (i === 0 ? seg : `M${seg}`));
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {segments.map((seg, i) => (
        <path key={i} d={seg} />
      ))}
    </svg>
  );
}

export const ICON = {
  caretRight: 'M9 6l6 6-6 6',
  caretDown: 'M6 9l6 6 6-6',
  chevronLeft: 'M15 6l-6 6 6 6',
  refresh:
    'M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 21v-5h5',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v.01 M11 12h1v5h1',
  circleCheck: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M5 12l5 5L20 7',
  settings:
    'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M18.7 12a6 6 0 0 0-.1-1.2l1.8-1.4-1.8-3.1-2.1.8a6.2 6.2 0 0 0-2.1-1.2L14 3.5h-4l-.4 2.4a6.2 6.2 0 0 0-2.1 1.2l-2.1-.8-1.8 3.1 1.8 1.4a6 6 0 0 0 0 2.4l-1.8 1.4 1.8 3.1 2.1-.8a6.2 6.2 0 0 0 2.1 1.2l.4 2.4h4l.4-2.4a6.2 6.2 0 0 0 2.1-1.2l2.1.8 1.8-3.1-1.8-1.4c.07-.4.1-.8.1-1.2z',
  // Generic Agent mark for mixed/unknown identity — the exact geometry the
  // main app already uses (CustomView), never an invented brand.
  bot: [
    'M12 8V4H8',
    'M20 8H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2z',
    'M9 13v2',
    'M15 13v2',
  ] as const,
};
