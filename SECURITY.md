# Security Policy

GitSpace is currently a pre-release project and changes quickly. We take reports about the confidentiality, integrity, or availability of GitSpace seriously.

## Supported versions

Security fixes are developed on `develop` and included in the current hosted service and official release channels. We do not provide security updates for older releases, forks, or development snapshots.

| Target | Supported |
| --- | --- |
| Current GitSpace hosted service | Yes |
| Most recent official machine and runtime release | Yes |
| Current `develop` branch | Yes |
| Older releases, forks, and snapshots | No |

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting form](https://github.com/inKibra/gitspace.sh/security/advisories/new). Do not include vulnerability details in a public issue, discussion, or pull request.

Include as much of the following as you can:

- the affected service, package, version, or commit;
- the prerequisites and security impact;
- steps to reproduce or a minimal proof of concept;
- relevant logs or screenshots, with credentials and personal data removed;
- any mitigation or fix you have already identified; and
- how you would like to be credited.

If the private reporting form is unavailable, open a public issue containing no vulnerability details and ask the maintainers to enable a private reporting channel.

We aim to acknowledge a report within three business days, provide an initial assessment within seven business days, and send an update at least every seven days while remediation is in progress. These are response targets rather than resolution deadlines; the time needed to release a fix depends on severity and complexity.

## Responsible testing

Please:

- test only with accounts, repositories, machines, and data you own or have permission to use;
- stop after demonstrating the minimum access needed to establish impact;
- avoid privacy violations, data destruction, service disruption, social engineering, and high-volume automated testing;
- do not retain or disclose credentials, personal data, or other data obtained during testing; and
- allow a reasonable period for investigation and remediation before public disclosure.

Publicly known dependency vulnerabilities are useful when the report explains how GitSpace reaches the vulnerable behavior or is affected in practice. General hardening suggestions and scanner output without a demonstrated security impact can be filed as regular issues.

We will coordinate disclosure timing with the reporter and, when requested, credit people who report vulnerabilities in good faith.
