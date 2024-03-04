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
