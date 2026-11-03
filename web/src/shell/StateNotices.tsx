// Connection and model notices. Page renders the connection notice; screens that show
// model output render <ModelNotice /> next to it.
import { Alert } from '@/components/arc/alert/alert';
import { formatClock } from './format';
import { useLastPoll, useMock } from './store';

export function ConnectionNotice() {
  const { connection, workspace } = useMock();
  const { lastPollAt, ageMs } = useLastPoll();
  if (connection === 'offline') {
    return (
      <Alert tone="danger" title="Hive is unreachable">
        {`Cannot reach ${workspace.cloudLink}. You are looking at data from ${formatClock(lastPollAt)}, so none of it is live. Actions are paused until the server answers.`}
      </Alert>
    );
  }
  if (connection === 'stale' || ageMs > 10_000) {
    return (
      <Alert tone="warning" title="Updates are delayed">
        {`The last update arrived ${Math.round(ageMs / 1000)} seconds ago. Hive keeps retrying; treat agent progress as out of date until it catches up.`}
      </Alert>
    );
  }
  return null;
}

export function ModelNotice() {
  const { model, snapshot } = useMock();
  if (model === 'not_configured' || !snapshot.model.configured) {
    return (
      <Alert tone="info" title="No model is configured">
        Hive still raises deterministic and compiler findings. Plain-language explanations and proposed declarations are off until an admin adds a model.
      </Alert>
    );
  }
  if (snapshot.analysis?.status === 'unavailable') {
    return (
      <Alert tone="warning" title="Muse Spark is unavailable">
        {snapshot.analysis.error ?? 'The model did not answer. Deterministic and compiler findings are unaffected.'}
      </Alert>
    );
  }
  return null;
}
