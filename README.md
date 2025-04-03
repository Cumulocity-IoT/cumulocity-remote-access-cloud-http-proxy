# Remote access cloud HTTP proxy

A Cumulocity IoT microservice that allows to proxy HTTP requests through the cloud to a (local) HTTP server running on a Cumulocity IoT connected device or in the accessible network of the device.
This project contains a backend microservice and a UI plugin. Both must be installed to your tenant in order to use this functionality.

A sample usecase might be to access a configuration UI on your device or to e.g. access an instance of [Node-RED](https://nodered.org/) running on your device:
![Demo Node-Red](images/demo-node-red.png)

## Prerequisits & Limitations

This functionality is heavily relying on the [Cloud Remote Access feature of Cumulocity](https://cumulocity.com/docs/cloud-remote-access/cra-general-aspects/).

- The shell application that you are installing the UI plugin to should use at least version 1017+ of the Web SDK.

- **PASSTHROUGH endpoint:** To use the proxy you need a remote access `PASSTHROUGH` endpoint configured on each of your devices you want to connect to. See [this guide](https://tech.forums.softwareag.com/t/how-to-get-started-with-cloud-remote-access-for-cumulocity-iot/258446#step-by-step-guide-to-setup-a-passthrough-connection-16) for further details.

- **Tenant Authentication Method:** The desired tenant must be configured to use the [`OAI Secure` Authentication](https://cumulocity.com/docs/authentication/basic-settings/#login-settings)

- **Disable XSRF-Token validation**: The XSRF-Token validation of Cumulocity needs to be disabled for the tenant. Please check on your own if this might be a security concern for you: [Cross-site request forgery](https://en.wikipedia.org/wiki/Cross-site_request_forgery). To do this, the corresponding tenant option (category: `jwt`, key: `xsrf-validation.enabled`) must be set to `false`. The microservice will take care of disabling this on subscribed tenants automatically.

- Requests through the proxy can be made via both HTTP and HTTPS. For requests made to an HTTPS server, the certificate of the server is not actually validated.

- The web server you are trying to access must be compatible with being served behind a reverse proxy with another path (which is in this case: `/service/cloud-http-proxy/<deviceId>/<remoteAccessConnectConfigId>/`). This might be something you can configure as part of your application, but not all applications support this.

In case you are reaching the limits of this tool, you can also give [remote-access-local-proxy](https://github.com/Cumulocity-IoT/cumulocity-remote-access-local-proxy) a try. This requires an application be to executed locally, but is not limited to just the HTTP protocol.

## Microservice

The microservice is written in nodeJS.

It's functionality can be described in the following steps:

1. Accept incoming requests on path: `/service/cloud-http-proxy/<deviceId>/<remoteAccessConnectConfigId>/**/*` and `/service/cloud-http-proxy/s/<deviceId>/<remoteAccessConnectConfigId>/**/*` (in case of HTTPS)
2. The authentication details and the connection details included in the path are taken from the incoming request.
3. The authentication information is used to create a new remote access connect session. The device ID and remote access connect configuration Id is also required to establish this connection.
4. After the remote access connect Websocket connection was established successfully, it will send the HTTP request through the Websocket connection to the web server running on the device. The corresponding response is also forwarded.

## UI Plugin

The UI plugin adds tabs on device level to the application it has been installed to.
The UI detects remote access connections available for the device that have been prefixed with `http:` and use the `PASSTHROUGH` protocol.

For instructions on how to install an UI plugin, please check [here](https://cumulocity.com/docs/standard-tenant/ecosystem/#extensions).

### Configuring a new connection

A new connection can be configured on devices supporting the remote access connect feature.
The default UI of the remote access connect feature can be used for that.

The name of the configuration should be prefixed with either `http:` or `https:` depending on the server you are trying to connect to. This is used by the UI Plugin to identify endpoints that are compatible with it.

The protocol should be set to `PASSTHROUGH`. In case this is not available, please contact your platform administrator to make it available.

You can then just enter the host and port that you would like to connect to with this configuration.
Below you can find a sample configuration for Node-RED.
![Configure Node-RED](images/configuring-node-red.png)

Once you saved the new connection, an new tab will show up on the device.
It might be required to reload the page once for the tab to show up.

In case the tab does not show up, check the browsers console logs. In case you've missed to set a tenant option, you should see a warning there.

In case the http server you are trying to access needs some sort auf authorization, you can set an `authorization` header via the UI, which will be attached by the proxy microservice to all request.

In case you want to set some other header as well, you can do so by setting a tenant option per header:

- Category should be `cloud-http-proxy`
- Key should follow this syntax: `credentials.rca-http-header-<headerKey>-<deviceId>-<connectionId>`
- Value: the header value to be set

  ```
  c8y tenantoptions update --category cloud-http-proxy --key credentials.rca-http-header-<headerKey>-<deviceId>-<connectionId> --value <headerValue>
  ```

## How to demo this

1. Setup a device with an agent that supports remote access connect, e.g. [thin-edge.io](https://thin-edge.github.io/thin-edge.io/install/)
2. Install e.g. Node-RED via [their install script](https://github.com/node-red/linux-installers/#debian-ubuntu-raspberry-pi-os)
3. Create an remote access endpoint like described above.
4. Reload the page once and you should see a new tab on device level with the name that you have used for the connection.

## Ideas for future improvements:

- ~~**Connection Pools:** As of now a remote access connect session is used per request. This does mean that per HTTP request sent, an operation for the device is created to establish the remote access connect session. This adds a certain delay to every request and creates a bunch of operations in Cumulocity. This could be improved by having a connection pool per device, to reuse remote access connect sessions.~~ **`implemented`**

- ~~**Authorization:** Currently any sort of authorization to the target HTTP server is not supported since the `Authorization` headers would be interpreted by Cumulocity and the access would be probably denied (as the user you are using against the device is probably not existing inside of Cumulocity). In theory an authorization header could be added to the requests as part of the http proxy that is running inside of the microservice.~~ **`implemented`**
