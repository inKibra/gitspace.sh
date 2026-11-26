// Tests run as on an install at GitSpace's own domains, named as the served page names them (a test that resets its
// modules reads them from the page again).
import { DEFAULT_DOMAINS, withDomainsMeta } from '@gitspace/protocol-environment/domains';
import { setInstallDomains } from './install-domains.js';

if (typeof document !== 'undefined') {
  const head = withDomainsMeta('<head></head>', DEFAULT_DOMAINS);
  document.head.insertAdjacentHTML('afterbegin', head.slice('<head>'.length, -'</head>'.length));
}
setInstallDomains(DEFAULT_DOMAINS);
