# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately: open a private security advisory on
this repository (**Security** tab, **Report a vulnerability**). Do not open a
public issue or pull request for a security problem.

Include what you found, how to reproduce it, and what an attacker could do
with it. If the issue is in a deployed instance rather than in the template
itself, report it to the team that runs that instance; the template's
maintainers have no access to anyone's deployment.

## Supported versions

Only the latest release tag receives security fixes. Instances should upgrade
to it as described in [UPGRADING.md](UPGRADING.md).

## Scope

The template's intended guarantees, its trusted parties, and what it
deliberately does not protect against are in [THREAT_MODEL.md](THREAT_MODEL.md)
and in [Limits and residual risk](README.md#limits-and-residual-risk) in the
README. A behaviour listed there as an accepted risk is not a vulnerability,
but a way around a stated guarantee is.
