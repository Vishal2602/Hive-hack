import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FileCode } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { Select } from '@/components/arc/select/select';
import { Page, formatRelative, parseSymbolKey, useHive, useMediaQuery, useNow } from '@/shell';
import type { Contract, ContractStatus, HiveEvent } from '@/mock';
import { ParticipantList } from './agreements/Participants';
import { StateBadge } from './agreements/StateBadge';
import { STATE_ORDER, VERDICT_TITLE, exitText, runVerdict, signedCount } from './agreements/model';
import { unfinishedRunIds } from './agreements/runs';
import styles from './agreements/agreements.module.css';

type Filter = 'all' | 'open' | 'verified' | 'stale' | 'closed';

const FILTERS: { value: Filter; label: string; states: ContractStatus[] }[] = [
  { value: 'all', label: 'All', states: STATE_ORDER },
  { value: 'open', label: 'In progress', states: ['proposed', 'accepted', 'implemented'] },
  { value: 'verified', label: 'Verified', states: ['verified'] },
  { value: 'stale', label: 'Stale', states: ['stale'] },
  { value: 'closed', label: 'Closed', states: ['rejected', 'cancelled'] },
];

const FILTER_EMPTY: Record<Filter, { title: string; description: string }> = {
  all: { title: 'No agreements yet', description: 'When two agents depend on the same interface, one proposes an agreement here and every participant signs the exact version.' },
  open: { title: 'Nothing in progress', description: 'Every agreement is verified, stale or closed. New proposals show up here first.' },
  verified: { title: 'Nothing verified yet', description: 'An agreement is verified only when an allowlisted test command passes on applied code.' },
  stale: { title: 'Nothing is stale', description: 'An agreement goes stale when its code or an intent changes after it was signed.' },
  closed: { title: 'Nothing rejected or cancelled', description: 'Rejected and cancelled agreements stay here for the record.' },
};

export default function Agreements() {
  const { snapshot, sessionName, events } = useHive();
  const navigate = useNavigate();
  const now = useNow(15_000);
  const phone = useMediaQuery('(max-width: 479px)');
  const [params, setParams] = useSearchParams();
  const filter = (FILTERS.find(f => f.value === params.get('state'))?.value ?? 'all') as Filter;

  const contracts = snapshot.contracts;
  const counts = useMemo(() => Object.fromEntries(
    FILTERS.map(f => [f.value, contracts.filter(c => f.states.includes(c.status)).length]),
  ) as Record<Filter, number>, [contracts]);

  const visible = useMemo(() => {
    const states = FILTERS.find(f => f.value === filter)!.states;
    return contracts.filter(c => states.includes(c.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [contracts, filter]);

  const setFilter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('state'); else next.set('state', value);
    setParams(next, { replace: true });
  };

  return (
    <Page
      title="Agreements"
      description="Versioned promises about an interface. A signature means the agents agreed; only a passing test run on applied code proves the code keeps the promise."
    >
      {contracts.length === 0 ? (
        <EmptyState
          className={styles.empty}
          icon={<FileCode />}
          title={FILTER_EMPTY.all.title}
          description={FILTER_EMPTY.all.description}
          action={<Button variant="secondary" onClick={() => navigate('/')}>Go to overview</Button>}
        />
      ) : (
        <section className={styles.listSection} aria-labelledby="agreements-heading">
          <h2 id="agreements-heading" className="visually-hidden">Agreement list</h2>
          <div className={styles.toolbar}>
            {phone ? (
              <div className={styles.filterSelect}>
                <Select
                  label="Show"
                  value={filter}
                  onValueChange={setFilter}
                  options={FILTERS.map(f => ({ value: f.value, label: `${f.label} (${counts[f.value]})` }))}
                />
              </div>
            ) : (
              <SegmentedControl
                label="Filter by state"
                value={filter}
                onValueChange={setFilter}
                options={FILTERS.map(f => ({ value: f.value, label: f.label, accessory: <span className={styles.count}>{counts[f.value]}</span> }))}
              />
            )}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              className={styles.empty}
              icon={<FileCode />}
              title={FILTER_EMPTY[filter].title}
              description={FILTER_EMPTY[filter].description}
              action={<Button variant="secondary" onClick={() => setFilter('all')}>Show all agreements</Button>}
            />
          ) : (
            <ul className={styles.list}>
              {visible.map(contract => (
                <AgreementRow key={contract.id} contract={contract} events={events} sessionName={sessionName} now={now} />
              ))}
            </ul>
          )}
        </section>
      )}
    </Page>
  );
}

function AgreementRow({ contract, events, sessionName, now }: { contract: Contract; events: HiveEvent[]; sessionName: (id: string) => string; now: number }) {
  const producer = contract.producerSymbol ? parseSymbolKey(contract.producerSymbol) : null;
  const signed = signedCount(contract);
  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowHead}>
          <h3 className={styles.rowTitle}>
            <Link to={`/agreements/${encodeURIComponent(contract.id)}`} className={styles.rowLink}>{contract.title}</Link>
          </h3>
          <StateBadge status={contract.status} />
        </div>
        <p className={styles.rowMeta}>
          <span>Version {contract.version}</span>
          {producer && (
            <span>
              <code>{producer.name}</code> in <code>{producer.file}</code>
            </span>
          )}
          <span>{signed} of {contract.participants.length} signed this version</span>
        </p>
        <ParticipantList contract={contract} sessionName={sessionName} />
        <LatestCheck contract={contract} events={events} />
      </div>
      <p className={styles.rowTime}>Updated {formatRelative(contract.updatedAt, now)}</p>
    </li>
  );
}

/** The latest test run on record, or a run in progress (known from its started event). */
function LatestCheck({ contract, events }: { contract: Contract; events: HiveEvent[] }) {
  const recorded = contract.evidence.verification ?? null;
  const running = unfinishedRunIds(events, contract.id, recorded?.id ?? null)[0];
  if (running) {
    const started = [...events].reverse().find(e => e.type === 'contract.verification_started' && e.payload?.runId === running);
    const command = typeof started?.payload?.command === 'string' ? started.payload.command : 'A test command';
    return <p className={styles.rowCheck} data-verdict="running">Running <code>{command}</code> now. No result yet.</p>;
  }
  if (!recorded) return <p className={styles.rowCheck}>No test run yet.</p>;
  const verdict = runVerdict(recorded);
  return (
    <p className={styles.rowCheck} data-verdict={verdict}>
      Latest check: <code>{recorded.command}</code> {VERDICT_TITLE[verdict].toLowerCase()}, {exitText(recorded)} at revision {recorded.revision}.
    </p>
  );
}
