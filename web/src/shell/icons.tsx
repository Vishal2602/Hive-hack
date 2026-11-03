// Inline SVG icon set for the shell (no icon dependency). 16px, 1.5px stroke, currentColor.
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

export const HiveMark = (p: IconProps) => (
  <Svg {...p}><path d="M8 1.75 13.4 4.875v6.25L8 14.25 2.6 11.125v-6.25Z" /><path d="M8 5.5 10.2 6.75v2.5L8 10.5 5.8 9.25v-2.5Z" /></Svg>
);
export const OverviewIcon = (p: IconProps) => (
  <Svg {...p}><rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1.25" /><rect x="9" y="2.25" width="4.75" height="4.75" rx="1.25" />
    <rect x="2.25" y="9" width="4.75" height="4.75" rx="1.25" /><rect x="9" y="9" width="4.75" height="4.75" rx="1.25" /></Svg>
);
export const ConnectIcon = (p: IconProps) => (
  <Svg {...p}><path d="M6.75 9.25 9.25 6.75" /><path d="M7.5 4.25 8.75 3a2.47 2.47 0 0 1 3.5 3.5L11 7.75" /><path d="M8.5 11.75 7.25 13a2.47 2.47 0 0 1-3.5-3.5L5 8.25" /></Svg>
);
export const AgreementsIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 1.75h5.25L12.5 5v8.25a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1Z" /><path d="M9 1.75V5.25h3.5" /><path d="m5.5 9.5 1.5 1.5 3-3" /></Svg>
);
export const ActivityIcon = (p: IconProps) => (
  <Svg {...p}><path d="M1.75 8h2.5l1.75-4.5 3.5 9 1.75-4.5h2.5" /></Svg>
);
export const MembersIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="6" cy="5.25" r="2.5" /><path d="M1.75 13.5c.4-2.3 2.1-3.75 4.25-3.75s3.85 1.45 4.25 3.75" />
    <path d="M10.5 2.9a2.5 2.5 0 0 1 0 4.7" /><path d="M12 9.95c1.2.5 2 1.75 2.25 3.55" /></Svg>
);
export const PanelLeftIcon = (p: IconProps) => (
  <Svg {...p}><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" /><path d="M6 2.25v11.5" /></Svg>
);
export const MenuIcon = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 4.5h11" /><path d="M2.5 8h11" /><path d="M2.5 11.5h11" /></Svg>
);
export const CloseIcon = (p: IconProps) => (
  <Svg {...p}><path d="m4 4 8 8" /><path d="m12 4-8 8" /></Svg>
);
export const LinkIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="8" r="6.25" /><path d="M1.75 8h12.5" /><path d="M8 1.75c1.6 1.7 2.4 3.8 2.4 6.25S9.6 12.55 8 14.25C6.4 12.55 5.6 10.45 5.6 8S6.4 3.45 8 1.75Z" /></Svg>
);
