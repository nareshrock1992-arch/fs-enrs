import ConfigPage from '../../platform/config/ConfigPage.jsx';

export default function SipProfilesPage() {
  return (
    <ConfigPage
      providerId="sip-profiles"
      title="SIP Global Settings"
      subtitle="mod_sofia global settings — sofia.conf.xml"
    />
  );
}
