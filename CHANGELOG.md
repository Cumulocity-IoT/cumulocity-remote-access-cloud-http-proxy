# [2.0.0](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v1.0.5...v2.0.0) (2024-01-31)


### Features

* add proper http server via express to handle every request individually instead of per socket ([#2](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/issues/2)) ([8123bb2](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/commit/8123bb2591941ae06cf691d3afe4a21da757d6b8))


### BREAKING CHANGES

* The device and config id for the remote access connect session are now provided as parameters in the path instead of cookies. This allows to have multiple sessions in parallel from the same browser. Please update both the UI plugin and the microservice.

## [1.0.5](https://github.com/SoftwareAG/cumulocity-remote-access-cloud-http-proxy/compare/v1.0.4...v1.0.5) (2024-01-29)
