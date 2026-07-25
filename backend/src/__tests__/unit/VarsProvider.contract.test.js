/**
 * VarsProvider contract test — runs the generic provider contract suite
 * against VarsProvider with a minimal fixture file.
 */
import { runProviderContractTests } from './providerContractSuite.js';
import { VarsProvider } from '../../../platform/configuration/providers/VarsProvider.js';

const STUB_DRIVER = { resolveConfigPath: () => '/dev/null' };

const VALID_CONTENT = `<?xml version="1.0"?>
<include>
  <X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>
  <X-PRE-PROCESS cmd="set" data="domain_port=5060"/>
  <!--<X-PRE-PROCESS cmd="set" data="external_sip_ip=auto"/>-->
  <X-PRE-PROCESS cmd="set" data="max_sessions=1000"/>
  <X-PRE-PROCESS cmd="set" data="default_password=2024secure"/>
</include>`;

runProviderContractTests(
  () => new VarsProvider(STUB_DRIVER),
  {
    validContent:      VALID_CONTENT,
    sampleChangeKey:   'domain_name',
    sampleChangeValue: 'example.com',
    knownKeys:         ['domain_name', 'domain_port', 'max_sessions', 'default_password'],
  }
);
