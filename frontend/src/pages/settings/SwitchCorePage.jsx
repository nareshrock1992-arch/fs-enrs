import ConfigPage from '../../platform/config/ConfigPage.jsx';

/**
 * SwitchCorePage — Core Switch Settings (switch.conf.xml).
 *
 * Thin wrapper around the shared ConfigPage template.
 * All logic (read, edit, deploy, history, audit, rollback) lives in ConfigPage.
 */
export default function SwitchCorePage() {
  return (
    <ConfigPage
      providerId="switch-core"
      title="Switch Core"
      subtitle="Core FreeSWITCH settings — switch.conf.xml"
    />
  );
}
