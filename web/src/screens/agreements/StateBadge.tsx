// The one place an agreement state becomes a chip. Use it on every screen so a state always looks the same.
// Mapping: accepted = amber (a signed promise), implemented = neutral, verified = success (the only green),
// stale = warning, rejected = danger, proposed and cancelled = neutral.
import { Ban, CircleDashed, Code, History, PenLine, ShieldCheck, X } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/arc/badge/badge';
import type { ContractStatus } from '@/mock';
import { STATE_LABEL } from './model';

const LOOK: Record<ContractStatus, Pick<BadgeProps, 'tone' | 'color' | 'outline' | 'icon'>> = {
  proposed: { tone: 'neutral', icon: <CircleDashed /> },
  accepted: { color: 'amber', icon: <PenLine /> },
  implemented: { tone: 'neutral', outline: true, icon: <Code /> },
  verified: { tone: 'success', icon: <ShieldCheck /> },
  stale: { tone: 'warning', icon: <History /> },
  rejected: { tone: 'danger', icon: <X /> },
  cancelled: { tone: 'neutral', outline: true, icon: <Ban /> },
};

export function StateBadge({ status, size = 'md' }: { status: ContractStatus; size?: BadgeProps['size'] }) {
  return <Badge size={size} {...LOOK[status]}>{STATE_LABEL[status]}</Badge>;
}
