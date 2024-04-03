# [2.5.0](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.4.3...v2.5.0) (2024-04-03)


### Features

* **microservice:** add support for dealing with cookies as a preparation for allowing to login into a c8y edge instance ([b789902](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/b78990293859481ea00cd93e7c1c03fd15aa943b))

## [2.4.3](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.4.2...v2.4.3) (2024-04-03)


### Bug Fixes

* **microservice:** disable timeouts as otherwise websocket connections were closed after ~60-90 seconds ([66b38d5](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/66b38d57ddb777549c5233fa566e8dba67cafd0b))

## [2.4.2](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.4.1...v2.4.2) (2024-03-22)


### Bug Fixes

* **microservice:** allow forwarding auth header if cookie for auth is also present ([97d66b9](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/97d66b9766d8cd4314502757155b55782d867f9f))

## [2.4.1](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.4.0...v2.4.1) (2024-03-22)


### Bug Fixes

* **microservice:** prefer `authorization` cookie over bearer token in `authorization` header when trying to extract user and tenant information ([5b4058b](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/5b4058bda3b4bc186118f09e99d58d9ed5496bde))

# [2.4.0](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.3.3...v2.4.0) (2024-03-21)


### Bug Fixes

* **Microservice:** enhance logging in error cases ([9357174](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/93571749c1c4dfc0b0c49f1371a43ab576bea65a))
* **Plugin:** add hint on console in case microservice was not found ([d7d0960](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/d7d0960d3f8df7a62d55725ce84d2a2c0849f91c))


### Features

* **microservice:** add custom user-agent header ([#45](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/issues/45)) ([52278e6](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/52278e63f813af1d776c43e0a99feb528f3f654d))

## [2.3.3](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.3.2...v2.3.3) (2024-03-21)


### Bug Fixes

* **Plugin:** allow tabs to show up even if `pass-through.enabled` system option is not set ([ca4960b](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/ca4960b029d0af30adb9df1ab6dd9bb3c4842f46))

## [2.3.2](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.3.1...v2.3.2) (2024-03-05)


### Bug Fixes

* add gainsight events for tracking ([12b58d7](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/12b58d7b01899f9bcfb350044618fcf9dff5a893))
* make gainsight service optional ([645571f](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/645571f14c21321bf404699b5f7bee2228f10cb0))

## [2.3.1](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.3.0...v2.3.1) (2024-03-04)


### Bug Fixes

* add https statistics to logging and return details on health endpoint ([4f4199d](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/4f4199dd70bc01c0920c48b142a126479ca8018d))

# [2.3.0](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.2.1...v2.3.0) (2024-03-04)


### Features

* add support for connections to https servers ([e55e308](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/e55e3081be42711c1551c0b5777e4752aa1b7f57))

## [2.2.1](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.2.0...v2.2.1) (2024-02-04)


### Bug Fixes

* remove hint that only one session is possible at the same time ([744a0a3](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/744a0a394d55064cf027e513f96e3f809cf8b18d))

# [2.2.0](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.1.0...v2.2.0) (2024-02-04)


### Features

* added socket pool which allows to reuse previously established connections. ([b44bc9b](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/b44bc9b2c924a07759783e2dabf6d6f95f45c975))

# [2.1.0](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v2.0.0...v2.1.0) (2024-02-01)


### Features

* allow adding custom authorization headers per config to every request ([d06aba7](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/d06aba7ea6fb643b4eb8f54c7eaa0ec1e8d3e9db))

# [2.0.0](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v1.0.5...v2.0.0) (2024-01-31)


### Features

* add proper http server via express to handle every request individually instead of per socket ([#2](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/issues/2)) ([8123bb2](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/8123bb2591941ae06cf691d3afe4a21da757d6b8))


### BREAKING CHANGES

* The device and config id for the remote access connect session are now provided as parameters in the path instead of cookies. This allows to have multiple sessions in parallel from the same browser. Please update both the UI plugin and the microservice.

## [1.0.5](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v1.0.4...v1.0.5) (2024-01-29)
