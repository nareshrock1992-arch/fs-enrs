import ConfigPage from '../../platform/config/ConfigPage.jsx';

/**
 * SysVarsPage — System Variables (Phase 7.1).
 *
 * A thin wrapper around the shared ConfigPage template. All logic
 * (read, edit, deploy, history, audit, rollback) lives in ConfigPage.
 * This file only provides the providerId and display strings.
 */
export default function SysVarsPage() {
  return (
    <ConfigPage
      providerId="vars"
      title="System Variables"
      subtitle="Global FreeSWITCH pre-processor variables — vars.xml"
    />
  );
}
